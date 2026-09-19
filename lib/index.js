import { SettingsConflictError, SettingsProvider } from "@deepseek-ai/dsh-settings";
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomInt } from "node:crypto";
import { exec } from "node:child_process";

const DDG_HTML_URL = "https://html.duckduckgo.com/html/";
const DDG_LITE_URL = "https://lite.duckduckgo.com/lite/";
const BING_URL = "https://www.bing.com/search";
const TAVILY_URL = "https://api.tavily.com/search";
const FIRECRAWL_URL = "https://api.firecrawl.dev/v2/search";
const PARALLEL_URL = "https://api.parallel.ai/v1/search";
const PARALLEL_MCP_URL = "https://search.parallel.ai/mcp";
const KEENABLE_URL = "https://api.keenable.ai/v1/search";
const KEENABLE_MCP_URL = "https://api.keenable.ai/mcp";
const SERPBASE_URL = "https://api.serpbase.dev/google/search";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const ACCEPT_LANG = "zh-CN,zh;q=0.9,en;q=0.8";

// 语言 → Bing 本地化档案：{ market, acceptLang }。
// lang 字段（设置页可切换）驱动 Bing 的 mkt + Accept-Language，让非中文用户
// 也能拿到本地化结果（俄语搜俄文等）。bingMarket 显式设置时优先于映射。
const LANG_PROFILES = {
  zh: { market: "zh-CN", acceptLang: "zh-CN,zh;q=0.9,en;q=0.8" },
  en: { market: "en-US", acceptLang: "en-US,en;q=0.9" },
  ru: { market: "ru-RU", acceptLang: "ru-RU,ru;q=0.9,en;q=0.8" },
  ja: { market: "ja-JP", acceptLang: "ja-JP,ja;q=0.9,en;q=0.8" },
  de: { market: "de-DE", acceptLang: "de-DE,de;q=0.9,en;q=0.8" },
  fr: { market: "fr-FR", acceptLang: "fr-FR,fr;q=0.9,en;q=0.8" },
  es: { market: "es-ES", acceptLang: "es-ES,es;q=0.9,en;q=0.8" },
  ko: { market: "ko-KR", acceptLang: "ko-KR,ko;q=0.9,en;q=0.8" },
};
// market → 语言（bingMarket 显式设置时反推 accept-language，避免中文优先 header 污染）
const MARKET_TO_LANG = {
  "zh-CN": "zh-CN,zh;q=0.9,en;q=0.8",
  "zh-TW": "zh-TW,zh;q=0.9,en;q=0.8",
  "en-US": "en-US,en;q=0.9",
  "en-GB": "en-GB,en;q=0.9",
  "ru-RU": "ru-RU,ru;q=0.9,en;q=0.8",
  "ja-JP": "ja-JP,ja;q=0.9,en;q=0.8",
  "de-DE": "de-DE,de;q=0.9,en;q=0.8",
  "fr-FR": "fr-FR,fr;q=0.9,en;q=0.8",
  "es-ES": "es-ES,es;q=0.9,en;q=0.8",
  "ko-KR": "ko-KR,ko;q=0.9,en;q=0.8",
};

const FREE_SEARCH_NS = "free-search";
const BRIDGE_PREFIX = "/api/dsh-free-search-settings";
const FREE_ENGINES = ["ddg", "ddg-lite", "bing", "searxng", "anysearch"];
const KEYLESS_ENGINES = ["bing", "anysearch", "ddg", "ddg-lite", "searxng", "exa", "tavily", "keenable", "parallel"];
const PAID_ENGINES = ["firecrawl", "perplexity", "serpbase", "deepseek-official"];
const ALL_ENGINES = [...KEYLESS_ENGINES, ...PAID_ENGINES];
const TIME_ENGINES = ["tavily", "exa", "keenable", "firecrawl", "parallel", "searxng", "ddg", "ddg-lite"];
const VAULT_MCP_URL = "https://fleet.vyibc.com/mcp/vault";
const PROVIDER_POOL_KEYS = {
  tavily: "dsh-web-search:provider:tavily",
  firecrawl: "dsh-web-search:provider:firecrawl",
};

// 当前插件版本（发布时与 package.json 同步）
const PLUGIN_VERSION = "0.4.34-vyibc.3";
// 检查更新的 npm registry 元数据地址（dsh-free-search 是 npmjs 上的公开包）
const NPM_REGISTRY_URL = "https://registry.npmjs.org/dsh-free-search/latest";
const PLUGIN_NPM_URL = "https://www.npmjs.com/package/dsh-free-search";
const PLUGIN_REPO_URL = "https://github.com/DDDMUC/dsh-free-search";

// 查询 npm registry 的最新版本；失败时返回 null（网络/代理问题不阻塞设置页）
async function fetchLatestVersion(signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const response = await fetch(NPM_REGISTRY_URL, {
      headers: { accept: "application/json", "user-agent": "deepseek-harness/free-search" },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data = await response.json();
    return typeof data.version === "string" ? data.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

// 简单的 semver 比较（仅处理 x.y.z 主/次/补丁，忽略预发布标签）；a>b 返回 1, a<b 返回 -1, 相等返回 0
function compareVersions(a, b) {
  const na = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const nb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((na[i] ?? 0) > (nb[i] ?? 0)) return 1;
    if ((na[i] ?? 0) < (nb[i] ?? 0)) return -1;
  }
  return 0;
}

// 检测插件的安装模式：遍历 profiles/*/node_modules/dsh-free-search，
// symlink（link: 本地开发）→ isLink=true；npm 真安装 → isLink=false；找不到 → null
function detectInstallMode() {
  const profilesDir = path.join(process.cwd(), "profiles");
  let found = null;
  try {
    for (const name of fs.readdirSync(profilesDir)) {
      const pkgPath = path.join(profilesDir, name, "node_modules", "dsh-free-search");
      if (!fs.existsSync(pkgPath)) continue;
      let isLink = false;
      try {
        isLink = fs.lstatSync(pkgPath).isSymbolicLink();
      } catch {}
      found = { profileDir: path.join(profilesDir, name), isLink };
      break;
    }
  } catch {}
  return found;
}

// time_range 支持：固定档 day/week/month/year，或自定义（相对 12h/3d/2mo/1y、绝对 YYYY-MM-DD）
const TIME_RANGES = ["day", "week", "month", "year"];
const DAYS_BY_RANGE = { day: 1, week: 7, month: 30, year: 365 };
const KEENABLE_REL = { day: "1d", week: "7d", month: "1mo", year: "1y" };
const SEARXNG_TIME = { day: "day", week: "week", month: "month", year: "year" };

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, ".000Z");
}

// 把用户/agent 给的 timeRange 解析成统一对象：{ days } 相对天数，或 { after } 绝对日期。
// 输入支持：day/week/month/year、12h/3d/2mo/1y、2026-07-01，或已解析的 {days}/{after} 对象。
// 无效返回 undefined。
function parseTimeRange(input) {
  if (input === undefined || input === null) return undefined;
  // 已解析对象：直接透传
  if (typeof input === "object") {
    if (typeof input.after === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.after)) return { after: input.after };
    if (typeof input.days === "number" && Number.isFinite(input.days) && input.days > 0) return { days: input.days };
    return undefined;
  }
  const s = String(input).trim().toLowerCase();
  if (s.length === 0) return undefined;
  if (TIME_RANGES.includes(s)) return { days: DAYS_BY_RANGE[s] };
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { after: s };
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(h|hour|hours|d|day|days|w|week|weeks|mo|month|months|y|year|years)$/);
  if (m) {
    const n = parseFloat(m[1]);
    const unit = m[2][0];
    const days =
      unit === "h" ? n / 24 : unit === "d" ? n : unit === "w" ? n * 7 : unit === "m" ? n * 30 : n * 365;
    return { days };
  }
  return undefined;
}

// 把自定义天数映射到只支持固定档的引擎（Tavily / SearXNG / DDG）的最近似档位
function approximateTimeRange(days) {
  if (days <= 2) return "day";
  if (days <= 14) return "week";
  if (days <= 90) return "month";
  return "year";
}

