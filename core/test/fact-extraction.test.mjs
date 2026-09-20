import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractFactSheet, checkEvidence, verifyFactSheet, buildExtractionPrompt, PROMPT_VERSIONS, LATEST_PROMPT } from '../src/fact-extraction.mjs';
import { createChat, getApiKey, parseJsonLoose } from '../src/llm.mjs';
import { loadCases } from '../eval/cases-loader.mjs';

const readJson = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf-8'));
const earbuds = readJson('../eval/cases/earbuds-01.json');
const good = readJson('../eval/fixtures/good/earbuds-01/fact-sheet.json');
const bad = readJson('../eval/fixtures/bad/earbuds-01/fact-sheet.json');
const input = earbuds.input;

/** 按顺序返回预设回答的假模型，并记录每次收到的 prompt */
const fakeChat = (...replies) => {
  const calls = [];
  const chat = async (req) => {
    calls.push(req);
    const r = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (r instanceof Error) throw r;
    return typeof r === 'string' ? r : JSON.stringify(r);
  };
  chat.calls = calls;
  return chat;
};

// ---------- 确定性防编造校验 ----------

test('好的事实表：通过全部校验（结构、编号引用、原文依据、数字一致）', () => {
  assert.deepEqual(verifyFactSheet(input, good), []);
});

test('编造的事实：依据在原文里找不到，被抓出', () => {
  const errs = checkEvidence(input, bad);
  assert.ok(errs.some((e) => e.includes('F4') && e.includes('找不到')), errs.join('\n'));
});

test('数字被篡改：陈述里的数字必须与依据一致', () => {
  const fs = structuredClone(good);
  fs.facts[2].statement = '含充电盒总续航约 50 小时';
  const errs = checkEvidence(input, fs);
  assert.ok(errs.some((e) => e.includes('F3') && e.includes('50')));
});

test('属性里的数字必须出现在所引事实的依据中', () => {
  const fs = structuredClone(good);
  fs.attributes[1].value = 'Up to 48 hours with charging case';
  const errs = checkEvidence(input, fs);
  assert.ok(errs.some((e) => e.includes('attributes[1]') && e.includes('48')));
});

test('品牌必须出现在原文里', () => {
  const fs = structuredClone(good);
  fs.product.brand = 'SoundMax';
  assert.ok(checkEvidence(input, fs).some((e) => e.includes('SoundMax')));
});

test('全半角与空白差异不误报：依据用半角括号、多余空格仍能匹配', () => {
  const fs = structuredClone(good);
  fs.facts[2].evidence = '续航30小时(含充电盒)';
  fs.facts[0].evidence = '蓝牙 5.3';
  assert.deepEqual(checkEvidence(input, fs), []);
});

test('source 不是 user_input 会被拒绝（当前只支持文字输入）', () => {
  const fs = structuredClone(good);
  fs.facts[0].source = 'url';
  assert.ok(checkEvidence(input, fs).some((e) => e.includes('user_input')));
});

// ---------- 提取流程：重试与失败 ----------

test('一次成功：只调用一次模型，prompt 里带原文', async () => {
  const chat = fakeChat(good);
  const r = await extractFactSheet({ rawInput: input, chat });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 1);
  assert.equal(chat.calls.length, 1);
  assert.ok(chat.calls[0].user.includes(input));
  assert.equal(chat.calls[0].temperature, 0);
  assert.equal(chat.calls[0].json, true);
});

test('编造被拦下后重试：第二次的 prompt 带着具体错误，最终成功', async () => {
  const chat = fakeChat(bad, good);
  const r = await extractFactSheet({ rawInput: input, chat });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 2);
  assert.match(chat.calls[1].user, /上一次的输出没有通过校验/);
  assert.match(chat.calls[1].user, /F4/);
});

test('输出不是合法 JSON：重试', async () => {
  const chat = fakeChat('这不是 JSON', '```json\n' + JSON.stringify(good) + '\n```');
  const r = await extractFactSheet({ rawInput: input, chat });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 2);
  assert.match(chat.calls[1].user, /不是合法 JSON/);
});

test('一直编造：用满次数后失败，返回错误而不抛异常', async () => {
  const chat = fakeChat(bad);
  const r = await extractFactSheet({ rawInput: input, chat, maxAttempts: 3 });
  assert.equal(r.ok, false);
  assert.equal(r.attempts, 3);
  assert.equal(chat.calls.length, 3);
  assert.ok(r.errors.length > 0);
});

