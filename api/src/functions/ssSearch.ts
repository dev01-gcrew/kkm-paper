import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import axios from "axios";

/**
 * Semantic Scholar 프록시: 검색
 * GET /api/ss/search?query=...&limit=10&offset=0
 */

const S2_BASE = "https://api.semanticscholar.org/graph/v1";
const DEFAULT_TIMEOUT_MS = 15000;

// 간단 메모리 캐시 (Functions 인스턴스 단위)
type CacheEntry = { expiresAt: number; value: any };
const cache = new Map<string, CacheEntry>();

function jsonResponse(status: number, body: any): HttpResponseInit {
  return {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseRetryAfterMs(headers: any): number | null {
  const v = headers?.["retry-after"] ?? headers?.["Retry-After"];
  if (!v) return null;

  // Retry-After: seconds OR HTTP-date
  const asNumber = Number(v);
  if (!Number.isNaN(asNumber) && asNumber > 0) return asNumber * 1000;

  const asDate = Date.parse(v);
  if (!Number.isNaN(asDate)) {
    const diff = asDate - Date.now();
    return diff > 0 ? diff : 0;
  }
  return null;
}

async function getWithRetry(url: string, params: any, ctx: InvocationContext) {
  const maxAttempts = 4;
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      const res = await axios.get(url, {
        params,
        timeout: DEFAULT_TIMEOUT_MS,
        headers: {
          "User-Agent": "kkm-paper/1.0 (+AzureFunctions)",
          Accept: "application/json",
        },
        validateStatus: (s) => s >= 200 && s < 500, // 4xx도 응답으로 받아서 처리
      });

      // 429 / 503류는 재시도
      if (res.status === 429 || res.status === 503) {
        const ra = parseRetryAfterMs(res.headers);
        const backoff = ra ?? Math.min(8000, 500 * 2 ** (attempt - 1));
        ctx.warn(`[ssSearch] rate limited/status=${res.status}, retry in ${backoff}ms (attempt ${attempt}/${maxAttempts})`);
        if (attempt >= maxAttempts) return res;
        await sleep(backoff);
        continue;
      }

      return res;
    } catch (e: any) {
      // timeout / network 계열
      const backoff = Math.min(8000, 500 * 2 ** (attempt - 1));
      ctx.warn(`[ssSearch] network error: ${e?.message ?? e}, retry in ${backoff}ms (attempt ${attempt}/${maxAttempts})`);
      if (attempt >= maxAttempts) throw e;
      await sleep(backoff);
    }
  }

  throw new Error("unexpected retry loop exit");
}

app.http("ssSearch", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "ss/search",
  handler: async (req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> => {
    try {
      const query = (req.query.get("query") || "").trim();
      const limit = Math.min(Number(req.query.get("limit") ?? "10") || 10, 100);
      const offset = Math.max(Number(req.query.get("offset") ?? "0") || 0, 0);

      if (!query) return jsonResponse(400, { message: "query is required" });

      const fields = [
        "title",
        "year",
        "venue",
        "authors",
        "abstract",
        "url",
        "openAccessPdf",
      ].join(",");

      const cacheKey = `search:${query}|${limit}|${offset}|${fields}`;
      const now = Date.now();
      const hit = cache.get(cacheKey);
      if (hit && hit.expiresAt > now) {
        return jsonResponse(200, hit.value);
      }

      const url = `${S2_BASE}/paper/search`;
      const res = await getWithRetry(url, { query, limit, offset, fields }, ctx);

      // Semantic Scholar가 4xx를 주면 그대로 전달 (프론트가 메시지 처리 가능)
      if (res.status >= 400) {
        return jsonResponse(res.status, {
          message: "semantic scholar error",
          status: res.status,
          data: res.data ?? null,
        });
      }

      // 성공 캐시(기본 20초)
      const value = res.data;
      cache.set(cacheKey, { value, expiresAt: now + 20_000 });

      return jsonResponse(200, value);
    } catch (e: any) {
      ctx.error(e);
      return jsonResponse(500, { message: e?.message ?? "server error" });
    }
  },
});
