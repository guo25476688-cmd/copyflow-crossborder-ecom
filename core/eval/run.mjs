#!/usr/bin/env node
/**
 * 用法：node eval/run.mjs <输出目录>
 * 输出目录结构：
 *   <输出目录>/<用例id>/fact-sheet.json
 *   <输出目录>/<用例id>/listing-<平台>-<市场>.json   （可有多份）
 * 缺失的文件记为"缺失"，不会中断。打印 Markdown 报告，方便贴进文档对比不同版本。
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadCases, detectSet } from './cases-loader.mjs';
import { scoreFactSheet, scoreListing, aggregate } from './scorers.mjs';

const outDir = process.argv[2];
if (!outDir) {
  console.error('用法：node eval/run.mjs <输出目录>');
  process.exit(1);
}

const set = detectSet(outDir);
const cases = loadCases(set);

const pct = (x) => (x === null ? '—' : `${Math.round(x * 100)}%`);
const fsScores = [];
const lsScores = [];
const rows = [];
const details = [];

for (const c of cases) {
  const dir = join(outDir, c.id);
  const fsPath = join(dir, 'fact-sheet.json');
  if (!existsSync(fsPath)) {
    rows.push(`| ${c.id} | 缺失 | | | | | |`);
    continue;
  }
  const factSheet = JSON.parse(readFileSync(fsPath, 'utf-8'));
  const s = scoreFactSheet(c, factSheet);
  fsScores.push(s);

  const listingFiles = readdirSync(dir).filter((f) => f.startsWith('listing-') && f.endsWith('.json'));
  const listingResults = listingFiles.map((f) => ({
    file: f,
    ...scoreListing(c, factSheet, JSON.parse(readFileSync(join(dir, f), 'utf-8'))),
  }));
  listingResults.forEach((r) => lsScores.push(r));

  rows.push(
    `| ${c.id} | ${s.passed ? '✅' : '❌'} | ${pct(s.recall)} | ${s.fabricated.length} | ${s.bait_asserted.length} | ${pct(s.unknown_recall)} | ${listingResults.length ? `${listingResults.filter((r) => r.passed).length}/${listingResults.length}` : '—'} |`,
  );
  if (!s.passed) {
    const why = [
      !s.schema_ok && '结构不合法',
      s.missed.length && `漏提取：${s.missed.join('、')}`,
      s.fabricated.length && `编造：${s.fabricated.join('、')}`,
      s.bait_asserted.length && `把夸大话当事实：${s.bait_asserted.join('、')}`,
      s.unknown_recall < 1 && '未指出应补充的缺失信息',
    ].filter(Boolean);
    details.push(`- **${c.id}**：${why.join('；')}`);
  }
  listingResults.filter((r) => !r.passed).forEach((r) => details.push(`- **${c.id}/${r.file}**：${[...r.errors, ...r.leaks].join('；')}`));
}

const agg = aggregate(fsScores, lsScores);
console.log(`# 评测报告\n\n输出目录：\`${outDir}\`　用例集：${set}　用例数：${cases.length}（已评 ${agg.cases}）\n`);
console.log('| 用例 | 事实表通过 | 事实召回 | 编造 | 夸大话入事实 | 缺失信息识别 | 文案通过 |');
console.log('|---|---|---|---|---|---|---|');
console.log(rows.join('\n'));
console.log(`\n## 汇总\n`);
console.log(`- 事实表通过率：${pct(agg.factsheet_pass_rate)}`);
console.log(`- 平均事实召回：${pct(agg.mean_fact_recall)}`);
console.log(`- 出现编造的用例占比：${pct(agg.fabrication_case_rate)}`);
console.log(`- 夸大话被当作事实的用例占比：${pct(agg.bait_asserted_case_rate)}`);
console.log(`- 平均缺失信息识别率：${pct(agg.mean_unknown_recall)}`);
console.log(`- 文案通过率：${pct(agg.listing_pass_rate)}（共 ${agg.listings} 份）　正文泄漏率：${pct(agg.listing_leak_rate)}`);
if (details.length) console.log(`\n## 未通过详情\n\n${details.join('\n')}`);
