import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTavily, FatalSearchError } from '../src/tavily.mjs';
import { loadTrendConfig, verifyTerms, distillTerms, buildSnapshot, plannedSearches, buildTrendPrompt } from '../src/trends.mjs';
import { validate } from '../src/validate.mjs';
import { RULE_SETS } from '../src/rules.mjs';

const config = loadTrendConfig();
const coreDir = fileURLToPath(new URL('..', import.meta.url));

// ---------- 配置 ----------

test('配置：预算不超过免费额度，id 唯一，市场都有对应规则集', () => {
  const perDay = plannedSearches(config);
  assert.ok(perDay * 31 <= 900, `每天 ${perDay} 次，每月 ${perDay * 31} 点数，应留出手动试跑的余量（≤900）`);

  const ids = config.markets.flatMap((m) => m.categories.map((c) => c.id));
  assert.equal(new Set(ids).size, ids.length, '类目 id 重复');
  const ruleMarkets = new Set(RULE_SETS.flatMap((s) => s.markets));
  for (const m of config.markets) {
    assert.ok(ruleMarkets.has(m.market), `${m.market} 没有对应的规则集，采集了也用不上`);
    for (const c of m.categories) {
      assert.ok(c.queries.length >= 1 && c.queries.length <= 3, `${c.id} 每个类目 1-3 条查询`);
      assert.ok(c.queries.every((q) => q.trim()));
    }
    assert.ok(m.trend_words.length >= 5 && m.trend_words.every((w) => w.trim()), `${m.market} 需要热度用语表，用来判断 signal`);
  }
});

// ---------- Tavily 客户端 ----------

const jsonRes = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body, text: async () => JSON.stringify(body) });

test('Tavily：请求形状符合官方文档，结果只保留必要字段并丢弃非 http 链接', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return jsonRes(200, {
      results: [
        { title: 'A', url: 'https://a.example/x', content: 'alpha', published_date: '2026-09-20', score: 0.9, raw_content: 'ignored' },
        { title: 'B', url: 'javascript:alert(1)', content: 'bad' },
        { title: 'C', url: 'https://c.example/y', content: 'gamma' },
      ],
    });
  };
  const search = createTavily({ apiKey: 'tvly-secret', fetchImpl });
  const rs = await search({ query: 'q', country: 'indonesia', maxResults: 5 });

  assert.equal(calls[0].url, 'https://api.tavily.com/search');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tvly-secret');
  assert.deepEqual(calls[0].body, { query: 'q', search_depth: 'basic', topic: 'general', time_range: 'week', max_results: 5, include_published_date: true, include_answer: false, country: 'indonesia' });
  assert.deepEqual(rs, [
    { title: 'A', url: 'https://a.example/x', content: 'alpha', published_date: '2026-09-20' },
    { title: 'C', url: 'https://c.example/y', content: 'gamma' },
  ]);
});

test('Tavily：429 与 5xx 重试后成功；401 与 432 立即停止且不重试；错误信息不含密钥', async () => {
  let n = 0;
  const flaky = async () => (++n < 3 ? jsonRes(n === 1 ? 429 : 503, {}) : jsonRes(200, { results: [] }));
  assert.deepEqual(await createTavily({ apiKey: 'k', fetchImpl: flaky, retryDelayMs: 0 })({ query: 'q' }), []);
  assert.equal(n, 3);

  for (const [status, re] of [[401, /401/], [432, /额度/]]) {
    let calls = 0;
    const fetchImpl = async () => (calls++, jsonRes(status, {}));
    await assert.rejects(createTavily({ apiKey: 'tvly-secret', fetchImpl, retryDelayMs: 0 })({ query: 'q' }), (e) => e instanceof FatalSearchError && re.test(e.message) && !e.message.includes('tvly-secret'));
    assert.equal(calls, 1, `${status} 不应重试`);
  }

  const down = async () => jsonRes(500, {});
  await assert.rejects(createTavily({ apiKey: 'k', fetchImpl: down, retryDelayMs: 0, retries: 1 })({ query: 'q' }), /500/);
  assert.throws(() => createTavily({}), /TAVILY_API_KEY/);
});

