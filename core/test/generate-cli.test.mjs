import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const coreDir = fileURLToPath(new URL('..', import.meta.url));
const good = JSON.parse(readFileSync(new URL('../eval/fixtures/good/earbuds-01/fact-sheet.json', import.meta.url), 'utf-8'));

// 本地假 DeepSeek：永远返回 earbuds 的好事实表，并记录请求
async function withMockApi(fn) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ auth: req.headers.authorization, body: JSON.parse(body) });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(good) }, finish_reason: 'stop' }], usage: { completion_tokens: 100 } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn({ url: `http://127.0.0.1:${server.address().port}/chat/completions`, requests });
  } finally {
    server.close();
  }
}

const gen = (args, env) =>
  run('node', ['eval/generate.mjs', ...args], { cwd: coreDir, env: { ...process.env, DEEPSEEK_API_KEY: 'test-key', ...env } }).then(
    (r) => ({ code: 0, ...r }),
    (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }),
  );

test('批量脚本端到端：开发集一个用例，写出事实表与 meta（含集合、提示词、思考开关、API 诊断）', async () => {
  await withMockApi(async ({ url, requests }) => {
    const out = mkdtempSync(join(tmpdir(), 'cf-dev-'));
    const r = await gen([out, '--cases', 'earbuds-01', '--prompt', 'p4', '--thinking', 'off'], { COPYFLOW_TEST_API_URL: url });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(existsSync(join(out, 'earbuds-01', 'fact-sheet.json')));
    const meta = JSON.parse(readFileSync(join(out, 'meta.json'), 'utf-8'));
    assert.equal(meta.set, 'dev');
    assert.equal(meta.prompt, 'p4');
    assert.equal(meta.thinking, 'off');
    assert.equal(meta.cases['earbuds-01'].ok, true);
    assert.equal(meta.cases['earbuds-01'].api.length, 1);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].auth, 'Bearer test-key');
    assert.deepEqual(requests[0].body.thinking, { type: 'disabled' });
  });
});

test('批量脚本端到端：留出集不加 --final 直接拒绝，且不产生任何输出、不发请求', async () => {
  await withMockApi(async ({ url, requests }) => {
    const out = mkdtempSync(join(tmpdir(), 'cf-ho-'));
    const r = await gen([join(out, 'x'), '--set', 'holdout'], { COPYFLOW_TEST_API_URL: url });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--final/);
    assert.equal(requests.length, 0);
    assert.equal(existsSync(join(out, 'x')), false);
  });
});

test('批量脚本端到端：留出集加 --final 能跑；模型答非所问时记为失败而不是崩溃，meta 照常写出', async () => {
  await withMockApi(async ({ url }) => {
    const out = mkdtempSync(join(tmpdir(), 'cf-ho2-'));
    const r = await gen([out, '--set', 'holdout', '--final', '--cases', 'airfryer-h4', '--thinking', 'off'], { COPYFLOW_TEST_API_URL: url });
    assert.equal(r.code, 0, r.stderr);
    const meta = JSON.parse(readFileSync(join(out, 'meta.json'), 'utf-8'));
    assert.equal(meta.set, 'holdout');
    assert.equal(meta.cases['airfryer-h4'].ok, false);
    assert.equal(meta.cases['airfryer-h4'].attempts, 3);
    assert.ok(existsSync(join(out, 'airfryer-h4', 'attempts.json')));
  });
});

test('批量脚本：没有密钥时给出提示并以非 0 退出，不产生输出目录', async () => {
  const out = mkdtempSync(join(tmpdir(), 'cf-nokey-'));
  const r = await run('node', ['eval/generate.mjs', join(out, 'y')], { cwd: coreDir, env: { PATH: process.env.PATH } }).then(
    () => ({ code: 0 }),
    (e) => ({ code: e.code, stderr: e.stderr }),
  );
  assert.equal(r.code, 1);
  assert.match(r.stderr, /DEEPSEEK_API_KEY/);
  assert.equal(existsSync(join(out, 'y')), false);
});

test('测试专用地址覆盖：只允许 localhost，指向外部地址会被拒绝（防止密钥被发往别处）', async () => {
  const out = mkdtempSync(join(tmpdir(), 'cf-evil-'));
  const r = await gen([out, '--cases', 'earbuds-01', '--thinking', 'off'], { COPYFLOW_TEST_API_URL: 'https://evil.example.com/steal' });
  const meta = JSON.parse(readFileSync(join(out, 'meta.json'), 'utf-8'));
  assert.equal(meta.cases['earbuds-01'].ok, false);
  assert.match(meta.cases['earbuds-01'].errors[0], /只允许指向 localhost/);
});
