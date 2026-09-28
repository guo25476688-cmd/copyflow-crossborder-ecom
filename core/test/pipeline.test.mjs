import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../src/validate.mjs';

const read = (p) => JSON.parse(readFileSync(new URL(`../examples/valid/${p}.json`, import.meta.url), 'utf-8'));
const goodFactSheet = () => JSON.stringify(read('fact-sheet'));
const goodBrief = () => JSON.stringify(read('brief'));

const run = promisify(execFile);
const coreDir = fileURLToPath(new URL('..', import.meta.url));
const cli = (args, env) =>
  run('node', ['eval/pipeline.mjs', ...args], { cwd: coreDir, env: { ...process.env, DEEPSEEK_API_KEY: 'sk-test-key', ...env } }).then(
    (r) => ({ code: 0, ...r }),
    (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }),
  );

/** 本地假 DeepSeek：按系统提示词里的角色标记区分是事实提取还是简报请求，各自独立可配置行为 */
async function withMockApi({ factReply = () => goodFactSheet(), briefReply = () => goodBrief() } = {}, fn) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      requests.push({ auth: req.headers.authorization, body: parsed });
      const system = parsed.messages[0].content;
      const isFact = system.includes('产品事实提取员');
      const isBrief = system.includes('创意策划');
      const content = isFact ? factReply() : isBrief ? briefReply() : (() => { throw new Error('未知的系统提示词'); })();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { completion_tokens: 100 } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn({ env: { COPYFLOW_TEST_API_URL: `http://127.0.0.1:${server.address().port}/chat/completions` }, requests });
  } finally {
    server.close();
  }
}

function makeInput() {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-in-'));
  const file = join(dir, 'raw.txt');
  writeFileSync(file, 'HoverGo Pro 无线蓝牙耳机，蓝牙5.3，主动降噪，续航30小时（含充电盒），IPX5防水');
  return file;
}
const outDir = () => mkdtempSync(join(tmpdir(), 'pipeline-out-'));

// examples/valid/brief.json 里有一条 origin=trend_snapshot 的关键词（"wireless earbuds"，en-US），
// 校验时必须能在趋势快照里逐字找到，所以凡是用 goodBrief() 的测试都要提供这份匹配的快照
function makeTrends() {
  const file = join(mkdtempSync(join(tmpdir(), 'pipeline-in-')), 'snapshot.json');
  writeFileSync(
    file,
    JSON.stringify({
      date: '2026-09-21', generated_at: '2026-09-21T01:00:00.000Z', label: '趋势词快照',
      note: '仅表示这些词在近期公开网页的搜索结果中出现过，不代表搜索量、销量或增长趋势；使用前请自行判断。',
      provider: { search: 'tavily', model: 'm' }, searches: 1,
      markets: [{ market: 'en-US', categories: [{ id: 'c', name: 'C', status: 'ok', sources_seen: 1, rejected_terms: 0, rejected_reasons: {}, terms: [{ term: 'wireless earbuds', evidence: 'the best wireless earbuds', signal: 'mentioned', source_url: 'https://a.example/1', source_title: 't' }] }] }],
    }),
  );
  return file;
}

// ---------- 端到端成功 ----------

test('端到端成功：依次写出事实表与简报，退出码 0，控制台报告两步结果，输出里没有密钥', async () => {
  await withMockApi({}, async ({ env, requests }) => {
    const out = outDir();
    const r = await cli([makeInput(), out, '--trends', makeTrends()], env);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /✅ 事实表.*4 条事实/);
    assert.match(r.stdout, /✅ 简报.*角度 3，关键词 \d+/);

    const factSheet = JSON.parse(readFileSync(join(out, 'fact-sheet.json'), 'utf-8'));
    assert.deepEqual(validate('factSheet', factSheet), { ok: true, errors: [] });
    const brief = JSON.parse(readFileSync(join(out, 'brief.json'), 'utf-8'));
    assert.deepEqual(validate('brief', brief), { ok: true, errors: [] });
    const meta = JSON.parse(readFileSync(join(out, 'meta.json'), 'utf-8'));
    assert.equal(meta.fact_extraction.ok, true);
    assert.equal(meta.brief_generation.ok, true);

    assert.equal(requests.length, 2, '先提取事实表，再生成简报，一共两次调用');
    assert.equal(requests[0].auth, 'Bearer sk-test-key');
    for (const f of ['fact-sheet.json', 'brief.json', 'meta.json']) assert.ok(!readFileSync(join(out, f), 'utf-8').includes('sk-test-key'));
    assert.ok(!r.stdout.includes('sk-test-key') && !r.stderr.includes('sk-test-key'));
    assert.ok(!existsSync(join(out, 'fact-extraction-attempts.json')), '一次通过不写尝试记录');
    assert.ok(!existsSync(join(out, 'brief-attempts.json')));
  });
});

// ---------- 事实提取失败：不生成简报 ----------

