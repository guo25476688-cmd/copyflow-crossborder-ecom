#!/usr/bin/env node
/**
 * 生成今日趋势词快照：Tavily 搜公开网页 → DeepSeek 摘录词 → 逐词做原文校验 → 写入 JSON。
 *
 * 用法：
 *   node trends/snapshot.mjs <输出目录> [--markets en-US,id-ID] [--categories id1,id2] [--dry-run]
 *
 * 需要环境变量 TAVILY_API_KEY 与 DEEPSEEK_API_KEY（只读取，不会写入任何输出）。
 * --dry-run 只打印计划的搜索次数，不需要密钥、不发请求。
 * 退出码：0 全部类目成功；1 有类目失败（快照照常写出）；2 参数或密钥问题。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createChat, getApiKey, DEFAULT_MODEL } from '../src/llm.mjs';
import { createTavily, getTavilyKey } from '../src/tavily.mjs';
import { loadTrendConfig, buildSnapshot, plannedSearches } from '../src/trends.mjs';
import { validate } from '../src/validate.mjs';

const args = process.argv.slice(2);
const VALUE_OPTS = ['--markets', '--categories'];
const outDir = args.find((a, i) => !a.startsWith('--') && !VALUE_OPTS.includes(args[i - 1]));
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const list = (name) => opt(name)?.split(',').filter(Boolean);

const config = loadTrendConfig();
const only = { markets: list('markets'), categories: list('categories') };
const knownMarkets = config.markets.map((m) => m.market);
const knownCategories = config.markets.flatMap((m) => m.categories.map((c) => c.id));
const unknown = [...(only.markets || []).filter((x) => !knownMarkets.includes(x)), ...(only.categories || []).filter((x) => !knownCategories.includes(x))];
if (unknown.length) {
  console.error(`未知的市场或类目：${unknown.join('、')}。可选市场：${knownMarkets.join('、')}；可选类目：${knownCategories.join('、')}`);
  process.exit(2);
}

const planned = plannedSearches(config, only);
if (args.includes('--dry-run')) {
  console.log(`计划搜索 ${planned} 次（basic 深度，每次 1 点数）。每天一次约每月 ${planned * 30} 点数，Tavily 免费额度为 1000 点数/月。`);
  process.exit(0);
}
if (!outDir) {
  console.error('用法：node trends/snapshot.mjs <输出目录> [--markets ...] [--categories ...] [--dry-run]');
  process.exit(2);
}
const tavilyKey = getTavilyKey();
const deepseekKey = getApiKey();
if (!tavilyKey || !deepseekKey) {
  console.error(`未检测到环境变量 ${[!tavilyKey && 'TAVILY_API_KEY', !deepseekKey && 'DEEPSEEK_API_KEY'].filter(Boolean).join('、')}。请在当前终端设置后再运行。`);
  process.exit(2);
}

const date = new Date().toISOString().slice(0, 10);
const search = createTavily({ apiKey: tavilyKey });
// 摘录是抽取任务，且结果有确定性校验兜底，关闭思考省 token
const chat = createChat({ apiKey: deepseekKey, thinking: 'disabled' });

console.log(`开始生成 ${date} 的趋势词快照，计划搜索 ${planned} 次…`);
const snapshot = await buildSnapshot({ config, search, chat, model: DEFAULT_MODEL, date, only });

const check = validate('trendSnapshot', snapshot);
if (!check.ok) {
  console.error(`快照不符合契约，未写入：\n${check.errors.join('\n')}`);
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
const json = JSON.stringify(snapshot, null, 2);
writeFileSync(join(outDir, `${date}.json`), json);
writeFileSync(join(outDir, 'latest.json'), json);

let failed = 0;
for (const m of snapshot.markets) {
  for (const c of m.categories) {
    if (c.status === 'failed') failed++;
    const mark = { ok: '✅', no_results: '⚪', failed: '❌' }[c.status];
    const stated = c.terms.filter((t) => t.signal === 'stated_trending').length;
    const dropped = Object.entries(c.rejected_reasons).map(([why, n]) => `${why}×${n}`).join('、');
    console.log(`${mark} ${m.market} ${c.id}  来源 ${c.sources_seen} 条，词 ${c.terms.length} 个（来源自称流行 ${stated} 个）${c.rejected_terms ? `，丢弃 ${c.rejected_terms} 个：${dropped}` : ''}${c.error ? `  ${c.error}` : ''}`);
  }
}
console.log(`\n实际搜索 ${snapshot.searches} 次。已写入 ${join(outDir, `${date}.json`)} 与 latest.json`);
process.exit(failed ? 1 : 0);
