# 规则集

平台合规规则，**只收录能在官方页面找到原文的内容**，每条规则都带来源链接、章节和查询日期。官方没写的，不臆造，而是列在各规则集的 `unverified` 里。

| 规则集 | 平台 × 市场 | 规则数 | 查询日期 |
|---|---|---|---|
| `amazon-us.json` | Amazon 美国站 × en-US | 20 | 2026-09-20 |
| `shopee-id.json` | Shopee 印尼站 × id-ID | 3 | 2026-09-20 |
| `tiktok-us.json` | TikTok Shop 美国站 × en-US（仅商品 Listing 文字） | 25 | 2026-09-21 |

## 依据等级（`patterns[].basis`）

| 等级 | 含义 | 严重程度 |
|---|---|---|
| `official_example` | 官方原文点名的短语，如 "free shipping"、"best"、"eco-friendly" | 沿用规则自身等级 |
| `official_category` | 官方点名的类别，但检测方式是启发式（如用正则识别电话、网址、HTML） | 沿用规则自身等级 |
| `derived` | 我基于官方精神的推断，如 "#1"、"on sale" | **一律只给警告** |

## 检查类型

`max_length` · `min_length`（描述按 描述+要点 合计）· `forbidden_patterns` · `forbidden_chars` · `max_word_repeat` · `title_case` · `all_caps` · `non_latin_script` · `emoji` · `claim_needs_fact`（命中声称，且事实表里找不到依据才报）· `mixed_script`（同一词混用拉丁与西里尔/希腊字母）· `title_includes_brand` · `bullet_starts_capital` · `count_range`

新增规则 = 在 JSON 里加一条；新增检查类型 = 在 `src/rules.mjs` 的 `checks` 里加一个函数。

## 更新规则

平台政策会变（Amazon 标题上限就在 2026 年 7 月从 200 改成了 75）。更新时重新读官方页面，改规则、改 `version` 与 `retrieved_at`，并跑 `npm test`——测试会检查每条规则的来源域名和依据等级。

## 措辞决定严重程度

同一份官方页面里，“must / do not / prohibited” 的写为错误，“should / avoid / recommended” 的写为警告。例如 TikTok 美国站的标题长度、描述 500 字符出自官方“建议”，只给警告；描述不少于 30 词、全大写、站外链接出自 Policy 标准，报错。
