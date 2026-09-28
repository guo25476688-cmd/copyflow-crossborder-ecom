import { validate, checkReferences } from './validate.mjs';
import { extractFields } from './rules.mjs';

// 全部是确定性的字符串/数字比对，不靠模型。抓的是"有依据吗"的硬性问题：
// 编造的规格数字、卖点没落在声明的位置、中文/全角字符漏进外语文案。
// 形容词层面的夸大（如事实里没有重量却写 lightweight）比对不出来，留给第 6 步的评审环节。

const norm = (s) => s.normalize('NFKC').toLowerCase();
export const squash = (s) => norm(s).replace(/\s+/g, '');

// ---------- 数字提取 ----------

const CN_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
// 中文数字只在后面紧跟量词/单位时才算数字（“三档色温”“两年”），避免把“一键”“统一”当成 1
const CN_NUM = /([零〇一二两三四五六七八九十百]+)([档挡个级段种层片粒瓶件套只条块节组倍孔面米克斤天年月周分秒小度寸])/gu;
// “一个”绝大多数是不定冠词用法（“一个亮点”＝a highlight），不是数量声称；其余“一+量词”（一年、一件）和“两个/三个”等仍按数字处理
const isGenericArticle = (digits, unit) => digits === '一' && unit === '个';
const cnToInt = (s) => {
  let total = 0;
  let cur = 0;
  for (const ch of s) {
    if (ch in CN_DIGIT) cur = CN_DIGIT[ch];
    else if (ch === '十') (total += (cur || 1) * 10), (cur = 0);
    else if (ch === '百') (total += (cur || 1) * 100), (cur = 0);
  }
  return total + cur;
};

const EN_UNITS = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const EN_TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const ID_UNITS = { dua: 2, tiga: 3, empat: 4, lima: 5, enam: 6, tujuh: 7, delapan: 8, sembilan: 9, sepuluh: 10 };
const B = (words) => `(?<![\\p{L}\\p{N}])(?:${words.join('|')})(?![\\p{L}\\p{N}])`;
const EN_COMPOUND = new RegExp(`(?<![\\p{L}\\p{N}])(${Object.keys(EN_TENS).join('|')})(?:[- ]?(one|${Object.keys(EN_UNITS).slice(0, 8).join('|')}))?(?![\\p{L}\\p{N}])`, 'giu');
const EN_WORD = new RegExp(B(Object.keys(EN_UNITS)), 'giu');
// “one” 太常见（one charge / no one），只在直接跟着时间或长度单位时才算数字（one-year warranty）
const EN_ONE = /(?<![\p{L}\p{N}])one[- ](?:year|month|week|day|hour|minute|inch|foot|pound)s?(?![\p{L}\p{N}])/giu;
const ID_WORD = new RegExp(B(Object.keys(ID_UNITS)), 'giu');

/** 一个数字 token 转成数值：千分位（1,000 / 印尼语 2.000）去掉分隔符，其余的单个分隔符按小数点处理 */
function toNumber(raw) {
  if (/^\d{1,3}([.,]\d{3})+$/.test(raw)) return Number(raw.replace(/[.,]/g, ''));
  return Number(raw.replace(',', '.'));
}

