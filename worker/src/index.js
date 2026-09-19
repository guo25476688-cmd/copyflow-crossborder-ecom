/**
 * CopyFlow API — Cloudflare Worker
 *
 * 用一个 Worker 取代原型阶段的 Dify 工作流：
 * - DeepSeek / Tavily 的 key 只存在 Worker 的 secret 里，浏览器端永远看不到
 * - "知识库" 就是 KV 里的几段文本，由 Cron Trigger 定时抓取刷新（见 scheduled()）
 * - 各平台 Prompt 直接照搬 workflow/prompts/*.md 里验证过的版本，未改写文案本身
 */

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-flash';
const TAVILY_API_URL = 'https://api.tavily.com/search';

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

async function callDeepSeek(env, systemPrompt, userPrompt, temperature = 0.7) {
  const res = await fetch(DEEPSEEK_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      temperature,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt || '请开始处理。' },
      ],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`DeepSeek ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
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

async function getKnowledge(env, key) {
  if (!env.COPYFLOW_KB) return '';
  const value = await env.COPYFLOW_KB.get(key);
  return value || '';
}

/* ── Prompt 构造：逐字复用 workflow/prompts/*.md 里验证过的版本 ── */

function buildStructurePrompt({ productName, productFeatures, kbContext, seoTrends }) {
  const system = `你是资深的跨境电商产品分析师。请根据提供的电商热词上下文（Context）和用户输入的产品信息，为产品提取结构化的核心卖点、痛点以及应用场景。

【电商热词参考】：
${kbContext || '（暂无）'}

【谷歌 SEO 热搜趋势】：
${seoTrends || '（暂无）'}

请结合电商热词和 SEO 趋势，将结果以清晰的层级结构输出，确保包含：核心卖点（Features）、用户痛点（Pain Points）、视频钩子建议（Hook Ideas）和应用场景（Scenarios）。`;
  const user = `产品名称：${productName}\n产品特性：${productFeatures}\n\n请进行卖点结构化提取。`;
  return { system, user };
}

const PLATFORM_PROMPTS = {
  amazon: {
    useContext: true,
    system: (rules) => `你是亚马逊 Listing（产品详情页）优化专家。请严格遵循以下平台规则生成纯文本排版的文案，切勿使用 JSON 格式。

【平台规则】：
${rules || '（暂无）'}

## 输出要求
请使用清晰的 Markdown 格式输出，包含以下结构：

### 标题 (Title)
[在此输出标题：要求包含核心词+品牌+属性+场景，长度控制在 80-200 字符]

### 五点描述 (Bullet Points)
* **[小标题1]**：[具体描述]
* **[小标题2]**：[具体描述]
* **[小标题3]**：[具体描述]
* **[小标题4]**：[具体描述]
* **[小标题5]**：[具体描述]

### 产品描述 (Product Description)
[在此用段落形式输出具有吸引力的详细产品描述]

## 规则检查清单
- 标题和文案中必须包含：核心词、品牌、属性、场景。
- 严禁出现 sale/discount 等促销违规词汇。`,
    user: (productName, structured) => `产品名称：${productName}

结构化卖点参考：
${structured}

请根据以上卖点生成 Amazon Listing 文案。`,
  },
  shopee: {
    useContext: true,
    system: (rules) => `你是 Shopee（虾皮）资深运营和爆款文案专家。请严格遵循以下平台规则生成纯文本排版的文案，切勿使用 JSON 格式。

【平台规则参考】：
${rules || '（暂无）'}

## 输出要求
请使用清晰的 Markdown 格式输出，包含以下结构：

### 商品标题
[在此输出标题：必须包含精准的长尾词（Long-tail keywords，即搜索量较小但转化率高的具体搜索词），尽量填满120字符]

### 核心卖点
[一句话核心卖点，加上显眼的🔥或⭐Emoji]

### 详细特性 (Features)
* [卖点1]
* [卖点2]
* [卖点3]

### 促销与服务标签 (Promotion Tags)
[标签1（如 Ready Stock/现货）] ｜ [标签2（如 Fast Shipping/极速发货）]

## 风格要求
- 语言口语化、热情，善用分隔符（如【】、｜、-）和 Emoji（表情符号）。
- 强烈突出产品的性价比、现货发售和售后保障。`,
    user: (productName, structured) => `产品名称：${productName}

请仔细阅读以下结构化卖点参考，提取核心痛点和功能，为我生成 Shopee 商品详情文案：

