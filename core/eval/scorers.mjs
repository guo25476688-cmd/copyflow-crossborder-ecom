import { validate, checkReferences } from '../src/validate.mjs';

// 全部是确定性的正则/关键词判断，比较粗糙：只能抓"明显编造"和"明显泄漏"。
// 语义层面（措辞变化后的夸大、事实是否被曲解）留给第 6 步的评审环节。

const compile = (patterns) => patterns.map((p) => new RegExp(p, 'iu'));
export const anyMatch = (patterns, text) => compile(patterns).some((r) => r.test(text));

const factText = (fs) =>
  [...fs.facts.map((f) => f.statement), ...fs.attributes.map((a) => `${a.name} ${a.value}`)].join('\n');

/** 评事实表：提取得全不全、有没有编造、有没有把夸大话当事实、缺失信息有没有被指出 */
export function scoreFactSheet(c, factSheet) {
  const schema = validate('factSheet', factSheet);
  const refErrors = schema.ok ? checkReferences({ factSheet }) : [];
  const facts = schema.ok ? factText(factSheet) : '';
  const forbidden = schema.ok ? factSheet.forbidden_claims.map((x) => `${x.claim} ${x.reason}`).join('\n') : '';
  const unknowns = schema.ok ? factSheet.unknowns.map((u) => `${u.field} ${u.why_needed}`).join('\n') : '';

  // 召回额外看 evidence：它是原文逐字摘录，模型改写陈述（"蓝牙版本为5.3"）时不该被判漏提取；
  // 查编造与夸大话则不看 evidence，只看模型自己写的陈述与属性
  const evidence = schema.ok ? factSheet.facts.map((f) => f.evidence).join('\n') : '';
  const captured = c.must_capture.filter((m) => anyMatch(m.patterns, `${facts}\n${evidence}`));
  const fabricated = c.traps.fabrication.filter((t) => anyMatch(t.patterns, facts)).map((t) => t.claim);
  const baitAsserted = c.traps.bait.filter((t) => anyMatch(t.patterns, facts)).map((t) => t.input_phrase);
  const baitFlagged = c.traps.bait.filter((t) => anyMatch(t.patterns, forbidden));
  const unknownFound = c.traps.must_flag_unknown.filter((u) => anyMatch(u.patterns, unknowns));

  const ratio = (n, d) => (d === 0 ? 1 : n / d);
  const m = {
    schema_ok: schema.ok && refErrors.length === 0,
    recall: ratio(captured.length, c.must_capture.length),
    fabricated,
    bait_asserted: baitAsserted,
    bait_flagged: ratio(baitFlagged.length, c.traps.bait.length),
    unknown_recall: ratio(unknownFound.length, c.traps.must_flag_unknown.length),
    missed: c.must_capture.filter((x) => !captured.includes(x)).map((x) => x.statement),
  };
  m.passed = m.schema_ok && m.recall === 1 && !fabricated.length && !baitAsserted.length && m.unknown_recall === 1;
  return m;
}

/** 评文案：结构是否合法、引用是否完整、有没有把编造内容或夸大话写进正文 */
export function scoreListing(c, factSheet, listing) {
  const schema = validate('listing', listing);
  const refErrors = schema.ok ? checkReferences({ factSheet, listing }) : [];
  const text = schema.ok
    ? [JSON.stringify(listing.content), ...listing.attributes.map((a) => `${a.name} ${a.value}`), ...listing.qa.map((q) => q.answer)].join('\n')
    : '';
  const leaks = [
    ...c.traps.fabrication.filter((t) => anyMatch(t.patterns, text)).map((t) => `编造：${t.claim}`),
    ...c.traps.bait.filter((t) => anyMatch(t.patterns, text)).map((t) => `夸大：${t.input_phrase}`),
  ];
  return {
    schema_ok: schema.ok && refErrors.length === 0,
    errors: [...schema.errors, ...refErrors],
    leaks,
    passed: schema.ok && refErrors.length === 0 && leaks.length === 0,
  };
}

/** 汇总多个用例的结果 */
export function aggregate(factSheetScores, listingScores) {
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const fs = factSheetScores;
  const ls = listingScores;
  return {
    cases: fs.length,
    factsheet_pass_rate: fs.length ? fs.filter((s) => s.passed).length / fs.length : null,
    mean_fact_recall: mean(fs.map((s) => s.recall)),
    fabrication_case_rate: fs.length ? fs.filter((s) => s.fabricated.length).length / fs.length : null,
    bait_asserted_case_rate: fs.length ? fs.filter((s) => s.bait_asserted.length).length / fs.length : null,
    mean_unknown_recall: mean(fs.map((s) => s.unknown_recall)),
    listings: ls.length,
    listing_pass_rate: ls.length ? ls.filter((s) => s.passed).length / ls.length : null,
    listing_leak_rate: ls.length ? ls.filter((s) => s.leaks.length).length / ls.length : null,
  };
}
