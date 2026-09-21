# 趋势词快照

每天用 GitHub Actions 跑一次：**Tavily 搜公开网页 → DeepSeek 摘录词 → 逐词做原文校验 → 存成 JSON**，供第 5 步生成 Listing 时参考。

## 它是什么，不是什么

- 是"近期公开网页的搜索结果里出现过这些商品词"，每个词都带**来源链接和原文摘录**。
- **不是**搜索量、销量或增长排行：Tavily 是网页搜索，没有这类数据。快照文件里的 `label` 和 `note` 是契约里的常量，改不了。
- 词只做**参考**，不进入事实层：产品事实只能来自卖家输入。

## 每个词的 `signal`：是"出现过"还是"来源说它流行"

由**代码**判断，不是模型：摘录里出现该市场"热度用语表"（`config.json` 的 `trend_words`，如 trending、viral、naik daun、terlaris）里的词，就标 `stated_trending`，否则标 `mentioned`。

- `stated_trending` 只表示**来源自己这么说**，不是我们核实过的事实；
- `mentioned` 只表示词在网页里出现过，多数词是这一种；
- 只看摘录，不看整条结果的其他部分；词内片段不算（trendsetter 不算 trend，hotel 不算 hot）。

## 怎么保证词不是模型编的

和事实提取同一思路，**确定性校验、不靠另一个模型**：

1. 模型只能摘录，每个词必须给出 `evidence`（从搜索结果标题或正文一字不差复制的片段）和 `source_id`。
2. 代码校验：`evidence` 必须是该条结果的子串（忽略大小写与空白）；词必须在 `evidence` 里；`evidence` 必须比词本身更长（只复制词本身、菜单导航里的一个词不算）；`evidence` ≤ 300 字符。
3. 词只允许字母、数字和少量连接符（搜索结果是不可信的网页文本，不让链接、标记、指令片段混进词表）；不含平台名；≤ 40 字符。
4. 没通过的词直接丢弃，按原因分类计入 `rejected_reasons`（`evidence_not_in_source`、`term_not_in_evidence`、`evidence_is_just_term`、`bad_chars`、`platform_name`、`duplicate`、`over_limit` 等），各项之和等于 `rejected_terms`，不会悄悄进入快照。

## 已知的质量局限（2026-09-21 两次真实试跑观察）

- 印尼类目的来源多是社交帖子和商店页面，噪声大；英文类目多是评测与编辑内容，质量明显更好。
- 词的粒度仍有波动：提示词要求完整的具体短语，但偶尔会出现被截断的碎片（如 `neck`）或笼统词，代码目前无法可靠识别，只能靠提示词。
- 品牌名、同义词、包含关系（如 `body mist` 与 `hair and body mist`）也无法确定性识别，只靠提示词要求。
- "摘录必须比词更长"只能挡住摘录等于词本身，挡不住商店导航菜单被整段当摘录（如 `TOYS + Balls & Chasers + Catnip Toys`）或只多一个 "Rekomendasi" 的标题式摘录。
- `signal` 只看摘录那一句：一篇标题就叫 "pet industry trends" 的文章，只要摘录的那一句没出现热度用语，词仍是 `mentioned`。这是有意的保守（宁可少标，不夸大），代价是会漏标。
- 商店自己的品类页文案（如 "our dog beds and mattresses…"）也会被摘录成词，它们只说明这个商店卖这些，不是趋势信号，都是 `mentioned`。
- 词可能撞上合规红线（如"治脱发"类补充剂）：**第 5 步使用这些词时，必须先过规则引擎，不能直接喂给生成。**

## 预算

默认配置每天 27 次 basic 搜索（每次 1 点数）≈ 每月 810 点数，在 Tavily 免费额度 1000 点数/月内。`npm test` 会校验配置预算不超过 900。查看计划：

```bash
node trends/snapshot.mjs --dry-run
```

## 本地试跑

密钥只放环境变量（在自己终端里 export），不要写进任何文件：

```bash
export TAVILY_API_KEY=...
export DEEPSEEK_API_KEY=...
node trends/snapshot.mjs /tmp/trend-out --markets id-ID --categories kecantikan   # 只跑一个类目，消耗 3 点数
```

**手动分开跑不同类目时请用不同的输出目录**：文件名是当天日期，同一目录里后一次会覆盖前一次（定时任务一次跑完全部类目，不受影响）。

退出码：0 全部成功；1 有类目失败（快照照常写出）；2 参数或密钥问题。

## 每天自动运行

工作流：`.github/workflows/trend-snapshot.yml`，每天 UTC 01:17（北京时间 09:17）运行，也可以在 Actions 页面手动触发（`workflow_dispatch`）。

**一次性设置**（在 GitHub 仓库 Settings → Secrets and variables → Actions → New repository secret）：

| 名称 | 内容 |
|---|---|
| `TAVILY_API_KEY` | 你的 Tavily 密钥（`tvly-` 开头） |
| `DEEPSEEK_API_KEY` | 你的 DeepSeek 密钥 |

设置好后，先在 Actions 页面手动触发一次，确认结果再依赖定时。

**结果存在哪**：`trend-data` 分支的 `snapshots/` 目录（`YYYY-MM-DD.json` 与 `latest.json`），不进入 `main`，避免每天一条提交污染主线历史。

**已知限制**：

- GitHub 官方说明：公开仓库 60 天内没有仓库活动，定时工作流会被自动禁用；定时任务也可能在整点等高负载时段延迟，甚至被丢弃。所以别把它当作"必定每天有数据"，也别把缺一天当成故障。
- 定时任务只在默认分支（`main`）上运行，所以工作流文件必须合并到 `main` 才会生效。
- 额度用尽（Tavily 返回 432/433）或密钥失效（401）时任务会停止后续搜索、已完成的类目照常保存，并以红色失败提示你。
- 快照里的 `evidence` 是不超过 300 字符的短摘录，并附来源链接，仅用于可追溯校验。

## 改查询词

编辑 `config.json` 里的 `queries` 即可（每类目 1-3 条）。查询词只是默认值，需要你按真实选品方向调整；改完跑 `npm test`。
