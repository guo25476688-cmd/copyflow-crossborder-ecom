import { validate, checkReferences } from './validate.mjs';
import { parseJsonLoose } from './llm.mjs';

const systemPrompt = (rule3) => `你是跨境电商的"产品事实提取员"。你的任务是把卖家随手写的产品资料，整理成一份只包含事实的事实表。你不是文案，不要美化，不要补充。

铁律：
1. 只提取输入里明确写出的信息。绝不根据产品类型的常识去补充规格、材质、认证、功能。
2. 每条事实（facts）必须带 evidence：从输入原文里一字不差地复制的片段（含标点和大小写），只复制刚好能支撑该事实的最短片段。复制不出来的，就不是事实。
${rule3}
4. 买家会关心但输入没写的信息（如尺寸、重量、颜色、适用型号、用法用量、保修、清洗方式），写进 unknowns 并说明为什么需要，最多 6 条。其中认证与检测证明（如 CE、FCC、FDA、检测报告）只要输入没提供，就必须出现在 unknowns 里，用来提醒卖家补充。
5. 再把输入里没有任何依据、但同类商品文案里常被编造的声称（如认证、防水等级、检测报告）列入 forbidden_claims，理由写"输入未提供"，最多 4 条。
6. facts 的 statement 和 attributes 使用与输入相同的语言，简洁陈述；statement 里出现的数字必须与 evidence 里的数字一致。
7. 只输出严格合法的 JSON：字符串里的英文双引号必须写成 \\"，不要多余的逗号，不要注释，不要任何解释，不要代码块标记。

输出结构：
{
  "product": { "name": "产品名", "brand": "品牌名，输入里没有就填 null", "category": { "value": "英文类目路径，如 Consumer Electronics > Headphones", "confidence": 0.0 } },
  "facts": [ { "id": "F1", "statement": "简洁陈述", "source": "user_input", "evidence": "原文片段" } ],
  "attributes": [ { "name": "属性名", "value": "属性值", "fact_ids": ["F1"] } ],
  "forbidden_claims": [ { "claim": "不能声称的内容", "reason": "原因" } ],
  "unknowns": [ { "field": "缺失的信息", "why_needed": "为什么需要" } ]
}
attributes 是把 facts 里的规格整理成"名称/值"的结构化属性，每项必须引用 fact_ids。`;

const RULE3 = '3. 输入里的夸大、绝对化、与竞品比较、疾病或健康功效等说法，不是事实，写进 forbidden_claims 并说明原因。';
// 版本记录：p2 = 首轮评测后加入"认证进 unknowns"与"严格合法 JSON"；p3 = 再补充"安全/无毒/环保/功效说法整句都不是事实"
const PROMPTS = {
  p2: systemPrompt(RULE3),
  p3: systemPrompt(`${RULE3}关于安全性、无毒无害、环保、功效的说法同理：除非输入同时给出了检测或认证依据，否则整句都不是事实，不要把其中一部分当事实、另一部分当禁止声称。`),
};
export const PROMPT_VERSIONS = Object.keys(PROMPTS);
export const LATEST_PROMPT = 'p3';

export function buildExtractionPrompt(rawInput, version = LATEST_PROMPT) {
  if (!PROMPTS[version]) throw new Error(`未知提示词版本：${version}`);
  return { system: PROMPTS[version], user: `以下是卖家的产品资料原文：\n<<<\n${rawInput}\n>>>\n请输出事实表 JSON。` };
}

// 比较前统一：全半角、空白、大小写
const norm = (s) => s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
const numbers = (s) => norm(s).match(/\d+(?:\.\d+)?/g) || [];
// 子串比对时忽略所有空白：模型常在中文与数字之间多插空格，这不是编造
const squash = (s) => norm(s).replace(/\s+/g, '');

/**
 * 确定性防编造校验：不靠另一个模型判断，只做字符串比对。
 * 编造出来的事实找不到原文依据；被篡改的数字也对不上依据。
 */
export function checkEvidence(rawInput, factSheet) {
  const errors = [];
  const input = squash(rawInput);

  for (const f of factSheet.facts) {
    if (f.source !== 'user_input') errors.push(`事实 ${f.id} 的 source 必须是 user_input（当前只支持文字输入）`);
    if (!input.includes(squash(f.evidence))) {
      errors.push(`事实 ${f.id} 的依据在原文里找不到，疑似编造：「${f.evidence}」`);
      continue;
    }
    const evNums = new Set(numbers(f.evidence));
    const bad = numbers(f.statement).filter((n) => !evNums.has(n));
    if (bad.length) errors.push(`事实 ${f.id} 的陈述里出现了依据中没有的数字 ${[...new Set(bad)].join('、')}`);
  }

  const evidenceOf = new Map(factSheet.facts.map((f) => [f.id, f.evidence]));
  factSheet.attributes.forEach((a, i) => {
    const evNums = new Set(a.fact_ids.flatMap((id) => numbers(evidenceOf.get(id) ?? '')));
    const bad = numbers(a.value).filter((n) => !evNums.has(n));
    if (bad.length) errors.push(`属性 attributes[${i}]「${a.name}」的值里出现了所引事实依据中没有的数字 ${[...new Set(bad)].join('、')}`);
  });

  const brand = factSheet.product.brand;
  if (brand && !input.includes(squash(brand))) errors.push(`品牌「${brand}」在原文里找不到`);
  return errors;
}

/** 一次校验：结构 + 编号引用 + 原文依据。返回错误数组 */
export function verifyFactSheet(rawInput, data) {
  const s = validate('factSheet', data);
  if (!s.ok) return s.errors.map((e) => `结构不合法：${e}`);
  return [...checkReferences({ factSheet: data }), ...checkEvidence(rawInput, data)];
}

/**
 * 从原始文字提取事实表。校验不通过就把具体问题带给模型重试，最多 maxAttempts 次。
 * 返回 { ok, factSheet?, attempts, errors, history }，失败时 errors 是最后一次的问题，不抛异常。
 * history 记录每次尝试被拒的原因和模型原始输出（截断），成功的那次也在其中，用于诊断为什么需要重试。
 */
export async function extractFactSheet({ rawInput, chat, maxAttempts = 3, promptVersion = LATEST_PROMPT }) {
  const { system, user } = buildExtractionPrompt(rawInput, promptVersion);
  let prompt = user;
  let errors = [];
  const history = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let text;
    try {
      text = await chat({ system, user: prompt, json: true, temperature: 0 });
    } catch (e) {
      return { ok: false, attempts: attempt, errors: [`模型调用失败：${e.message}`], history };
    }

    let data;
    try {
      data = parseJsonLoose(text);
    } catch (e) {
      errors = [`输出不是合法 JSON：${e.message}`];
    }
    if (data) errors = verifyFactSheet(rawInput, data);
    history.push({ attempt, errors: [...errors], raw: text.slice(0, 4000) });
    if (data && !errors.length) return { ok: true, factSheet: data, attempts: attempt, errors: [], history };
    prompt = `${user}\n\n你上一次的输出没有通过校验，问题如下：\n${errors.slice(0, 8).map((e) => `- ${e}`).join('\n')}\n请修正这些问题，重新输出完整的 JSON。`;
  }
  return { ok: false, attempts: maxAttempts, errors, history };
}