test('模型调用本身失败：直接返回失败，不再空转重试', async () => {
  const chat = fakeChat(new Error('DeepSeek 401：invalid key'));
  const r = await extractFactSheet({ rawInput: input, chat });
  assert.equal(r.ok, false);
  assert.equal(chat.calls.length, 1);
  assert.match(r.errors[0], /模型调用失败/);
});

test('提示词包含关键铁律：逐字依据、不补充、夸大话进 forbidden_claims', () => {
  const { system } = buildExtractionPrompt('x');
  for (const s of ['一字不差', '绝不根据产品类型的常识', 'forbidden_claims', 'unknowns']) assert.ok(system.includes(s), s);
});

// ---------- DeepSeek 客户端（假 fetch，不联网） ----------

const okResponse = (content) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }), text: async () => '' });
const statusResponse = (status, body = '') => ({ ok: false, status, json: async () => ({}), text: async () => body });

test('客户端：请求格式正确（地址、模型、JSON 模式、鉴权头），返回模型文本', async () => {
  let seen;
  const chat = createChat({ apiKey: 'sk-test-SECRET', fetchImpl: async (url, init) => ((seen = { url, init }), okResponse('{"a":1}')) });
  assert.equal(await chat({ system: 's', user: 'u' }), '{"a":1}');
  assert.equal(seen.url, 'https://api.deepseek.com/chat/completions');
  const body = JSON.parse(seen.init.body);
  assert.equal(body.model, 'deepseek-flash');
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.temperature, 0);
  assert.equal(seen.init.headers.Authorization, 'Bearer sk-test-SECRET');
});

test('客户端：密钥错误（401）直接报错，错误信息里不含密钥', async () => {
  const chat = createChat({ apiKey: 'sk-test-SECRET', fetchImpl: async () => statusResponse(401, 'Authentication Fails'), retryDelayMs: 0 });
  await assert.rejects(chat({ system: 's', user: 'u' }), (e) => e.message.includes('401') && !e.message.includes('sk-test-SECRET'));
});

test('客户端：429/5xx/空内容会重试，成功即返回；用尽重试才失败', async () => {
  let n = 0;
  const flaky = createChat({ apiKey: 'k', retryDelayMs: 0, fetchImpl: async () => [statusResponse(500), okResponse(''), okResponse('ok')][n++] });
  assert.equal(await flaky({ system: 's', user: 'u' }), 'ok');
  assert.equal(n, 3);

  const dead = createChat({ apiKey: 'k', retryDelayMs: 0, retries: 1, fetchImpl: async () => statusResponse(503) });
  await assert.rejects(dead({ system: 's', user: 'u' }), /503/);
});

test('客户端：没有密钥时拒绝创建；密钥只从环境变量读取', () => {
  assert.throws(() => createChat({}), /DEEPSEEK_API_KEY/);
  assert.equal(getApiKey({}), null);
  assert.equal(getApiKey({ DEEPSEEK_API_KEY: 'abc' }), 'abc');
});

test('parseJsonLoose：兼容代码块包裹', () => {
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
});

test('重试记录：history 保留每次被拒的原因，成功的那次错误为空', async () => {
  const r = await extractFactSheet({ rawInput: input, chat: fakeChat(bad, '这不是 JSON', good) });
  assert.equal(r.attempts, 3);
  assert.equal(r.history.length, 3);
  assert.ok(r.history[0].errors.some((e) => e.includes('F4')));
  assert.match(r.history[1].errors[0], /不是合法 JSON/);
  assert.deepEqual(r.history[2].errors, []);
});

test('客户端：空内容的错误里带诊断信息；onResponse 收到结束原因与用量（不含密钥）', async () => {
  const seen = [];
  const empty = { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '' }, finish_reason: 'stop' }], usage: { completion_tokens: 4096 } }), text: async () => '' };
  const chat = createChat({ apiKey: 'sk-test-SECRET', retryDelayMs: 0, retries: 0, fetchImpl: async () => empty, onResponse: (i) => seen.push(i) });
  await assert.rejects(chat({ system: 's', user: 'u' }), (e) => /finish_reason=stop/.test(e.message) && /4096/.test(e.message) && !e.message.includes('sk-test-SECRET'));
  assert.deepEqual(seen, [{ finish_reason: 'stop', usage: { completion_tokens: 4096 }, content_length: 0 }]);
});

