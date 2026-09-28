import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergeReports, checkListing, repairListing, isBetter } from '../src/repair.mjs';
import { runRules } from '../src/rules.mjs';
import { checkGrounding } from '../src/grounding.mjs';
import { validate } from '../src/validate.mjs';

const read = (p) => JSON.parse(readFileSync(new URL(`../examples/valid/${p}.json`, import.meta.url), 'utf-8'));
const factSheet = read('fact-sheet');
const validListing = () => structuredClone(read('listing-amazon'));

// 一份同时触发规则引擎（标题超长+促销语）与依据检查（数字无依据）两类问题的坏文案
function brokenListing() {
  const l = validListing();
  l.content.title += ' Free Shipping';
  l.content.bullets[1].text = 'The charging case extends total battery life to about 40 hours, so a full week of commuting needs far fewer charges.';
  l.claims[1].text = 'about 40 hours';
  return l;
}
const fixTitle = (l) => {
  l.content.title = l.content.title.replace(' Free Shipping', '');
  return l;
};
const fixBattery = (l) => {
  l.content.bullets[1].text = 'The charging case extends total battery life to about 30 hours, so a full week of commuting needs far fewer charges.';
  l.claims[1].text = 'about 30 hours';
  return l;
};
const errIds = (r) => r.issues.filter((i) => i.severity === 'error').map((i) => i.rule_id);

// ---------- mergeReports / checkListing ----------

test('mergeReports：passed 要求两者都通过，issues 拼接，version 用 + 连接', () => {
  const a = { passed: true, rule_set_version: 'amazon-us@2026-09-20', issues: [{ rule_id: 'a', severity: 'warning', path: 'x', evidence: 'e', fix_hint: 'f' }] };
  const b = { passed: false, rule_set_version: 'grounding@1', issues: [{ rule_id: 'b', severity: 'error', path: 'y', evidence: 'e', fix_hint: 'f' }] };
  const m = mergeReports(a, b);
  assert.equal(m.passed, false);
  assert.equal(m.rule_set_version, 'amazon-us@2026-09-20+grounding@1');
  assert.deepEqual(m.issues, [...a.issues, ...b.issues]);
  assert.deepEqual(validate('report', m), { ok: true, errors: [] });

  const bothOk = mergeReports({ ...a, issues: [] }, { ...b, passed: true, issues: [] });
  assert.equal(bothOk.passed, true);
});

test('checkListing：等价于分别跑规则引擎与依据检查后合并；合规样例零问题', () => {
  const l = brokenListing();
  const expected = mergeReports(runRules({ listing: l, factSheet }), checkGrounding({ factSheet, listing: l }));
  assert.deepEqual(checkListing({ listing: l, factSheet }), expected);
  assert.deepEqual(errIds(expected).sort(), ['amz.title.max-length', 'amz.title.promotional', 'ground.claim-number-unsupported', 'ground.text-number-unsupported'].sort());

  const clean = checkListing({ listing: validListing(), factSheet });
  assert.equal(clean.passed, true);
  assert.deepEqual(clean.issues, []);
});

// ---------- repairListing：已通过时不调用模型 ----------

test('已经通过（无 error）的文案：不调用模型，直接返回，attempts 为 0', async () => {
  const chat = async () => {
    throw new Error('不应该被调用');
  };
  const r = await repairListing({ listing: validListing(), factSheet, chat });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 0);
  assert.deepEqual(r.history, []);
  assert.equal(r.report.passed, true);
});

// ---------- 收敛 ----------

test('分两步收敛：第一次只修好规则引擎问题，第二次连依据问题一起修好', async () => {
  const calls = [];
  const chat = async (a) => {
    calls.push(a.user);
    return calls.length === 1 ? JSON.stringify(fixTitle(brokenListing())) : JSON.stringify(fixBattery(fixTitle(brokenListing())));
  };
  const r = await repairListing({ listing: brokenListing(), factSheet, chat });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 2);
  assert.deepEqual(r.report.issues, []);
  assert.equal(calls.length, 2);
  assert.match(calls[0], /amz\.title\.promotional/, '第一次的提示词要包含最初的问题清单');
  assert.match(calls[0], /amz\.title\.max-length/);
  assert.match(calls[0], /ground\.claim-number-unsupported/);
  assert.match(calls[1], /ground\.claim-number-unsupported/, '第二次的提示词只应包含还没修好的问题');
  assert.doesNotMatch(calls[1], /amz\.title\.promotional/, '已经修好的问题不应再出现在下一次的提示词里');
  assert.match(calls[0], /"F3"/, '提示词要包含事实表');
  assert.equal(r.history.length, 2);
  assert.deepEqual(r.history.map((h) => h.ok), [false, true]);
});