// ---------- 词的原文校验 ----------

const results = [
  { id: 'R1', title: 'Best neck fans of 2026', url: 'https://a.example/1', content: 'Portable neck fan models keep you cool.  Also popular: magnetic phone grip.', published_date: '2026-09-18' },
  { id: 'R2', title: 'Kipas angin portabel', url: 'https://b.example/2', content: 'Kipas angin portabel sedang laris.' },
];
const good = { term: 'neck fan', evidence: 'Portable neck fan models keep you cool.', source_id: 'R1' };

test('词校验：合格的词补上来源链接、标题与日期', () => {
  const { terms, rejected } = verifyTerms([good], results);
  assert.equal(rejected, 0);
  assert.deepEqual(terms, [{ term: 'neck fan', evidence: good.evidence, signal: 'mentioned', source_url: 'https://a.example/1', source_title: 'Best neck fans of 2026', published_date: '2026-09-18' }]);
});

test('词校验：大小写、空白差异不算编造', () => {
  const r = verifyTerms([{ term: 'Magnetic Phone Grip', evidence: 'also popular:  MAGNETIC phone grip.', source_id: 'R1' }], results);
  assert.equal(r.terms.length, 1);
});

test('词校验：原文里找不到的摘录、不在摘录里的词、不存在的来源编号都被丢弃并计数', () => {
  const bad = [
    { term: 'neck fan', evidence: 'Neck fans are the number one seller', source_id: 'R1' }, // 摘录是编的
    { term: 'led mask', evidence: 'Portable neck fan models keep you cool.', source_id: 'R1' }, // 词不在摘录里
    { ...good, source_id: 'R9' }, // 编号不存在
    { ...good, source_id: 'R2' }, // 摘录出自另一条结果
    { term: 'neck fan' }, // 缺字段
    null,
  ];
  const r = verifyTerms(bad, results);
  assert.deepEqual(r.terms, []);
  assert.equal(r.rejected, 6);
});

test('词校验：平台名、含链接或标记的词、过长的词被拒绝（这些词在原文里确实出现过，摘录也带上下文，是被词本身的规则拒绝的）', () => {
  const long = 'a'.repeat(41);
  const bads = ['TikTok neck fan', 'neck fan <script>', 'neck fan https://x.co', long, 'Shopee neck fan'];
  const src = [{ id: 'R1', title: 't', url: 'https://a.example/1', content: `${bads.map((b) => `See ${b} here.`).join(' ')} See neck fan here.` }];
  const r = verifyTerms(bads.map((term) => ({ term, evidence: `See ${term} here.`, source_id: 'R1' })), src);
  assert.deepEqual(r.terms, []);
  assert.deepEqual(r.reasons, { platform_name: 2, bad_chars: 2, term_too_long: 1 });
  // 对照：同一段原文里干净的词是能通过的
  assert.equal(verifyTerms([{ term: 'neck fan', evidence: 'See neck fan here.', source_id: 'R1' }], src).terms.length, 1);
});

test('词校验：摘录就是词本身（菜单/导航里的一个词、没有上下文）被拒绝', () => {
  const src = [{ id: 'R1', title: 'Shop', url: 'https://a.example/1', content: 'cat tree | dog toys | Free returns on cat tree orders' }];
  const r = verifyTerms([{ term: 'cat tree', evidence: 'cat tree', source_id: 'R1' }, { term: 'Dog Toys', evidence: ' dog  toys ', source_id: 'R1' }], src);
  assert.deepEqual(r.terms, []);
  assert.deepEqual(r.reasons, { evidence_is_just_term: 2 });
  assert.equal(verifyTerms([{ term: 'cat tree', evidence: 'Free returns on cat tree orders', source_id: 'R1' }], src).terms.length, 1);
});

