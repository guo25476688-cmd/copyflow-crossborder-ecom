# CopyFlow 原型

单文件 Web 原型（`index.html`，无构建、无依赖），调用 [CopyFlow API](../worker/)（Cloudflare Worker + DeepSeek）生成文案。原型早期版本对接的是 Dify 工作流，历史设计记录见 [`../docs/workflow-design.md`](../docs/workflow-design.md)。

## 在线 Demo

> 部署在 GitHub Pages：`https://<你的用户名>.github.io/copyflow-crossborder-ecom/`

默认进入**演示模式**：不需要任何配置，数据为预置样例（产品 `HoverGo Pro`），可完整体验「一次输入 → 四平台差异化文案 + 英语/印尼语双语对比」的流程。点击输入区的 **load example** 一键预填。

## 本地运行

```bash
cd prototype
python3 -m http.server 7788
# 打开 http://localhost:7788
```

## 接入真实 CopyFlow API

点右上角 **configure**，填入部署好的 [CopyFlow API](../worker/) 地址（如 `https://copyflow-api.your-name.workers.dev`）。**不需要填任何 key**——DeepSeek/Tavily 的 key 只存在 Worker 的 secret 里，浏览器端和这个原型都接触不到。

原型对每个选中的平台调用一次 `POST {url}/api/generate`，解析返回的 `platforms.{platform}.{language}`（各语种 Markdown 文案）后按平台 Tab + 语种 Tab 渲染。

## 已实现 / 未实现

| 已实现 | 未实现（见 [PRD 4.5](../docs/PRD.md#45-原型与-prd-的差异诚实记录)） |
|---|---|
| 三种输入模式（表单 / URL / 自由文本） | 历史记录页 |
| 四平台并行生成 + 骨架屏进度 | 商品主图预览 UI |
| 平台 Tab + 语种 Tab 结果对比 | 合规违禁词可视化标红 |
| 分区块复制、演示模式 | 质量反馈 👍👎 埋点 |

## 技术说明

- 纯静态：HTML + 原生 JS + Canvas（首屏文字艺术与代码雨），Google Fonts 外链
- 设计风格：深色、编辑排版感（editorial），呼应「文字渡洋 / Language as Vessel」主题
- 历史迭代版本（`app.js` / `style.css`）已归档，不在仓库内