function decodeEntities(text) {
  return String(text)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

//#region 结果缓存（防限流/省额度，LRU 50 条，TTL 可配置 0-5 分钟）
const CACHE_MAX_ENTRIES = 50;
// fallback 条目（实际引擎 ≠ 首选引擎时）TTL = 配置 TTL 的 1/5（默认 5 分钟 → 60s）：
// 首选引擎恢复后最多 1 分钟即可拿到新结果，避免回退结果被完整 TTL 钉死；首选成功条目仍用完整 TTL。

function buildCacheKey(query, maxResults, timeRangeLabel, preferred) {
  return [query ?? "", maxResults ?? 5, timeRangeLabel ?? "", preferred].join("\u0000");
}
//#endregion

// 统一的 snippet 清洗：剔除登录/付费墙/订阅等噪音短语，折叠空白，限制长度。
// 只在回退链出口统一应用，各引擎内部不做，避免重复处理。
const SNIPPET_NOISE =
  /\b(sign up|sign in|log in|login|subscribe( to| for)?|member[- ]?only|become a member|create (a )?free account|read more|continue reading|story continues|get started|install (the )?app|view on|medium membership|join \w+ for free|get updates from this writer|stories in your inbox|remember me for|unlock this|free to read|become a patron)\b/gi;

function cleanSnippet(text) {
  if (!text) return text;
  return String(text)
    .replace(SNIPPET_NOISE, " ")
    .replace(/^\s*(#{1,6}\s*|\[\s*x?\s*\]\s*|-\s*\[\s*x?\s*\]\s*|>\s*)/gm, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function stripTags(html) {
  return decodeEntities(String(html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function extractDdgUrl(rel) {
  if (!rel) return null;
  const m = rel.match(/uddg=([^&]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return m[1];
    }
  }
  if (rel.startsWith("//")) return `https:${rel}`;
  return rel;
}

function uniqueSources(sources, limit) {
  const seen = new Set();
  const out = [];
  for (const s of sources) {
    if (s.url && !seen.has(s.url)) {
      seen.add(s.url);
      out.push(s);
    }
    if (out.length >= limit) break;
  }
  return out;
}

async function fetchHtml(url, signal, acceptLang) {
  // 单次请求超时 12s，避免挂起被当成 Connection error
  let response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort);
    response = await fetch(url, {
      headers: { "user-agent": USER_AGENT, "accept-language": acceptLang ?? ACCEPT_LANG },
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`connection error: ${error?.message ?? String(error)}`);
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url.split("?")[0]}`);
  }
  const html = await response.text();
  // DuckDuckGo 反爬验证页检测（HTTP 202 或验证关键字）
  if (response.status === 202 || /anomaly|captcha|unusual traffic|robot check/i.test(html.slice(0, 4000))) {
    throw new Error("DuckDuckGo is rate-limited right now (anti-bot challenge, usually temporary) - Bing works");
  }
  return html;
}

// 带重试的抓取：网络错误/空结果时重试，间隔 1.5s，最多 3 次
async function fetchHtmlWithRetry(url, signal, acceptLang) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const html = await fetchHtml(url, signal, acceptLang);
      if (html.length > 500) return html;
      lastError = new Error(`empty response (${html.length} bytes)`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw lastError ?? new Error("fetch failed");
}

async function searchDdgHtml(query, maxResults, options, signal) {
  const params = new URLSearchParams({ q: query });
  if (options?.region) params.set("kl", options.region);
  // DDG 安全搜索：off(adlt=-1) / moderate(adlt=0) / strict(adlt=1)
  const adlt = options?.safeSearch ?? "off";
  params.set("adlt", adlt === "strict" ? "1" : adlt === "moderate" ? "0" : "-1");
  // DDG 时间过滤：df=d/w/m/y（只支持固定档，自定义取近似档）
  if (options?.timeRange) {
    const df = { day: "d", week: "w", month: "m", year: "y" }[approximateTimeRange(options.timeRange.days ?? 7)];
    if (df) params.set("df", df);
  }
  const html = await fetchHtmlWithRetry(`${DDG_HTML_URL}?${params}`, signal);
  const blocks = html.match(/<div class="result results_links[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/g) ?? [];
  const sources = [];
  for (const block of blocks) {
    const urlMatch = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]*)"/);
    const titleMatch = block.match(/<a[^>]*class="result__a"[^>]*>(.*?)<\/a>/);
    const snippetMatch = block.match(/<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/);
    const dateMatch = block.match(/<span[^>]*>\s*([\dT:.+-]+)\s*<\/span>/);
    const url = extractDdgUrl(urlMatch?.[1]);
    if (!url) continue;
    sources.push({
      url,
      ...(titleMatch ? { title: stripTags(titleMatch[1]) } : {}),
      ...(snippetMatch ? { snippet: stripTags(snippetMatch[1]) } : {}),
      ...(dateMatch ? { publishedAt: dateMatch[1] } : {}),
    });
  }
  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}

async function searchDdgLite(query, maxResults, options, signal) {
  const params = new URLSearchParams({ q: query });
  const adlt = options?.safeSearch ?? "off";
  params.set("adlt", adlt === "strict" ? "1" : adlt === "moderate" ? "0" : "-1");
  // DDG Lite 同样支持 df 时间过滤
  if (options?.timeRange) {
    const df = { day: "d", week: "w", month: "m", year: "y" }[approximateTimeRange(options.timeRange.days ?? 7)];
    if (df) params.set("df", df);
  }
  const html = await fetchHtmlWithRetry(`${DDG_LITE_URL}?${params}`, signal);
  const linkMatches = html.match(/<a[^>]*class=['"]result-link['"][^>]*>[\s\S]*?<\/a>/g) ?? [];
  const snippetMatches = html.match(/class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g) ?? [];
  const sources = [];
  for (let i = 0; i < linkMatches.length; i++) {
    const tag = linkMatches[i];
    const hrefMatch = tag.match(/href="([^"]*)"/);
    const titleMatch = tag.match(/class=['"]result-link['"][^>]*>(.*?)<\/a>/);
    if (!hrefMatch) continue;
    const url = extractDdgUrl(hrefMatch[1]);
    if (!url) continue;
    const snippet = snippetMatches[i]?.match(/class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/)?.[1];
    sources.push({
      url,
      ...(titleMatch ? { title: stripTags(titleMatch[1]) } : {}),
      ...(snippet ? { snippet: stripTags(snippet) } : {}),
    });
  }
  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}

async function searchBing(query, maxResults, options, signal) {
  // mkt：显式 bingMarket 优先；否则按 lang 映射（zh→zh-CN, ru→ru-RU ...）
  const profile = LANG_PROFILES[options?.lang] ?? LANG_PROFILES.zh;
  const market = options?.bingMarket ?? profile.market;
  const params = new URLSearchParams({ q: query, mkt: market });
  // Accept-Language：显式 bingMarket 时按 market 反推（避免中文 header 污染），否则用 lang 档案
  const acceptLang = options?.bingMarket
    ? (MARKET_TO_LANG[market] ?? ACCEPT_LANG)
    : (profile.acceptLang ?? ACCEPT_LANG);
  const adlt = options?.safeSearch ?? "off";
  if (adlt === "off") params.set("adlt", "off");
  else if (adlt === "moderate") params.set("adlt", "moderate");
  else if (adlt === "strict") params.set("adlt", "strict");
  const html = await fetchHtmlWithRetry(`${BING_URL}?${params}`, signal, acceptLang);
  const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) ?? [];
  const sources = [];
  for (const block of blocks) {
    const hrefMatch = block.match(/<a[^>]*href="(https?:\/\/[^"]+)"/);
    const titleMatch = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*>(.*?)<\/a>[\s\S]*?<\/h2>/);
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    if (!hrefMatch) continue;
    sources.push({
      url: hrefMatch[1],
      ...(titleMatch ? { title: stripTags(titleMatch[1]) } : {}),
      ...(snippetMatch ? { snippet: stripTags(snippetMatch[1]) } : {}),
    });
  }
  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}

//#region searxng (meta-search, free instances, auto-failover)
const SEARXNG_INSTANCES = [
  "https://opnxng.com",
  "https://priv.au",
  "https://searx.be",
  "https://searx.tiekoetter.com",
  "https://search.inetol.net",
  "https://paulgo.io",
];

async function searchSearxng(query, maxResults, options, signal) {
  const instances = options?.searxngInstances?.length
    ? options.searxngInstances
    : SEARXNG_INSTANCES;
  // 聚合所有实例的失败原因，避免只显示最后一个实例的错误
  const errors = [];
  for (const base of instances) {
    try {
      const params = new URLSearchParams({ q: query, format: "json" });
      // SearXNG 原生支持 time_range 过滤（只支持固定档，自定义取近似档）
      if (options?.timeRange) {
        const tr = SEARXNG_TIME[approximateTimeRange(options.timeRange.days ?? 7)];
        if (tr) params.set("time_range", tr);
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const onAbort = () => ctrl.abort();
      signal?.addEventListener("abort", onAbort);
      const response = await fetch(`${base}/search?${params}`, {
        headers: { "user-agent": USER_AGENT, accept: "application/json" },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (!response.ok) {
        errors.push(`${base}: HTTP ${response.status}`);
        continue;
      }
      const data = await response.json().catch(() => null);
      if (!data || !Array.isArray(data.results)) {
        errors.push(`${base}: invalid JSON`);
        continue;
      }
      const sources = data.results
        .filter((r) => r.url)
        .map((r) => ({
          url: r.url,
          ...(r.title ? { title: String(r.title) } : {}),
          ...(r.content ? { snippet: String(r.content) } : {}),
        }));
      if (sources.length > 0) {
        return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
      }
      errors.push(`${base}: 0 results`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${base}: ${message}`);
    }
  }
  // 空实例列表兜底：避免 "all SearXNG instances failed: " 尾巴悬空
  const detail = errors.length > 0 ? errors.join(", ") : "no instances configured";
  // Note 会引用这个错误消息，截断避免 6 实例全挂时刷屏
  throw new Error(`all SearXNG instances failed: ${detail.slice(0, 300)}`);
}
//#endregion

//#region keyless engines (AnySearch / Exa MCP - free, no API key)
const ANYSEARCH_URL = "https://api.anysearch.com/v1/search";
const EXA_MCP_URL = "https://mcp.exa.ai/mcp";

// AnySearch: 免费匿名额度（无 key），结构化 JSON 结果
async function searchAnysearch(query, maxResults, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  let response;
  try {
    response = await fetch(ANYSEARCH_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, max_results: maxResults ?? 5 }),
      signal: controller.signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`AnySearch request failed: ${error?.message ?? String(error)}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  if (!response.ok) throw new Error(`AnySearch API error (HTTP ${response.status})`);
  const data = await response.json();
  if (data.code !== 0) throw new Error(`AnySearch API error: ${data.message ?? data.code}`);
  const results = data.data?.results ?? [];
  return {
    sources: results
      .filter((r) => r.url)
      .map((r) => ({
        url: r.url,
        ...(r.title ? { title: String(r.title) } : {}),
        ...(r.snippet ? { snippet: String(r.snippet).slice(0, 300) } : {}),
      })),
    truncated: false,
  };
}

// Exa MCP: 匿名公开 MCP（无 key），web_search_exa 工具
async function searchExaMCP(query, maxResults, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  let response;
  try {
    response = await fetch(EXA_MCP_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: { name: "web_search_exa", arguments: { query, numResults: maxResults ?? 5 } },
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`Exa MCP request failed: ${error?.message ?? String(error)}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  if (!response.ok) throw new Error(`Exa MCP error (HTTP ${response.status})`);
  const text = await response.text();
  // 解析 SSE 格式：event: message\ndata: {...}
  const lines = text.split("\n");
  let json = null;
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      try {
        json = JSON.parse(line.slice(6));
        break;
      } catch {}
    }
  }
  if (!json || json.error) {
    throw new Error(`Exa MCP error: ${json?.error?.message ?? "no data"}`);
  }
  const content = json.result?.content ?? [];
  const sources = [];
  const textBlocks = content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  // 解析 "Title: X\nURL: Y\nPublished: Z\nHighlights:\n..."
  const blocks = textBlocks.split(/\n(?=Title:)/);
  for (const block of blocks) {
    const title = block.match(/^Title: (.+)$/m)?.[1];
    const url = block.match(/^URL: (\S+)$/m)?.[1];
    const published = block.match(/^Published: (.+)$/m)?.[1];
    const highlights = block.split(/^Highlights:$/m)[1]?.split("\n").filter((l) => l.trim() && !l.trim().startsWith("...")).slice(0, 3).join(" ");
    if (!url) continue;
    sources.push({
      url,
      ...(title ? { title } : {}),
      ...(highlights ? { snippet: highlights.slice(0, 300) } : {}),
      // 只保留日期形态（ISO 或 YYYY-MM-DD），过滤 "N/A" 等占位符
      ...(published && /^\d{4}-\d{2}-\d{2}/.test(published) ? { publishedAt: published } : {}),
    });
  }
  return { sources, truncated: false };
}
//#endregion

//#region platform search (GitHub / V2EX / Bilibili / Reddit / HN / StackOverflow / Wikipedia / npm)
const PLATFORMS = {
  github: { name: "GitHub" },
  v2ex: { name: "V2EX" },
  bilibili: { name: "Bilibili" },
  reddit: { name: "Reddit" },
  hn: { name: "Hacker News" },
  stackoverflow: { name: "Stack Overflow" },
  wikipedia: { name: "Wikipedia" },
  npm: { name: "npm" },
};

async function searchGithub(query, maxResults, signal) {
  const response = await fetch(
    `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=${maxResults ?? 5}`,
    {
      headers: { "user-agent": USER_AGENT, accept: "application/vnd.github+json" },
      ...(signal !== undefined ? { signal } : {}),
    }
  );
  if (!response.ok) throw new Error(`GitHub API error (HTTP ${response.status})`);
  const data = await response.json();
  return {
    sources: (data.items ?? []).map((item) => ({
      url: item.html_url,
      title: item.full_name ?? item.name,
      snippet: `${item.description ?? ""}${item.stargazers_count ? ` ⭐${item.stargazers_count}` : ""}`.trim(),
    })),
    truncated: false,
  };
}

async function searchV2ex(query, maxResults, signal) {
  const response = await fetch("https://www.v2ex.com/api/topics/hot.json", {
    headers: { "user-agent": USER_AGENT },
    ...(signal !== undefined ? { signal } : {}),
  });
  if (!response.ok) throw new Error(`V2EX API error (HTTP ${response.status})`);
  const topics = await response.json();
  const q = query.toLowerCase();
  const matched = Array.isArray(topics)
    ? topics.filter((t) => (t.title ?? "").toLowerCase().includes(q) || (t.content ?? "").toLowerCase().includes(q))
    : [];
  return {
    sources: matched.slice(0, maxResults ?? 5).map((t) => ({
      url: `https://www.v2ex.com/t/${t.id}`,
      title: t.title,
      ...(t.content ? { snippet: String(t.content).slice(0, 200) } : {}),
    })),
    truncated: false,
  };
}

async function searchBilibili(query, maxResults, signal) {
  const response = await fetch(
    `https://api.bilibili.com/x/web-interface/search/all/v2?keyword=${encodeURIComponent(query)}`,
    {
      headers: { "user-agent": USER_AGENT, referer: "https://www.bilibili.com" },
      ...(signal !== undefined ? { signal } : {}),
    }
  );
  if (!response.ok) throw new Error(`Bilibili API error (HTTP ${response.status})`);
  const data = await response.json();
  if (data.code !== 0) throw new Error(`Bilibili API error: ${data.message ?? data.code}`);
  const sources = [];
  for (const section of data.data?.result ?? []) {
    for (const item of section.data ?? []) {
      if (!item.arcurl) continue;
      sources.push({
        url: item.arcurl,
        title: item.title ? String(item.title).replace(/<[^>]+>/g, "") : item.bvid,
        ...(item.desc ? { snippet: String(item.desc).slice(0, 200) } : {}),
      });
      if (sources.length >= (maxResults ?? 5)) break;
    }
    if (sources.length >= (maxResults ?? 5)) break;
  }
  return { sources, truncated: false };
}

async function searchReddit(query, maxResults, signal) {
  const response = await fetch(
    `https://old.reddit.com/search.json?q=${encodeURIComponent(query)}&limit=${maxResults ?? 5}&sort=relevance`,
    {
      headers: {
        "user-agent": `${USER_AGENT} (dsh-free-search; contact: github.com/DDDMUC)`,
        accept: "application/json",
      },
      ...(signal !== undefined ? { signal } : {}),
    }
  );
  if (!response.ok) throw new Error(`Reddit API error (HTTP ${response.status})`);
  const data = await response.json();
  return {
    sources: (data.data?.children ?? [])
      .map((c) => c.data)
      .filter((p) => p && p.url)
      .map((p) => ({
        url: p.url,
        title: p.title ?? "",
        ...(p.selftext ? { snippet: String(p.selftext).slice(0, 200) } : {}),
      })),
    truncated: false,
  };
}

async function searchHackerNews(query, maxResults, signal) {
  const response = await fetch(
    `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=${maxResults ?? 5}`,
    {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      ...(signal !== undefined ? { signal } : {}),
    }
  );
  if (!response.ok) throw new Error(`Hacker News API error (HTTP ${response.status})`);
  const data = await response.json();
  return {
    sources: (data.hits ?? [])
      .filter((h) => h.title || h.story_title)
      .map((h) => ({
        // 有外链用外链，纯讨论帖用 HN 讨论页
        url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
        title: h.title ?? h.story_title,
        ...((h.points !== undefined && h.points !== null) || (h.num_comments !== undefined && h.num_comments !== null)
          ? { snippet: `HN discussion · ${h.points ?? 0} points · ${h.num_comments ?? 0} comments` }
          : {}),
      })),
    truncated: false,
  };
}

async function searchStackOverflow(query, maxResults, signal) {
  const response = await fetch(
    `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(query)}&site=stackoverflow&pagesize=${maxResults ?? 5}&filter=!nNPvSNVZJS`,
    {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      ...(signal !== undefined ? { signal } : {}),
    }
  );
  if (!response.ok) throw new Error(`Stack Exchange API error (HTTP ${response.status})`);
  const data = await response.json();
  if (data.error_message) throw new Error(`Stack Exchange API error: ${data.error_message}`);
  return {
    sources: (data.items ?? []).map((it) => ({
      url: it.link,
      title: it.title,
      ...(it.score !== undefined || it.answer_count !== undefined
        ? { snippet: `${it.is_answered ? "✓ answered" : "unanswered"} · score ${it.score ?? 0} · ${it.answer_count ?? 0} answers` }
        : {}),
    })),
    truncated: false,
  };
}

