import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBrief, generateBrief, buildBriefPrompt, trendCandidates, BRIEF_PROMPT_VERSIONS } from '../src/brief.mjs';
import { validate, checkReferences } from '../src/validate.mjs';

const read = (p) => JSON.parse(readFileSync(new URL(`../examples/valid/${p}.json`, import.meta.url), 'utf-8'));
const factSheet = read('fact-sheet');
const brief = () => structuredClone(read('brief'));
const MARKETS = ['en-US', 'id-ID'];
const trends = {
  markets: [
    { market: 'en-US', categories: [{ status: 'ok', terms: [{ term: 'Wireless Earbuds', signal: 'stated_trending' }, { term: 'open earbuds', signal: 'mentioned' }] }, { status: 'failed', terms: [{ term: 'ghost', signal: 'mentioned' }] }] },
    { market: 'id-ID', categories: [{ status: 'ok', terms: [{ term: 'earphone bluetooth', signal: 'mentioned' }] }] },
  ],
};
const verify = (b, over = {}) => verifyBrief({ factSheet, brief: b, markets: MARKETS, trends, ...over });
const kw = (term, market, extra = {}) => ({ term, market, origin: 'model', fact_ids: ['F1'], ...extra });

// ---------- 契约 ----------

test('简报契约：示例通过，关键词缺 fact_ids / origin 非法 / 缺市场都被拒绝', () => {
  assert.deepEqual(validate('brief', brief()), { ok: true, errors: [] });
  assert.deepEqual(checkReferences({ factSheet, brief: brief() }), []);

  let b = brief();
  delete b.keywords[0].fact_ids;
  assert.equal(validate('brief', b).ok, false);
  b = brief();
  b.keywords[0].fact_ids = [];
  assert.equal(validate('brief', b).ok, false);
  b = brief();
  b.keywords[0].origin = 'guess';
  assert.equal(validate('brief', b).ok, false);
  b = brief();
  delete b.keywords[0].market;
  assert.equal(validate('brief', b).ok, false);
  b = brief();
  b.keywords = ['wireless earbuds'];
  assert.equal(validate('brief', b).ok, false, '旧的字符串数组格式不再合法');
});

test('简报引用完整性：关键词引用了不存在的事实编号', () => {
  const b = brief();
  b.keywords[1].fact_ids = ['F99'];
  assert.match(checkReferences({ factSheet, brief: b }).join('\n'), /keywords\[1\].*F99/);
});

// ---------- 趋势词候选 ----------

test('趋势候选：只取该市场、状态 ok 的类目，按大小写去重，标出来源自称流行', () => {
  assert.deepEqual(trendCandidates(trends, 'en-US'), [{ term: 'Wireless Earbuds', stated: true }, { term: 'open earbuds', stated: false }]);
  assert.deepEqual(trendCandidates(trends, 'id-ID'), [{ term: 'earphone bluetooth', stated: false }]);
  assert.deepEqual(trendCandidates(trends, 'fr-FR'), []);
  assert.deepEqual(trendCandidates(null, 'en-US'), []);
});

test('趋势候选：不同类目里大小写不同的同一个词只留一个（保留先出现的写法）', () => {
  const t = {
    markets: [
      {
        market: 'en-US',
        categories: [
          { status: 'ok', terms: [{ term: 'Neck Fan', signal: 'mentioned' }] },
          { status: 'ok', terms: [{ term: 'neck  fan', signal: 'stated_trending' }, { term: 'yoga mat', signal: 'mentioned' }] },
        ],
      },
    ],
  };
  assert.deepEqual(trendCandidates(t, 'en-US'), [{ term: 'Neck Fan', stated: false }, { term: 'yoga mat', stated: false }]);
});

// ---------- 提示词 ----------

test('简报提示词：包含事实编号与依据，声明不能补充事实，趋势词按市场列出并标注自称流行', () => {
  const { system, user } = buildBriefPrompt({ factSheet, markets: MARKETS, trends });
  assert.match(system, /只能使用事实表里已有的信息/);
  assert.match(system, /逐字一致/);
  assert.match(system, /不可信的文本/);
  assert.match(user, /"id": "F3"/);
  assert.match(user, /"evidence": "续航30小时（含充电盒）"/);
  assert.match(user, /en-US：Wireless Earbuds［来源自称流行］；open earbuds/);
  assert.match(user, /id-ID：earphone bluetooth/);
  assert.doesNotMatch(user, /ghost/, '失败类目的词不能出现在提示词里');
});

