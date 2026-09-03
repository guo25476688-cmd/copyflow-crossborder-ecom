# Prompt 清单（从 Dify 工作流抽取）

本目录是工作流中每个 LLM 节点的 **System / User Prompt 原文**，与
[`../多平台跨境电商文案及图片生成.yml`](../多平台跨境电商文案及图片生成.yml) 一一对应，便于阅读和复用。

Prompt 背后的**设计思路、踩坑记录与权衡**见
[`../../docs/prompt-engineering.md`](../../docs/prompt-engineering.md)。

| 文件 | 对应节点 | 作用 | temperature |
|---|---|---|---|
| [`01-卖点结构化.md`](01-卖点结构化.md) | 提取_卖点结构化 | 三源数据 → 四维结构化卖点 | 0.7 |
| [`02-amazon.md`](02-amazon.md) | Amazon 文案 | SEO + 合规双约束的 Listing | 0.7 |
| [`03-shopee.md`](03-shopee.md) | Shopee 文案 | 长尾词 + Emoji + 本土促销词 | 0.7 |
| [`04-tiktok.md`](04-tiktok.md) | TikTok 脚本 | 带时间轴的口播脚本 | 0.7 |
| [`05-shein.md`](05-shein.md) | SHEIN 文案 | 生活方式感 + 感官词汇 | 0.7 |
| [`06-本地化翻译.md`](06-本地化翻译.md) | 翻译_多语种（迭代节点内 LLM） | 本地化编辑，逐语种沙箱翻译 | 0.7 |
| [`07-配图prompt.md`](07-配图prompt.md) | 生成_图片Prompt | 产品主图的英文绘图 Prompt | 0.7 |

> 变量占位符说明：`{{#context#}}` 为知识检索节点召回的电商术语/平台规则；
> `{{#<节点ID>.text#}}` 为上游节点输出；`{{#1775032454128.xxx#}}` 为「用户输入」节点的字段。