test('客户端：输出上限随思考开关调整；reasoning_effort 只在设置时写入', async () => {
  const bodies = [];
  const mk = (opts) => createChat({ apiKey: 'k', ...opts, fetchImpl: async (_u, init) => (bodies.push(JSON.parse(init.body)), okResponse('{}')) });
  await mk({})({ system: 's', user: 'u' });
  await mk({ thinking: 'disabled' })({ system: 's', user: 'u' });
  await mk({ reasoningEffort: 'low' })({ system: 's', user: 'u' });
  assert.equal(bodies[0].max_tokens, 8192);
  assert.equal(bodies[1].max_tokens, 2048);
  assert.equal('reasoning_effort' in bodies[0], false);
  assert.equal(bodies[2].reasoning_effort, 'low');
});

test('客户端：被截断且无内容时立即报错，不原样重试', async () => {
  let calls = 0;
  const truncated = { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '' }, finish_reason: 'length' }], usage: { completion_tokens: 8192 } }), text: async () => '' };
  const chat = createChat({ apiKey: 'k', retryDelayMs: 0, retries: 2, fetchImpl: async () => (calls++, truncated) });
  await assert.rejects(chat({ system: 's', user: 'u' }), /输出被截断/);
  assert.equal(calls, 1);
});

test('提示词：认证与检测证明必须进 unknowns；要求严格合法 JSON', () => {
  const { system } = buildExtractionPrompt('x');
  assert.match(system, /认证与检测证明[^。]*必须出现在 unknowns/);
  assert.match(system, /严格合法的 JSON/);
});

test('客户端：thinking 选项只在设置时才写入请求；默认不写（沿用服务端默认）', async () => {
  const bodies = [];
  const mk = (thinking) => createChat({ apiKey: 'k', thinking, fetchImpl: async (_u, init) => (bodies.push(JSON.parse(init.body)), okResponse('{}')) });
  await mk(undefined)({ system: 's', user: 'u' });
  await mk('disabled')({ system: 's', user: 'u' });
  assert.equal('thinking' in bodies[0], false);
  assert.deepEqual(bodies[1].thinking, { type: 'disabled' });
});

test('提示词版本：各版本只在第 3 条规则上不同，默认用最新版，未知版本报错', () => {
  assert.deepEqual(PROMPT_VERSIONS, ['p2', 'p3', 'p4']);
  assert.equal(LATEST_PROMPT, 'p4');
  const [p2, p3, p4] = ['p2', 'p3', 'p4'].map((v) => buildExtractionPrompt('x', v).system);
  assert.equal(buildExtractionPrompt('x').system, p4);
  const rule3Line = (t) => t.split('\n').find((l) => l.startsWith('3.'));
  const strip = (t) => t.split('\n').filter((l) => !l.startsWith('3.') && !l.startsWith('但卖家写明')).join('\n');
  assert.equal(strip(p3), strip(p2), 'p3 除第 3 条外应与 p2 一致');
  assert.equal(strip(p4), strip(p2), 'p4 除第 3 条外应与 p2 一致');
  assert.ok(rule3Line(p3).includes('整句都不是事实'));
  assert.throws(() => buildExtractionPrompt('x', 'p9'), /未知提示词版本/);
});

test('p4 同时包含两条相反方向的指引：模糊说法整句不算事实；具体规格记为事实并追问依据', () => {
  const p4 = buildExtractionPrompt('x', 'p4').system;
  assert.match(p4, /"无毒无味""绝对环保"/);
  assert.match(p4, /整句都不是事实/);
  assert.match(p4, /"防摔 1\.5 米""不含 BPA"/);
  assert.ok(!/150\s*kg|3\s*岁/.test(p4), '提示词例子不能含留出集探针');
  assert.match(p4, /要记为事实/);
  assert.match(p4, /在 unknowns 里追问依据/);
});

test('extractFactSheet 会按指定版本发送提示词', async () => {
  const chat = fakeChat(good);
  await extractFactSheet({ rawInput: input, chat, promptVersion: 'p2' });
  assert.equal(chat.calls[0].system, buildExtractionPrompt(input, 'p2').system);
});

test('防泄漏：提示词的任何版本都不得包含留出集用例输入里的片段（否则留出集失去意义）', () => {
  const squash = (t) => t.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  const prompts = PROMPT_VERSIONS.map((v) => squash(buildExtractionPrompt('', v).system));
  for (const c of loadCases('holdout')) {
    const fragments = c.input.split(/[，。、；,.;\s（）()]+/).map(squash).filter((f) => f.length >= 3);
    for (const f of fragments) {
      for (const p of prompts) assert.ok(!p.includes(f), `提示词包含了留出用例 ${c.id} 的输入片段「${f}」`);
    }
  }
});
