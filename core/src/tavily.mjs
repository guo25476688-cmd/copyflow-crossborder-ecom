const API_URL = 'https://api.tavily.com/search';

export const getTavilyKey = (env = process.env) => env.TAVILY_API_KEY || null;

// 仅供测试：把请求指向本机的假服务器。只允许 localhost/127.0.0.1，绝不允许把密钥发往其他地址
function resolveUrl(env = process.env) {
  const override = env.COPYFLOW_TEST_TAVILY_URL;
  if (!override) return API_URL;
  const { hostname } = new URL(override);
  if (hostname !== '127.0.0.1' && hostname !== 'localhost') throw new Error('COPYFLOW_TEST_TAVILY_URL 只允许指向 localhost');
  return override;
}

/** 密钥无效或额度用尽：继续请求只会白白失败，调用方应当停止后续搜索 */
export class FatalSearchError extends Error {}

/** Tavily 的 published_date 格式不统一（如 “Thu, 17 Sep 2026 19:00:00 GMT”），统一成 UTC 日期；解析不了就不带日期 */
export function toIsoDate(value) {
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString().slice(0, 10);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Tavily 搜索客户端（官方文档：POST /search，Bearer 认证，basic 深度每次 1 点数）。
 * search({ query, country, timeRange, maxResults }) => [{ title, url, content, published_date? }]
 * 错误信息里不含密钥；fetchImpl 与 retryDelayMs 可注入，便于不联网测试。
 */
export function createTavily({ apiKey, fetchImpl = fetch, retries = 2, retryDelayMs = 1000, onSearch } = {}) {
  if (!apiKey) throw new Error('缺少 TAVILY_API_KEY：请在终端或 GitHub Secrets 里设置后再运行');

  return async function search({ query, country, timeRange = 'week', maxResults = 8 }) {
    const body = { query, search_depth: 'basic', topic: 'general', time_range: timeRange, max_results: maxResults, include_published_date: true, include_answer: false };
    if (country) body.country = country;

    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(retryDelayMs);
      let res;
      try {
        res = await fetchImpl(resolveUrl(), {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        });
      } catch (e) {
        lastError = new Error(`Tavily 请求失败：${e.message}`);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`Tavily ${res.status}（可重试）`);
        continue;
      }
      if (res.status === 401) throw new FatalSearchError('Tavily 401：密钥缺失或无效');
      if (res.status === 432 || res.status === 433) throw new FatalSearchError(`Tavily ${res.status}：套餐额度已用尽`);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Tavily ${res.status}：${text.slice(0, 200)}`);
      }
      const data = await res.json();
      onSearch?.(query);
      return (data.results || [])
        .filter((r) => r && typeof r.url === 'string' && /^https?:\/\//.test(r.url))
        .map((r) => {
          const date = r.published_date ? toIsoDate(String(r.published_date)) : undefined;
          return { title: String(r.title ?? ''), url: r.url, content: String(r.content ?? ''), ...(date ? { published_date: date } : {}) };
        });
    }
    throw lastError;
  };
}