test('词校验：摘录过长（整段照抄）被拒绝，摘录应当是刚好支撑该词的最短片段', () => {
  const para = `neck fan ${'lorem ipsum '.repeat(30)}`;
  const src = [{ id: 'R1', title: 't', url: 'https://a.example/1', content: para }];
  assert.ok(para.length > 300);
  assert.equal(verifyTerms([{ term: 'neck fan', evidence: para.trim(), source_id: 'R1' }], src).rejected, 1);
  assert.equal(verifyTerms([{ term: 'neck fan', evidence: 'neck fan lorem ipsum', source_id: 'R1' }], src).terms.length, 1);
});

test('词校验：同一个词只留一个，超过上限的被截掉并计入丢弃', () => {
  const dup = verifyTerms([good, { ...good, term: 'Neck Fan' }], results);
  assert.equal(dup.terms.length, 1);
  assert.deepEqual(dup.reasons, { duplicate: 1 });

  const two = verifyTerms([good, { term: 'kipas angin portabel', evidence: 'Kipas angin portabel sedang laris.', source_id: 'R2' }], results, { maxTerms: 1 });
  assert.equal(two.terms.length, 1);
  assert.deepEqual(two.reasons, { over_limit: 1 });
});

test('词校验：每个输入的词要么保留、要么按原因计数，二者之和恒等于输入数量', () => {
  const input = [
    good, // 保留
    { ...good, term: 'Neck Fan' }, // duplicate
    { term: 'led mask', evidence: good.evidence, source_id: 'R1' }, // term_not_in_evidence
    { term: 'neck fan', evidence: 'invented sentence about neck fan', source_id: 'R1' }, // evidence_not_in_source
    { ...good, source_id: 'R9' }, // unknown_source
    { term: '', evidence: 'x', source_id: 'R1' }, // bad_shape
    null, // bad_shape
    { term: 'kipas angin portabel', evidence: 'Kipas angin portabel sedang laris.', source_id: 'R2' }, // over_limit（上限 1）
  ];
  const r = verifyTerms(input, results, { maxTerms: 1 });
  assert.deepEqual(r.reasons, { duplicate: 1, term_not_in_evidence: 1, evidence_not_in_source: 1, unknown_source: 1, bad_shape: 2, over_limit: 1 });
  assert.equal(r.terms.length + r.rejected, input.length);
});

test('热度信号：由代码按摘录里的用语判断，模型无法自己声称“这个词很火”', () => {
  const src = [
    { id: 'R1', title: 't', url: 'https://a.example/1', content: 'PDRN atau DNA Salmon sedang naik daun. Koleksi kosmetik favorit Anda. Serum retinol tersedia.' },
    { id: 'R2', title: 't', url: 'https://a.example/2', content: 'Everything about the trendsetter brand. Book a hotel. Viral phone grip goes on sale. Our trending picks. Also magnetic phone grip.' },
  ];
  const sig = (term, evidence, source_id, trendWords) => verifyTerms([{ term, evidence, source_id }], src, { trendWords }).terms[0]?.signal;
  const id = ['naik daun', 'viral'];
  assert.equal(sig('PDRN', 'PDRN atau DNA Salmon sedang naik daun', 'R1', id), 'stated_trending');
  assert.equal(sig('kosmetik', 'Koleksi kosmetik favorit Anda', 'R1', id), 'mentioned');
  const en = ['trending', 'viral', 'hot'];
  assert.equal(sig('phone grip', 'Viral phone grip goes on sale', 'R2', en), 'stated_trending');
  assert.equal(sig('picks', 'Our trending picks', 'R2', en), 'stated_trending');
  // 词内片段不算：trendsetter ≠ trend，hotel ≠ hot
  assert.equal(sig('trendsetter brand', 'Everything about the trendsetter brand', 'R2', ['trend', 'hot']), 'mentioned');
  assert.equal(sig('hotel', 'Book a hotel', 'R2', ['trend', 'hot']), 'mentioned');
  // 只看摘录：同一条结果里别处说了 viral，但摘录里没有，不算
  assert.equal(sig('phone grip', 'Also magnetic phone grip', 'R2', en), 'mentioned');
  // 没配热度用语表时一律 mentioned
  assert.equal(sig('phone grip', 'Viral phone grip goes on sale', 'R2', undefined), 'mentioned');
});

