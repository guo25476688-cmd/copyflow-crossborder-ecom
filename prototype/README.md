# CopyFlow 原型

单文件 Web 原型（`index.html`，无构建、无依赖），把 [Dify 工作流](../workflow/) 封装成可交互的产品界面。

## 在线 Demo

> 部署在 GitHub Pages：`https://<你的用户名>.github.io/copyflow-crossborder-ecom/`

默认进入**演示模式**：不需要任何配置，数据为预置样例（产品 `HoverGo Pro`），可完整体验「一次输入 → 四平台差异化文案 + 英语/印尼语双语对比」的流程。点击输入区的 **load example** 一键预填。

## 本地运行

```bash
cd prototype
python3 -m http.server 7788
# 打开 http://localhost:7788
```

## 接入真实 Dify 工作流

点右上角 **configure**，填入：

- **Dify API endpoint**：如 `http://your-server/v1`
- **Workflow API key**：`app-xxxxxxxx`

原型会以 `blocking` 模式调用 `POST {endpoint}/workflows/run`，每个平台一次请求并行发出，解析 `data.outputs.output`（多语种数组）后按平台 Tab + 语种 Tab 渲染。API Key 仅存于浏览器 `localStorage`，不上传。

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
