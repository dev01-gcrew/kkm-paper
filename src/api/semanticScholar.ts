import axios, { AxiosError } from "axios";

const client = axios.create({
  // ✅ Semantic Scholar를 브라우저에서 직접 호출하지 않습니다(CORS/429 원인)
  // Azure Static Web Apps에서는 Functions가 같은 도메인의 /api 아래로 노출됩니다.
  baseURL: "/api/ss",
  timeout: 20000,
});

export type Paper = {
  paperId: string;
  title: string;
  year?: number;
  venue?: string;
  authors?: { name: string }[];
  abstract?: string;
  url?: string;
  openAccessPdf?: { url: string; status?: string } | null;
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getWithRetry<T>(path: string, params: any): Promise<T> {
  const maxAttempts = 4;
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      const res = await client.get<T>(path, { params });
      return res.data;
    } catch (e: any) {
      const err = e as AxiosError<any>;
      const status = err.response?.status;

      // 429/503/timeout/network는 재시도
      const isRetryable =
        status === 429 ||
        status === 503 ||
        err.code === "ECONNABORTED" ||
        err.message?.includes("Network Error");

      if (!isRetryable || attempt >= maxAttempts) throw e;

      // Retry-After 있으면 우선
      const ra = err.response?.headers?.["retry-after"];
      const retryAfterMs =
        ra && !Number.isNaN(Number(ra)) ? Number(ra) * 1000 : null;

      const backoff = retryAfterMs ?? Math.min(8000, 500 * 2 ** (attempt - 1));
      await sleep(backoff);
    }
  }

  throw new Error("unexpected retry loop exit");
}

export async function searchPapers(params: {
  query: string;
  limit?: number;
  offset?: number;
}) {
  const { query, limit = 10, offset = 0 } = params;

  return getWithRetry<{ total: number; offset: number; next: number; data: Paper[] }>(
    "/search",
    { query, limit, offset }
  );
}

export async function getPaper(paperId: string) {
  return getWithRetry<Paper>(`/paper/${encodeURIComponent(paperId)}`, {});
}
