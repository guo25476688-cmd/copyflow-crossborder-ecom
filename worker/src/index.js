/**
 * CopyFlow API — Cloudflare Worker
 *
 * 用一个 Worker 取代原型阶段的 Dify 工作流：
 * - DeepSeek / Tavily 的 key 只存在 Worker 的 secret 里，浏览器端永远看不到
 * - 生成结果是结构化 JSON（DeepSeek response_format: json_object），不再靠正则解析 Markdown
 * - 结果按平台流式（SSE）返回，哪个平台先跑完就先推给前端，不用等全部平台
 * - "知识库"用 Cloudflare Vectorize 做语义检索（Workers AI 的 bge-m3 生成向量），由 Cron Trigger 定时抓取刷新
 * - 每次生成结果落一份到 D1，对应 PRD 里一直没做的"历史记录"能力
 * - 各平台 Prompt 的文案要求承袭 workflow/prompts/*.md 里验证过的版本，只是把输出格式从 Markdown 换成 JSON
 */

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-flash';
const TAVILY_API_URL = 'https://api.tavily.com/search';
const EMBEDDING_MODEL = '@cf/baai/bge-m3'; // 多语言 embedding，配中文知识库更合适

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

/* ── SSE：把一个异步生成过程包装成 text/event-stream 响应 ── */

function sseResponse(runner) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const send = async (event, data) => {
    await writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  };
  (async () => {
    try {
      await runner(send);
    } catch (err) {
      await send('error', { error: err.message || String(err) });
    } finally {
      await writer.close();
    }
  })();
  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...CORS_HEADERS,
    },
  });
}

/* ── DeepSeek 调用 ── */

async function callDeepSeek(env, systemPrompt, userPrompt, opts = {}) {
  const body = {
    model: DEEPSEEK_MODEL,
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.maxTokens ?? 2048,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt || '请开始处理。' },
    ],
  };
  if (opts.json) body.response_format = { type: 'json_object' };

  const res = await fetch(DEEPSEEK_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`DeepSeek ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

function extractJson(text) {
  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/, '')
    .replace(/```\s*$/, '')
    .trim();
  return JSON.parse(cleaned);
}

// DeepSeek 的 json_object 模式是"尽力而为"，不保证完全符合我们要的 schema，
// 所以这里统一做一次防御性解析，解析失败时把原始输出的前 200 字带出来方便排查。
async function callDeepSeekJSON(env, system, user, opts = {}) {
  const raw = await callDeepSeek(env, system, user, { ...opts, json: true });
  try {
    return extractJson(raw);
  } catch (e) {
    throw new Error(`JSON 解析失败：${e.message}；原始输出前 200 字：${raw.slice(0, 200)}`);
  }
}

async function tavilySearch(env, query) {
  if (!env.TAVILY_API_KEY) return '';
  try {
    const res = await fetch(TAVILY_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: env.TAVILY_API_KEY,
        query,
        search_depth: 'advanced',
        include_answer: 'advanced',
      }),
    });
    if (!res.ok) return '';
    const data = await res.json();
    if (data.answer) return data.answer;
    return (data.results || []).slice(0, 5).map((r) => r.content).join('\n\n');
  } catch {
    return '';
  }
}

/* ── 知识库：Workers AI 生成 embedding + Vectorize 语义检索 ──
 * 替代原来 Dify 的 RAG 节点 / 上一版用 KV 存文本再精确匹配 key 的做法。
 */

async function embed(env, texts) {
  const resp = await env.AI.run(EMBEDDING_MODEL, { text: texts });
  return resp.data; // number[][]，与 texts 一一对应
}

async function queryKnowledge(env, queryText, { type, platform, topK = 4 } = {}) {
  if (!env.VECTORIZE || !env.AI) return '';
  try {
    const [vector] = await embed(env, [queryText]);
    // 多查一些再按 metadata 过滤，因为 Vectorize 这边没有按 metadata 精确筛选再排序的能力保证
    const result = await env.VECTORIZE.query(vector, { topK: topK * 3, returnMetadata: 'all' });
    const matches = (result.matches || [])
      .filter((m) => {
        if (type && m.metadata?.type !== type) return false;
        if (platform && m.metadata?.platform && m.metadata.platform !== platform) return false;
        return true;
      })
      .slice(0, topK);
    return matches.map((m) => m.metadata?.text || '').filter(Boolean).join('\n\n');
  } catch {
    return '';
  }
}

/* ── Prompt 构造：延续 workflow/prompts/*.md 里验证过的文案要求，输出格式从 Markdown 改成 JSON ── */

