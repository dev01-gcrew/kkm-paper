import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import axios from "axios";

/**
 * Semantic Scholar 프록시: 논문 상세
 * GET /api/ss/paper/{paperId}
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
        validateStatus: (s) => s >= 200 && s < 500,
      });

      if (res.status === 429 || res.status === 503) {
        const ra = parseRetryAfterMs(res.headers);
        const backoff = ra ?? Math.min(8000, 500 * 2 ** (attempt - 1));
        ctx.warn(`[ssPaper] rate limited/status=${res.status}, retry in ${backoff}ms (attempt ${attempt}/${maxAttempts})`);
        if (attempt >= maxAttempts) return res;
        await sleep(backoff);
        continue;
      }

      return res;
    } catch (e: any) {
      const backoff = Math.min(8000, 500 * 2 ** (attempt - 1));
      ctx.warn(`[ssPaper] network error: ${e?.message ?? e}, retry in ${backoff}ms (attempt ${attempt}/${maxAttempts})`);
      if (attempt >= maxAttempts) throw e;
      await sleep(backoff);
    }
  }

  throw new Error("unexpected retry loop exit");
}

app.http("ssPaper", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "ss/paper/{paperId}",
  handler: async (req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> => {
    try {
      const paperId = (req.params.paperId || "").trim();
      if (!paperId) return jsonResponse(400, { message: "paperId is required" });

      const fields = [
        "title",
        "year",
        "venue",
        "authors",
        "abstract",
        "url",
        "openAccessPdf",
      ].join(",");

      const cacheKey = `paper:${paperId}|${fields}`;
      const now = Date.now();
      const hit = cache.get(cacheKey);
      if (hit && hit.expiresAt > now) {
        return jsonResponse(200, hit.value);
      }

      const url = `${S2_BASE}/paper/${encodeURIComponent(paperId)}`;
      const res = await getWithRetry(url, { fields }, ctx);

      if (res.status >= 400) {
        return jsonResponse(res.status, {
          message: "semantic scholar error",
          status: res.status,
          data: res.data ?? null,
        });
      }

      const value = res.data;
      cache.set(cacheKey, { value, expiresAt: now + 60_000 }); // 상세는 60초 캐시

      return jsonResponse(200, value);
    } catch (e: any) {
      ctx.error(e);
      return jsonResponse(500, { message: e?.message ?? "server error" });
    }
  },
});