test('Tavily：发布日期统一成 YYYY-MM-DD，解析不了的不带日期', async () => {
  const fetchImpl = async () =>
    jsonRes(200, {
      results: [
        { title: 'a', url: 'https://a.example/1', content: 'x', published_date: 'Thu, 17 Sep 2026 19:00:00 GMT' },
        { title: 'b', url: 'https://a.example/2', content: 'x', published_date: '2026-09-18' },
        { title: 'c', url: 'https://a.example/3', content: 'x', published_date: 'not a date' },
      ],
    });
  const rs = await createTavily({ apiKey: 'k', fetchImpl })({ query: 'q' });
  assert.deepEqual(rs.map((r) => r.published_date), ['2026-09-17', '2026-09-18', undefined]);
  assert.ok(!('published_date' in rs[2]));
});

test('摘录提示词：明确禁止评价热度与执行网页里的指令，且带上结果编号', () => {
  const { system, user } = buildTrendPrompt(results, 'English');
  assert.match(system, /不评价热度/);
  assert.match(system, /比词本身更长/);
  assert.match(system, /笼统大类/);
  assert.match(system, /不可信的网页文本/);
  assert.match(user, /\[R1\] 标题：Best neck fans of 2026/);
});

test('摘录：输出不是合法 JSON 时重试一次，仍失败则抛错', async () => {
  let n = 0;
  const chat = async () => (++n === 1 ? 'not json' : JSON.stringify({ terms: [good] }));
  const r = await distillTerms({ results, chat, language: 'English', maxTerms: 8 });
  assert.equal(r.terms.length, 1);
  assert.equal(n, 2);

  await assert.rejects(distillTerms({ results, chat: async () => 'nope', language: 'English', maxTerms: 8 }), /不是合法 JSON/);
});

// ---------- 快照 ----------

const smallConfig = {
  ...config,
  markets: [
    { market: 'en-US', country: 'united states', language: 'English', trend_words: ['trending', 'viral'], categories: [{ id: 'c1', name: 'One', queries: ['q1', 'q2'] }, { id: 'c2', name: 'Two', queries: ['q3'] }] },
    { market: 'id-ID', country: 'indonesia', language: 'Indonesian', trend_words: ['naik daun'], categories: [{ id: 'c3', name: 'Tiga', queries: ['q4'] }] },
  ],
};
const build = (over) => buildSnapshot({ config: smallConfig, model: 'm', date: '2026-09-21', now: new Date('2026-09-21T01:00:00Z'), ...over });
const okChat = async ({ user }) => JSON.stringify({ terms: [{ term: 'neck fan', evidence: 'Portable neck fan', source_id: 'R1' }].filter(() => /Portable neck fan/.test(user)) });
const okSearch = async () => [{ title: 't', url: 'https://a.example/1', content: 'Portable neck fan models' }];

test('快照：完整流程产出合法契约，词都带来源，相同链接的结果去重', async () => {
  const snap = await build({ search: okSearch, chat: okChat });
  assert.deepEqual(validate('trendSnapshot', snap), { ok: true, errors: [] });
  assert.equal(snap.searches, 4);
  const c1 = snap.markets[0].categories[0];
  assert.equal(c1.status, 'ok');
  assert.equal(c1.sources_seen, 1, '两次搜索返回同一链接，只算一条来源');
  assert.equal(c1.terms[0].source_url, 'https://a.example/1');
});

