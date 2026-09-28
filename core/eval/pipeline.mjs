#!/usr/bin/env node
/**
 * 单次跑通"卖家原始资料 → 事实表 → 创意简报"，供人工检查一条真实输入的完整效果，
 * 也是第 7 步最小界面的后端逻辑原型（界面本身还没做，这里先把链路走通）。
 *
 * 用法：
 *   node eval/pipeline.mjs <原始资料.txt> <输出目录> [--markets en-US,id-ID] [--trends 趋势快照.json]
 *     [--thinking on|off] [--effort low|high] [--prompt p4] [--brief-prompt b1]
 *
 * 事实表校验不过就停止，不会拿一份不可靠的事实表去生成简报。
 * 需要环境变量 DEEPSEEK_API_KEY（只读取，不会写入任何输出）。
 * 退出码：0 全部成功；1 事实提取失败；2 简报生成失败（事实表仍会写出）；3 参数、密钥或趋势快照问题。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createChat, getApiKey, DEFAULT_MODEL } from '../src/llm.mjs';
import { extractFactSheet, PROMPT_VERSIONS, LATEST_PROMPT } from '../src/fact-extraction.mjs';
import { generateBrief, BRIEF_PROMPT_VERSIONS, LATEST_BRIEF_PROMPT } from '../src/brief.mjs';
import { validate } from '../src/validate.mjs';

const args = process.argv.slice(2);
const VALUE_OPTS = ['--markets', '--trends', '--thinking', '--effort', '--prompt', '--brief-prompt'];
const positional = args.filter((a, i) => !a.startsWith('--') && !VALUE_OPTS.includes(args[i - 1]));
const [inputFile, outDir] = positional;
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const fail = (msg, code = 3) => {
  console.error(msg);
  process.exit(code);
};

if (!inputFile || !outDir) fail('用法：node eval/pipeline.mjs <原始资料.txt> <输出目录> [--markets en-US,id-ID] [--trends 快照.json] [--thinking on|off] [--effort low|high] [--prompt p4] [--brief-prompt b1]');

const apiKey = getApiKey();
if (!apiKey) fail('未检测到环境变量 DEEPSEEK_API_KEY。请在当前终端窗口里设置后再运行。');

let rawInput;
try {
  rawInput = readFileSync(inputFile, 'utf-8');
} catch (e) {
  fail(`读不到原始资料文件：${e.message}`);
}
if (!rawInput.trim()) fail('原始资料文件是空的');

const markets = (opt('markets') || 'en-US,id-ID').split(',').filter(Boolean);
if (!markets.length || !markets.every((m) => /^[a-z]{2}-[A-Z]{2}$/.test(m))) fail('--markets 需要形如 en-US,id-ID');

const thinking = opt('thinking') || 'on';
const effort = opt('effort');
const promptVersion = opt('prompt') || LATEST_PROMPT;
const briefPromptVersion = opt('brief-prompt') || LATEST_BRIEF_PROMPT;
if (!['on', 'off'].includes(thinking) || !PROMPT_VERSIONS.includes(promptVersion) || !BRIEF_PROMPT_VERSIONS.includes(briefPromptVersion) || (effort && !['low', 'high'].includes(effort))) {
  fail(`参数不合法：--thinking 只能是 on/off，--effort 只能是 low/high，--prompt 只能是 ${PROMPT_VERSIONS.join('/')}，--brief-prompt 只能是 ${BRIEF_PROMPT_VERSIONS.join('/')}`);
}

let trends = null;
if (opt('trends')) {
  try {
    trends = JSON.parse(readFileSync(opt('trends'), 'utf-8'));
  } catch (e) {
    fail(`读不到趋势快照：${e.message}`);
  }
  const t = validate('trendSnapshot', trends);
  if (!t.ok) fail(`趋势快照不符合契约：\n${t.errors.join('\n')}`);
}

mkdirSync(outDir, { recursive: true });
let apiLog = [];
const chat = createChat({ apiKey, thinking: thinking === 'off' ? 'disabled' : undefined, reasoningEffort: effort || undefined, onResponse: (info) => apiLog.push(info) });
const meta = { markets, trends: opt('trends') || null, model: DEFAULT_MODEL, thinking, effort: effort || 'default', prompt: promptVersion, briefPrompt: briefPromptVersion, date: new Date().toISOString() };

console.log('第一步：提取事实表…');
apiLog = [];
const fact = await extractFactSheet({ rawInput, chat, promptVersion });
meta.fact_extraction = { ok: fact.ok, attempts: fact.attempts, errors: fact.errors, api: apiLog };
if (fact.attempts > 1 || !fact.ok) writeFileSync(join(outDir, 'fact-extraction-attempts.json'), JSON.stringify(fact.history, null, 2));
if (!fact.ok) {
  writeFileSync(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));
  fail(`❌ 事实提取失败（尝试 ${fact.attempts} 次）：${fact.errors[0]}\n没有可靠的事实表，不生成简报。`, 1);
}
writeFileSync(join(outDir, 'fact-sheet.json'), JSON.stringify(fact.factSheet, null, 2));
console.log(`✅ 事实表  尝试 ${fact.attempts} 次，${fact.factSheet.facts.length} 条事实`);

console.log('第二步：生成创意简报…');
apiLog = [];
const brief = await generateBrief({ factSheet: fact.factSheet, markets, trends, chat, promptVersion: briefPromptVersion });
meta.brief_generation = { ok: brief.ok, attempts: brief.attempts, errors: brief.errors, api: apiLog };
writeFileSync(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));
if (brief.attempts > 1 || !brief.ok) writeFileSync(join(outDir, 'brief-attempts.json'), JSON.stringify(brief.history, null, 2));
if (!brief.ok) fail(`❌ 简报生成失败（尝试 ${brief.attempts} 次）：${brief.errors[0]}\n事实表已写出，简报未写出。`, 2);
writeFileSync(join(outDir, 'brief.json'), JSON.stringify(brief.brief, null, 2));
const fromTrend = brief.brief.keywords.filter((k) => k.origin === 'trend_snapshot').length;
console.log(`✅ 简报  尝试 ${brief.attempts} 次，角度 ${brief.brief.angles.length}，关键词 ${brief.brief.keywords.length}（取自趋势快照 ${fromTrend}）`);
console.log(`\n已写入 ${outDir}`);
