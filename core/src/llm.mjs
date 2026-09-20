const API_URL = 'https://api.deepseek.com/chat/completions';
export const DEFAULT_MODEL = 'deepseek-flash';

/** 密钥只从环境变量读取，代码里不存、不打印、不写入任何输出文件 */
export function getApiKey(env = process.env) {
  return env.DEEPSEEK_API_KEY || null;
}

// 仅供测试：把请求指向本机的假服务器。只允许 localhost/127.0.0.1，绝不允许把密钥发往其他地址
function resolveApiUrl(env = process.env) {
  const override = env.COPYFLOW_TEST_API_URL;
  if (!override) return API_URL;
  const { hostname } = new URL(override);
  if (hostname !== '127.0.0.1' && hostname !== 'localhost') throw new Error('COPYFLOW_TEST_API_URL 只允许指向 localhost');
  return override;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 创建一个 chat 函数：chat({ system, user, json, temperature, maxTokens }) => 模型返回的文本
 * fetchImpl 与 retryDelayMs 可注入，便于不联网测试。
 */
export function createChat({ apiKey, model = DEFAULT_MODEL, fetchImpl = fetch, retryDelayMs = 1000, retries = 2, onResponse, thinking, reasoningEffort } = {}) {
  if (!apiKey) throw new Error('缺少 DEEPSEEK_API_KEY：请在终端里设置环境变量后再运行');

  // 思考开启（含默认）时推理 token 占用输出上限，实测 4096 会被截断，故给 8192；关闭思考时输出很短，2048 足够
  const defaultMaxTokens = thinking === 'disabled' ? 2048 : 8192;

  return async function chat({ system, user, json = true, temperature = 0, maxTokens = defaultMaxTokens }) {
    const body = {
      model,
      temperature,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    };
    if (json) body.response_format = { type: 'json_object' };
    // deepseek-flash 默认开启思考，推理 token 会占用 max_tokens 且使 temperature 失效；传 'disabled' 可关闭
    if (thinking) body.thinking = { type: thinking };
    if (reasoningEffort) body.reasoning_effort = reasoningEffort;

    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(retryDelayMs);
      let res;
      try {
        res = await fetchImpl(resolveApiUrl(), {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(90_000),
        });
      } catch (e) {
        lastError = new Error(`DeepSeek 请求失败：${e.message}`);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`DeepSeek ${res.status}（可重试）`);
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`DeepSeek ${res.status}：${text.slice(0, 200)}`);
      }
      const data = await res.json();
      const choice = data.choices?.[0];
      const content = choice?.message?.content?.trim();
      // 诊断信息（不含密钥）：结束原因与 token 用量，用来判断空内容是被截断还是接口偶发
      onResponse?.({ finish_reason: choice?.finish_reason ?? null, usage: data.usage ?? null, content_length: content?.length ?? 0 });
      // 被截断且没有任何内容：原样重试只会再被截断一次，直接报错并提示原因，不空耗请求
      if (!content && choice?.finish_reason === 'length') {
        throw new Error(`DeepSeek 输出被截断（finish_reason=length，completion_tokens=${data.usage?.completion_tokens ?? '未知'}），请调大 maxTokens 或关闭思考`);
      }
      // 官方文档提示 API 偶尔返回空内容，按可重试处理
      if (!content) {
        lastError = new Error(`DeepSeek 返回了空内容（finish_reason=${choice?.finish_reason ?? '未知'}，completion_tokens=${data.usage?.completion_tokens ?? '未知'}）`);
        continue;
      }
      return content;
    }
    throw lastError;
  };
}

/** DeepSeek 的 json_object 模式是"尽力而为"，统一做防御性解析 */
export function parseJsonLoose(text) {
  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/, '')
    .replace(/```\s*$/, '')
    .trim();
  return JSON.parse(cleaned);
}
