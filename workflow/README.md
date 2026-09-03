# Dify 工作流

[`多平台跨境电商文案及图片生成.yml`](多平台跨境电商文案及图片生成.yml) 是可直接导入 [Dify](https://dify.ai) 的工作流 DSL（`version: 0.6.0`）。

## 导入方式

1. Dify 控制台 → 工作室 → 导入 DSL 文件 → 选择该 `.yml`
2. 补齐依赖插件：`langgenius/openrouter`、`langgenius/tavily`
3. 配置密钥：OpenRouter API Key、Tavily API Key
4. 重建节点 `检索_电商热词` 引用的 4 个知识库（见下），或临时关闭该节点

## 工作流结构

![Dify 工作流画布](../docs/assets/dify-workflow-canvas.png)

完整节点讲解见 [`../docs/workflow-design.md`](../docs/workflow-design.md)；各节点 Prompt 原文见 [`prompts/`](prompts/)。

```
用户输入 ─┬─→ 检索_电商热词 (RAG) ──┐
          ├─→ Tavily Search (实时SEO) ┤→ 提取_卖点结构化 ─→ 条件分支 ─┬→ Amazon 文案 ─┐
          └─→ 字符串分割成数组 ─────────────────────────────────────┤→ Shopee 文案 ─┤
                                        │                          ├→ TikTok 脚本 ─┼→ 变量聚合器 ─→ 翻译_多语种(迭代) ─→ 输出
                                        │                          └→ SHEIN 文案 ──┘
                                        └─→ 生成_图片Prompt ─→ HTTP 请求(文生图) ────────────────────────────────────────→ 输出
```

## 依赖的知识库（4 个）

| 知识库 | 内容 |
|---|---|
| 电商关键词库 | 通用关键词列表、加权转化优先级、术语表、类别-关键词映射 |
| 平台规则参考库 | 各平台格式规范、语气要求、禁止内容、类别内容优先级 |
| 抖音挂钩库 | 按类型和产品类别组织的挂钩模板 |
| SHEIN 场景标签库 | 生活方式场景与风格描述符 |

> 知识库原始语料不含在本仓库中。`dataset_ids` 为占位，导入后需替换为你自己的知识库 ID。

## 模型与成本

原型阶段通过 OpenRouter 接入**免费模型**（`arcee-ai/trinity-large-preview:free`、`minimax/minimax-m2.5:free`），目的是零成本验证 Prompt 设计与工作流架构，代价是速率受限、输出稳定性偏低。产品化阶段的模型选型权衡见 [`../docs/PRD.md`](../docs/PRD.md#83-技术架构概述产品化方向)。