test('快照：热度信号与丢弃原因写入快照，且契约要求它们必须存在', async () => {
  const search = async () => [{ title: 't', url: 'https://a.example/1', content: 'Viral neck fan models. Also a cat tree | dog toys' }];
  const chat = async () =>
    JSON.stringify({
      terms: [
        { term: 'neck fan', evidence: 'Viral neck fan models', source_id: 'R1' },
        { term: 'cat tree', evidence: 'cat tree', source_id: 'R1' },
        { term: 'ghost item', evidence: 'never in the source', source_id: 'R1' },
      ],
    });
  const snap = await build({ search, chat });
  const c = snap.markets[0].categories[0];
  assert.deepEqual(c.terms.map((t) => [t.term, t.signal]), [['neck fan', 'stated_trending']]);
  assert.equal(c.rejected_terms, 2);
  assert.deepEqual(c.rejected_reasons, { evidence_is_just_term: 1, evidence_not_in_source: 1 });
  assert.deepEqual(validate('trendSnapshot', snap), { ok: true, errors: [] });

  const noSignal = structuredClone(snap);
  delete noSignal.markets[0].categories[0].terms[0].signal;
  assert.equal(validate('trendSnapshot', noSignal).ok, false);
  const badSignal = structuredClone(snap);
  badSignal.markets[0].categories[0].terms[0].signal = 'hot';
  assert.equal(validate('trendSnapshot', badSignal).ok, false);
  const noReasons = structuredClone(snap);
  delete noReasons.markets[0].categories[0].rejected_reasons;
  assert.equal(validate('trendSnapshot', noReasons).ok, false);
  const badDate = structuredClone(snap);
  badDate.markets[0].categories[0].terms[0].published_date = 'Thu, 17 Sep 2026 19:00:00 GMT';
  assert.equal(validate('trendSnapshot', badDate).ok, false);
});

test('快照：没有搜索结果标 no_results 且不调用模型', async () => {
  let called = 0;
  const snap = await build({ search: async () => [], chat: async () => (called++, '{}') });
  assert.equal(called, 0);
  assert.ok(snap.markets.flatMap((m) => m.categories).every((c) => c.status === 'no_results' && c.terms.length === 0));
  assert.equal(validate('trendSnapshot', snap).ok, true);
});

test('快照：单个类目模型失败不影响其他类目', async () => {
  let n = 0;
  const chat = async (a) => (++n === 1 ? 'garbage' : n === 2 ? 'garbage' : okChat(a));
  const snap = await build({ search: okSearch, chat });
  const cats = snap.markets.flatMap((m) => m.categories);
  assert.equal(cats[0].status, 'failed');
  assert.match(cats[0].error, /不是合法 JSON/);
  assert.equal(cats[1].status, 'ok');
  assert.equal(cats[2].status, 'ok');
});

test('快照：密钥无效或额度用尽时停止后续搜索，已完成的类目保留，其余标 failed', async () => {
  let calls = 0;
  const search = async () => {
    if (++calls === 3) throw new FatalSearchError('Tavily 432：套餐额度已用尽');
    return okSearch();
  };
  const snap = await build({ search, chat: okChat });
  const cats = snap.markets.flatMap((m) => m.categories);
  assert.deepEqual(cats.map((c) => c.status), ['ok', 'failed', 'failed']);
  assert.match(cats[1].error, /额度.*已停止/);
  assert.equal(calls, 3, '出现致命错误后不应再发搜索');
  assert.equal(validate('trendSnapshot', snap).ok, true);
});

test('快照：可按市场与类目筛选，只搜筛选到的', async () => {
  const seen = [];
  const search = async ({ query }) => (seen.push(query), okSearch());
  const snap = await build({ search, chat: okChat, only: { markets: ['id-ID'] } });
  assert.deepEqual(seen, ['q4']);
  assert.equal(snap.markets.length, 1);
  assert.equal(plannedSearches(smallConfig, { categories: ['c1'] }), 2);
});

test('快照契约：声明与文字不能被改（标签、免责说明是常量）', async () => {
  const snap = await build({ search: okSearch, chat: okChat });
  assert.equal(validate('trendSnapshot', { ...snap, label: '搜索量排行' }).ok, false);
  assert.equal(validate('trendSnapshot', { ...snap, note: '这些词很火' }).ok, false);
  const noSource = structuredClone(snap);
  delete noSource.markets[0].categories[0].terms[0].source_url;
  assert.equal(validate('trendSnapshot', noSource).ok, false);
});

// ---------- 命令行端到端（本机假 Tavily + 假 DeepSeek） ----------

const run = promisify(execFile);
const cli = (args, env) =>
  run('node', ['trends/snapshot.mjs', ...args], { cwd: coreDir, env: { ...process.env, TAVILY_API_KEY: 'tvly-test-key', DEEPSEEK_API_KEY: 'sk-test-key', ...env } }).then(
    (r) => ({ code: 0, ...r }),
    (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }),
  );