// ---------- 单位 ----------
// 只识别公制/英制的长度、重量、容量、温度，用于判断“这是不是同一个数字的单位换算”。
// 其余单位（小时、mAh、W 等）不识别，unit 为 null。
const UNIT_TABLE = [
  ['mm', /毫米|mm/], ['cm', /厘米|公分|cm/], ['km', /公里|km/], ['m', /米|meters?|metres?|m/], ['kg', /公斤|千克|kg/], ['g', /克|g/],
  ['ml', /毫升|ml/], ['l', /升|liters?|litres?|l/], ['c', /摄氏度|°\s*c|℃/], ['f', /华氏度|°\s*f|℉/],
  ['in', /英寸|inch(?:es)?|in|"/], ['ft', /英尺|feet|foot|ft/], ['lb', /磅|pounds?|lbs?/], ['oz', /盎司|ounces?|oz/], ['floz', /fl\.?\s*oz/],
  ['gal', /加仑|gallons?|gal/], ['mi', /英里|miles?|mi/],
];
// 长的写法优先（fl oz 先于 oz，mm 先于 m），且单位后面不能紧跟字母（mAh 不是 m，mL 不是 m）
const UNIT_RE = new RegExp(`^\\s{0,2}(?:${UNIT_TABLE.map(([, re]) => `(${re.source})`).join('|')})(?![\\p{L}])`, 'iu');
function unitAfter(text, index) {
  const m = UNIT_RE.exec(text.slice(index));
  if (!m) return null;
  return UNIT_TABLE[m.slice(1).findIndex((g) => g !== undefined)][0];
}

/** 提取文本里的所有数字（阿拉伯数字、中文数字+量词、英文/印尼语数字词），返回 [{ value, unit }]，unit 是紧跟其后的可识别单位或 null */
export function numbersIn(text) {
  const t = norm(text);
  const out = [];
  const push = (value, end) => out.push({ value, unit: unitAfter(t, end) });
  for (const m of t.matchAll(/\d+(?:[.,]\d+)*/g)) push(toNumber(m[0]), m.index + m[0].length);
  // 单位检测的起点是数字之后、量词之前（“三米”的“米”本身就是单位，量词和单位重合时也要能识别到）
  for (const m of t.matchAll(CN_NUM)) if (!isGenericArticle(m[1], m[2])) push(cnToInt(m[1]), m.index + m[1].length);
  // 英文复合数字（twenty-four）先整体提取并抹掉，避免其中的 four 被再算一次
  const rest = t.replace(EN_COMPOUND, (m, tens, unit, i) => (push(EN_TENS[tens.toLowerCase()] + (unit ? EN_UNITS[unit.toLowerCase()] ?? 1 : 0), i + m.length), ' '.repeat(m.length)));
  for (const m of rest.matchAll(EN_WORD)) push(EN_UNITS[m[0].toLowerCase()], m.index + m[0].length);
  for (const m of rest.matchAll(EN_ONE)) push(1, m.index + m[0].length);
  for (const m of rest.matchAll(ID_WORD)) push(ID_UNITS[m[0].toLowerCase()], m.index + m[0].length);
  return out;
}

// ---------- 单位换算 ----------
// 中国卖家的规格是公制，英文站文案写英制是正常的（30cm → 11.8 inches），反过来印尼站要写回公制。
// 只有“事实里的单位 → 文案里的单位”是下表里的一对时才允许换算，并且四舍五入到 0/1/2 位小数能得到该数；
// 不看单位的话，事实里随便一个数字乘个系数就能撞上任何编造的数字。
const CONVERSIONS = {
  'cm>in': (x) => x * 0.3937008, 'mm>in': (x) => x * 0.03937008, 'm>ft': (x) => x * 3.28084, 'm>in': (x) => x * 39.37008, 'cm>ft': (x) => x * 0.0328084, 'km>mi': (x) => x * 0.621371,
  'kg>lb': (x) => x * 2.204623, 'g>oz': (x) => x * 0.03527396, 'g>lb': (x) => x * 0.0022046, 'kg>oz': (x) => x * 35.274,
  'ml>floz': (x) => x * 0.033814, 'l>gal': (x) => x * 0.2641721, 'l>floz': (x) => x * 33.814, 'c>f': (x) => (x * 9) / 5 + 32,
  'in>cm': (x) => x * 2.54, 'in>mm': (x) => x * 25.4, 'ft>m': (x) => x * 0.3048, 'ft>cm': (x) => x * 30.48, 'mi>km': (x) => x * 1.609344,
  'lb>kg': (x) => x * 0.4535924, 'oz>g': (x) => x * 28.34952, 'lb>g': (x) => x * 453.5924, 'floz>ml': (x) => x * 29.5735, 'gal>l': (x) => x * 3.785412, 'f>c': (x) => ((x - 32) * 5) / 9,
};
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

/** 数字 y（{ value, unit }）是否有依据：与支撑集合里某个数相等，或是它按“单位对”做的换算 */
export function isSupported(y, support) {
  for (const x of support) {
    if (x.value === y.value) return true;
    const conv = x.unit && y.unit ? CONVERSIONS[`${x.unit}>${y.unit}`] : null;
    if (conv && [0, 1, 2].some((d) => Math.abs(round(conv(x.value), d) - y.value) < 1e-9)) return true;
  }
  return false;
}

/** 一组事实（及可选的额外文本，如产品名）能支撑的数字集合 */
export function supportNumbers(facts, extraTexts = []) {
  const out = [];
  for (const f of facts) out.push(...numbersIn(f.evidence), ...numbersIn(f.statement));
  for (const t of extraTexts) if (t) out.push(...numbersIn(t));
  return out;
}

/** 文本中没有依据的数字值（去重） */
export function unsupportedNumbers(text, support) {
  return [...new Set(numbersIn(text).filter((y) => !isSupported(y, support)).map((y) => y.value))];
}

// ---------- 语言/字符 ----------

// 允许的文字系统：en、id 都是拉丁字母。µ μ Ω Ω 是单位符号（微米、欧姆），不算串味
const LATIN_MARKETS = new Set(['en', 'id']);
const UNIT_SYMBOLS = /[µμΩΩ]/u;
const FULLWIDTH = /[　-〿！-｠￠-￦]/u;

export const usesLatinOnly = (market) => LATIN_MARKETS.has(market.slice(0, 2));

/** 非拉丁字母（CJK 等），brandTexts 里出现的子串不算（如中文品牌名） */
export function foreignLetters(text, brandTexts = []) {
  let t = text;
  for (const b of brandTexts) if (b) t = t.split(b).join(' ');
  return [...t].filter((ch) => /\p{L}/u.test(ch) && !/\p{Script=Latin}/u.test(ch) && !UNIT_SYMBOLS.test(ch));
}
export const hasFullwidthPunctuation = (text) => FULLWIDTH.test(text);

// ---------- 路径 ----------

/** 按 “content/bullets/0/text” 这样的路径取值；取不到返回 undefined */
export function resolvePath(obj, path) {
  let cur = obj;
  for (const seg of path.split('/').filter(Boolean)) {
    if (cur === null || typeof cur !== 'object' || !(seg in cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

// ---------- 生成后检查 ----------

// promo（Shopee 促销标签）也算：库存、发货速度这类说法卖家没提供过就不能写
const ANCHORED_KINDS = new Set(['bullet', 'feature', 'highlights', 'highlight', 'promo']);

/**
 * 检查一份 Listing 的“有依据吗”，返回与合规规则引擎相同的 ComplianceReport 格式，
 * 第 6 步的修复循环可以把两份报告合并处理。
 * 只做确定性检查：结构与编号引用、卖点落在声明位置、数字有事实依据、没有外语字符串味、每行有声明依据。
 */
export function checkGrounding({ factSheet, listing }) {
  const issues = [];
  const add = (rule_id, severity, path, evidence, fix_hint) => issues.push({ rule_id, severity, path, evidence, fix_hint });
  const done = () => ({ passed: !issues.some((i) => i.severity === 'error'), rule_set_version: 'grounding@1', issues });

  const schema = validate('listing', listing);
  if (!schema.ok) {
    for (const e of schema.errors) add('ground.schema', 'error', '/', e, '按 Listing 契约修正结构');
    return done();
  }
  for (const e of checkReferences({ factSheet, listing })) add('ground.reference', 'error', '/', e, '只能引用事实表里存在的事实编号');

  const byId = new Map(factSheet.facts.map((f) => [f.id, f]));
  const factsOf = (ids) => ids.map((id) => byId.get(id)).filter(Boolean);
  const identity = [factSheet.product.name, factSheet.product.brand];
  const global = supportNumbers(factSheet.facts, identity);
  const clip = (s, n = 80) => (s.length > n ? `${s.slice(0, n)}…` : s);

  // 1. 卖点必须落在声明的位置，且是逐字出现
  if (!listing.claims.length) add('ground.no-claims', 'error', 'claims', '没有声明任何卖点依据', '为文案里每条卖点性陈述声明 claims（原文片段、所在位置、事实编号）');
  listing.claims.forEach((c, i) => {
    const where = `claims/${i}`;
    const value = resolvePath(listing, c.path);
    if (typeof value !== 'string') return add('ground.claim-path-missing', 'error', where, c.path, '卖点的 path 必须指向文案里真实存在的文本字段');
    if (!squash(value).includes(squash(c.text))) return add('ground.claim-text-not-at-path', 'error', where, clip(c.text), `卖点原文必须逐字出现在 ${c.path} 中`);
    const bad = unsupportedNumbers(c.text, supportNumbers(factsOf(c.fact_ids)));
    if (bad.length) add('ground.claim-number-unsupported', 'error', where, `${clip(c.text)}（${bad.join('、')}）`, '卖点里的数字必须出现在所引事实的原文依据中');
  });

  // 2. 结构化属性与买家问答：数字必须来自它所引用的事实
  listing.attributes.forEach((a, i) => {
    const bad = unsupportedNumbers(a.value, supportNumbers(factsOf(a.fact_ids)));
    if (bad.length) add('ground.attribute-number-unsupported', 'error', `attributes/${i}`, `${a.name}: ${a.value}（${bad.join('、')}）`, '属性值里的数字必须出现在所引事实的原文依据中');
  });
  listing.qa.forEach((q, i) => {
    const bad = unsupportedNumbers(q.answer, supportNumbers(factsOf(q.fact_ids)));
    if (bad.length) add('ground.qa-number-unsupported', 'error', `qa/${i}/answer`, `${clip(q.answer)}（${bad.join('、')}）`, '回答里的数字必须出现在所引事实的原文依据中');
  });

  // 3. 正文里出现的数字，至少要在事实表的某处有依据（防止正文夹带没人声明过的规格）
  const fields = extractFields(listing);
  for (const f of fields.filter((x) => x.kind !== 'attribute' && x.kind !== 'qa')) {
    const bad = unsupportedNumbers(f.text, global);
    if (bad.length) add('ground.text-number-unsupported', 'error', f.path, `${clip(f.text)}（${bad.join('、')}）`, '删除这个数字，或让卖家在产品资料里补充对应信息');
  }

  // 4. 文字系统：拉丁字母市场里不能出现中文等字符（漏译），全角标点给警告
  if (usesLatinOnly(listing.market)) {
    const all = [...fields, ...listing.qa.map((q, i) => ({ path: `qa/${i}/question`, text: q.question }))];
    for (const f of all) {
      const bad = foreignLetters(f.text, identity);
      if (bad.length) add('ground.foreign-script', 'error', f.path, [...new Set(bad)].slice(0, 10).join(''), `${listing.market} 文案里不能出现这些字符，请翻译成目标语言`);
      else if (hasFullwidthPunctuation(f.text)) add('ground.fullwidth-punctuation', 'warning', f.path, clip(f.text), '把全角标点改成目标语言的标点');
    }
  }

  // 5. 每条要点/卖点行都应有声明依据（没有的给警告，提示补 claims 或删掉这一行）
  const anchored = (groupPath) => listing.claims.some((c) => c.path === groupPath || c.path.startsWith(`${groupPath}/`));
  const seen = new Set();
  for (const f of fields.filter((x) => ANCHORED_KINDS.has(x.kind))) {
    if (seen.has(f.groupPath)) continue;
    seen.add(f.groupPath);
    if (!anchored(f.groupPath)) add('ground.line-without-claim', 'warning', f.groupPath, clip(f.text), '为这一行补充 claims 声明依据，没有依据的内容不要写');
  }
  return done();
}