async function searchWikipedia(query, maxResults, signal, lang) {
  const host = lang === "en" ? "en.wikipedia.org" : "zh.wikipedia.org";
  const response = await fetch(
    `https://${host}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=${maxResults ?? 5}`,
    {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      ...(signal !== undefined ? { signal } : {}),
    }
  );
  if (!response.ok) throw new Error(`Wikipedia API error (HTTP ${response.status})`);
  const data = await response.json();
  return {
    sources: (data.query?.search ?? []).map((s) => ({
      url: `https://${host}/wiki/${encodeURIComponent(String(s.title).replace(/ /g, "_"))}`,
      title: s.title,
      // snippet 含 <span class="searchmatch"> 高亮标签，剥掉
      ...(s.snippet ? { snippet: stripTags(s.snippet).slice(0, 200) } : {}),
    })),
    truncated: false,
  };
}

async function searchNpm(query, maxResults, signal) {
  const response = await fetch(
    `https://registry.npmjs.com/-/v1/search?text=${encodeURIComponent(query)}&size=${maxResults ?? 5}`,
    {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      ...(signal !== undefined ? { signal } : {}),
    }
  );
  if (!response.ok) throw new Error(`npm registry API error (HTTP ${response.status})`);
  const data = await response.json();
  return {
    sources: (data.objects ?? [])
      .map((o) => o.package)
      .filter((p) => p && p.name)
      .map((p) => ({
        url: p.links?.npm ?? `https://www.npmjs.com/package/${p.name}`,
        title: p.name,
        ...((p.description || p.version)
          ? { snippet: `v${p.version ?? "?"}${p.description ? ` — ${String(p.description).slice(0, 160)}` : ""}` }
          : {}),
      })),
    truncated: false,
  };
}

async function searchPlatform(platform, query, maxResults, signal, lang) {
  switch (platform) {
    case "github":
      return searchGithub(query, maxResults, signal);
    case "v2ex":
      return searchV2ex(query, maxResults, signal);
    case "bilibili":
      return searchBilibili(query, maxResults, signal);
    case "reddit":
      return searchReddit(query, maxResults, signal);
    case "hn":
      return searchHackerNews(query, maxResults, signal);
    case "stackoverflow":
      return searchStackOverflow(query, maxResults, signal);
    case "wikipedia":
      return searchWikipedia(query, maxResults, signal, lang);
    case "npm":
      return searchNpm(query, maxResults, signal);
    default:
      throw new Error(`unknown platform: ${platform}`);
  }
}
//#endregion

//#region paid engines (exa / tavily / perplexity / serpbase / deepseek-official)
async function searchExa(query, maxResults, apiKey, timeRange, signal) {
  if (!apiKey) throw new Error("Exa search requires EXA_API_KEY");
  const body = {
    query,
    type: "auto",
    contents: { highlights: { highlightsPerUrl: 1 } },
    ...(maxResults !== undefined ? { numResults: maxResults } : {}),
  };
  // Exa 时间过滤：startPublishedDate（ISO 日期；支持任意天数和绝对日期）
  if (timeRange) {
    if (timeRange.after) body.startPublishedDate = timeRange.after;
    else if (timeRange.days !== undefined) body.startPublishedDate = isoDaysAgo(timeRange.days);
  }
  const response = await fetch("https://api.exa.ai/search", {
    method: "POST",
    redirect: "error",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "deepseek-harness/free-search",
    },
    body: JSON.stringify(body),
    ...(signal !== undefined ? { signal } : {}),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 401) {
      throw new Error("Exa API key is invalid (HTTP 401) - update it in Settings > Plugins > Free Search");
    }
    if (response.status === 402) {
      throw new Error(`Exa quota/billing error (HTTP 402) - the key is valid, but its team has no usable credits or hit a usage limit; check usage/credits for the key's team at dashboard.exa.ai. ${detail.slice(0, 200)}`);
    }
    throw new Error(`Exa API error (HTTP ${response.status}): ${detail.slice(0, 200)}`);
  }
  const data = await response.json();
  const sources = (data.results ?? [])
    .map((result) => {
      const snippet = result.highlights?.find((h) => h.trim().length > 0);
      if (!snippet) return null;
      return {
        url: result.url,
        ...(result.title ? { title: result.title } : {}),
        snippet,
        ...(result.publishedDate ? { publishedAt: result.publishedDate } : {}),
      };
    })
    .filter(Boolean);
  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}

// Tavily: 有 key 走账号档；未配置时保留历史 keyless 兼容路径。
async function searchTavily(query, maxResults, apiKey, timeRange, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  let response;
  try {
    const body = {
      query,
      max_results: Math.min(maxResults ?? 5, 20),
      search_depth: "basic",
    };
    // Tavily 时间过滤：time_range 只支持固定档，自定义天数取最近似档位
    if (timeRange) {
      const tr = approximateTimeRange(timeRange.days ?? 7);
      if (tr) body.time_range = tr;
    }
    response = await fetch(TAVILY_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : { "x-tavily-access-mode": "keyless" }),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: "error",
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`Tavily request failed: ${error?.message ?? String(error)}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 401) {
      throw new Error("Tavily API key is invalid (HTTP 401) - update it in Settings > Plugins > Free Search");
    }
    throw new Error(`Tavily API error (HTTP ${response.status}): ${detail.slice(0, 200)}`);
  }
  const data = await response.json();
  const sources = (data.results ?? [])
    .filter((r) => r.url)
    .map((r) => ({
      url: r.url,
      ...(r.title ? { title: String(r.title) } : {}),
      ...(r.content ? { snippet: String(r.content).slice(0, 300) } : {}),
    }));
  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}

// Firecrawl: 使用官方 API；密钥优先来自 Fleet Vault 的 Provider 池。
const FIRECRAWL_TBS = { day: "qdr:d", week: "qdr:w", month: "qdr:m", year: "qdr:y" };

// Firecrawl 自定义绝对日期 → Google tbs 语法（cd_min 用 M/D/YYYY）
function formatFirecrawlDate(date) {
  const [y, m, d] = String(date).split("-").map((n) => parseInt(n, 10));
  return `${m}/${d}/${y}`;
}

async function searchFirecrawl(query, maxResults, apiKey, timeRange, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  let response;
  try {
    const body = { query, limit: Math.min(Math.max(maxResults ?? 5, 1), 10) };
    // Firecrawl 时间过滤：tbs 支持固定档（qdr:d/w/m/y）与自定义绝对区间（cdr:1,cd_min:...）
    if (timeRange) {
      if (timeRange.after) {
        body.tbs = `cdr:1,cd_min:${formatFirecrawlDate(timeRange.after)}`;
      } else if (timeRange.days !== undefined) {
        const tr = approximateTimeRange(timeRange.days);
        if (FIRECRAWL_TBS[tr]) body.tbs = FIRECRAWL_TBS[tr];
      }
    }
    response = await fetch(FIRECRAWL_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: "error",
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`Firecrawl request failed: ${error?.message ?? String(error)}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 401) {
      throw new Error("Firecrawl API key is invalid (HTTP 401) - update it in Settings > Plugins > Free Search");
    }
    if (response.status === 429) {
      throw new Error("Firecrawl rate limit exceeded (HTTP 429) - configure FIRECRAWL_API_KEY for higher limits");
    }
    throw new Error(`Firecrawl API error (HTTP ${response.status}): ${detail.slice(0, 200)}`);
  }
  const data = await response.json();
  const sources = (data.data?.web ?? [])
    .filter((r) => r.url)
    .map((r) => ({
      url: r.url,
      ...(r.title ? { title: String(r.title) } : {}),
      ...(r.description ? { snippet: String(r.description).slice(0, 300) } : {}),
    }));
  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}

function buildEngineChain(preferred, strategy, timeRange) {
  const ordered = strategy === "quality-first"
    ? [preferred, "tavily", "firecrawl", ...KEYLESS_ENGINES]
    : [preferred, ...KEYLESS_ENGINES, "firecrawl"];
  const unique = [...new Set(ordered.filter((engine) => ALL_ENGINES.includes(engine)))];
  if (!timeRange) return unique;
  return [
    ...unique.filter((engine) => TIME_ENGINES.includes(engine)),
    ...unique.filter((engine) => !TIME_ENGINES.includes(engine)),
  ];
}

function providerKeyFingerprint(secret) {
  return createHash("sha256").update(String(secret)).digest("hex").slice(0, 10);
}

function normalizeProviderPool(provider, raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const seen = new Set();
  const keys = [];
  for (const entry of Array.isArray(source.keys) ? source.keys : []) {
    const secret = typeof entry === "string" ? entry.trim() : String(entry?.secret ?? "").trim();
    if (!secret || seen.has(secret)) continue;
    seen.add(secret);
    keys.push({
      secret,
      fingerprint: providerKeyFingerprint(secret),
      enabled: typeof entry === "object" ? entry.enabled !== false : true,
      status: typeof entry === "object" && typeof entry.status === "string" ? entry.status : "unchecked",
      remaining: typeof entry === "object" && Number.isFinite(entry.remaining) ? entry.remaining : null,
      limit: typeof entry === "object" && Number.isFinite(entry.limit) ? entry.limit : null,
      lastCheckedAt: typeof entry === "object" && typeof entry.lastCheckedAt === "string" ? entry.lastCheckedAt : null,
      error: typeof entry === "object" && typeof entry.error === "string" ? entry.error.slice(0, 160) : null,
    });
  }
  return { version: 1, provider, strategy: "random", keys };
}

function redactProviderPool(pool) {
  return {
    version: pool.version,
    provider: pool.provider,
    strategy: pool.strategy,
    count: pool.keys.length,
    enabledCount: pool.keys.filter((entry) => entry.enabled).length,
    keys: pool.keys.map(({ secret: _secret, ...entry }) => entry),
  };
}

function providerPoolCandidates(pool, randomIndex = randomInt) {
  const eligible = pool.keys.filter((entry) => entry.enabled && entry.status !== "invalid" && entry.status !== "exhausted");
  if (eligible.length < 2) return eligible;
  const start = randomIndex(eligible.length);
  return [...eligible.slice(start), ...eligible.slice(0, start)];
}

function parseMcpEnvelope(text) {
  const trimmed = String(text ?? "").trim();
  const payload = trimmed.startsWith("data:")
    ? trimmed.split(/\r?\n/).find((line) => line.startsWith("data:"))?.slice(5).trim()
    : trimmed;
  return JSON.parse(payload || "{}");
}

async function vaultToolCall(token, name, args) {
  if (!token) throw new Error("Fleet Vault credential is unavailable");
  const response = await fetch(VAULT_MCP_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Fleet Vault HTTP ${response.status}`);
  const rpc = parseMcpEnvelope(await response.text());
  if (rpc.error) throw new Error(rpc.error.message || "Fleet Vault request failed");
  const text = rpc.result?.content?.find((item) => item.type === "text")?.text;
  const envelope = JSON.parse(text || "{}");
  if (envelope.ok !== true) {
    if (name === "vyibc-vault_get_config") return undefined;
    throw new Error(envelope.message || "Fleet Vault request failed");
  }
  return envelope.value;
}

async function loadProviderPool(provider, token) {
  const key = PROVIDER_POOL_KEYS[provider];
  if (!key) throw new Error(`unsupported provider pool: ${provider}`);
  try {
    const raw = await vaultToolCall(token, "vyibc-vault_get_config", { key });
    if (raw === undefined || raw === null) return normalizeProviderPool(provider, {});
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    return normalizeProviderPool(provider, value);
  } catch (error) {
    if (/not found|missing|不存在|404/i.test(String(error?.message ?? error))) {
      return normalizeProviderPool(provider, {});
    }
    throw error;
  }
}

async function saveProviderPool(provider, pool, token) {
  await vaultToolCall(token, "vyibc-vault_set_config", {
    key: PROVIDER_POOL_KEYS[provider],
    description: `DSH Web Search ${provider} API key pool; random selection; secrets never returned to clients`,
    value: pool,
  });
  return redactProviderPool(pool);
}

async function runWithProviderPool(provider, pool, operation, onRejected) {
  const candidates = providerPoolCandidates(pool);
  if (candidates.length === 0) throw new Error(`${provider} API key pool is empty`);
  let lastError;
  for (const candidate of candidates) {
    try {
      return await operation(candidate.secret);
    } catch (error) {
      lastError = error;
      const message = String(error?.message ?? error);
      if (!/HTTP (401|402|403|429)|quota|rate limit|invalid/i.test(message)) throw error;
      onRejected?.(candidate, error);
    }
  }
  throw lastError ?? new Error(`${provider} key pool has no usable key`);
}

async function inspectProviderKey(provider, secret) {
  const checkedAt = new Date().toISOString();
  if (provider === "firecrawl") {
    const response = await fetch("https://api.firecrawl.dev/v2/team/credit-usage", {
      headers: { Authorization: `Bearer ${secret}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return { status: response.status === 429 ? "exhausted" : "invalid", remaining: null, limit: null, lastCheckedAt: checkedAt, error: `HTTP ${response.status}` };
    const payload = await response.json();
    const remaining = Number(payload?.data?.remainingCredits);
    const limit = Number(payload?.data?.planCredits);
    return { status: remaining === 0 ? "exhausted" : "ready", remaining: Number.isFinite(remaining) ? remaining : null, limit: Number.isFinite(limit) ? limit : null, lastCheckedAt: checkedAt, error: null };
  }
  try {
    await searchTavily("OpenAI", 1, secret, undefined, AbortSignal.timeout(15000));
    return { status: "ready", remaining: null, limit: null, lastCheckedAt: checkedAt, error: null };
  } catch (error) {
    const message = String(error?.message ?? error);
    return { status: /429|quota|rate limit/i.test(message) ? "exhausted" : "invalid", remaining: null, limit: null, lastCheckedAt: checkedAt, error: message.slice(0, 160) };
  }
}