function buildStructurePrompt({ productName, productFeatures, kbContext, seoTrends }) {
  const system = `你是资深的跨境电商产品分析师。请根据提供的电商热词上下文（Context）和用户输入的产品信息，为产品提取结构化的核心卖点、痛点以及应用场景。

【电商热词参考】：
${kbContext || '（暂无）'}

【谷歌 SEO 热搜趋势】：
${seoTrends || '（暂无）'}

请以 JSON 格式输出，严格遵循以下结构，不要输出任何 JSON 之外的文字：
{
  "features": ["核心卖点1", "核心卖点2"],
  "painPoints": ["用户痛点1", "用户痛点2"],
  "hookIdeas": ["视频钩子建议1", "视频钩子建议2"],
  "scenarios": ["应用场景1", "应用场景2"]
}`;
  const user = `产品名称：${productName}\n产品特性：${productFeatures}\n\n请进行卖点结构化提取，以 JSON 输出。`;
  return { system, user };
}

const PLATFORM_PROMPTS = {
  amazon: {
    useContext: true,
    system: (rules) => `你是亚马逊 Listing（产品详情页）优化专家。请严格遵循以下平台规则生成文案。

【平台规则】：
${rules || '（暂无）'}

请以 JSON 格式输出，严格遵循以下结构，不要输出任何 JSON 之外的文字：
{
  "title": "标题：包含核心词+品牌+属性+场景，长度控制在 80-200 字符",
  "bulletPoints": [
    {"heading": "小标题", "description": "具体描述"}
  ],
  "productDescription": "段落形式的详细产品描述"
}
bulletPoints 需要正好 5 条。

## 规则检查清单
- 标题和文案中必须包含：核心词、品牌、属性、场景。
- 严禁出现 sale/discount 等促销违规词汇。`,
    user: (productName, structured) => `产品名称：${productName}

结构化卖点参考（JSON）：
${JSON.stringify(structured)}

请根据以上卖点生成 Amazon Listing 文案，以 JSON 输出。`,
  },
  shopee: {
    useContext: true,
    system: (rules) => `你是 Shopee（虾皮）资深运营和爆款文案专家。请严格遵循以下平台规则生成文案。

【平台规则参考】：
${rules || '（暂无）'}

请以 JSON 格式输出，严格遵循以下结构，不要输出任何 JSON 之外的文字：
{
  "title": "商品标题：必须包含精准长尾词（搜索量较小但转化率高），尽量填满120字符",
  "coreSellingPoint": "一句话核心卖点，加上显眼的🔥或⭐Emoji",
  "features": ["详细特性1", "详细特性2", "详细特性3"],
  "promotionTags": ["Ready Stock/现货", "Fast Shipping/极速发货"]
}

## 风格要求
- 语言口语化、热情，善用分隔符（如【】、｜、-）和 Emoji。
- 强烈突出产品的性价比、现货发售和售后保障。`,
    user: (productName, structured) => `产品名称：${productName}

请仔细阅读以下结构化卖点参考（JSON），提取核心痛点和功能，为我生成 Shopee 商品详情文案，以 JSON 输出：

${JSON.stringify(structured)}`,
  },
  tiktok: {
    useContext: true,
    system: (rules) => `你是 TikTok 短视频脚本专家。

【平台规则参考】：
${rules || '（暂无）'}

请以 JSON 格式输出，严格遵循以下结构，不要输出任何 JSON 之外的文字：
{
  "caption": "引人注目的视频标题",
  "hashtags": ["#fyp", "#产品词"],
  "audioScript": "80-150字的口播内容，必须口语化，适合真人发音",
  "timeline": [
    {"time": "0-5s", "label": "开场钩子", "content": "展示悬念/痛点/好奇/对比/紧迫感"},
    {"time": "5-15s", "label": "痛点展示", "content": "点出用户面临的困扰"},
    {"time": "15-35s", "label": "产品解决方案与效果", "content": "展示产品如何解决痛点"},
    {"time": "35-50s", "label": "行动指令 CTA", "content": "引导 follow/like/comment 或购买"}
  ]
}
总时长控制在 60 秒内，用时间轴逼模型按注意力分配组织内容，而不是按产品功能逻辑。`,
    user: (productName, structured) => `产品：${productName}

请仔细阅读以下【结构化卖点参考】（JSON），重点提取其中的痛点和钩子建议，为我生成 TikTok 短视频脚本，以 JSON 输出：

${JSON.stringify(structured)}`,
  },
  shein: {
    // 与原设计一致：SHEIN 分支不接知识库 context
    useContext: false,
    system: () => `你是 SHEIN 的高级时尚与生活方式文案策划（Copywriter）。

请以 JSON 格式输出，严格遵循以下结构，不要输出任何 JSON 之外的文字：
{
  "styleNotes": "1-2句话描述这件产品的时尚氛围或生活方式感",
  "details": ["材质/设计细节1", "材质/设计细节2", "材质/设计细节3"],
  "scenarios": "推荐穿着/使用的场景，如 Perfect for a weekend getaway",
  "searchKeywords": ["核心词1", "核心词2", "核心词3", "核心词4", "核心词5"]
}

## 风格要求
- 语气要充满灵感、自信、走在潮流前线（Trendy）。
- 大量使用感官词汇（视觉/听觉/触觉），具体描述产品带来的身体和心理感受。`,
    user: (productName, structured) => `产品名称：${productName}

请仔细阅读以下结构化卖点参考（JSON），重点提取应用场景和核心卖点，为我生成 SHEIN 风格的文案，以 JSON 输出：

${JSON.stringify(structured)}`,
  },
};