test('一次就修好：attempts 为 1', async () => {
  const chat = async () => JSON.stringify(fixBattery(fixTitle(brokenListing())));
  const r = await repairListing({ listing: brokenListing(), factSheet, chat });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 1);
});

// ---------- 不采纳变差的修复，但仍继续尝试 ----------

test('修复引入了新问题（比原来更差）：不采纳，基准不变，下一次仍基于原问题清单重试', async () => {
  let n = 0;
  const chat = async () => {
    n++;
    if (n === 1) {
      // 修好了标题问题，却在描述里新引入一个促销语，总 error 数没有减少（4 变成了 3，仍然更差或持平都不该被采纳——这里构造成不降反升的情况）
      const l = fixTitle(brokenListing());
      l.content.description += ' Free Shipping this week only.';
      return JSON.stringify(l);
    }
    return JSON.stringify(fixBattery(fixTitle(brokenListing())));
  };
  const r = await repairListing({ listing: brokenListing(), factSheet, chat });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 2);
  assert.equal(r.history[0].ok, false);
  assert.ok(!r.report.issues.some((i) => i.rule_id === 'amz.title.promotional'), '最终结果不应包含第一次尝试引入的新问题');
});

// ---------- 结构性错误：不合法 JSON、改了 platform/market、schema 不合法 ----------

test('输出不是合法 JSON：计入历史，基准不变，继续用同一份问题清单重试', async () => {
  let n = 0;
  const chat = async () => (++n === 1 ? 'not json at all' : JSON.stringify(fixBattery(fixTitle(brokenListing()))));
  const r = await repairListing({ listing: brokenListing(), factSheet, chat });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 2);
  assert.match(r.history[0].structuralErrors[0], /不是合法 JSON/);
});

test('模型擅自改了 market：视为结构错误，拒绝采纳', async () => {
  let n = 0;
  const chat = async () => {
    n++;
    const l = fixBattery(fixTitle(brokenListing()));
    if (n === 1) l.market = 'en-GB';
    return JSON.stringify(l);
  };
  const r = await repairListing({ listing: brokenListing(), factSheet, chat });
  assert.equal(r.attempts, 2);
  assert.match(r.history[0].structuralErrors.join('\n'), /market 不能从 en-US 改成 en-GB/);
  assert.equal(r.listing.market, 'en-US');
});

test('模型擅自改了 platform：视为结构错误，拒绝采纳', async () => {
  let n = 0;
  const chat = async () => {
    n++;
    const l = fixBattery(fixTitle(brokenListing()));
    if (n === 1) l.platform = 'tiktok'; // content 仍是 amazon 结构，schema 也会连带报错，但 platform 的提示必须出现
    return JSON.stringify(l);
  };
  const r = await repairListing({ listing: brokenListing(), factSheet, chat });
  assert.equal(r.attempts, 2);
  assert.match(r.history[0].structuralErrors.join('\n'), /platform 不能从 amazon 改成 tiktok/);
  assert.equal(r.listing.platform, 'amazon');
});

test('结构不合法的输出即使内容本身干净也不能被当作修好：会被当结构错误重试，不会提前判定通过', async () => {
  let n = 0;
  const chat = async () => {
    n++;
    if (n === 1) {
      const l = fixBattery(fixTitle(brokenListing()));
      l.not_a_real_field = 'x'; // 内容其实已经改干净了，但整体不是合法的 Listing（额外字段）
      return JSON.stringify(l);
    }
    return JSON.stringify(fixBattery(fixTitle(brokenListing())));
  };
  const r = await repairListing({ listing: brokenListing(), factSheet, chat });
  assert.equal(r.attempts, 2, '第一次必须被当结构错误拒绝，不能因为内容干净就提前通过');
  assert.match(r.history[0].structuralErrors.join('\n'), /结构不合法/);
  assert.equal(r.ok, true);
});