test('简报提示词：没有趋势词时明确要求 origin 一律为 model；未知版本报错', () => {
  const { user } = buildBriefPrompt({ factSheet, markets: MARKETS, trends: null });
  assert.match(user, /origin 一律填 "model"/);
  assert.throws(() => buildBriefPrompt({ factSheet, markets: MARKETS, version: 'b99' }), /未知简报提示词版本/);
  assert.deepEqual(BRIEF_PROMPT_VERSIONS, ['b1']);
});

test('简报提示词防泄漏：不含任何测试用例或示例产品的具体内容', () => {
  const { system } = buildBriefPrompt({ factSheet, markets: MARKETS, trends });
  for (const leak of ['earbuds', 'HoverGo', '耳机', 'IPX5', '降噪', '台灯', '瑜伽']) assert.ok(!system.includes(leak), `系统提示词不应包含 ${leak}`);
});

// ---------- 校验 ----------

test('校验：示例简报通过', () => {
  assert.deepEqual(verify(brief()), []);
});

test('校验：结构不合法只报结构问题', () => {
  const b = brief();
  delete b.audience;
  const errs = verify(b);
  assert.ok(errs.length && errs.every((e) => e.startsWith('结构不合法')));
});

test('校验：角度数量必须 2-4 个', () => {
  let b = brief();
  b.angles = b.angles.slice(0, 1);
  assert.match(verify(b).join('\n'), /angles 需要 2 到 4 个，当前 1 个/);
  b = brief();
  b.angles = [...b.angles, ...b.angles];
  assert.match(verify(b).join('\n'), /当前 6 个/);
});

test('校验：角度描述与受众里的数字必须有事实依据', () => {
  let b = brief();
  b.angles[1].description = '含充电盒续航长达 40 小时，减少充电焦虑';
  assert.match(verify(b).join('\n'), /angles\[1\].*数字 40/);
  b = brief();
  b.angles[1].description = '含充电盒续航约 30 小时';
  assert.deepEqual(verify(b), []);
  b = brief();
  b.angles[1].description = '续航约 30 小时';
  b.angles[1].fact_ids = ['F1'];
  assert.match(verify(b).join('\n'), /angles\[1\].*数字 30/, '30 在 F3，不在所引的 F1');
  b = brief();
  b.audience = '每天通勤超过 90 分钟的上班族';
  assert.match(verify(b).join('\n'), /audience.*数字 90/);
});

test('校验：语气必须每个目标市场恰好一条，不能有未选择的市场', () => {
  let b = brief();
  b.market_tones = b.market_tones.slice(0, 1);
  assert.match(verify(b).join('\n'), /市场 id-ID 需要恰好一条，当前 0 条/);
  b = brief();
  b.market_tones.push({ market: 'en-US', tone: '重复' });
  assert.match(verify(b).join('\n'), /市场 en-US 需要恰好一条，当前 2 条/);
  b = brief();
  b.market_tones.push({ market: 'fr-FR', tone: '法语' });
  assert.match(verify(b).join('\n'), /未选择的市场 fr-FR/);
});

test('校验：每个市场的关键词数量 4-8 个', () => {
  let b = brief();
  b.keywords = b.keywords.filter((k) => !(k.market === 'id-ID' && k.term.includes('noise')));
  assert.match(verify(b).join('\n'), /id-ID 的关键词需要 4 到 8 个，当前 3 个/);
  b = brief();
  for (let i = 0; i < 5; i++) b.keywords.push(kw(`wireless earbuds v${i}`, 'en-US'));
  assert.match(verify(b).join('\n'), /en-US 的关键词需要 4 到 8 个，当前 9 个/);
});

test('校验：关键词的字符、平台名、语言、重复', () => {
  const withKw = (k) => {
    const b = brief();
    b.keywords.push(k);
    return verify(b).join('\n');
  };
  assert.match(withKw(kw('earbuds <b>', 'en-US')), /只能是不超过 60 字符/);
  assert.match(withKw(kw('a'.repeat(61), 'en-US')), /只能是不超过 60 字符/);
  assert.match(withKw(kw('tiktok earbuds', 'en-US')), /含平台名/);
  assert.match(withKw(kw('shopee earphone', 'id-ID')), /含平台名/);
  assert.match(withKw(kw('蓝牙耳机', 'en-US')), /含非拉丁字母/);
  assert.match(withKw(kw('Wireless  Earbuds', 'en-US')), /在 en-US 里重复/);
  assert.equal(withKw(kw('wireless earbuds', 'id-ID')), '', '同一个词在不同市场不算重复');
});