function buildLocalizationPrompt(lang, baseCopyObj) {
  const system = `你是资深的跨境电商本地化（Localization）翻译专家。请将以下 JSON 格式的产品文案翻译成目标语言：${lang}，并进行符合当地文化和电商搜索习惯的深度微调。

【待翻译文案（JSON）】：
${JSON.stringify(baseCopyObj)}

## 语言本地化要求
- **印尼语**：使用 "diskon besar"（大促）、"gratis ongkir"（包邮）等本土高频促销词。
- **泰语**：句末自然地添加礼貌助词 "ครับ/ค่ะ"，使用 "ส่งฟรี" 表示包邮。
- **西班牙语**：使用 "ofertas"（特价）、"envío gratis"（免运费）等词汇。
- **英语**：如果目标语言是英语，请直接对原文进行母语级别（Native-level）的语法和地道表达润色。
- **其他语言**：请严格遵循当地主流电商平台的常用营销话术。

## 输出要求
1. **严格保持 JSON 结构**：字段名（key）必须和原文完全一致，只翻译字段的值（value）；数组元素个数保持不变。
2. **忠于原意**：严禁随意增减原文的核心卖点和痛点逻辑。
3. **只输出 JSON**：不要输出任何解释或前缀，不要用 \`\`\`json 代码块包裹。`;
  return { system, user: '请开始处理，以 JSON 输出。' };
}

/* ── Amazon 违禁词校验（真正可执行的检查，取代纯 Prompt 自检） ──
 * Prompt 末尾的"规则检查清单"能把违规率从 ~15% 降到接近 0，但不是 0——
 * 模型偶尔还是会漏。这里用一次真实的正则检查兜底：查到了就带着违规词
 * 明确告诉模型再生成一次，而不是假设 Prompt 自检一定生效。
 */
const AMAZON_BANNED_WORDS = [
  'sale', 'discount', 'deal', 'promotion', 'best', 'guarantee', '#1', 'free shipping',
];

function findBannedWords(text) {
  const lower = text.toLowerCase();
  return AMAZON_BANNED_WORDS.filter((w) => lower.includes(w));
}

async function generateAmazonCopy(env, system, user) {
  let raw = await callDeepSeek(env, system, user, { json: true });
  const hits = findBannedWords(raw);
  if (hits.length) {
    const retryUser = `${user}\n\n【重新生成】上一次输出里出现了违禁词：${hits.join('、')}。请在不改变卖点结构的前提下换一种说法，确保 JSON 里完全不包含这些词，仍然只输出 JSON。`;
    raw = await callDeepSeek(env, system, retryUser, { json: true });
  }
  try {
    return extractJson(raw);
  } catch (e) {
    throw new Error(`JSON 解析失败：${e.message}；原始输出前 200 字：${raw.slice(0, 200)}`);
  }
}

/* ── D1：生成历史记录 ── */