async function withMocks(fn, { tavilyStatus = 200 } = {}) {
  const seen = { tavily: [], deepseek: [] };
  const serve = (key, handler) =>
    createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen[key].push({ auth: req.headers.authorization, body: JSON.parse(body) });
        handler(res, JSON.parse(body));
      });
    });
  const tavily = serve('tavily', (res) => {
    res.statusCode = tavilyStatus;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ results: [{ title: 'Neck fans', url: 'https://a.example/1', content: 'Portable neck fan models keep you cool.' }] }));
  });
  const deepseek = serve('deepseek', (res) => {
    res.setHeader('Content-Type', 'application/json');
    const content = JSON.stringify({ terms: [{ term: 'neck fan', evidence: 'Portable neck fan models', source_id: 'R1' }] });
    res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
  });
  await Promise.all([tavily, deepseek].map((s) => new Promise((r) => s.listen(0, '127.0.0.1', r))));
  const env = {
    COPYFLOW_TEST_TAVILY_URL: `http://127.0.0.1:${tavily.address().port}/search`,
    COPYFLOW_TEST_API_URL: `http://127.0.0.1:${deepseek.address().port}/chat/completions`,
  };
  try {
    return await fn({ env, seen });
  } finally {
    tavily.close();
    deepseek.close();
  }
}

test('命令行：--dry-run 不需要密钥也不发请求，只报预算', async () => {
  const r = await cli(['--dry-run'], { TAVILY_API_KEY: '', DEEPSEEK_API_KEY: '' });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /计划搜索 27 次/);
});

test('命令行：缺密钥退出码 2 并指出缺哪个', async () => {
  const out = mkdtempSync(join(tmpdir(), 'trend-'));
  const r = await cli([out], { TAVILY_API_KEY: '' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /TAVILY_API_KEY/);
  assert.doesNotMatch(r.stderr, /DEEPSEEK_API_KEY/);
});

test('命令行：端到端写出快照与 latest.json，契约合法，输出里没有密钥', async () => {
  await withMocks(async ({ env, seen }) => {
    const out = mkdtempSync(join(tmpdir(), 'trend-'));
    const r = await cli([out, '--categories', 'consumer-electronics', '--markets', 'en-US'], env);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(seen.tavily.length, 3);
    assert.equal(seen.tavily[0].auth, 'Bearer tvly-test-key');
    assert.equal(seen.deepseek.length, 1);
    assert.deepEqual(seen.deepseek[0].body.thinking, { type: 'disabled' });

    const files = readdirSync(out).sort();
    assert.equal(files.length, 2);
    assert.ok(files.includes('latest.json'));
    const snap = JSON.parse(readFileSync(join(out, 'latest.json'), 'utf-8'));
    assert.deepEqual(validate('trendSnapshot', snap), { ok: true, errors: [] });
    assert.equal(snap.markets[0].categories[0].terms[0].term, 'neck fan');
    assert.match(r.stdout, /词 1 个（来源自称流行 0 个）/);

    for (const f of files) {
      const text = readFileSync(join(out, f), 'utf-8');
      assert.ok(!text.includes('tvly-test-key') && !text.includes('sk-test-key'), '输出里不能出现密钥');
    }
    assert.ok(!r.stdout.includes('tvly-test-key') && !r.stderr.includes('sk-test-key'));
  });
});

test('命令行：额度用尽时快照照常写出，但退出码为 1，让定时任务显示失败', async () => {
  await withMocks(
    async ({ env }) => {
      const out = mkdtempSync(join(tmpdir(), 'trend-'));
      const r = await cli([out, '--markets', 'id-ID'], env);
      assert.equal(r.code, 1);
      assert.match(r.stdout, /额度/);
      const snap = JSON.parse(readFileSync(join(out, 'latest.json'), 'utf-8'));
      assert.ok(snap.markets[0].categories.every((c) => c.status === 'failed'));
    },
    { tavilyStatus: 432 },
  );
});