// Parallel: 有 key 走 REST（x-api-key）；无 key 走官方 MCP 免 key。自然语言 objective + search_queries，返回带 excerpts 的结果
async function searchParallel(query, maxResults, apiKey, timeRange, signal) {
  if (!apiKey) throw new Error("Parallel search requires PARALLEL_API_KEY");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  let response;
  try {
    const body = {
      objective: query,
      search_queries: [query],
      mode: "fast",
      advanced_settings: { max_results: Math.min(Math.max(maxResults ?? 5, 1), 20) },
    };
    // Parallel 时间过滤：source_policy.after_date（YYYY-MM-DD，精确）
    if (timeRange) {
      const after =
        timeRange.after ??
        (timeRange.days !== undefined ? isoDaysAgo(timeRange.days).slice(0, 10) : undefined);
      if (after) body.advanced_settings.source_policy = { after_date: after };
    }
    response = await fetch(PARALLEL_URL, {
      method: "POST",
      headers: { "x-api-key": apiKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: "error",
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`Parallel request failed: ${error?.message ?? String(error)}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Parallel API key is invalid (HTTP ${response.status}) - update it in Settings > Plugins > Free Search`);
    }
    if (response.status === 402) {
      throw new Error(`Parallel quota/billing error (HTTP 402) - check usage/credits at platform.parallel.ai. ${detail.slice(0, 200)}`);
    }
    throw new Error(`Parallel API error (HTTP ${response.status}): ${detail.slice(0, 200)}`);
  }
  const data = await response.json();
  const sources = (data.results ?? [])
    .filter((r) => r.url)
    .map((r) => {
      const excerpt = (r.excerpts ?? []).find((e) => String(e).trim().length > 0);
      return {
        url: r.url,
        ...(r.title ? { title: String(r.title) } : {}),
        ...(excerpt ? { snippet: String(excerpt).slice(0, 300) } : {}),
        ...(r.publish_date ? { publishedAt: String(r.publish_date) } : {}),
      };
    });
  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}

// Parallel keyless：官方 MCP（search.parallel.ai/mcp）匿名额度，无需 API key。
// 与 REST 的差异：MCP 的 web_search 工具没有 max_results / after_date 参数
// （条数由服务端决定），时间过滤退化为 objective 里的新鲜度提示（软过滤）。
const PARALLEL_MCP_SESSION = (() => {
  let id = "";
  for (let i = 0; i < 32; i++) id += Math.floor(Math.random() * 16).toString(16);
  return id;
})();

async function searchParallelMCP(query, maxResults, timeRange, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  let response;
  try {
    const after = timeRange
      ? timeRange.after ?? (timeRange.days !== undefined ? isoDaysAgo(timeRange.days).slice(0, 10) : undefined)
      : undefined;
    const objective = after ? `${query} (prefer results published after ${after})` : query;
    response = await fetch(PARALLEL_MCP_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: {
          name: "web_search",
          arguments: {
            objective,
            search_queries: [query],
            session_id: PARALLEL_MCP_SESSION,
          },
        },
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`Parallel MCP request failed: ${error?.message ?? String(error)}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  if (!response.ok) throw new Error(`Parallel MCP error (HTTP ${response.status})`);
  const text = await response.text();
  // 兼容 JSON 与 SSE（event: message\ndata: {...}）两种响应形态
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    for (const line of text.split("\n")) {
      if (line.startsWith("data: ")) {
        try {
          json = JSON.parse(line.slice(6));
          break;
        } catch {}
      }
    }
  }
  if (!json || json.error) throw new Error(`Parallel MCP error: ${json?.error?.message ?? "no data"}`);
  const blocks = (json.result?.content ?? []).filter((b) => b.type === "text").map((b) => b.text);
  if (json.result?.isError) throw new Error(`Parallel MCP error: ${blocks.join(" ").slice(0, 200) || "tool call failed"}`);
  let payload = null;
  for (const block of blocks) {
    try {
      payload = JSON.parse(block);
      break;
    } catch {}
  }
  const sources = (payload?.results ?? [])
    .filter((r) => r.url)
    .map((r) => {
      const excerpt = (r.excerpts ?? []).find((e) => String(e).trim().length > 0);
      return {
        url: r.url,
        ...(r.title ? { title: String(r.title) } : {}),
        ...(excerpt ? { snippet: String(excerpt).slice(0, 300) } : {}),
        ...(r.publish_date ? { publishedAt: String(r.publish_date) } : {}),
      };
    });
  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}

// 把任意天数转成 Keenable 的相对时间格式（12h / Nd / Nmo / Ny）
function formatKeenableRelative(days) {
  if (days <= 0.5) return "12h";
  if (days < 1) return `${Math.round(days * 24)}h`;
  if (days < 30) return `${Math.round(days)}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${Math.round(days / 365)}y`;
}

// Keenable: 有 key 走 REST API（X-API-Key），无 key 走 keyless MCP（免费匿名额度）
function extractKeenableSources(text, maxResults) {
  const sources = [];
  const blocks = String(text).split(/\n(?=Title:)/);
  for (const block of blocks) {
    const title = block.match(/^Title: (.+)$/m)?.[1];
    const url = block.match(/^URL: (\S+)$/m)?.[1];
    const published = block.match(/^Published: (.+)$/m)?.[1] ?? block.match(/^Acquired: (.+)$/m)?.[1];
    const snippets = block.split(/^Snippets:$/m)[1]?.split("\n").filter((l) => l.trim()).slice(0, 3).join(" ");
    if (!url) continue;
    sources.push({
      url,
      ...(title ? { title } : {}),
      ...(snippets ? { snippet: snippets.slice(0, 300) } : {}),
      // 与 Exa MCP 一致：只保留日期形态，过滤 "N/A" 等占位符
      ...(published && /^\d{4}-\d{2}-\d{2}/.test(published) ? { publishedAt: published } : {}),
    });
  }
  return uniqueSources(sources, maxResults ?? 10);
}

async function searchKeenableREST(query, maxResults, apiKey, timeRange, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  let response;
  try {
    const body = { query, mode: "realtime" };
    // Keenable 时间过滤：published_after（相对 12h/7d/1mo/1y 或绝对 YYYY-MM-DD）
    if (timeRange) {
      if (timeRange.after) body.published_after = timeRange.after;
      else if (timeRange.days !== undefined) body.published_after = formatKeenableRelative(timeRange.days);
    }
    response = await fetch(KEENABLE_URL, {
      method: "POST",
      headers: { "x-api-key": apiKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`Keenable request failed: ${error?.message ?? String(error)}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 401) {
      throw new Error("Keenable API key is invalid (HTTP 401) - update it in Settings > Plugins > Free Search");
    }
    throw new Error(`Keenable API error (HTTP ${response.status}): ${detail.slice(0, 200)}`);
  }
  const data = await response.json();
  const sources = (data.results ?? [])
    .filter((r) => r.url)
    .map((r) => ({
      url: r.url,
      ...(r.title ? { title: String(r.title) } : {}),
      ...(r.snippet ?? r.description ? { snippet: String(r.snippet ?? r.description).slice(0, 300) } : {}),
      ...(r.published_at ? { publishedAt: String(r.published_at) } : {}),
    }));
  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}

async function searchKeenableMCP(query, maxResults, timeRange, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  let response;
  try {
    const arguments_ = { query };
    // Keenable MCP 支持 published_after（相对或绝对日期）
    if (timeRange) {
      if (timeRange.after) arguments_.published_after = timeRange.after;
      else if (timeRange.days !== undefined) arguments_.published_after = formatKeenableRelative(timeRange.days);
    }
    response = await fetch(KEENABLE_MCP_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: { name: "search_web_pages", arguments: arguments_ },
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`Keenable MCP request failed: ${error?.message ?? String(error)}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  if (!response.ok) throw new Error(`Keenable MCP error (HTTP ${response.status})`);
  const data = await response.json();
  if (data.error) throw new Error(`Keenable MCP error: ${data.error?.message ?? "unknown"}`);
  const content = data.result?.content ?? [];
  // isError=true 时 content 里是错误文本
  const text = content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  if (data.result?.isError) throw new Error(`Keenable MCP error: ${text.slice(0, 200)}`);
  return { sources: extractKeenableSources(text, maxResults ?? 10), truncated: false };
}

async function searchKeenable(query, maxResults, apiKey, timeRange, signal) {
  if (apiKey) return searchKeenableREST(query, maxResults, apiKey, timeRange, signal);
  return searchKeenableMCP(query, maxResults, timeRange, signal);
}

async function searchPerplexity(query, maxResults, apiKey, signal) {
  if (!apiKey) throw new Error("Perplexity search requires PERPLEXITY_API_KEY");
  // 内置 20s 超时（与外部 signal 组合）：调用方不传 signal 时也不会永久卡住
  const response = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    redirect: "error",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      model: "sonar",
      max_tokens: 1024,
      messages: [{ role: "user", content: query }],
    }),
    signal: AbortSignal.any([...(signal !== undefined ? [signal] : []), AbortSignal.timeout(20000)]),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 401) {
      throw new Error("Perplexity API key is invalid (HTTP 401) - update it in Settings > Plugins > Free Search");
    }
    throw new Error(`Perplexity API error (HTTP ${response.status}): ${detail.slice(0, 200)}`);
  }
  const data = await response.json();
  const answer = data.choices?.[0]?.message?.content ?? "";
  const citations = data.citations ?? [];
  const sources = citations.map((url) => ({ url, ...(answer ? { snippet: answer.slice(0, 200) } : {}) }));
  return {
    content: answer,
    sources: uniqueSources(sources, maxResults ?? 10),
    truncated: false,
  };
}

async function searchDeepSeekOfficial(query, maxResults, apiKey, signal) {
  if (!apiKey) throw new Error("DeepSeek search requires DEEPSEEK_API_KEY");
  // 内置 20s 超时（与外部 signal 组合）：调用方不传 signal 时也不会永久卡住
  const response = await fetch("https://api.deepseek.com/anthropic/v1/messages", {
    method: "POST",
    redirect: "error",
    headers: {
      "x-api-key": apiKey,
      authorization: `Bearer ${apiKey}`,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "deepseek-harness/free-search",
    },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: `Perform a web search for the query: ${query}` }],
        },
      ],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
    }),
    signal: AbortSignal.any([...(signal !== undefined ? [signal] : []), AbortSignal.timeout(20000)]),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 401) {
      throw new Error("DeepSeek API key is invalid (HTTP 401) - update it in Settings > Plugins > Free Search");
    }
    throw new Error(`DeepSeek API error (HTTP ${response.status}): ${detail.slice(0, 200)}`);
  }
  const data = await response.json();
  const blocks = data.content ?? [];
  const resultBlocks = blocks.filter((block) => block.type === "web_search_tool_result");
  const snippets = new Map();
  for (const block of blocks) {
    if (block.type !== "text") continue;
    for (const cite of block.citations ?? []) {
      if (cite.url && cite.cited_text && !snippets.has(cite.url)) snippets.set(cite.url, cite.cited_text);
    }
  }
  const sources = [];
  for (const block of resultBlocks) {
    for (const item of block.content ?? []) {
      if (item.type !== "web_search_result" || !item.url) continue;
      if (sources.some((s) => s.url === item.url)) continue;
      sources.push({
        url: item.url,
        ...(item.title ? { title: item.title } : {}),
        ...(snippets.get(item.url) ? { snippet: snippets.get(item.url) } : {}),
        ...(item.page_age ? { publishedAt: item.page_age } : {}),
      });
    }
  }
  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}

// SerpBase: 必须配置 SERPBASE_API_KEY（无 key 跳过，同 perplexity）
// Google SERP API：POST + X-API-Key 头，返回 organic[]（title/link/snippet/published_at）。
// 注意：SerpBase 始终返回 HTTP 200，业务状态放在 JSON 的 status 字段（0=成功，1001=key 无效/缺失，1000=请求非法）。
const SERPBASE_LOCALE = {
  zh: { hl: "zh-CN", gl: "cn" },
  en: { hl: "en", gl: "us" },
  ru: { hl: "ru", gl: "ru" },
  ja: { hl: "ja", gl: "jp" },
  de: { hl: "de", gl: "de" },
  fr: { hl: "fr", gl: "fr" },
  es: { hl: "es", gl: "es" },
  ko: { hl: "ko", gl: "kr" },
};

async function searchSerpbase(query, maxResults, apiKey, options, signal) {
  if (!apiKey) throw new Error("SerpBase search requires SERPBASE_API_KEY");
  // hl/gl 跟随设置页的 lang（SerpBase 支持 Google 的 hl/gl 本地化），默认 en/us
  const locale = SERPBASE_LOCALE[options?.lang] ?? SERPBASE_LOCALE.en;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  let response;
  try {
    response = await fetch(SERPBASE_URL, {
      method: "POST",
      redirect: "error",
      headers: {
        "X-API-Key": apiKey,
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": "deepseek-harness/free-search",
      },
      body: JSON.stringify({ q: query, hl: locale.hl, gl: locale.gl, page: 1 }),
      signal: controller.signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`SerpBase request failed: ${error?.message ?? String(error)}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`SerpBase API error (HTTP ${response.status}): ${detail.slice(0, 200)}`);
  }
  // HTTP 200 + status 字段：0 成功 / 1001 key 无效或缺 / 1000 请求非法
  const data = await response.json();
  if (data.status !== 0) {
    if (data.status === 1001) {
      throw new Error("SerpBase API key is invalid or missing (status 1001) - update it in Settings > Plugins > Free Search");
    }
    throw new Error(`SerpBase API error (status ${data.status}): ${String(data.error ?? "").slice(0, 200)}`);
  }
  const sources = (data.organic ?? [])
    .filter((r) => r.link)
    .map((r) => ({
      url: r.link,
      ...(r.title ? { title: String(r.title) } : {}),
      ...(r.snippet ? { snippet: String(r.snippet) } : {}),
      ...((r.published_at ?? r.date) ? { publishedAt: String(r.published_at ?? r.date) } : {}),
    }));
  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}
//#endregion

//#region bridge
const MAX_JSON_BODY_BYTES = 64 * 1024;

function isLoopbackRequest(request) {
  const address = request.socket.remoteAddress;
  if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") return false;
  const host = request.headers.host;
  if (typeof host !== "string") return false;
  let hostUrl;
  try {
    hostUrl = new URL("http://" + host);
  } catch {
    return false;
  }
  if (hostUrl.hostname !== "127.0.0.1" && hostUrl.hostname !== "localhost" && hostUrl.hostname !== "[::1]") return false;
  if (request.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "referrer-policy": "no-referrer" });
  res.end(payload);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk;
    size += buffer.length;
    if (size > MAX_JSON_BODY_BYTES) return undefined;
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

function toView(descriptor) {
  return {
    ns: String(descriptor.ns),
    schema: descriptor.schema,
    value: descriptor.value,
    ...(descriptor.base === undefined ? {} : { base: descriptor.base }),
    ...(descriptor.user === undefined ? {} : { user: descriptor.user }),
    ...(descriptor.secrets === undefined
      ? {}
      : { secrets: descriptor.secrets.map((secret) => ({ path: [...secret.path], set: secret.set })) }),
    revision: descriptor.revision,
  };
}

function makeBridgeRoutes(settings, search, testEngine, getCredentials, providerPools) {
  const allowlisted = () =>
    settings
      .describe({ redactSecrets: true })
      .filter((descriptor) => String(descriptor.ns) === FREE_SEARCH_NS)
      .map((descriptor) => String(descriptor.ns));

  const handlers = {
    async checkUpdate() {
      const latest = await fetchLatestVersion();
      if (latest === null) {
        return {
          ok: false,
          code: "update-check-failed",
          message: "could not reach the npm registry (network/proxy) - check your connection",
        };
      }
      const cmp = compareVersions(latest, PLUGIN_VERSION);
      const mode = detectInstallMode();
      return {
        ok: true,
        value: {
          current: PLUGIN_VERSION,
          latest,
          hasUpdate: cmp > 0,
          updateUrl: PLUGIN_NPM_URL,
          repoUrl: PLUGIN_REPO_URL,
          // 可一键升级：npm 真安装时 true；本地 link 开发模式 false（升级请 git pull 源码）
          installable: mode !== null && !mode.isLink,
          installMode: mode?.isLink ? "link" : mode !== null ? "registry" : "unknown",
        },
      };
    },
    // 一键升级：仅在 npm 真安装模式下执行 pnpm 升级；link 模式拒绝（避免破坏本地开发链路）
    async updatePlugin() {
      const mode = detectInstallMode();
      if (mode === null) {
        return { ok: false, code: "install-not-found", message: "could not locate dsh-free-search in any profile" };
      }
      if (mode.isLink) {
        return {
          ok: false,
          code: "local-link-mode",
          message: "local development install (symlink) - update the source repo instead (git pull), then restart dsh",
        };
      }
      try {
        const result = await new Promise((resolve, reject) => {
          exec("pnpm add dsh-free-search@latest", { cwd: mode.profileDir, timeout: 120000 }, (error, stdout, stderr) => {
            if (error) reject(new Error(`upgrade failed: ${(stderr || stdout || error.message).trim().slice(0, 300)}`));
            else resolve(stdout);
          });
        });
        const latest = await fetchLatestVersion();
        return {
          ok: true,
          value: {
            updated: true,
            latest: latest ?? "unknown",
            message: `upgraded to latest - restart dsh to apply`,
            output: String(result).trim().slice(0, 200),
          },
        };
      } catch (error) {
        return { ok: false, code: "upgrade-failed", message: error instanceof Error ? error.message : String(error) };
      }
    },
    async rawSearch(request) {
      if (request === null || typeof request !== "object" || typeof request.query !== "string" || request.query.length === 0) {
        return { ok: false, code: "search-rejected", message: "malformed bridge search request (query is required)" };
      }
      const maxResults = Math.min(Math.max(Number(request.maxResults) || 5, 1), 10);
      const timeRange = parseTimeRange(request.timeRange);
      // 指定 engine：直测该引擎本身（不走回退链），报告它自己的可用性
      if (typeof request.engine === "string" && request.engine.length > 0) {
        if (typeof testEngine !== "function") {
          return { ok: false, code: "search-unavailable", message: "engine test is not wired" };
        }
        try {
          const result = await testEngine(request.engine, request.query, timeRange);
          if (result.ok === false) {
            return { ok: false, code: "engine-failed", message: result.error ?? `${request.engine} failed` };
          }
          return {
            ok: true,
            value: {
              provider: request.engine,
              sources: result.sources ?? [],
              content: result.content ?? "",
            },
          };
        } catch (error) {
          return { ok: false, code: "engine-failed", message: error instanceof Error ? error.message : String(error) };
        }
      }
      if (typeof search !== "function") {
        return { ok: false, code: "search-unavailable", message: "search provider is not wired" };
      }
      try {
        const result = await search({ ...request, maxResults, timeRange });
        return {
          ok: true,
          value: {
            // 实际使用的引擎：provider.search 在成功时返回 provider 字段
            provider: result.provider ?? request.engine ?? request.provider ?? "bing",
            sources: result.sources ?? [],
            content: result.content ?? "",
            // 缓存命中标记：provider.search 成功路径标记 _cache（hit=命中缓存，miss=真实搜索）
            cache: result._cache === "hit" ? "hit" : "miss",
          },
        };
      } catch (error) {
        return { ok: false, code: "search-failed", message: error instanceof Error ? error.message : String(error) };
      }
    },
    async describe() {
      const descriptors = settings.describe({ redactSecrets: true });
      return {
        ok: true,
        value: {
          namespaces: allowlisted()
            .map((ns) => descriptors.find((descriptor) => String(descriptor.ns) === ns))
            .filter((descriptor) => descriptor !== undefined)
            .map(toView),
          writable: settings.writable !== false,
        },
      };
    },
    async mutate(request) {
      const body = request;
      if (body === null || typeof body !== "object" || typeof body.ns !== "string" || !Array.isArray(body.ops)) {
        return { ok: false, code: "settings-rejected", message: "malformed bridge settings request" };
      }
      const { ns } = body;
      if (!allowlisted().includes(ns)) {
        return { ok: false, code: "settings-not-exposed", message: `settings namespace "${ns}" is not exposed` };
      }
      const expectedRevision = typeof body.expectedRevision === "number" ? body.expectedRevision : undefined;
      try {
        await settings.mutate(ns, body.ops, expectedRevision);
      } catch (error) {
        if (error instanceof SettingsConflictError) {
          return { ok: false, code: "settings-conflict", message: error.message };
        }
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, code: "internal", message };
      }
      const descriptor = settings.describe({ redactSecrets: true }).find((candidate) => String(candidate.ns) === ns);
      if (descriptor === undefined) {
        return { ok: false, code: "internal", message: `settings namespace "${ns}" was disposed after the mutate` };
      }
      return { ok: true, value: toView(descriptor) };
    },
    // 凭据中心：查询各引擎 key 的配置状态（value 不返回，只返回是否已配置）
    async credentialsStatus() {
      const credentials = getCredentials();
      if (!credentials) return { ok: false, code: "credentials-unavailable", message: "credentials service is not available" };
      const configured = {};
      for (const [settingsKey, ref] of Object.entries(KEY_REF_MAP)) {
        try {
          const info = await credentials.describe(ref);
          configured[settingsKey] = info !== undefined && info.configured === true;
        } catch {
          configured[settingsKey] = false;
        }
      }
      return { ok: true, value: { configured, available: true } };
    },
    // 凭据中心：写入一个引擎 key（ref 白名单限定）
    async credentialsSet(request) {
      const credentials = getCredentials();
      if (!credentials) return { ok: false, code: "credentials-unavailable", message: "credentials service is not available" };
      const { key, value } = request ?? {};
      const ref = KEY_REF_MAP[key];
      if (!ref) return { ok: false, code: "credentials-rejected", message: `unknown credential key "${key}"` };
      if (typeof value !== "string" || value.trim().length === 0) {
        return { ok: false, code: "credentials-rejected", message: "value is required" };
      }
      try {
        await credentials.set(ref, value.trim());
        return { ok: true, value: { ref, set: true } };
      } catch (error) {
        return { ok: false, code: "credentials-write-failed", message: error instanceof Error ? error.message : String(error) };
      }
    },
    // 凭据中心：删除一个引擎 key
    async credentialsUnset(request) {
      const credentials = getCredentials();
      if (!credentials) return { ok: false, code: "credentials-unavailable", message: "credentials service is not available" };
      const { key } = request ?? {};
      const ref = KEY_REF_MAP[key];
      if (!ref) return { ok: false, code: "credentials-rejected", message: `unknown credential key "${key}"` };
      try {
        await credentials.unset(ref);
        return { ok: true, value: { ref, set: false } };
      } catch (error) {
        return { ok: false, code: "credentials-write-failed", message: error instanceof Error ? error.message : String(error) };
      }
    },
    async providerPoolStatus(request) {
      try {
        return { ok: true, value: await providerPools.status(request?.provider) };
      } catch (error) {
        return { ok: false, code: "provider-pool-read-failed", message: error instanceof Error ? error.message : String(error) };
      }
    },
    async providerPoolSet(request) {
      try {
        return { ok: true, value: await providerPools.set(request ?? {}) };
      } catch (error) {
        return { ok: false, code: "provider-pool-write-failed", message: error instanceof Error ? error.message : String(error) };
      }
    },
    async providerPoolRefresh(request) {
      try {
        return { ok: true, value: await providerPools.refresh(request?.provider) };
      } catch (error) {
        return { ok: false, code: "provider-pool-refresh-failed", message: error instanceof Error ? error.message : String(error) };
      }
    },
  };

  const guard = (req, res) => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { error: "loopback requests only" });
      return false;
    }
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "method not allowed: " + (req.method ?? "") });
      return false;
    }
    return true;
  };

  return [
    {
      kind: "exact",
      path: `${BRIDGE_PREFIX}/describe`,
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        writeJson(res, 200, await handlers.describe());
      },
    },
    {
      kind: "exact",
      path: `${BRIDGE_PREFIX}/mutate`,
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        const body = await readJsonBody(req);
        if (body === undefined) {
          writeJson(res, 400, { ok: false, code: "settings-rejected", message: "malformed JSON body" });
          return;
        }
        writeJson(res, 200, await handlers.mutate(body));
      },
    },
    {
      kind: "exact",
      path: `${BRIDGE_PREFIX}/credentials-status`,
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        writeJson(res, 200, await handlers.credentialsStatus());
      },
    },
    {
      kind: "exact",
      path: `${BRIDGE_PREFIX}/credentials-set`,
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        const body = await readJsonBody(req);
        if (body === undefined) {
          writeJson(res, 400, { ok: false, code: "credentials-rejected", message: "malformed JSON body" });
          return;
        }
        writeJson(res, 200, await handlers.credentialsSet(body));
      },
    },
    {
      kind: "exact",
      path: `${BRIDGE_PREFIX}/credentials-unset`,
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        const body = await readJsonBody(req);
        if (body === undefined) {
          writeJson(res, 400, { ok: false, code: "credentials-rejected", message: "malformed JSON body" });
          return;
        }
        writeJson(res, 200, await handlers.credentialsUnset(body));
      },
    },
    {
      kind: "exact",
      path: `${BRIDGE_PREFIX}/check-update`,
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        writeJson(res, 200, await handlers.checkUpdate());
      },
    },
    {
      kind: "exact",
      path: `${BRIDGE_PREFIX}/provider-pool/status`,
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        const body = await readJsonBody(req);
        writeJson(res, 200, await handlers.providerPoolStatus(body ?? {}));
      },
    },
    {
      kind: "exact",
      path: `${BRIDGE_PREFIX}/provider-pool/set`,
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        const body = await readJsonBody(req);
        if (body === undefined) {
          writeJson(res, 400, { ok: false, code: "provider-pool-rejected", message: "malformed JSON body" });
          return;
        }
        writeJson(res, 200, await handlers.providerPoolSet(body));
      },
    },
    {
      kind: "exact",
      path: `${BRIDGE_PREFIX}/provider-pool/refresh`,
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        const body = await readJsonBody(req);
        writeJson(res, 200, await handlers.providerPoolRefresh(body ?? {}));
      },
    },
    {
      kind: "exact",
      path: `${BRIDGE_PREFIX}/update`,
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        writeJson(res, 200, await handlers.updatePlugin());
      },
    },
    {
      kind: "exact",
      path: `${BRIDGE_PREFIX}/raw-search`,
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        const body = await readJsonBody(req);
        if (body === undefined) {
          writeJson(res, 400, { ok: false, code: "search-rejected", message: "malformed JSON body" });
          return;
        }
        writeJson(res, 200, await handlers.rawSearch(body));
      },
    },
  ];
}
//#endregion

