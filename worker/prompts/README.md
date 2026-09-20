# Prompt 库

本目录是 `../src/index.js` 里 `PLATFORM_PROMPTS` / `buildStructurePrompt` / `buildLocalizationPrompt` 对应 Prompt 的可读版本，方便脱离代码单独阅读和复用。

这些 Prompt 最早是在 Dify 工作流里逐轮迭代验证出来的（设计思路、踩坑记录见 [`../../docs/prompt-engineering.md`](../../docs/prompt-engineering.md)），现在已经把输出格式从 Markdown 改成 JSON（配合 DeepSeek 的 `response_format: json_object` 结构化输出），文件内容已同步更新为当前实际使用的版本。

| 文件 | 用途 | 对应代码 |
|---|---|---|
| [`01-卖点结构化.md`](01-卖点结构化.md) | 三源数据 → 四维结构化卖点 | `buildStructurePrompt` |
| [`02-amazon.md`](02-amazon.md) | SEO + 合规双约束的 Listing | `PLATFORM_PROMPTS.amazon` |
| [`03-shopee.md`](03-shopee.md) | 长尾词 + Emoji + 本土促销词 | `PLATFORM_PROMPTS.shopee` |
| [`04-tiktok.md`](04-tiktok.md) | 带时间轴的口播脚本 | `PLATFORM_PROMPTS.tiktok` |
| [`05-shein.md`](05-shein.md) | 生活方式感 + 感官词汇 | `PLATFORM_PROMPTS.shein` |
| [`06-本地化翻译.md`](06-本地化翻译.md) | 本地化编辑，逐语种翻译 | `buildLocalizationPrompt` |

`{context}` / `{结构化卖点}` 这类占位符对应代码里的模板字符串变量，实际请求时会替换成知识库检索结果、上一步结构化输出等真实内容。