test('校验：关键词里的数字必须出自所引事实', () => {
  const b = brief();
  b.keywords.push(kw('24 hour battery earbuds', 'en-US', { fact_ids: ['F3'] }));
  assert.match(verify(b).join('\n'), /24 hour battery earbuds.*数字 24/);
  const ok = brief();
  ok.keywords.push(kw('30 hour battery earbuds', 'en-US', { fact_ids: ['F3'] }));
  assert.deepEqual(verify(ok), []);
});

test('校验：标为 trend_snapshot 的词必须逐字（忽略大小写空白）出自该市场的趋势词', () => {
  const b = brief();
  b.keywords.push(kw('open  EARBUDS', 'en-US', { origin: 'trend_snapshot' }));
  assert.deepEqual(verify(b), [], '大小写与空白差异不算');

  const bad = brief();
  bad.keywords.push(kw('open ear headphones', 'en-US', { origin: 'trend_snapshot' }));
  assert.match(verify(bad).join('\n'), /标为 trend_snapshot，但不在 en-US 的趋势词里/);

  const wrongMarket = brief();
  wrongMarket.keywords.push(kw('open earbuds', 'id-ID', { origin: 'trend_snapshot' }));
  assert.match(verify(wrongMarket).join('\n'), /不在 id-ID 的趋势词里/, '趋势词按市场核对');

  const failedCategory = brief();
  failedCategory.keywords.push(kw('ghost', 'en-US', { origin: 'trend_snapshot' }));
  assert.match(verify(failedCategory).join('\n'), /ghost.*不在 en-US 的趋势词里/, '失败类目的词不可用');
});

test('校验：没有提供趋势快照时，任何 trend_snapshot 标注都不成立', () => {
  assert.match(verify(brief(), { trends: null }).join('\n'), /wireless earbuds.*标为 trend_snapshot/);
});

test('校验：关键词的市场不在目标市场内', () => {
  const b = brief();
  b.keywords.push(kw('earbuds', 'fr-FR'));
  assert.match(verify(b).join('\n'), /市场 fr-FR 不在目标市场内/);
});

// ---------- 生成（带重试） ----------

const good = () => JSON.stringify(brief());
const gen = (chat, extra = {}) => generateBrief({ factSheet, markets: MARKETS, trends, chat, ...extra });

test('生成：第一次就通过，不重试；调用参数符合约定', async () => {
  const calls = [];
  const chat = async (a) => (calls.push(a), good());
  const r = await gen(chat);
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 1);
  assert.deepEqual(r.brief, brief());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].json, true);
});

test('生成：校验不过就把具体问题带给模型重试，第二次通过', async () => {
  const bad = brief();
  bad.angles[1].description = '续航长达 40 小时';
  const calls = [];
  const chat = async (a) => (calls.push(a.user), calls.length === 1 ? JSON.stringify(bad) : good());
  const r = await gen(chat);
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 2);
  assert.match(calls[1], /上一次的输出没有通过校验/);
  assert.match(calls[1], /数字 40/);
  assert.equal(r.history.length, 2);
});

test('生成：输出不是合法 JSON 也会重试；三次都不通过则失败并保留最后的错误', async () => {
  let n = 0;
  const r1 = await gen(async () => (++n === 1 ? 'not json' : good()));
  assert.equal(r1.ok, true);
  assert.equal(r1.attempts, 2);

  const bad = brief();
  bad.audience = '90 分钟通勤族';
  const r2 = await gen(async () => JSON.stringify(bad));
  assert.equal(r2.ok, false);
  assert.equal(r2.attempts, 3);
  assert.match(r2.errors.join('\n'), /audience/);
  assert.equal(r2.history.length, 3);
});

test('生成：模型调用失败不抛异常，记录错误', async () => {
  const r = await gen(async () => {
    throw new Error('boom');
  });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /模型调用失败：boom/);
});

// ---------- 命令行端到端（本机假 DeepSeek） ----------

const run = promisify(execFile);
const coreDir = fileURLToPath(new URL('..', import.meta.url));
const cli = (args, env) =>
  run('node', ['eval/generate-briefs.mjs', ...args], { cwd: coreDir, env: { ...process.env, DEEPSEEK_API_KEY: 'sk-test-key', ...env } }).then(
    (r) => ({ code: 0, ...r }),
    (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }),
  );

async function withMockApi(fn) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ auth: req.headers.authorization, body: JSON.parse(body) });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: good() }, finish_reason: 'stop' }], usage: { completion_tokens: 50 } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn({ env: { COPYFLOW_TEST_API_URL: `http://127.0.0.1:${server.address().port}/chat/completions` }, requests });
  } finally {
    server.close();
  }
}