const name = "web-search-free";
const inject = ["web", "tools"];

// 引擎 key 与凭据中心 ref 的映射（白名单：只允许这些 ref 被 UI 读写凭据中心）
const KEY_REF_MAP = {
  exaApiKey: "EXA_API_KEY",
  tavilyApiKey: "TAVILY_API_KEY",
  keenableApiKey: "KEENABLE_API_KEY",
  firecrawlApiKey: "FIRECRAWL_API_KEY",
  parallelApiKey: "PARALLEL_API_KEY",
  perplexityApiKey: "PERPLEXITY_API_KEY",
  serpbaseApiKey: "SERPBASE_API_KEY",
  deepseekApiKey: "DEEPSEEK_API_KEY",
};

const Config = z.object({
  provider: z.string().default("bing"),
  cache: z.boolean().default(true), // 单 query 结果缓存开关（防限流/省额度）
  cacheTtl: z.number().default(5), // 缓存时长（分钟），0-5 可配置（使用处再 clamp）
  keyStorage: z.string().default("credentials"), // key 存储位置：credentials（凭据中心）| settings（设置页）
  lang: z.string().default("zh"),
  region: z.string(),
  bingMarket: z.string().default("zh-CN"),
  safeSearch: z.string().default("off"),
  searxngInstances: z.array(z.string()),
  platforms: z.array(z.string()).default(["github", "v2ex", "bilibili", "reddit", "hn", "stackoverflow", "wikipedia", "npm"]),
  exaApiKey: z.string().role("secret"),
  tavilyApiKey: z.string().role("secret"),
  keenableApiKey: z.string().role("secret"),
  firecrawlApiKey: z.string().role("secret"),
  parallelApiKey: z.string().role("secret"),
  perplexityApiKey: z.string().role("secret"),
  serpbaseApiKey: z.string().role("secret"),
  deepseekApiKey: z.string().role("secret"),
});

