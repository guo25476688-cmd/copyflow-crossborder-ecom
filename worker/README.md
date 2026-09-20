# CopyFlow API（Cloudflare Worker）

> **当前状态**：这是一套完整、可部署的架构实现，用来证明"key 不下发到浏览器、商家不用自己配置任何东西"这个设计是可行的——但目前**没有对外部署运营**，不是一个正在运行的线上服务。想实际体验的话需要自己按下面步骤部署。

取代原型阶段的 Dify 工作流，把生成逻辑和 DeepSeek / Tavily 的 key 都收在这个 Worker 里——浏览器端永远不会看到任何密钥，架构上支持商家直接用、不用自己配置任何 API endpoint/key。

## 技术栈

全部是 Cloudflare 自家服务，零运维、免费额度够个人项目用：

| 能力 | 用的什么 | 取代了什么 |
|---|---|---|
| 生成编排 | Worker 本身（普通 JS） | Dify 可视化工作流 |
| 结构化输出 | DeepSeek `response_format: json_object` | 靠 Prompt 要求 Markdown + 前端正则解析（容易格式坍塌） |
| 流式返回 | SSE（`ReadableStream`），哪个平台先跑完先推给前端 | 等全部平台跑完才一次性返回 |
| 知识库检索 | Vectorize（向量库）+ Workers AI（`bge-m3` 生成 embedding） | Dify RAG 节点 / 纯关键词文本匹配 |
| 生成历史 | D1（Cloudflare 的 serverless SQLite） | 无（原型一直没做这块） |

## 部署步骤

```bash
cd worker
npm install -g wrangler   # 如果还没装
wrangler login

# 1. 创建 Vectorize 索引（bge-m3 输出 1024 维向量，用 cosine 相似度）
wrangler vectorize create copyflow-kb --dimensions=1024 --metric=cosine

# 2. 创建 D1 数据库，把返回的 database_id 填进 wrangler.toml
wrangler d1 create copyflow-db
wrangler d1 execute copyflow-db --remote --file=migrations/0001_init.sql

# 3. 配置密钥（只存在 Cloudflare，不会进代码库）
wrangler secret put DEEPSEEK_API_KEY
wrangler secret put TAVILY_API_KEY

# 4. 部署
wrangler deploy
```

`[ai]` 绑定（Workers AI）不需要额外创建，`wrangler.toml` 里声明了就能用。部署完成后会得到一个形如 `https://copyflow-api.<your-subdomain>.workers.dev` 的地址——这就是 `prototype/index.html` 里"configure"填的 API base URL。

## 接口

### `POST /api/generate`（SSE 流式）

请求体：

```json
{
  "productName": "HoverGo Pro",
  "productFeatures": "无线蓝牙耳机，主动降噪，续航30小时",
  "platforms": ["amazon", "shopee"],
  "targetLanguages": "English, Indonesian"
}
```

返回 `Content-Type: text/event-stream`，按顺序推送这些事件：

| event | data | 说明 |
|---|---|---|
| `status` | `{"stage":"researching"}` / `{"stage":"structuring"}` | 进度提示 |
| `structured` | `{"data":{...四维结构化卖点}}` | 卖点结构化的中间结果 |
| `platform` | `{"platform":"amazon","data":{"English":{...},"Indonesian":{...}}}` | 某个平台全部语言都生成完，立刻推送，不用等其他平台 |
| `platformError` | `{"platform":"amazon","error":"..."}` | 某个平台失败不影响其他平台继续 |
| `done` | `{"requestId":"..."}` | 全部完成 |
| `error` | `{"error":"..."}` | 请求级别的错误（比如必填字段缺失） |

每个平台 `data` 字段的具体 JSON 结构因平台而异（比如 Amazon 是 `{title, bulletPoints, productDescription}`，TikTok 是 `{caption, hashtags, audioScript, timeline}`），对应 `src/index.js` 里 `PLATFORM_PROMPTS` 各自的 schema 说明。

前端消费方式见 [`../prototype/index.html`](../prototype/index.html) 里的 `streamGenerate()`——用 `fetch` + `response.body.getReader()` 手动解析 SSE（原生 `EventSource` 不支持 POST 带 body，所以没法直接用）。

### `GET /api/history?limit=20`

返回最近的生成记录（存在 D1 里），用于以后做历史记录页：

```json
{ "items": [{ "id": "...", "request_id": "...", "created_at": 1758000000000, "product_name": "HoverGo Pro", "platform": "amazon", "result_json": "{...}" }] }
```

目前只有这个数据接口，`prototype/` 里还没有对应的历史记录页面 UI（PRD 里的 P1 需求，数据层已经就绪，界面留作后续）。

### `GET /api/health`

存活检查，返回 `{"ok": true}`。

## 知识库自动更新

`src/index.js` 里的 `KB_SOURCES` 是一个 `{"type:platform": [URL...]}` 的映射，目前是空数组占位。填入真实的目标页面（比如各平台官方内容规范页）后：

- `scheduled()` 会按 `wrangler.toml` 里 `crons` 配置的节奏（默认每周一）抓取页面 → 清洗 HTML → 按 500 字切块 → 用 `bge-m3` 生成 embedding → 存进 Vectorize
- `handleGenerateSSE` 会用当前产品信息做语义检索（`queryKnowledge`），按 `type`（`rules`/`keywords`）和 `platform` 过滤出最相关的几段，注入对应平台的 Prompt

清洗逻辑目前只是简单剥离 HTML 标签（`stripHtml`），够用但比较粗糙；如果发现抓取内容质量不好，可以针对具体目标站点加更精细的正则或用 `unstructured` 之类的解析库替换。

## 本地调试

```bash
cd worker
wrangler dev
```

会在本地起一个开发服务器，`.dev.vars` 文件（自建，不要提交到 git）里可以放：

```
DEEPSEEK_API_KEY=sk-xxx
TAVILY_API_KEY=tvly-xxx
```

Vectorize/D1/Workers AI 在 `wrangler dev` 下也有对应的本地模拟，具体行为以 Wrangler 当时的版本文档为准。

## 成本

Cloudflare Workers / Vectorize / D1 / Workers AI 都有免费额度，个人项目/早期阶段基本不会超。DeepSeek/Tavily 按量计费，具体看调用次数——这是唯一需要留意别被刷爆的地方，所以现阶段不建议把部署好的地址公开出去（详见根目录 README「局限与下一步」）。