【结构化卖点参考】：
${structured}`,
  },
  tiktok: {
    useContext: true,
    system: (rules) => `你是 TikTok 短视频脚本专家。请生成纯文本排版的短视频脚本，切勿使用 JSON 格式。

【平台规则参考】：
${rules || '（暂无）'}

## 输出要求
请使用清晰的 Markdown 格式输出，包含以下结构：

### 视频标题与标签 (Caption & Hashtags)
[引人注目的视频标题]
[3-5个热门标签，如 #fyp #产品词]

### 完整口播脚本 (Audio Script)
[在此输出 80-150 字的口播内容，必须口语化，适合真人发音]

## 脚本结构（总时长控制在 60 秒内）
- **0-5秒：开场钩子 (Hook)**：[展示悬念/痛点/好奇/对比/紧迫感，迅速抓住眼球，30字符内]
- **5-15秒：痛点展示**：[点出用户面临的困扰]
- **15-35秒：产品解决方案与效果**：[展示产品如何解决痛点]
- **35-50秒：行动指令 (CTA - Call to Action)**：[引导用户进行 follow/关注、like/点赞、comment/评论 或购买]`,
    user: (productName, structured) => `产品：${productName}

请仔细阅读以下【结构化卖点参考】，重点提取其中的痛点（Pain Points）和钩子建议（Hook Ideas），为我生成 TikTok 短视频脚本：

【结构化卖点参考】：
${structured}`,
  },
  shein: {
    // 与原设计一致：SHEIN 分支不接知识库 context
    useContext: false,
    system: () => `你是 SHEIN 的高级时尚与生活方式文案策划（Copywriter）。请生成纯文本排版的文案，切勿使用 JSON 格式。

## 输出要求
请使用清晰的 Markdown 格式输出，包含以下结构：

### 风格笔记 (Style Notes)
[用 1-2 句话，描述这件产品的时尚氛围或生活方式感]

### 材质与设计细节 (Details)
* [材质/设计细节 1]
* [材质/设计细节 2]
* [材质/设计细节 3]

### 推荐场景 (Scenarios)
[推荐穿着/使用的场景，如：Perfect for a weekend getaway]

### 核心搜索词 (Search Keywords)
[5个核心词，用逗号分隔]

## 风格要求
- 语气要充满灵感、自信、走在潮流前线（Trendy）。
- 大量使用感官词汇（Sensory words，即能调动视觉、听觉、触觉等感官体验的形容词），具体描述产品带来的身体和心理感受。`,
    user: (productName, structured) => `产品名称：${productName}

请仔细阅读以下结构化卖点参考，重点提取其中的应用场景（Scenarios）和核心卖点（Features），为我生成 SHEIN 风格的文案：

【结构化卖点参考】：
${structured}`,
  },
};

function buildLocalizationPrompt(lang, baseCopy) {
  const system = `你是资深的跨境电商本地化（Localization）翻译专家。请将以下产品文案翻译成目标语言：${lang}，并进行符合当地文化和电商搜索习惯的深度微调。

【待翻译文案】：
${baseCopy}

## 语言本地化要求
- **印尼语**：使用 "diskon besar"（大促）、"gratis ongkir"（包邮）等本土高频促销词。
- **泰语**：句末自然地添加礼貌助词 "ครับ/ค่ะ"，使用 "ส่งฟรี" 表示包邮。
- **西班牙语**：使用 "ofertas"（特价）、"envío gratis"（免运费）等词汇。
- **英语**：如果目标语言是英语，请直接对原文进行母语级别（Native-level）的语法和地道表达润色（Polishing）。
- **其他语言**：请严格遵循当地主流电商平台（Marketplace）的常用营销话术。

## 输出要求
1. **严格保持排版**：必须保留原文的 Markdown 层级和排版格式（例如 \`###\` 标题分隔符、\`*\` 列表项目符号、Emoji 以及粗体等）。
2. **忠于原意**：严禁随意增减原文的核心卖点（Features）和痛点（Pain points）逻辑。
3. **纯文本直出**：直接输出翻译并优化后的文案结果，**绝对不要**使用任何 JSON 代码块，也**不要**输出诸如"好的，这是您的翻译"之类的废话（Filler words）。`;
  return { system, user: '请开始处理。' };
}

