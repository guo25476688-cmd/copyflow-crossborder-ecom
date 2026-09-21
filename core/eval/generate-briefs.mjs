#!/usr/bin/env node
/**
 * 对一批已提取好的事实表生成创意简报，输出到 <输出目录>/<用例id>/brief.json。
 *
 * 用法：
 *   node eval/generate-briefs.mjs <输出目录> --from <事实表运行目录> [--markets en-US,id-ID] [--trends 趋势快照.json]
 *     [--cases id1,id2] [--thinking on|off] [--prompt b1] [--final]
 *
 * 事实表来自 eval/generate.mjs 的运行结果（<运行目录>/<用例id>/fact-sheet.json）。
 * 与事实提取相同的纪律：运行目录来自留出集时，必须加 --final，且只应在提示词定稿后跑一次。
 * 需要环境变量 DEEPSEEK_API_KEY（只读取，不会写入任何输出）。
 */
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createChat, getApiKey, DEFAULT_MODEL } from '../src/llm.mjs';
import { generateBrief, BRIEF_PROMPT_VERSIONS, LATEST_BRIEF_PROMPT } from '../src/brief.mjs';
import { validate } from '../src/validate.mjs';

const args = process.argv.slice(2);
const VALUE_OPTS = ['--from', '--markets', '--trends', '--cases', '--thinking', '--prompt'];
const outDir = args.find((a, i) => !a.startsWith('--') && !VALUE_OPTS.includes(args[i - 1]));
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const fail = (msg, code = 2) => {
  console.error(msg);
  process.exit(code);
};

const from = opt('from');
if (!outDir || !from) fail('用法：node eval/generate-briefs.mjs <输出目录> --from <事实表运行目录> [--markets en-US,id-ID] [--trends 快照.json] [--cases ...] [--thinking on|off]');
if (!existsSync(from)) fail(`找不到事实表运行目录：${from}`);

const apiKey = getApiKey();
if (!apiKey) fail('未检测到环境变量 DEEPSEEK_API_KEY。请在当前终端窗口里设置后再运行。', 1);

const markets = (opt('markets') || 'en-US,id-ID').split(',').filter(Boolean);
const thinking = opt('thinking') || 'off';
const promptVersion = opt('prompt') || LATEST_BRIEF_PROMPT;
if (!markets.length || !markets.every((m) => /^[a-z]{2}-[A-Z]{2}$/.test(m))) fail('--markets 需要形如 en-US,id-ID');
if (!['on', 'off'].includes(thinking) || !BRIEF_PROMPT_VERSIONS.includes(promptVersion)) fail(`参数不合法：--thinking 只能是 on/off，--prompt 只能是 ${BRIEF_PROMPT_VERSIONS.join('/')}`);

const fromMeta = existsSync(join(from, 'meta.json')) ? JSON.parse(readFileSync(join(from, 'meta.json'), 'utf-8')) : {};
if (fromMeta.set === 'holdout' && !args.includes('--final')) {
  fail('这个运行目录来自留出集：留出集只应在提示词定稿后跑一次，用来报告真实水平；反复跑并据此调提示词，它就失去留出的意义了。\n确认已定稿，请加上 --final 参数。');
}

let trends = null;
if (opt('trends')) {
  trends = JSON.parse(readFileSync(opt('trends'), 'utf-8'));
  const t = validate('trendSnapshot', trends);
  if (!t.ok) fail(`趋势快照不符合契约：\n${t.errors.join('\n')}`);
}

const only = opt('cases')?.split(',');
const ids = readdirSync(from, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(from, d.name, 'fact-sheet.json')) && (!only || only.includes(d.name)))
  .map((d) => d.name)
  .sort();
if (!ids.length) fail('运行目录里没有可用的 fact-sheet.json');

let apiLog = [];
const chat = createChat({ apiKey, thinking: thinking === 'off' ? 'disabled' : undefined, onResponse: (info) => apiLog.push(info) });
const meta = { from, markets, trends: opt('trends') || null, model: DEFAULT_MODEL, thinking, prompt: promptVersion, date: new Date().toISOString(), cases: {} };

for (const id of ids) {
  const factSheet = JSON.parse(readFileSync(join(from, id, 'fact-sheet.json'), 'utf-8'));
  const dir = join(outDir, id);
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  apiLog = [];
  const r = await generateBrief({ factSheet, markets, trends, chat, promptVersion });
  const seconds = Math.round((Date.now() - t0) / 100) / 10;
  meta.cases[id] = { ok: r.ok, attempts: r.attempts, seconds, errors: r.errors, api: apiLog };
  if (r.ok) writeFileSync(join(dir, 'brief.json'), JSON.stringify(r.brief, null, 2));
  if (r.attempts > 1 || !r.ok) writeFileSync(join(dir, 'attempts.json'), JSON.stringify(r.history, null, 2));
  const kw = r.ok ? r.brief.keywords : [];
  const fromTrend = kw.filter((k) => k.origin === 'trend_snapshot').length;
  console.log(`${r.ok ? '✅' : '❌'} ${id}  尝试 ${r.attempts} 次  ${seconds}s${r.ok ? `  角度 ${r.brief.angles.length}，关键词 ${kw.length}（取自趋势快照 ${fromTrend}）` : `  ${r.errors[0]}`}`);
}
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));
console.log(`\n已写入 ${outDir}`);