test('输出不符合 Listing 契约：视为结构错误', async () => {
  let n = 0;
  const chat = async () => {
    n++;
    const l = fixBattery(fixTitle(brokenListing()));
    if (n === 1) delete l.claims;
    return JSON.stringify(l);
  };
  const r = await repairListing({ listing: brokenListing(), factSheet, chat });
  assert.equal(r.attempts, 2);
  assert.match(r.history[0].structuralErrors.join('\n'), /结构不合法/);
});

// ---------- 模型调用失败：立即停止 ----------

test('模型调用失败：不再重试，直接返回目前最好的结果（也就是原始输入）', async () => {
  const l = brokenListing();
  const chat = async () => {
    throw new Error('网络错误');
  };
  const r = await repairListing({ listing: l, factSheet, chat, maxAttempts: 3 });
  assert.equal(r.ok, false);
  assert.equal(r.attempts, 1);
  assert.deepEqual(r.listing, l);
  assert.match(r.history[0].error, /模型调用失败：网络错误/);
});

// ---------- 达到上限仍未修好：返回目前最好的一版，不假装通过 ----------

test('达到 maxAttempts 仍未修好：ok 为 false，返回历史里最好的一版而不是最后一版', async () => {
  let n = 0;
  const chat = async () => {
    n++;
    if (n === 1) return JSON.stringify(fixTitle(brokenListing())); // 更好：4 个 error 变 2 个
    // 第二次刻意变差：撤销刚修好的标题问题，只剩依据问题也不修
    return JSON.stringify(brokenListing());
  };
  const r = await repairListing({ listing: brokenListing(), factSheet, chat, maxAttempts: 2 });
  assert.equal(r.ok, false);
  assert.equal(r.attempts, 2);
  assert.deepEqual(r.listing, fixTitle(brokenListing()), '应采纳第一次更好的结果，而不是第二次更差的结果');
  assert.equal(r.report.issues.filter((i) => i.severity === 'error').length, 2);
});

// ---------- isBetter：谁更好的判断标准 ----------

const report = (errors, warnings) => ({
  passed: errors === 0,
  rule_set_version: 'x',
  issues: [
    ...Array.from({ length: errors }, (_, i) => ({ rule_id: `e${i}`, severity: 'error', path: 'p', evidence: 'x', fix_hint: 'f' })),
    ...Array.from({ length: warnings }, (_, i) => ({ rule_id: `w${i}`, severity: 'warning', path: 'p', evidence: 'x', fix_hint: 'f' })),
  ],
});

test('isBetter：优先比较 error 数；error 一样多才比总问题数（含 warning）；完全一样不算更好', () => {
  assert.equal(isBetter(report(1, 0), report(0, 3)), false, 'error 更多，即使总问题更少，也不算更好');
  assert.equal(isBetter(report(0, 3), report(1, 0)), true, 'error 更少就算更好，即使总问题更多');
  assert.equal(isBetter(report(1, 1), report(1, 3)), true, 'error 数相同时，总问题少的更好');
  assert.equal(isBetter(report(1, 3), report(1, 1)), false);
  assert.equal(isBetter(report(1, 1), report(1, 1)), false, '完全一样不算更好');
});

test('端到端验证 isBetter 的效果：error 数相同但总问题（含 warning）更少的一版会被采纳为最终结果', async () => {
  const base = validListing();
  base.content.bullets[4].text = 'A wireless design made for commuting.'; // 制造一个 line-without-claim 警告
  const withWarning = () => structuredClone(base);
  const clean = () => validListing();
  let n = 0;
  const chat = async () => {
    n++;
    // 两次都不通过（都保留同一个数字错误，只是要修的 warning 数量不同）
    const l = n === 1 ? withWarning() : clean();
    l.content.bullets[1].text = 'The charging case extends total battery life to about 40 hours.';
    l.claims[1].text = 'about 40 hours';
    return JSON.stringify(l);
  };
  const r = await repairListing({ listing: brokenListing(), factSheet, chat, maxAttempts: 2 });
  assert.equal(r.ok, false);
  const finalHasLineWarning = r.report.issues.some((i) => i.rule_id === 'ground.line-without-claim');
  assert.equal(finalHasLineWarning, false, '第二次 error 数相同但少一个 warning，应被采纳');
});