function buildImagePrompt({ productName, productFeatures, structured }) {
  const system = `你是一位专业的电商商品摄影导演和AI图像提示词专家。
根据产品信息，生成一段适合生成高质量电商主图的英文提示词（Prompt）。

## 要求
- 纯白背景，产品居中摆放
- 专业商业摄影风格，打光均匀
- 突出产品核心外观特征与使用场景
- 英文输出，不超过120词
- 只输出Prompt本身，不要任何解释、标题或前缀`;
  const user = `产品名称：${productName}
产品特性：${productFeatures}
卖点参考：${structured}

请生成适合此产品的电商主图英文Prompt。`;
  return { system, user };
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
  let copy = await callDeepSeek(env, system, user);
  const hits = findBannedWords(copy);
  if (hits.length) {
    const retryUser = `${user}\n\n【重新生成】上一次输出里出现了违禁词：${hits.join('、')}。请在不改变卖点结构的前提下换一种说法，确保正文完全不包含这些词。`;
    copy = await callDeepSeek(env, system, retryUser);
  }
  return copy;
}

/* ── 主流程 ── */

function splitLanguages(raw) {
  if (Array.isArray(raw)) return raw.map((s) => String(s).trim()).filter(Boolean);
  if (!raw) return ['English'];
  return String(raw).split(/[,，;；、]/).map((s) => s.trim()).filter(Boolean);
}

async function handleGenerate(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }

  const productName = (body.productName || '').trim();
  const productFeatures = (body.productFeatures || '').trim();
  const category = body.category || 'general';
  const platforms = (Array.isArray(body.platforms) ? body.platforms : [body.platforms]).filter(
    (p) => PLATFORM_PROMPTS[p]
  );
  const languages = splitLanguages(body.targetLanguages);

  if (!productName || !productFeatures) {
    return json({ error: 'productName 和 productFeatures 为必填项' }, 400);
  }
  if (platforms.length === 0) {
    return json({ error: '至少选择一个受支持的平台：amazon/shopee/tiktok/shein' }, 400);
  }

  try {
    const [kbContext, seoTrends] = await Promise.all([
      getKnowledge(env, `keywords:${category}`).then((v) => v || getKnowledge(env, 'keywords:general')),
      tavilySearch(
        env,
        `${productName} e-commerce SEO trends, best selling features and consumer pain points`
      ),
    ]);

    const structurePrompt = buildStructurePrompt({ productName, productFeatures, kbContext, seoTrends });
    const structured = await callDeepSeek(env, structurePrompt.system, structurePrompt.user);

    const platformResults = {};
    await Promise.all(
      platforms.map(async (plat) => {
        const cfg = PLATFORM_PROMPTS[plat];
        const rules = cfg.useContext ? await getKnowledge(env, `rules:${plat}`) : '';
        const system = cfg.system(rules);
        const user = cfg.user(productName, structured);
        const baseCopy = plat === 'amazon'
          ? await generateAmazonCopy(env, system, user)
          : await callDeepSeek(env, system, user);

        const langEntries = await Promise.all(
          languages.map(async (lang) => {
            const loc = buildLocalizationPrompt(lang, baseCopy);
            const text = await callDeepSeek(env, loc.system, loc.user);
            return [lang, text];
          })
        );
        platformResults[plat] = Object.fromEntries(langEntries);
      })
    );

    let imagePrompt = null;
    try {
      const ip = buildImagePrompt({ productName, productFeatures, structured });
      imagePrompt = await callDeepSeek(env, ip.system, ip.user);
    } catch {
      // 配图是锦上添花，失败不影响主流程
    }

    return json({ platforms: platformResults, imagePrompt });
  } catch (err) {
    return json({ error: err.message || String(err) }, 502);
  }
}

/* ── 知识库定时刷新（取代 Dify 知识库流水线，见 docs/workflow-design.md §8） ── */

// 按需替换成真实的目标页面；每个 key 对应一批 URL，抓取正文合并后存入 KV
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
    .trim()
    .slice(0, 6000);
}

async function refreshKnowledgeBase(env) {
  if (!env.COPYFLOW_KB) return;
  for (const [key, urls] of Object.entries(KB_SOURCES)) {
    if (!urls.length) continue;
    const texts = await Promise.all(
      urls.map(async (url) => {
        try {
          const res = await fetch(url, { headers: { 'User-Agent': 'CopyFlowBot/1.0' } });
          if (!res.ok) return '';
          return stripHtml(await res.text());
        } catch {
          return '';
        }
      })
    );
    const merged = texts.filter(Boolean).join('\n\n---\n\n');
    if (merged) await env.COPYFLOW_KB.put(key, merged);
  }
}

/* ── Worker 入口 ── */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }
    if (url.pathname === '/api/generate' && request.method === 'POST') {
      return handleGenerate(request, env);
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