function apply(ctx, config) {
  let current = () => config ?? {};
  const logger = ctx.logger;
  // credentials 服务可能晚于本插件挂载（跨 bundle 顺序），运行期动态获取而不是 apply 时缓存
  const getCredentials = () => ctx.get("credentials");

  // 系统提示词动态刷新：设置变更时重新生成，避免显示旧引擎
  let refreshPrompt = null;

  // 单 query 结果缓存（provider.search 内闭包持有）：LRU 50 条 / TTL 可配置
  const searchCache = new Map(); // key -> { value, expiresAt }

  // key 优先级：credentials（.credentials.yaml 凭据中心，官方推荐）> settings 的 free-search.<x>ApiKey（遗留兼容）> 环境变量
  const resolveApiKey = async (envName, settingsKey) => {
    const credentials = getCredentials();
    if (credentials) {
      try {
        const resolved = await credentials.resolve(envName);
        if (resolved?.value) return resolved.value;
      } catch {}
    }
    const cfg = current();
    if (settingsKey && cfg[settingsKey]) return cfg[settingsKey];
    return process.env[envName] ?? "";
  };

  const providerPoolCache = new Map();
  const providerCooldowns = new Map();
  const providerPools = {
    async token() {
      return resolveApiKey("FLEET_VAULT_TOKEN");
    },
    async load(provider, force = false) {
      if (!PROVIDER_POOL_KEYS[provider]) throw new Error(`unsupported provider pool: ${provider}`);
      const cached = providerPoolCache.get(provider);
      if (!force && cached && cached.expiresAt > Date.now()) return cached.pool;
      const pool = await loadProviderPool(provider, await this.token());
      providerPoolCache.set(provider, { pool, expiresAt: Date.now() + 60000 });
      return pool;
    },
    async status(provider) {
      if (provider) return redactProviderPool(await this.load(provider, true));
      return {
        tavily: redactProviderPool(await this.load("tavily", true)),
        firecrawl: redactProviderPool(await this.load("firecrawl", true)),
      };
    },
    async set(request) {
      const provider = request.provider;
      if (!PROVIDER_POOL_KEYS[provider]) throw new Error("provider must be tavily or firecrawl");
      const incoming = Array.isArray(request.keys)
        ? request.keys
        : String(request.keys ?? "").split(/[\r\n,]+/);
      const cleaned = incoming.map((value) => String(value).trim()).filter(Boolean);
      if (cleaned.length === 0) throw new Error("at least one API key is required");
      if (cleaned.length > 100) throw new Error("at most 100 API keys may be stored per provider");
      const currentPool = request.mode === "append" ? await this.load(provider, true) : normalizeProviderPool(provider, {});
      const merged = normalizeProviderPool(provider, { keys: [...currentPool.keys, ...cleaned] });
      const view = await saveProviderPool(provider, merged, await this.token());
      providerPoolCache.set(provider, { pool: merged, expiresAt: Date.now() + 60000 });
      return view;
    },
    async refresh(provider) {
      if (!PROVIDER_POOL_KEYS[provider]) throw new Error("provider must be tavily or firecrawl");
      const pool = await this.load(provider, true);
      const updated = [];
      for (const entry of pool.keys) {
        updated.push({ ...entry, ...(entry.enabled ? await inspectProviderKey(provider, entry.secret) : {}) });
      }
      const next = normalizeProviderPool(provider, { ...pool, keys: updated });
      const view = await saveProviderPool(provider, next, await this.token());
      providerPoolCache.set(provider, { pool: next, expiresAt: Date.now() + 60000 });
      return view;
    },
    async run(provider, operation, fallbackKey = "") {
      try {
        const pool = await this.load(provider);
        const now = Date.now();
        const available = {
          ...pool,
          keys: pool.keys.filter((entry) => (providerCooldowns.get(`${provider}:${entry.fingerprint}`) ?? 0) <= now),
        };
        if (providerPoolCandidates(available).length > 0) {
          return await runWithProviderPool(provider, available, operation, (entry) => {
            providerCooldowns.set(`${provider}:${entry.fingerprint}`, Date.now() + 5 * 60 * 1000);
          });
        }
      } catch (error) {
        logger.warn(`free-search: ${provider} provider pool unavailable (${String(error?.message ?? error)}), using legacy credential`);
      }
      if (fallbackKey) return operation(fallbackKey);
      return operation("");
    },
  };

  // 总控 provider：按 settings 的 provider 字段路由到任意引擎。
  // 任何引擎失败（缺 key / 401 / 限流 / 网络）都会自动轮流尝试下一个引擎，
  // 直到成功或全部失败。并在结果里附带回退提示，避免 agent 搜索直接失败。
  const provider = {
    id: "ddg",
    available() {
      return true;
    },
    // 单 query 结果缓存：key=query+maxResults+timeRangeLabel+preferred，Map 天然 LRU
    async search(request, signal) {
      // 公共咽喉校验：web_search / advanced_search / raw-search 三条路径都经过这里
      if (request === null || typeof request !== "object" || typeof request.query !== "string" || request.query.trim().length === 0) {
        throw new Error("query is required");
      }
      const cfg = current();
      const strategy = request.strategy === "quality-first" ? "quality-first" : "free-first";
      const explicitEngine = typeof request.engine === "string" && ALL_ENGINES.includes(request.engine);
      const minimumSources = Math.min(Math.max(Number(request.minimumSources) || 1, 1), Math.max(request.maxResults ?? 10, 1));
      // 显式指定引擎仍优先；quality-first 未指定时优先走 Tavily Provider 池。
      const preferred = explicitEngine
        ? request.engine
        : strategy === "quality-first"
          ? "tavily"
          : cfg.provider ?? "bing";
      // time_range 过滤（仅 advanced_search 工具透传；标准 web_search 无此参数）
      // 保留原始字符串用于 Note 展示；raw-search 桥可能已把 timeRange 解析成对象
      const timeRange = parseTimeRange(request.timeRange);
      const timeRangeLabel = typeof request.timeRange === "string" ? request.timeRange : String(timeRange?.days ?? timeRange?.after ?? "");

      // 缓存 TTL（分钟，0-5 可配置）；cache=false 或 ttl<=0 时完全禁用
      const cacheTtlMs = (Math.min(Math.max(Number(cfg.cacheTtl) ?? 5, 0), 5)) * 60 * 1000;
      const cacheEnabled = cfg.cache !== false && cacheTtlMs > 0;
      const cacheKey = cacheEnabled
        ? buildCacheKey(request.query, request.maxResults, `${timeRangeLabel}|${strategy}|${minimumSources}`, preferred)
        : null;
      if (cacheKey !== null) {
        const hit = searchCache.get(cacheKey);
        if (hit && hit.expiresAt > Date.now()) {
          if (signal?.aborted) throw new Error("search aborted");
          searchCache.delete(cacheKey);
          searchCache.set(cacheKey, hit);
          // 浅拷贝 + 私有标记：sources 数组也复制一层，彻底隔离缓存对象（调用方 push/改元素不影响缓存）
          return { ...hit.value, sources: hit.value.sources?.slice(), _cache: "hit" };
        }
        if (hit) searchCache.delete(cacheKey);
      }

      // free-first: 免费/匿名线路在前，最后才升级到付费 Provider。
      // quality-first: Tavily/Firecrawl Provider 池在前，失败后再回落免费线路。
      let chain = buildEngineChain(preferred, strategy, timeRange);
      // 首选引擎被跳过的原因（用于生成准确的 Note，避免误导 agent/用户）：
      //  - "time-filter"：带 timeRange 且首选引擎不支持时间过滤（根本没尝试）
      //  - "failed"：首选引擎确实被尝试但失败（缺 key / 401 / 限流 / 0 结果 / 网络）
      //  - null：首选引擎成功或无回退
      let preferredSkippedReason = null;
      if (timeRange && !TIME_ENGINES.includes(preferred)) {
        preferredSkippedReason = "time-filter";
        chain = chain.filter((engine) => engine !== preferred);
      }

      let lastError = null;
      let usedEngine = null;
      let bestPartial = null;
      // 首选引擎若被尝试后失败，记录失败详情（用于 Note）
      let preferredFailure = null;
      // 总超时预算：串行回退时限制整条引擎链的总时长，防止各引擎超时累加达分钟级
      const BUDGET_MS = 30000;
      const deadline = Date.now() + BUDGET_MS;
      for (const engine of chain) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error(`search timed out after ${BUDGET_MS / 1000}s`);
        }
        // 组合外部取消 signal + 剩余预算超时：官方 web_search 取消、引擎超时、总预算都能触发
        const effSignal = AbortSignal.any([...(signal !== undefined ? [signal] : []), AbortSignal.timeout(remaining)]);
        try {
          let result;
          if (engine === "ddg") {
            result = await searchDdgHtml(request.query, request.maxResults, { ...cfg, timeRange }, effSignal);
          } else if (engine === "ddg-lite") {
            result = await searchDdgLite(request.query, request.maxResults, { ...cfg, timeRange }, effSignal);
          } else if (engine === "bing") {
            result = await searchBing(request.query, request.maxResults, cfg, effSignal);
          } else if (engine === "searxng") {
            result = await searchSearxng(request.query, request.maxResults, { ...cfg, timeRange }, effSignal);
          } else if (engine === "anysearch") {
            result = await searchAnysearch(request.query, request.maxResults, effSignal);
          } else if (engine === "exa") {
            // exa：有 key 走 REST，无 key 走 keyless MCP（免费）
            const key = explicitEngine ? await resolveApiKey("EXA_API_KEY", "exaApiKey") : "";
            if (key) {
              result = await searchExa(request.query, request.maxResults, key, timeRange, effSignal);
            } else {
              result = await searchExaMCP(request.query, request.maxResults, effSignal);
            }
          } else if (engine === "tavily") {
            const fallbackKey = await resolveApiKey("TAVILY_API_KEY", "tavilyApiKey");
            result = await providerPools.run("tavily", (key) => searchTavily(request.query, request.maxResults, key, timeRange, effSignal), fallbackKey);
          } else if (engine === "keenable") {
            // keenable：有 key 走 REST，无 key 走 keyless MCP（免费）
            const key = explicitEngine ? await resolveApiKey("KEENABLE_API_KEY", "keenableApiKey") : "";
            result = await searchKeenable(request.query, request.maxResults, key, timeRange, effSignal);
          } else if (engine === "firecrawl") {
            const fallbackKey = await resolveApiKey("FIRECRAWL_API_KEY", "firecrawlApiKey");
            result = await providerPools.run("firecrawl", (key) => searchFirecrawl(request.query, request.maxResults, key, timeRange, effSignal), fallbackKey);
          } else if (engine === "parallel") {
            // parallel：有 key 走 REST（支持 after_date 精确过滤），无 key 走 keyless MCP（免费匿名额度）
            const key = explicitEngine ? await resolveApiKey("PARALLEL_API_KEY", "parallelApiKey") : "";
            if (key) {
              result = await searchParallel(request.query, request.maxResults, key, timeRange, effSignal);
            } else {
              result = await searchParallelMCP(request.query, request.maxResults, timeRange, effSignal);
            }
          } else if (engine === "perplexity") {
            const key = await resolveApiKey("PERPLEXITY_API_KEY", "perplexityApiKey");
            if (!key) {
              lastError = new Error("Perplexity requires PERPLEXITY_API_KEY");
              if (engine === preferred) preferredFailure = "PERPLEXITY_API_KEY is not configured";
              logger.warn(`free-search: engine "${engine}" skipped (no key), trying next engine`);
              continue; // 无 key 跳过
            }
            result = await searchPerplexity(request.query, request.maxResults, key, effSignal);
          } else if (engine === "deepseek-official") {
            const key = await resolveApiKey("DEEPSEEK_API_KEY", "deepseekApiKey");
            if (!key) {
              lastError = new Error("DeepSeek requires DEEPSEEK_API_KEY");
              if (engine === preferred) preferredFailure = "DEEPSEEK_API_KEY is not configured";
              logger.warn(`free-search: engine "${engine}" skipped (no key), trying next engine`);
              continue; // 无 key 跳过
            }
            result = await searchDeepSeekOfficial(request.query, request.maxResults, key, effSignal);
          } else if (engine === "serpbase") {
            // serpbase：必须配置 SERPBASE_API_KEY（无 key 跳过，同 perplexity）
            const key = await resolveApiKey("SERPBASE_API_KEY", "serpbaseApiKey");
            if (!key) {
              lastError = new Error("SerpBase requires SERPBASE_API_KEY");
              if (engine === preferred) preferredFailure = "SERPBASE_API_KEY is not configured";
              logger.warn(`free-search: engine "${engine}" skipped (no key), trying next engine`);
              continue; // 无 key 跳过
            }
            result = await searchSerpbase(request.query, request.maxResults, key, cfg, effSignal);
          } else {
            continue;
          }

          if (result.sources.length > 0 && result.sources.length < minimumSources) {
            if (!bestPartial || result.sources.length > bestPartial.result.sources.length) {
              bestPartial = { engine, result };
            }
            lastError = new Error(`engine "${engine}" returned ${result.sources.length}/${minimumSources} required sources`);
            if (engine === preferred) preferredFailure = lastError.message;
            logger.warn(`free-search: ${lastError.message}, trying next engine`);
            continue;
          }
          if (result.sources.length > 0) {
            usedEngine = engine;
            // 统一清洗 snippet：去登录/付费墙/订阅噪音，折叠空白（有值的才处理，保持 lossless JSON）
            result.sources = result.sources.map((s) =>
              s.snippet ? { ...s, snippet: cleanSnippet(s.snippet) } : s
            );
            // 用了非首选引擎时，在结果里附上准确提示（区分"不支持时间过滤被跳过"与"真实失败"）
            if (engine !== preferred) {
              if (preferredSkippedReason === "time-filter") {
                result.content = `Note: ${preferred} does not support time filtering (timeRange=${timeRangeLabel}), using ${engine}.`;
              } else if (preferredFailure) {
                result.content = `Note: ${preferred} unavailable or failed (${preferredFailure}), using ${engine}.`;
              } else {
                result.content = `Note: ${preferred} unavailable or failed, using ${engine}.`;
              }
            }
            // 写入缓存（只缓存成功结果，失败走 throw 天然不缓存）
            const cached = { ...result, provider: engine, engine: engine };
            if (cacheKey !== null) {
              // fallback 条目（实际引擎≠首选）用配置 TTL 的 1/5，首选成功保持完整 TTL
              const entryTtlMs = engine !== preferred ? Math.max(cacheTtlMs / 5, 1000) : cacheTtlMs;
              searchCache.set(cacheKey, {
                value: cached,
                expiresAt: Date.now() + entryTtlMs,
              });
              if (searchCache.size > CACHE_MAX_ENTRIES) {
                const oldest = searchCache.keys().next().value;
                if (oldest !== undefined) searchCache.delete(oldest);
              }
            }
            return { ...cached, _cache: "miss" };
          }
          lastError = new Error(`engine "${engine}" returned 0 results`);
          if (engine === preferred) preferredFailure = "returned 0 results";
          logger.warn(`free-search: ${engine} returned 0 results, trying next engine`);
        } catch (error) {
          lastError = error;
          const message = error instanceof Error ? error.message : String(error);
          if (engine === preferred) preferredFailure = message;
          logger.warn(`free-search: engine "${engine}" failed (${message}), trying next engine`);
        }
      }
      if (bestPartial) {
        const { engine, result } = bestPartial;
        result.sources = result.sources.map((source) =>
          source.snippet ? { ...source, snippet: cleanSnippet(source.snippet) } : source
        );
        return {
          ...result,
          provider: engine,
          engine,
          content: `Note: only ${result.sources.length}/${minimumSources} requested sources were found after all eligible engines were tried.`,
          _cache: "miss",
        };
      }
      throw lastError ?? new Error("all search engines failed");
    },
  };

  ctx.inject(["settings"], (sctx) => {
    // alpha.2+（SettingsProvider 有 installSection 方法）与 rc.2（模块级 installSettingsSection）双兼容：
    // 特性检测优先用 alpha 方法；缺失时动态 import 旧 API 注册（rc.2 环境，不会触发 alpha 的缺失导出报错）。
    if (typeof sctx.settings.installSection === "function") {
      sctx.settings.installSection(ctx, FREE_SEARCH_NS, Config, config ?? {}, {
        setSource: (source) => {
          current = source;
        },
        onChange: () => {
          // settings 变更时刷新系统提示词（显示最新引擎）
          if (typeof refreshPrompt === "function") refreshPrompt();
        },
      });
    } else {
      void (async () => {
        const legacy = await import("@deepseek-ai/dsh-settings");
        if (typeof legacy.installSettingsSection === "function" && legacy.settingsNamespace) {
          const legacyNs = legacy.settingsNamespace(FREE_SEARCH_NS);
          legacy.installSettingsSection(ctx, legacyNs, Config, config ?? {}, {
            setSource: (source) => {
              current = source;
            },
            onChange: () => {
              if (typeof refreshPrompt === "function") refreshPrompt();
            },
          });
        } else {
          sctx.logger?.warn?.("free-search: dsh-settings 无可用注册 API（installSection/installSettingsSection 均缺失）");
          return;
        }
      })();
    }
  });

  ctx.inject(["webServer", "settings"], (sctx) => {
    sctx.effect(() => {
      const disposers = makeBridgeRoutes(
        sctx.settings,
        (request) => provider.search(request, undefined),
        (engine, query, timeRange) => runEngineTest(engine, query, timeRange),
        getCredentials,
        providerPools
      ).map((route) => sctx.webServer.register(route));
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, "free-search: settings bridge");
  });

  ctx.web.registerSearchProvider(provider);

  // 运行时兜底：DSH 0.1.1+ 中 profile patch 的 config 会整体覆盖 bundle patch 的 config，
  // 用户的 `- id: web` patch（如只设 fetchProvider）会静默抹掉 searchProvider，导致回退 DeepSeek 官方搜索。
  // 这里在 provider 注册后检查：未指向任何 provider（undefined）时自动接管为本插件；
  // 用户显式配置了其他 provider 则不动。
  if (!ctx.web.searchProviderId) {
    ctx.web.searchProviderId = provider.id;
    logger.info(`free-search: web.searchProvider was unset (patch override or missing config), taking over as "${provider.id}"`);
  }

  // 测试工具：让 agent 逐个测试所有搜索引擎，报告可用性
  const runEngineTest = async (engine, query, timeRange) => {
    const cfg = current();
    const q = query || "DeepSeek Harness";
    const tr = parseTimeRange(timeRange);
    const attempt = async () => {
      switch (engine) {
        case "ddg":
          return await searchDdgHtml(q, 2, { ...cfg, timeRange: tr });
        case "ddg-lite":
          return await searchDdgLite(q, 2, { ...cfg, timeRange: tr });
        case "bing":
          return await searchBing(q, 2, cfg);
        case "searxng":
          return await searchSearxng(q, 2, { ...cfg, timeRange: tr });
        case "anysearch":
          return await searchAnysearch(q, 2);
        case "exa": {
          const key = await resolveApiKey("EXA_API_KEY", "exaApiKey");
          if (key) return await searchExa(q, 2, key, tr);
          return await searchExaMCP(q, 2);
        }
        case "tavily": {
          const fallbackKey = await resolveApiKey("TAVILY_API_KEY", "tavilyApiKey");
          return providerPools.run("tavily", (key) => searchTavily(q, 2, key, tr), fallbackKey);
        }
        case "keenable": {
          const key = await resolveApiKey("KEENABLE_API_KEY", "keenableApiKey");
          return await searchKeenable(q, 2, key, tr);
        }
        case "firecrawl": {
          const fallbackKey = await resolveApiKey("FIRECRAWL_API_KEY", "firecrawlApiKey");
          return providerPools.run("firecrawl", (key) => searchFirecrawl(q, 2, key, tr), fallbackKey);
        }
        case "parallel": {
          const key = await resolveApiKey("PARALLEL_API_KEY", "parallelApiKey");
          if (key) return await searchParallel(q, 2, key, tr);
          return await searchParallelMCP(q, 2, tr);
        }
        case "perplexity": {
          const key = await resolveApiKey("PERPLEXITY_API_KEY", "perplexityApiKey");
          if (!key) return { ok: false, error: "PERPLEXITY_API_KEY not configured" };
          return await searchPerplexity(q, 2, key);
        }
        case "deepseek-official": {
          const key = await resolveApiKey("DEEPSEEK_API_KEY", "deepseekApiKey");
          if (!key) return { ok: false, error: "DEEPSEEK_API_KEY not configured" };
          return await searchDeepSeekOfficial(q, 2, key);
        }
        case "serpbase": {
          const key = await resolveApiKey("SERPBASE_API_KEY", "serpbaseApiKey");
          if (!key) return { ok: false, error: "SERPBASE_API_KEY not configured" };
          return await searchSerpbase(q, 2, key, cfg);
        }
        default:
          return { ok: false, error: `unknown engine: ${engine}` };
      }
    };
    try {
      const result = await attempt();
      // 付费引擎无 key：直接透传失败结果
      if (result.ok === false) return result;
      // 免费引擎偶发反爬/空结果时重试一次
      if (result.sources && result.sources.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        return await attempt();
      }
      return {
        ok: true,
        sources: (result.sources ?? []).map((s) =>
          s.snippet ? { ...s, snippet: cleanSnippet(s.snippet) } : s
        ),
        truncated: result.truncated ?? false,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  ctx.inject(["tools"], (sctx) => {
    sctx.effect(() => {
      const dispose = sctx.tools.register(
        defineTool({
          name: "free_search_test",
          description:
            "Test every configured web search engine and report which ones work. Use this to verify engine availability, diagnose search failures, or check whether an API key is configured.",
          parameters: {
            engines: {
              type: "array",
              description: "Which engines to test (default: all). Options: ddg, ddg-lite, bing, searxng, anysearch, exa, tavily, keenable, firecrawl, parallel, perplexity, serpbase, deepseek-official.",
              items: { type: "string" },
            },
            query: {
              type: "string",
              description: "Optional search query to use for the test (default: 'DeepSeek Harness').",
            },
          },
          output: {
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                results: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      engine: { type: "string" },
                      status: { type: "string" },
                      results: { type: "number" },
                      error: { type: "string" },
                      sampleTitle: { type: "string" },
                      sampleUrl: { type: "string" },
                    },
                  },
                },
              },
            },
            render(args, value) {
              const lines = value.results.map((r) => {
                if (r.status === "ok") {
                  return `- ${r.engine}: OK (${r.results} results${r.sampleTitle ? `, e.g. "${r.sampleTitle.slice(0, 40)}"` : ""})`;
                }
                return `- ${r.engine}: FAIL - ${r.error}`;
              });
              // 契约要求直接返回 ContentBlock[]：finalizeContent 在 tools/post-execute 之后才执行，
              // 只返回字符串会让该阶段的消费者（如 dsh-hooks-codex）拿到裸字符串崩溃。
              return [{ type: "text", text: `Search engine test:\n${lines.join("\n")}` }];
            },
          },
          async execute(args) {
            const engines = args.engines && args.engines.length > 0 ? args.engines : ALL_ENGINES;
            const results = [];
            for (const engine of engines) {
              const r = await runEngineTest(engine, args.query);
              if (r.ok) {
                const item = {
                  engine,
                  status: "ok",
                  results: r.sources.length,
                };
                if (r.sources[0]?.title) item.sampleTitle = String(r.sources[0].title);
                if (r.sources[0]?.url) item.sampleUrl = String(r.sources[0].url);
                results.push(item);
              } else {
                results.push({ engine, status: "fail", error: r.error ?? "unknown error" });
              }
            }
            return { results };
          },
          finalizeContent(exec, result) {
            // render 已直接返回 block 数组；这里仅作旧路径兼容兜底（幂等）
            const text = result.content;
            if (typeof text === "string" && text.length > 0) {
              return [{ type: "text", text }];
            }
            return undefined;
          },
        })
      );
      return () => {
        dispose();
      };
    }, "free-search: test engines tool");
  });

  // 平台搜索工具：GitHub / V2EX / Bilibili / Reddit（公开 API，零依赖）
  ctx.inject(["tools"], (sctx) => {
    sctx.effect(() => {
      const dispose = sctx.tools.register(
        defineTool({
          name: "platform_search",
          description:
            "Search a specific platform (GitHub / V2EX / Bilibili / Reddit / Hacker News / Stack Overflow / Wikipedia / npm) for a query. Returns source URLs with titles and snippets. Use this when the user asks about repos, code, forum threads, videos, discussions, Q&A, encyclopedia entries, or packages.",
          parameters: {
            platform: {
              type: "string",
              description: "Platform to search: github, v2ex, bilibili, reddit, hn, stackoverflow, wikipedia, npm",
            },
            query: {
              type: "string",
              description: "The search query.",
            },
            maxResults: {
              type: "number",
              description: "Optional result count (default 5, max 10).",
            },
          },
          output: {
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                platform: { type: "string" },
                sources: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      url: { type: "string" },
                      title: { type: "string" },
                      snippet: { type: "string" },
                    },
                  },
                },
              },
            },
            render(args, value) {
              const lines = value.sources.map((s, i) => `- [${s.title ?? s.url}](${s.url})${s.snippet ? ` - ${s.snippet.slice(0, 120)}` : ""}`);
              return [{ type: "text", text: `Platform search (${value.platform}):\n${lines.join("\n") || "No results found."}` }];
            },
          },
          async execute(args) {
            const platform = args.platform;
            if (!PLATFORMS[platform]) {
              throw new Error(`unknown platform "${platform}" - use one of: ${Object.keys(PLATFORMS).join(", ")}`);
            }
            // 平台开关：settings 里禁用某平台时，工具明确告知
            const enabled = current().platforms ?? ["github", "v2ex", "bilibili", "reddit", "hn", "stackoverflow", "wikipedia", "npm"];
            if (!enabled.includes(platform)) {
              throw new Error(
                `platform "${platform}" is disabled in Free Search settings - enable it in Settings > Plugins > Free Search to use it`
              );
            }
            const limit = Math.min(args.maxResults ?? 5, 10);
            const result = await searchPlatform(platform, args.query, limit, undefined, current().lang);
            // lossless JSON 不允许 undefined 字段：剔除缺失字段
            const sources = (result.sources ?? []).map((s) => {
              const source = {};
              if (s.url !== undefined && s.url !== null && s.url !== "") source.url = s.url;
              if (s.title !== undefined && s.title !== null && s.title !== "") source.title = String(s.title);
              if (s.snippet !== undefined && s.snippet !== null && s.snippet !== "") source.snippet = String(s.snippet);
              return source;
            });
            return { platform, sources };
          },
          finalizeContent(exec, result) {
            // render 已直接返回 block 数组；这里保留为幂等兜底
            const text = result.content;
            return typeof text === "string" && text.length > 0 ? [{ type: "text", text }] : undefined;
          },
        })
      );
      return () => {
        dispose();
      };
    }, "free-search: platform search tool");
  });

  // 高级搜索工具：支持时间过滤（time_range）和指定引擎（engine）。
  // 走与 web_search 相同的统一回退链，但允许 agent 显式请求"最近 N 天"的结果。
  ctx.inject(["tools"], (sctx) => {
    sctx.effect(() => {
      const dispose = sctx.tools.register(
        defineTool({
          name: "advanced_search",
          description:
            "Search the web with optional time filtering and an explicit cost/quality strategy. Use quality-first for deep research, current news, multi-source evidence, or citation-sensitive work; ordinary discovery defaults to free-first.",
          parameters: {
            query: {
              type: "string",
              description: "The search query.",
            },
            maxResults: {
              type: "number",
              description: "Optional result count (default 5, max 10).",
            },
            timeRange: {
              type: "string",
              description: "Optional time filter. Fixed tiers: day, week, month, year. Custom: relative like 12h, 3d, 2mo, 1y, or an absolute date like 2026-07-01 (published after that date). Exa/Keenable apply it precisely; Tavily/SearXNG/DDG map to the nearest tier.",
            },
            engine: {
              type: "string",
              description: "Optional specific engine to try first: ddg, ddg-lite, bing, searxng, anysearch, exa, tavily, keenable, firecrawl, parallel, perplexity, serpbase, deepseek-official.",
            },
            strategy: {
              type: "string",
              enum: ["free-first", "quality-first"],
              description: "Routing strategy. free-first tries anonymous/free engines before paid providers. quality-first starts with Tavily/Firecrawl provider pools and falls back to free engines.",
            },
            minimumSources: {
              type: "number",
              description: "Optional minimum acceptable source count (1-10). If an engine returns fewer, continue the route and return the best partial result only after all eligible engines are tried.",
            },
          },
          output: {
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                provider: { type: "string" },
                content: { type: "string" },
                sources: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      url: { type: "string" },
                      title: { type: "string" },
                      snippet: { type: "string" },
                      publishedAt: { type: "string" },
                    },
                  },
                },
              },
            },
            render(args, value) {
              const lines = value.sources.map((s, i) => `- [${s.title ?? s.url}](${s.url})${s.snippet ? ` - ${s.snippet.slice(0, 120)}` : ""}${s.publishedAt ? ` (${s.publishedAt})` : ""}`);
              return [{ type: "text", text: `Search (${value.provider}${args.timeRange ? `, timeRange=${args.timeRange}` : ""}):\n${lines.join("\n") || "No results found."}${value.content ? `\n\n${value.content}` : ""}` }];
            },
          },
          async execute(args) {
            if (!args.query || !String(args.query).trim()) throw new Error("query is required");
            const request = {
              query: args.query,
              maxResults: Math.min(args.maxResults ?? 5, 10),
            };
            if (parseTimeRange(args.timeRange) !== undefined) request.timeRange = args.timeRange;
            if (args.strategy === "quality-first") request.strategy = "quality-first";
            else request.strategy = "free-first";
            if (Number.isInteger(args.minimumSources)) request.minimumSources = Math.min(Math.max(args.minimumSources, 1), 10);
            // engine 指定时：仅当该引擎可用才优先（仍走回退链，失败自动换引擎）
            if (args.engine && ALL_ENGINES.includes(args.engine)) request.engine = args.engine;
            const result = await provider.search(request);
            // lossless JSON 不允许 undefined 字段：按存在的值构造对象，缺字段直接省略
            return {
              provider: result.provider ?? result._provider ?? "bing",
              content: typeof result.content === "string" ? result.content : "",
              sources: (result.sources ?? []).map((s) => {
                const source = {};
                if (s.url !== undefined && s.url !== null && s.url !== "") source.url = s.url;
                if (s.title !== undefined && s.title !== null && s.title !== "") source.title = String(s.title);
                if (s.snippet !== undefined && s.snippet !== null && s.snippet !== "") source.snippet = String(s.snippet);
                if (s.publishedAt !== undefined && s.publishedAt !== null && s.publishedAt !== "") {
                  source.publishedAt = String(s.publishedAt);
                }
                return source;
              }),
            };
          },
          finalizeContent(exec, result) {
            // render 已直接返回 block 数组；这里保留为幂等兜底
            const text = result.content;
            return typeof text === "string" && text.length > 0 ? [{ type: "text", text }] : undefined;
          },
        })
      );
      return () => {
        dispose();
      };
    }, "free-search: advanced search tool");
  });

  // 让 agent 知道可用搜索引擎（动态生成，随 key/设置变化）
  ctx.inject(["systemPrompt"], (sctx) => {
    let disposeSection = null;
    refreshPrompt = () => {
      if (disposeSection) {
        disposeSection();
        disposeSection = null;
      }
      disposeSection = sctx.systemPrompt.section({
        name: "free-search:engines",
        order: 500,
        text: [
          "## Available web search engines (free-search plugin)",
          "",
          "You have the web_search tool. Its backend engine is chosen in Settings > Web.",
          "Current engine: " + (current().provider ?? "bing"),
          "Safe search filter (Settings > Plugins > Free Search): " + (current().safeSearch ?? "off") + " (off|moderate|strict). Engine default off; applies to bing/ddg/ddg-lite.",
          "Bing market: " + (current().bingMarket ?? "zh-CN") + " (mkt + Accept-Language; e.g. ru-RU returns Russian results for Cyrillic queries).",
          "",
          "Available engines and their requirements:",
          "- ddg (DuckDuckGo HTML) - FREE, no key (may be rate-limited)",
          "- ddg-lite (DuckDuckGo Lite) - FREE, no key (may be rate-limited)",
          "- bing (Bing) - FREE, no key (most stable)",
          "- searxng (meta-search, multi-instance) - FREE, no key",
          "- anysearch (AI search) - FREE, no key",
          "- exa - FREE keyless (MCP) or EXA_API_KEY for higher limits",
          "- tavily - Fleet Vault API-key pool with randomized selection; legacy TAVILY_API_KEY fallback",
          "- keenable - FREE keyless (MCP) or KEENABLE_API_KEY for higher limits",
          "- firecrawl - Fleet Vault API-key pool with randomized selection; legacy FIRECRAWL_API_KEY fallback",
          "- parallel - FREE keyless (MCP) or PARALLEL_API_KEY for higher limits",
          "- perplexity - requires PERPLEXITY_API_KEY",
          "- deepseek-official - requires DEEPSEEK_API_KEY",
          "- serpbase - Google organic results via API, requires SERPBASE_API_KEY (100 free queries on signup)",
          "",
          "ROUTING: ordinary web_search is free-first: anonymous/free engines run before paid Provider pools. Keep free-first for simple fact lookup, navigation, broad discovery, and questions already answered by adequate free results. Use advanced_search with strategy=quality-first when the user requests deep research, current news or recent changes, independent cross-source verification, citation-sensitive conclusions, or a concrete source count; also escalate after free results are empty, insufficient, stale, or contradictory. Set minimumSources when a count is required. Explicit engine selection remains authoritative. Do not infer routing from a hardcoded keyword list: choose from the requested evidence quality and observed result sufficiency. Results identify the engine actually used and why fallback occurred.",
          "",
          "Use the free_search_test tool to test which engines actually work right now.",
          "",
          "When the user wants results from a specific time window (e.g. 'last week', 'this month', 'last 3 days'), use the advanced_search tool with timeRange. Fixed tiers: day|week|month|year. Custom: 12h, 3d, 2mo, 1y, or an absolute date like 2026-07-01.",
          "",
          "For platform-specific searches (GitHub repos, V2EX threads, Bilibili videos, Reddit posts, Hacker News discussions, Stack Overflow questions, Wikipedia articles, npm packages), use the platform_search tool with platform: github|v2ex|bilibili|reddit|hn|stackoverflow|wikipedia|npm.",
          "",
          "The user can switch the search engine themselves by typing /free-search-engine in the chat — it opens a picker to choose an engine, just like the settings page. This changes the preferred engine; search still falls back to other engines automatically if it fails. You should not switch engines on your own; let the user decide.",
        ].join("\n"),
      });
    };
    sctx.effect(() => {
      refreshPrompt();
      return () => {
        if (disposeSection) disposeSection();
        disposeSection = null;
      };
    }, "free-search: engine list prompt section");
  });
}