test('事实提取失败：不写事实表，不调用简报接口，退出码 1，写出尝试记录', async () => {
  await withMockApi({ factReply: () => 'not json at all' }, async ({ env, requests }) => {
    const out = outDir();
    const r = await cli([makeInput(), out], env);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /事实提取失败/);
    assert.ok(!existsSync(join(out, 'fact-sheet.json')));
    assert.ok(!existsSync(join(out, 'brief.json')));
    assert.ok(existsSync(join(out, 'fact-extraction-attempts.json')));
    assert.equal(requests.length, 3, '重试到用尽 3 次');
    assert.ok(requests.every((req) => req.body.messages[0].content.includes('产品事实提取员')), '不应该出现过任何简报请求');
    const meta = JSON.parse(readFileSync(join(out, 'meta.json'), 'utf-8'));
    assert.equal(meta.fact_extraction.ok, false);
    assert.ok(!('brief_generation' in meta), '没跑到这一步就不该出现在 meta 里');
  });
});

// ---------- 简报生成失败：事实表仍保留 ----------

test('事实提取成功但简报失败：事实表照常写出，简报不写出，退出码 2', async () => {
  await withMockApi({ briefReply: () => 'not json at all' }, async ({ env, requests }) => {
    const out = outDir();
    const r = await cli([makeInput(), out], env);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /简报生成失败/);
    assert.ok(existsSync(join(out, 'fact-sheet.json')));
    assert.ok(!existsSync(join(out, 'brief.json')));
    assert.ok(existsSync(join(out, 'brief-attempts.json')));
    assert.equal(requests.filter((req) => req.body.messages[0].content.includes('产品事实提取员')).length, 1);
    assert.equal(requests.filter((req) => req.body.messages[0].content.includes('创意策划')).length, 3);
    const meta = JSON.parse(readFileSync(join(out, 'meta.json'), 'utf-8'));
    assert.equal(meta.fact_extraction.ok, true);
    assert.equal(meta.brief_generation.ok, false);
  });
});

// ---------- 参数、密钥、趋势快照 ----------

test('缺密钥、缺参数、找不到输入文件、输入为空、非法市场：退出码都是 3，且不发请求', async () => {
  const noCallEnv = { COPYFLOW_TEST_API_URL: 'http://127.0.0.1:1/should-not-be-called' };
  assert.equal((await cli([makeInput(), outDir()], { DEEPSEEK_API_KEY: '' })).code, 3);
  assert.equal((await cli([makeInput()])).code, 3, '缺输出目录');
  assert.equal((await cli([join(tmpdir(), 'does-not-exist.txt'), outDir()], noCallEnv)).code, 3);
  const emptyFile = join(mkdtempSync(join(tmpdir(), 'pipeline-in-')), 'empty.txt');
  writeFileSync(emptyFile, '   ');
  assert.equal((await cli([emptyFile, outDir()], noCallEnv)).code, 3);
  assert.equal((await cli([makeInput(), outDir(), '--markets', 'english'], noCallEnv)).code, 3);
  assert.equal((await cli([makeInput(), outDir(), '--thinking', 'maybe'], noCallEnv)).code, 3);
  assert.equal((await cli([makeInput(), outDir(), '--prompt', 'p99'], noCallEnv)).code, 3);
  assert.equal((await cli([makeInput(), outDir(), '--brief-prompt', 'b99'], noCallEnv)).code, 3);
});

test('趋势快照文件读不到或不符合契约：退出码 3，不发请求', async () => {
  const noCallEnv = { COPYFLOW_TEST_API_URL: 'http://127.0.0.1:1/should-not-be-called' };
  const bad = join(mkdtempSync(join(tmpdir(), 'pipeline-in-')), 'bad-trends.json');
  writeFileSync(bad, JSON.stringify({ date: '2026-09-21' }));
  const r = await cli([makeInput(), outDir(), '--trends', bad], noCallEnv);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /不符合契约/);
  const missing = join(tmpdir(), 'no-such-trends.json');
  assert.equal((await cli([makeInput(), outDir(), '--trends', missing], noCallEnv)).code, 3);
});

// ---------- 参数透传 ----------

test('--thinking off 时请求体带 thinking:disabled；默认（on）不带该字段；--effort 透传', async () => {
  await withMockApi({}, async ({ env, requests }) => {
    await cli([makeInput(), outDir(), '--trends', makeTrends(), '--thinking', 'off', '--effort', 'low'], env);
    assert.deepEqual(requests[0].body.thinking, { type: 'disabled' });
    assert.equal(requests[0].body.reasoning_effort, 'low');
  });
  await withMockApi({}, async ({ env, requests }) => {
    await cli([makeInput(), outDir(), '--trends', makeTrends()], env);
    assert.ok(!('thinking' in requests[0].body), '默认开启思考时不需要显式传 thinking 字段');
  });
});

test('--trends 会传给简报生成：趋势词出现在简报请求的提示词里', async () => {
  await withMockApi({}, async ({ env, requests }) => {
    await cli([makeInput(), outDir(), '--trends', makeTrends()], env);
    const briefReq = requests.find((r) => r.body.messages[0].content.includes('创意策划'));
    assert.match(briefReq.body.messages[1].content, /en-US：wireless earbuds/);
  });
});