function makeRunDir(set = 'dev') {
  const dir = mkdtempSync(join(tmpdir(), 'brief-from-'));
  for (const id of ['case-a', 'case-b']) {
    mkdirSync(join(dir, id));
    writeFileSync(join(dir, id, 'fact-sheet.json'), JSON.stringify(factSheet));
  }
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ set }));
  const snap = join(dir, 'snapshot.json');
  writeFileSync(
    snap,
    JSON.stringify({
      date: '2026-09-21', generated_at: '2026-09-21T01:00:00.000Z', label: '趋势词快照',
      note: '仅表示这些词在近期公开网页的搜索结果中出现过，不代表搜索量、销量或增长趋势；使用前请自行判断。',
      provider: { search: 'tavily', model: 'm' }, searches: 1,
      markets: [{ market: 'en-US', categories: [{ id: 'c', name: 'C', status: 'ok', sources_seen: 1, rejected_terms: 0, rejected_reasons: {}, terms: [{ term: 'wireless earbuds', evidence: 'the best wireless earbuds', signal: 'mentioned', source_url: 'https://a.example/1', source_title: 't' }] }] }],
    }),
  );
  return { dir, snap };
}

test('命令行：端到端为每个用例写出合法简报，输出里没有密钥，默认关闭思考', async () => {
  await withMockApi(async ({ env, requests }) => {
    const { dir, snap } = makeRunDir();
    const out = mkdtempSync(join(tmpdir(), 'brief-out-'));
    const r = await cli([out, '--from', dir, '--trends', snap], env);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].auth, 'Bearer sk-test-key');
    assert.deepEqual(requests[0].body.thinking, { type: 'disabled' });
    assert.match(requests[0].body.messages[1].content, /en-US：wireless earbuds/);

    for (const id of ['case-a', 'case-b']) {
      const b = JSON.parse(readFileSync(join(out, id, 'brief.json'), 'utf-8'));
      assert.deepEqual(validate('brief', b), { ok: true, errors: [] });
      assert.ok(!existsSync(join(out, id, 'attempts.json')), '一次通过不写 attempts');
    }
    const meta = readFileSync(join(out, 'meta.json'), 'utf-8');
    assert.ok(!meta.includes('sk-test-key') && !r.stdout.includes('sk-test-key'));
    assert.match(r.stdout, /✅ case-a.*角度 3，关键词 8（取自趋势快照 1）/);
  });
});

test('命令行：--cases 只跑指定用例；不给趋势快照时 trend_snapshot 标注不成立，重试后仍失败并写出 attempts', async () => {
  await withMockApi(async ({ env, requests }) => {
    const { dir } = makeRunDir();
    const out = mkdtempSync(join(tmpdir(), 'brief-out-'));
    const r = await cli([out, '--from', dir, '--cases', 'case-b'], env);
    assert.equal(r.code, 0);
    assert.equal(requests.length, 3, '三次尝试');
    assert.match(r.stdout, /❌ case-b  尝试 3 次/);
    assert.ok(existsSync(join(out, 'case-b', 'attempts.json')));
    assert.ok(!existsSync(join(out, 'case-b', 'brief.json')));
    assert.ok(!existsSync(join(out, 'case-a')));
  });
});

test('命令行：留出集运行目录不加 --final 会被拒绝，加了才放行', async () => {
  await withMockApi(async ({ env, requests }) => {
    const { dir, snap } = makeRunDir('holdout');
    const out = mkdtempSync(join(tmpdir(), 'brief-out-'));
    const denied = await cli([out, '--from', dir, '--trends', snap], env);
    assert.equal(denied.code, 2);
    assert.match(denied.stderr, /留出集/);
    assert.equal(requests.length, 0);
    const ok = await cli([out, '--from', dir, '--trends', snap, '--final'], env);
    assert.equal(ok.code, 0);
    assert.equal(requests.length, 2);
  });
});

test('命令行：缺密钥退出码 1；缺 --from、非法市场、坏的趋势快照退出码 2', async () => {
  const { dir } = makeRunDir();
  const out = mkdtempSync(join(tmpdir(), 'brief-out-'));
  assert.equal((await cli([out, '--from', dir], { DEEPSEEK_API_KEY: '' })).code, 1);
  assert.equal((await cli([out])).code, 2);
  assert.equal((await cli([out, '--from', dir, '--markets', 'english'])).code, 2);
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{"date":"x"}');
  const r = await cli([out, '--from', dir, '--trends', bad]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /不符合契约/);
});