export {
  ALL_ENGINES,
  ANYSEARCH_URL,
  BING_URL,
  Config,
  DDG_HTML_URL,
  DDG_LITE_URL,
  EXA_MCP_URL,
  FIRECRAWL_URL,
  FREE_ENGINES,
  FREE_SEARCH_NS,
  KEENABLE_MCP_URL,
  KEENABLE_URL,
  PARALLEL_URL,
  PLATFORMS,
  SEARXNG_INSTANCES,
  TAVILY_URL,
  TIME_RANGES,
  apply,
  approximateTimeRange,
  buildEngineChain,
  formatKeenableRelative,
  inject,
  name,
  parseTimeRange,
  searchAnysearch,
  searchBing,
  searchBilibili,
  searchDeepSeekOfficial,
  searchDdgHtml,
  searchDdgLite,
  searchExa,
  searchExaMCP,
  searchFirecrawl,
  searchGithub,
  searchHackerNews,
  searchKeenable,
  searchKeenableMCP,
  searchKeenableREST,
  searchNpm,
  searchParallel,
  searchPerplexity,
  searchPlatform,
  searchReddit,
  searchSearxng,
  searchSerpbase,
  searchStackOverflow,
  searchTavily,
  searchV2ex,
  normalizeProviderPool,
  providerKeyFingerprint,
  providerPoolCandidates,
  redactProviderPool,
  runWithProviderPool,
  searchWikipedia,
};
