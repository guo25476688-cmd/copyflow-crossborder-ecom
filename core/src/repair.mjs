import { runRules } from './rules.mjs';
import { checkGrounding } from './grounding.mjs';
import { validate } from './validate.mjs';
import { parseJsonLoose } from './llm.mjs';

// 校验修复循环（第 6 步）：合规规则引擎只管平台规则，依据检查只管"有没有依据"，
// 这里把两份报告合成一份，再驱动一个有上限的自动修复循环。
// 循环只做"按问题清单改文案"这一件事，不重新生成、不引入清单之外的改动；
// 修不干净就如实返回目前最好的一版和完整报告，绝不假装通过。

/** 合并规则引擎与依据检查两份报告：issues 拼接，passed 要求两者都通过 */
export function mergeReports(a, b) {
  return { passed: a.passed && b.passed, rule_set_version: `${a.rule_set_version}+${b.rule_set_version}`, issues: [...a.issues, ...b.issues] };
}

/** 对一份 Listing 同时跑合规规则引擎与依据检查，返回合并后的报告（第 6 步应当只调这一个函数） */
export function checkListing({ listing, factSheet }) {
  return mergeReports(runRules({ listing, factSheet }), checkGrounding({ factSheet, listing }));
}

export const errorCount = (r) => r.issues.filter((i) => i.severity === 'error').length;
// 比较两份报告谁更好：error 少的更好；error 一样多时，总问题（含 warning）少的更好
export const isBetter = (a, b) => errorCount(a) < errorCount(b) || (errorCount(a) === errorCount(b) && a.issues.length < b.issues.length);

const systemPrompt = () => `你是跨境电商文案的"修复员"。你会收到一份平台文案（JSON）、它依据的事实表，以及一份问题清单（每条问题带规则、位置、触发的原文、严重程度与修复建议）。你的任务是只按问题清单修复这份文案，输出修正后的完整文案 JSON。

铁律：
1. 只能使用事实表里已有的信息，绝不为了填补空白而编造新的规格、数字、认证或功效。
2. platform 与 market 不能改变；文案的字段结构（有哪些字段、bullets 有几条等）尽量保持不变，除非某条问题明确要求增减数量。
3. severity 为 error 的问题必须修复；warning 级的问题在不引入新问题的前提下也尽量修复，但不强制。
4. 参照每条问题的 fix_hint，但不要为了避开一个问题而制造另一个问题——比如为了不超字数就把内容删成空洞的话，或者删掉声明依据（claims）却留着卖点原文不删，或者去掉某个字段该有的引用编号。
5. 不在问题清单里的内容原样保留，不要顺手做其他改动。
6. 只输出严格合法的 JSON：就是修正后的完整 Listing，字段结构与输入一致，不要解释，不要代码块标记。`;

function buildRepairPrompt({ listing, factSheet, issues }) {
  const facts = {
    product: factSheet.product,
    facts: factSheet.facts.map(({ id, statement, evidence }) => ({ id, statement, evidence })),
    forbidden_claims: factSheet.forbidden_claims,
  };
  const list = issues.map((i) => `- [${i.severity}] ${i.rule_id} @ ${i.path}：${i.evidence}\n  修复建议：${i.fix_hint}`).join('\n');
  const user = `平台文案（需要修复）：
<<<
${JSON.stringify(listing, null, 1)}
>>>

事实表：
<<<
${JSON.stringify(facts, null, 1)}
>>>

需要修复的问题（共 ${issues.length} 条）：
<<<
${list}
>>>

请输出修正后的完整文案 JSON。`;
  return { system: systemPrompt(), user };
}

/**
 * 对一份 Listing 跑有上限的自动修复循环。已经通过（无 error 级问题）时不调用模型，直接返回。
 * 每次尝试：把当前问题清单发给模型 → 校验输出结构（不能改 platform/market，必须合法）
 * → 跑合并报告。变好就采纳为新的基准；模型调用失败直接停止；结构不合法计入历史但保留原基准重试。
 * 循环结束时始终返回目前见过的最好一版，不会因为修不干净就返回一份更差或无效的结果。
 * 返回 { ok, listing, report, attempts, history }；ok = 最终报告 passed（无 error）。
 */
export async function repairListing({ listing, factSheet, chat, maxAttempts = 3 }) {
  let best = { listing, report: checkListing({ listing, factSheet }) };
  if (best.report.passed) return { ok: true, listing: best.listing, report: best.report, attempts: 0, history: [] };

  const history = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { system, user } = buildRepairPrompt({ listing: best.listing, factSheet, issues: best.report.issues });
    let text;
    try {
      text = await chat({ system, user, json: true, temperature: 0 });
    } catch (e) {
      history.push({ attempt, ok: false, error: `模型调用失败：${e.message}` });
      break; // 调用本身失败，再试也是同样的失败，直接停止并返回目前最好的结果
    }

    let data;
    const structuralErrors = [];
    try {
      data = parseJsonLoose(text);
    } catch (e) {
      structuralErrors.push(`输出不是合法 JSON：${e.message}`);
    }
    if (data) {
      if (data.platform !== listing.platform) structuralErrors.push(`platform 不能从 ${listing.platform} 改成 ${data.platform}`);
      if (data.market !== listing.market) structuralErrors.push(`market 不能从 ${listing.market} 改成 ${data.market}`);
      const s = validate('listing', data);
      if (!s.ok) structuralErrors.push(...s.errors.map((e) => `结构不合法：${e}`));
    }
    if (structuralErrors.length) {
      history.push({ attempt, ok: false, structuralErrors, raw: text.slice(0, 4000) });
      continue; // 基准（best）保持不变，下一次仍从同一个问题清单再试
    }

    const report = checkListing({ listing: data, factSheet });
    history.push({ attempt, ok: report.passed, error_count: errorCount(report), total_issues: report.issues.length });
    if (report.passed) return { ok: true, listing: data, report, attempts: attempt, history };
    if (isBetter(report, best.report)) best = { listing: data, report };
  }
  return { ok: false, listing: best.listing, report: best.report, attempts: history.length, history };
}