async function saveHistory(env, { requestId, productName, productFeatures, platform, langMap }) {
  if (!env.DB) return;
  await env.DB.prepare(
    `INSERT INTO generations (id, request_id, created_at, product_name, product_features, platform, result_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(crypto.randomUUID(), requestId, Date.now(), productName, productFeatures, platform, JSON.stringify(langMap))
    .run();
}

async function handleHistory(request, env) {
  if (!env.DB) return json({ items: [] });
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get('limit')) || 20, 100);
  const { results } = await env.DB.prepare(
    `SELECT id, request_id, created_at, product_name, platform, result_json
     FROM generations ORDER BY created_at DESC LIMIT ?`
  )
    .bind(limit)
    .all();
  return json({ items: results || [] });
}

/* ── 主流程 ── */

function splitLanguages(raw) {
  if (Array.isArray(raw)) return raw.map((s) => String(s).trim()).filter(Boolean);
  if (!raw) return ['English'];
  return String(raw).split(/[,，;；、]/).map((s) => s.trim()).filter(Boolean);
}

async function handleGenerateSSE(request, env, send) {
  let body;
  try {
    body = await request.json();
  } catch {
    await send('error', { error: 'invalid JSON body' });
    return;
  }

  const productName = (body.productName || '').trim();
  const productFeatures = (body.productFeatures || '').trim();
  const platforms = (Array.isArray(body.platforms) ? body.platforms : [body.platforms]).filter(
    (p) => PLATFORM_PROMPTS[p]
  );
  const languages = splitLanguages(body.targetLanguages);

  if (!productName || !productFeatures) {
    await send('error', { error: 'productName 和 productFeatures 为必填项' });
    return;
  }
  if (!platforms.length) {
    await send('error', { error: '至少选择一个受支持的平台：amazon/shopee/tiktok/shein' });
    return;
  }

  const requestId = crypto.randomUUID();

  await send('status', { stage: 'researching' });
  const [kbContext, seoTrends] = await Promise.all([
    queryKnowledge(env, `${productName} ${productFeatures}`, { type: 'keywords' }),
    tavilySearch(env, `${productName} e-commerce SEO trends, best selling features and consumer pain points`),
  ]);

  await send('status', { stage: 'structuring' });
  const sp = buildStructurePrompt({ productName, productFeatures, kbContext, seoTrends });
  const structured = await callDeepSeekJSON(env, sp.system, sp.user);
  await send('structured', { data: structured });

  await Promise.all(
    platforms.map(async (plat) => {
      try {
        const cfg = PLATFORM_PROMPTS[plat];
        const rules = cfg.useContext
          ? await queryKnowledge(env, `${productName} ${productFeatures}`, { type: 'rules', platform: plat })
          : '';
        const system = cfg.system(rules);
        const user = cfg.user(productName, structured);
        const baseCopy = plat === 'amazon'
          ? await generateAmazonCopy(env, system, user)
          : await callDeepSeekJSON(env, system, user);

        const langEntries = await Promise.all(
          languages.map(async (lang) => {
            const loc = buildLocalizationPrompt(lang, baseCopy);
            const localized = await callDeepSeekJSON(env, loc.system, loc.user);
            return [lang, localized];
          })
        );
        const langMap = Object.fromEntries(langEntries);

        await send('platform', { platform: plat, data: langMap });
        await saveHistory(env, { requestId, productName, productFeatures, platform: plat, langMap }).catch(() => {});
      } catch (err) {
        await send('platformError', { platform: plat, error: err.message || String(err) });
      }
    })
  );

  await send('done', { requestId });
}

/* ── 知识库定时刷新：抓取 → 清洗 → 分块 → embedding → 存入 Vectorize ──
 * 取代 Dify 知识库流水线的自动化更新方案（见 docs/architecture.md）。
 */

// 按需替换成真实的目标页面；key 格式为 "type:platform"（platform 对 keywords 类型没有实际过滤意义，写 general 即可）
const KB_SOURCES = {
  'rules:amazon': [],
  'rules:shopee': [],
  'rules:tiktok': [],
  'keywords:general': [],
};

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function chunkText(text, size = 500, overlap = 50) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size - overlap) {
    chunks.push(text.slice(i, i + size));
    if (i + size >= text.length) break;
  }
  return chunks;
}

function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

async function refreshKnowledgeBase(env) {
  if (!env.VECTORIZE || !env.AI) return;
  const vectors = [];
  for (const [sourceKey, urls] of Object.entries(KB_SOURCES)) {
    if (!urls.length) continue;
    const [type, platform] = sourceKey.split(':');
    for (const url of urls) {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': 'CopyFlowBot/1.0' } });
        if (!res.ok) continue;
        const text = stripHtml(await res.text()).slice(0, 20000);
        const chunks = chunkText(text);
        if (!chunks.length) continue;
        const vecs = await embed(env, chunks);
        chunks.forEach((chunk, i) => {
          vectors.push({
            id: `${sourceKey}:${hashString(url)}:${i}`,
            values: vecs[i],
            metadata: { type, platform, text: chunk, sourceUrl: url },
          });
        });
      } catch {
        // 单个源抓取失败不影响其他源
      }
    }
  }
  if (vectors.length) await env.VECTORIZE.upsert(vectors);
}

/* ── Worker 入口 ── */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }
    if (url.pathname === '/api/generate' && request.method === 'POST') {
      return sseResponse((send) => handleGenerateSSE(request, env, send));
    }
    if (url.pathname === '/api/history' && request.method === 'GET') {
      return handleHistory(request, env);
    }
    if (url.pathname === '/api/health') {
      return json({ ok: true });
    }
    return json({ error: 'not found' }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshKnowledgeBase(env));
  },
};
