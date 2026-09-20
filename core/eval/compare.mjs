#!/usr/bin/env node
/**
 * 并排比较多次评测：node eval/compare.mjs <输出目录1> <输出目录2> ...
 * 缺失的用例（提取失败或未运行）按未通过计入，不会被悄悄忽略。
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreFactSheet } from './scorers.mjs';

const dirs = process.argv.slice(2);
if (!dirs.length) {
  console.error('用法：node eval/compare.mjs <输出目录1> <输出目录2> ...');
  process.exit(1);
}
const casesDir = fileURLToPath(new URL('./cases/', import.meta.url));
const cases = readdirSync(casesDir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(casesDir, f), 'utf-8')));
const pct = (x) => `${Math.round(x * 100)}%`;
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

const rows = dirs.map((dir) => {
  const metaPath = join(dir, 'meta.json');
  const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf-8')) : null;
  const scores = [];
  for (const c of cases) {
    const p = join(dir, c.id, 'fact-sheet.json');
    if (existsSync(p)) scores.push(scoreFactSheet(c, JSON.parse(readFileSync(p, 'utf-8'))));
  }
  const n = cases.length;
  const calls = meta ? Object.values(meta.cases).flatMap((v) => v.api || []) : [];
  const cfg = meta ? `${meta.prompt || '-'} / 思考${meta.thinking ?? '-'}${meta.effort && meta.effort !== 'default' ? ` / 强度${meta.effort}` : ''}` : '未知';
  return {
    dir,
    cfg,
    ok: `${scores.length}/${n}`,
    pass: pct(scores.filter((s) => s.passed).length / n),
    recall: scores.length ? pct(avg(scores.map((s) => s.recall))) : '—',
    fab: `${scores.filter((s) => s.fabricated.length).length}`,
    bait: `${scores.filter((s) => s.bait_asserted.length).length}`,
    unk: scores.length ? pct(avg(scores.map((s) => s.unknown_recall))) : '—',
    tries: meta ? avg(Object.values(meta.cases).map((v) => v.attempts)).toFixed(1) : '—',
    secs: meta ? avg(Object.values(meta.cases).map((v) => v.seconds)).toFixed(1) : '—',
    tokens: calls.length ? Math.round(avg(calls.map((c) => c.usage?.completion_tokens ?? 0))) : '—',
    reasoning: calls.length ? Math.round(avg(calls.map((c) => c.usage?.completion_tokens_details?.reasoning_tokens ?? 0))) : '—',
  };
});

console.log('| 评测 | 配置 | 成功出结果 | 事实表通过率 | 事实召回 | 有编造 | 夸大话当事实 | 缺失信息识别 | 平均尝试 | 平均秒数 | 平均输出token | 其中推理token |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.dir.split('/').pop()} | ${r.cfg} | ${r.ok} | ${r.pass} | ${r.recall} | ${r.fab} | ${r.bait} | ${r.unk} | ${r.tries} | ${r.secs} | ${r.tokens} | ${r.reasoning} |`);
