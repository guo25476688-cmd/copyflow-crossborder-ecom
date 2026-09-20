import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validate, checkReferences, checkReport } from '../src/validate.mjs';

const read = (p) => JSON.parse(readFileSync(new URL(`../examples/${p}`, import.meta.url), 'utf-8'));

const factSheet = read('valid/fact-sheet.json');
const brief = read('valid/brief.json');
const amazon = read('valid/listing-amazon.json');
const shopee = read('valid/listing-shopee.json');
const report = read('valid/compliance-report.json');

test('有效样例：结构全部通过', () => {
  assert.deepEqual(validate('factSheet', factSheet), { ok: true, errors: [] });
  assert.deepEqual(validate('brief', brief), { ok: true, errors: [] });
  assert.deepEqual(validate('listing', amazon), { ok: true, errors: [] });
  assert.deepEqual(validate('listing', shopee), { ok: true, errors: [] });
  assert.deepEqual(validate('report', report), { ok: true, errors: [] });
});

test('有效样例：事实编号引用完整、报告自洽', () => {
  assert.deepEqual(checkReferences({ factSheet, brief, listing: amazon }), []);
  assert.deepEqual(checkReferences({ factSheet, brief, listing: shopee }), []);
  assert.deepEqual(checkReport(report), []);
});

test('卖点没有事实编号：结构校验直接拒绝（无依据的卖点无法被表达）', () => {
  const bad = read('invalid/listing-claim-without-fact-ids.json');
  const r = validate('listing', bad);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /claims\/0\/fact_ids/);
});

test('引用不存在的事实编号：结构合法，但引用完整性校验拒绝', () => {
  const bad = read('invalid/listing-unknown-fact-id.json');
  assert.equal(validate('listing', bad).ok, true);
  const errs = checkReferences({ factSheet, brief, listing: bad });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /F99/);
});

test('Amazon 只有 4 条 bullet：按平台结构拒绝', () => {
  const r = validate('listing', read('invalid/listing-amazon-4-bullets.json'));
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /bullets/);
});

test('合规报告 passed 与 error 级问题矛盾：一致性校验拒绝', () => {
  const errs = checkReport(read('invalid/report-passed-but-has-error.json'));
  assert.equal(errs.length, 1);
});

test('平台内容结构串台：shopee 的 content 用了 amazon 结构会被拒绝', () => {
  const wrong = structuredClone(shopee);
  wrong.content = structuredClone(amazon.content);
  assert.equal(validate('listing', wrong).ok, false);
});
