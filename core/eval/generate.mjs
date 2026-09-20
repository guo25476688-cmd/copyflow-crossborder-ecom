#!/usr/bin/env node
/**
 * 对黄金测试集批量提取事实表，输出到 <输出目录>/<用例id>/，再用 run.mjs 打分。
 *
 * 用法：
 *   node eval/generate.mjs <输出目录> [--cases id1,id2] [--model deepseek-flash] [--thinking on|off] [--effort low|high] [--prompt p2|p3]
 *   node eval/run.mjs <输出目录>
 *
 * 需要环境变量 DEEPSEEK_API_KEY（只读取，不会写入任何输出）。
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChat, getApiKey, DEFAULT_MODEL } from '../src/llm.mjs';
import { extractFactSheet, PROMPT_VERSIONS, LATEST_PROMPT } from '../src/fact-extraction.mjs';

const args = process.argv.slice(2);
const outDir = args.find((a) => !a.startsWith('--'));
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
if (!outDir) {
  console.error('用法：node eval/generate.mjs <输出目录> [--cases id1,id2] [--model 模型名]');
  process.exit(1);
}
const apiKey = getApiKey();
if (!apiKey) {
  console.error('未检测到环境变量 DEEPSEEK_API_KEY。请在当前终端窗口里设置后再运行（设置方法见对话说明）。');
  process.exit(1);
}

const model = opt('model') || DEFAULT_MODEL;
const thinking = opt('thinking') || 'on';
const effort = opt('effort');
const promptVersion = opt('prompt') || LATEST_PROMPT;
if (!['on', 'off'].includes(thinking) || !PROMPT_VERSIONS.includes(promptVersion) || (effort && !['low', 'high'].includes(effort))) {
  console.error(`参数不合法：--thinking 只能是 on/off，--effort 只能是 low/high，--prompt 只能是 ${PROMPT_VERSIONS.join('/')}`);
  process.exit(1);
}
const only = opt('cases')?.split(',');
const casesDir = fileURLToPath(new URL('./cases/', import.meta.url));
const cases = readdirSync(casesDir)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(casesDir, f), 'utf-8')))
  .filter((c) => !only || only.includes(c.id));

let apiLog = [];
const chat = createChat({ apiKey, model, thinking: thinking === 'off' ? 'disabled' : undefined, reasoningEffort: effort || undefined, onResponse: (info) => apiLog.push(info) });
const meta = { model, thinking, effort: effort || 'default', prompt: promptVersion, date: new Date().toISOString(), cases: {} };

for (const c of cases) {
  const dir = join(outDir, c.id);
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  apiLog = [];
  const r = await extractFactSheet({ rawInput: c.input, chat, promptVersion });
  meta.cases[c.id] = { ok: r.ok, attempts: r.attempts, seconds: Math.round((Date.now() - t0) / 100) / 10, errors: r.errors, api: apiLog };
  if (r.ok) writeFileSync(join(dir, 'fact-sheet.json'), JSON.stringify(r.factSheet, null, 2));
  if (r.attempts > 1 || !r.ok) writeFileSync(join(dir, 'attempts.json'), JSON.stringify(r.history, null, 2));
  console.log(`${r.ok ? '✅' : '❌'} ${c.id}  尝试 ${r.attempts} 次  ${meta.cases[c.id].seconds}s${r.ok ? '' : `  ${r.errors[0]}`}`);
}
writeFileSync(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));
console.log(`\n已写入 ${outDir}。接着运行：node eval/run.mjs ${outDir}`);
