# CopyFlow API（Cloudflare Worker）

> **当前状态**：这是一套完整、可部署的架构实现，用来证明"key 不下发到浏览器、商家不用自己配置任何东西"这个设计是可行的——但目前**没有对外部署运营**，不是一个正在运行的线上服务。想实际体验的话需要自己按下面步骤部署。

取代原型阶段的 Dify 工作流，把生成逻辑和 DeepSeek / Tavily 的 key 都收在这个 Worker 里——浏览器端永远不会看到任何密钥，架构上支持商家直接用、不用自己配置任何 API endpoint/key。

## 为什么换掉 Dify

- 原型阶段用 Dify 做可视化编排验证 Prompt，达到了目的（详见 [../docs/workflow-design.md](../docs/workflow-design.md) 里保留的历史设计记录）
- 但要给真实商家用，浏览器直连 Dify workflow API + 把 key 存在 localStorage 是不安全也不现实的；本地自建 Dify 又要拖一整套 Docker 服务，运维成本对个人项目太重
- 这里的"知识库"本质是几份关键词表/平台规则清单，规模小、结构固定，不需要 Dify 那套向量检索基建，一个 KV + 定时抓取就够

## 部署步骤

```bash
cd worker
npm install -g wrangler   # 如果还没装
wrangler login

# 1. 创建 KV 命名空间，把返回的 id 填进 wrangler.toml 的 kv_namespaces
wrangler kv namespace create COPYFLOW_KB

# 2. 配置密钥（只存在 Cloudflare，不会进代码库）
wrangler secret put DEEPSEEK_API_KEY
wrangler secret put TAVILY_API_KEY

# 3. 部署
wrangler deploy
```

部署完成后会得到一个形如 `https://copyflow-api.<your-subdomain>.workers.dev` 的地址——这就是 `prototype/index.html` 里"configure"填的 API base URL。

## 接口

### `POST /api/generate`

请求体：

```json
{
  "productName": "HoverGo Pro",
  "productFeatures": "无线蓝牙耳机，主动降噪，续航30小时",
  "category": "electronics",
  "platforms": ["amazon"],
  "targetLanguages": "English, Indonesian"
}
```

返回：

```json
{
  "platforms": {
    "amazon": {
      "English": "### Title\n...",
      "Indonesian": "### Judul\n..."
    }
  },
  "imagePrompt": "A sleek pair of wireless earbuds..."
}
```

`platforms` 目前支持 `amazon` / `shopee` / `tiktok` / `shein`，对应 [`../workflow/prompts/`](../workflow/prompts/) 里验证过的 4 套 Prompt，逐字复用未改写。

### `GET /api/health`

存活检查，返回 `{"ok": true}`。

## 知识库自动更新

`src/index.js` 里的 `KB_SOURCES` 是一个 `{KV key: [URL...]}` 的映射，目前是空数组占位。填入真实的目标页面（比如各平台官方内容规范页）后：

- `scheduled()` 会按 `wrangler.toml` 里 `crons` 配置的节奏（默认每周一）自动抓取、清洗、存入 KV
- `handleGenerate` 里对应平台的 Prompt 会自动读取这份 KV 内容作为 `{{平台规则}}` 注入

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

## 成本

Cloudflare Workers 免费额度每天 10 万次请求，个人项目/早期阶段基本不会超。DeepSeek/Tavily 按量计费，具体看调用次数。
