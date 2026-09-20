import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { scoreFactSheet, scoreListing, anyMatch } from '../eval/scorers.mjs';

const casesDir = new URL('../eval/cases/', import.meta.url);
const cases = readdirSync(casesDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(new URL(f, casesDir), 'utf-8')));
const fixture = (kind, id, file) => JSON.parse(readFileSync(new URL(`../eval/fixtures/${kind}/${id}/${file}`, import.meta.url), 'utf-8'));
const earbuds = cases.find((c) => c.id === 'earbuds-01');

// ---------- 用例自检：防止用例本身写错，导致评分失真 ----------

test('用例自检：数量、id 唯一、目标平台合法', () => {
  assert.equal(cases.length, 10);
  assert.equal(new Set(cases.map((c) => c.id)).size, cases.length);
  for (const c of cases) {
    assert.ok(c.input.length > 0, c.id);
    c.targets.platforms.forEach((p) => assert.ok(['amazon', 'shopee'].includes(p), c.id));
  }
});

test('用例自检：所有正则都能编译', () => {
  for (const c of cases) {
    const all = [...c.must_capture, ...c.traps.fabrication, ...c.traps.bait, ...c.traps.must_flag_unknown];
    for (const item of all) assert.ok(item.patterns.length > 0, `${c.id} 有条目没写 patterns`);
    for (const item of all) item.patterns.forEach((p) => assert.doesNotThrow(() => new RegExp(p, 'iu'), `${c.id}: ${p}`));
  }
});

test('用例自检：应提取的事实，输入里必须真的有', () => {
  for (const c of cases)
    for (const m of c.must_capture) assert.ok(anyMatch(m.patterns, c.input), `${c.id}/${m.id} 在输入里匹配不到`);
});

test('用例自检：编造陷阱与缺失信息，输入里必须真的没有（否则陷阱不成立）', () => {
  for (const c of cases) {
    for (const t of c.traps.fabrication) assert.ok(!anyMatch(t.patterns, c.input), `${c.id} 编造陷阱「${t.claim}」在输入里已存在`);
    for (const u of c.traps.must_flag_unknown) assert.ok(!anyMatch(u.patterns, c.input), `${c.id} 缺失项「${u.field}」在输入里其实有`);
  }
});

test('用例自检：夸大话必须原样出现在输入里，且检测规则能匹配到', () => {
  for (const c of cases)
    for (const b of c.traps.bait) {
      assert.ok(c.input.includes(b.input_phrase), `${c.id} 夸大话「${b.input_phrase}」不在输入里`);
      assert.ok(anyMatch(b.patterns, c.input), `${c.id} 夸大话检测规则匹配不到输入`);
    }
});

test('用例覆盖：包含高风险品类、信息很少、混杂格式、夸大话陷阱', () => {
  const tags = new Set(cases.flatMap((c) => c.tags));
  for (const t of ['high-risk-category', 'thin-input', 'messy', 'claim-bait', 'fabrication-trap']) assert.ok(tags.has(t), t);
});

// ---------- 评分函数自检：好的输出应满分，坏的输出应被抓出来 ----------

test('评分：好的事实表满分', () => {
  const s = scoreFactSheet(earbuds, fixture('good', 'earbuds-01', 'fact-sheet.json'));
  assert.equal(s.passed, true);
  assert.equal(s.recall, 1);
  assert.equal(s.bait_flagged, 1);
  assert.equal(s.unknown_recall, 1);
  assert.deepEqual(s.fabricated, []);
});

test('评分：坏的事实表被抓出编造、夸大话入事实、漏提取、漏指出缺失', () => {
  const s = scoreFactSheet(earbuds, fixture('bad', 'earbuds-01', 'fact-sheet.json'));
  assert.equal(s.passed, false);
  assert.ok(s.fabricated.some((x) => x.includes('CE')));
  assert.ok(s.bait_asserted.some((x) => x.includes('吊打')));
  assert.ok(s.missed.some((x) => x.includes('IPX5')));
  assert.equal(s.unknown_recall, 0);
});

test('评分：好的文案通过；正文里写了编造认证和竞品对比的文案被抓出', () => {
  const goodFs = fixture('good', 'earbuds-01', 'fact-sheet.json');
  assert.equal(scoreListing(earbuds, goodFs, fixture('good', 'earbuds-01', 'listing-amazon-en-US.json')).passed, true);
  assert.equal(scoreListing(earbuds, goodFs, fixture('good', 'earbuds-01', 'listing-shopee-id-ID.json')).passed, true);
  const bad = scoreListing(earbuds, goodFs, fixture('bad', 'earbuds-01', 'listing-amazon-en-US.json'));
  assert.equal(bad.passed, false);
  assert.ok(bad.leaks.some((x) => x.startsWith('编造')));
  assert.ok(bad.leaks.some((x) => x.startsWith('夸大')));
});

test('运行器：能对一个输出目录出报告，缺失用例不会中断', () => {
  const out = execFileSync('node', ['eval/run.mjs', 'eval/fixtures/good'], { encoding: 'utf-8' });
  assert.match(out, /earbuds-01 \| ✅/);
  assert.match(out, /desk-lamp-02 \| 缺失/);
  const bad = execFileSync('node', ['eval/run.mjs', 'eval/fixtures/bad'], { encoding: 'utf-8' });
  assert.match(bad, /earbuds-01 \| ❌/);
  assert.match(bad, /未通过详情/);
});
