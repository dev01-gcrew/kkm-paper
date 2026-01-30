import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import axios, { AxiosError, type AxiosRequestConfig } from "axios";
import { BlobServiceClient, ContainerClient } from "@azure/storage-blob";
//import { DefaultAzureCredential } from "@azure/identity";

type PaperAuthor = {
  name: string;
};

type StorePaperBody = {
  paperId: string;
  title: string;
  //pdfUrl: string;
  // 둘 중 하나면 됨: pdfUrl(서버 다운로드) 또는 pdfBase64(브라우저가 다운로드 후 전송)
  pdfUrl?: string;
  pdfBase64?: string;
  pdfFileName?: string;  

  year?: number | string;
  venue?: string;
  authors?: PaperAuthor[];
  paperUrl?: string;
};

type ErrorJson = {
  name: string;
  message: string;
  stack: string | null;
  cause: string | null;
  axiosInfo: {
    axios: true;
    code: string | null;
    status: number | null;
    statusText: string | null;
    responseHeaders: Record<string, unknown> | null;
    responseDataPreview: string | null;
    config: {
      url: string | null;
      method: string | null;
      timeout: number | null;
    };
  } | null;
};

function sanitizeFileName(input: string): string {
  const cleaned = input.replace(/[\/\\:*?"<>|]/g, "_").replace(/\s+/g, " ").trim();
  return cleaned.length > 140 ? cleaned.slice(0, 140).trim() : cleaned;
}

function buildBaseName(p: StorePaperBody): string {
  const year = p.year ? String(p.year) : "noyear";
  const firstAuthor = p.authors?.[0]?.name ? sanitizeFileName(p.authors[0].name) : "noauthor";
  const title = sanitizeFileName(p.title || "untitled");
  return `${year}_${firstAuthor}_${title}`.replace(/\s/g, "_");
}

async function resolveUniqueBlobName(
  containerClient: ContainerClient,
  base: string,
  ext: string,
): Promise<string> {
  let candidate = `${base}${ext}`;
  let i = 0;

  while (i < 999) {
    const blobClient = containerClient.getBlockBlobClient(candidate);
    const exists = await blobClient.exists();
    if (!exists) {
      return candidate;
    }
    i += 1;
    candidate = `${base}(${i})${ext}`;
  }

  throw new Error("동일 파일명이 너무 많아 저장할 수 없습니다.");
}

function jsonResponse(status: number, body: unknown): HttpResponseInit {
  return {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

function errorToJson(err: unknown): ErrorJson {
  const e = err as Error & {
    cause?: unknown;
    isAxiosError?: boolean;
  };

  const axiosInfo = (() => {
    const ax = err as AxiosError;
    if (!ax || !(ax as AxiosError).isAxiosError) {
      return null;
    }

    const data = ax.response?.data;
    const preview =
      typeof data === "string" ? data.slice(0, 2000) : data ? "[non-string data]" : null;

    return {
      axios: true as const,
      code: ax.code ?? null,
      status: ax.response?.status ?? null,
      statusText: ax.response?.statusText ?? null,
      responseHeaders: (ax.response?.headers as unknown as Record<string, unknown>) ?? null,
      responseDataPreview: preview,
      config: {
        url: ax.config?.url ?? null,
        method: ax.config?.method ?? null,
        timeout: (ax.config?.timeout as number | undefined) ?? null,
      },
    };
  })();

  const cause = (() => {
    const c = e?.cause;
    if (!c) {
      return null;
    }
    if (typeof c === "string") {
      return c;
    }
    if (typeof c === "object" && c && "message" in c) {
      return String((c as { message?: unknown }).message ?? "[cause object]");
    }
    return "[cause object]";
  })();

  return {
    name: e?.name ?? "Error",
    message: e?.message ?? String(err),
    stack: e?.stack ?? null,
    cause,
    axiosInfo,
  };
}

// ---------------------------
// MDPI 403 우회용 다운로드 로직
// ---------------------------
function isMdpiPdfUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname.endsWith("mdpi.com") && u.pathname.includes("/pdf");
 } catch {
    return false;
  }
}

function browserLikeHeaders(extra?: Record<string, string>) {
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
    "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    ...extra,
  };
}

async function downloadPdfWithFallback(pdfUrl: string, paperUrl?: string): Promise<Buffer> {
  // 1) 기본 다운로드 시도
  const baseConfig: AxiosRequestConfig = {
    url: pdfUrl,
    method: "get",
    timeout: 60000,
    responseType: "arraybuffer",
    maxRedirects: 5,
    headers: browserLikeHeaders({
      Accept: "application/pdf,application/octet-stream;q=0.9,*/*;q=0.8",
      Referer: paperUrl ?? "https://www.mdpi.com/",
    }),
    validateStatus: (s) => s >= 200 && s < 400,
  };

  try {
    const r = await axios.request<ArrayBuffer>(baseConfig);
    return Buffer.from(r.data);
  } catch (e: any) {
    const status = e?.response?.status;
    // 2) MDPI + 403이면: HTML 먼저 호출해서 set-cookie 확보 후 PDF 재요청
    if (status === 403 && isMdpiPdfUrl(pdfUrl)) {
      // pdfUrl: https://www.mdpi.com/.../pdf?version=...
      // htmlUrl: https://www.mdpi.com/...  (pdf 제거)
      const htmlUrl = pdfUrl.replace(/\/pdf(\?.*)?$/, "");

      const htmlRes = await axios.get<string>(htmlUrl, {
        timeout: 60000,
        maxRedirects: 5,
        headers: browserLikeHeaders({
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          Referer: "https://www.mdpi.com/",
        }),
        validateStatus: (s) => s >= 200 && s < 400,
      });

      const setCookie = (htmlRes.headers as any)?.["set-cookie"];
      const cookieHeader =
        Array.isArray(setCookie) && setCookie.length > 0
          ? setCookie.map((c: string) => c.split(";")[0]).join("; ")
          : "";

      const pdfRes2 = await axios.get<ArrayBuffer>(pdfUrl, {
        responseType: "arraybuffer",
        timeout: 60000,
        maxRedirects: 5,
        headers: browserLikeHeaders({
          Accept: "application/pdf,application/octet-stream;q=0.9,*/*;q=0.8",
          Referer: htmlUrl,
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        }),
        validateStatus: (s) => s >= 200 && s < 400,
      });

      return Buffer.from(pdfRes2.data);
    }

    throw e;
  }
}

export async function storePaper(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  let step = "start";
  const requestId = ctx.invocationId ?? `req_${Date.now()}`;

  try {
    step = "read_env";
    const containerName = process.env.STORAGE_CONTAINER || "papers";

    step = "read_body";
    const body = (await req.json().catch((e: unknown) => {
      throw Object.assign(new Error("요청 본문(JSON) 파싱 실패"), { cause: e });
    })) as Partial<StorePaperBody>;

    //if (!body?.paperId || !body?.title || !body?.pdfUrl) {
    if (!body?.paperId || !body?.title || (!body?.pdfUrl && !body?.pdfBase64)) {
      return jsonResponse(400, {
        requestId,
        step,
        //message: "paperId, title, pdfUrl 은 필수입니다.",
        message: "paperId, title, pdfUrl 또는 pdfBase64 중 하나는 필수입니다.",
        receivedKeys: body ? Object.keys(body) : null,
      });
    }

    step = "create_blob_client";
    const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
    if (!connectionString) {
      return jsonResponse(500, {
        requestId,
        step,
        message: "AZURE_STORAGE_CONNECTION_STRING 이 설정되지 않았습니다.",
        hint:
          "Azure Portal > Static Web App(kkm-paper-app) > 구성(Configuration) > 애플리케이션 설정에 AZURE_STORAGE_CONNECTION_STRING 을 추가하세요.",
      });
    }

    const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    const containerClient = blobServiceClient.getContainerClient(containerName);


    step = "create_container_if_not_exists";
    await containerClient.createIfNotExists();

    step = "build_blob_names";
    const base = buildBaseName(body as StorePaperBody);
    const pdfBlobName = await resolveUniqueBlobName(containerClient, base, ".pdf");
    const jsonBlobName = pdfBlobName.replace(/\.pdf$/i, ".json");

    step = "download_pdf";

    // ✅ 1) 프론트가 PDF를 다운로드해 base64로 전달한 경우(출판사 403 우회)
    let pdfBytes: Buffer;

    if (body.pdfBase64) {
      const b64 = body.pdfBase64.includes(",")
        ? body.pdfBase64.split(",")[1]
        : body.pdfBase64;

      pdfBytes = Buffer.from(b64, "base64");
    } else {
      
      //// ✅ 2) pdfUrl을 서버에서 직접 다운로드 (일부 출판사(MDPI 등)는 403 가능)
      //const pdfRes = await axios.get<ArrayBuffer>(body.pdfUrl!, {
      //  responseType: "arraybuffer",
      //  timeout: 60000,
      //  maxRedirects: 5,
      //  headers: {
      //    // 브라우저와 유사한 UA/Referer로 시도 (완전 해결 보장 X)
      //    "User-Agent":
      //      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
      //    Accept: "application/pdf,application/octet-stream;q=0.9,*/*;q=0.8",
      //    "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
      //    Referer: body.paperUrl ?? "https://www.mdpi.com/",
      //  },
      //  validateStatus: (status: number) => status >= 200 && status < 400,
      //});
      //pdfBytes = Buffer.from(pdfRes.data);

      // ✅ 2) pdfUrl을 서버에서 직접 다운로드 (MDPI 403이면 HTML→쿠키 확보→PDF 재시도)
      pdfBytes = await downloadPdfWithFallback(body.pdfUrl!, body.paperUrl);
    }

    step = "upload_pdf";
    const pdfBlobClient = containerClient.getBlockBlobClient(pdfBlobName);
    await pdfBlobClient.uploadData(pdfBytes, {
      blobHTTPHeaders: { blobContentType: "application/pdf" },
    });

    step = "upload_json";
    const meta = {
      paperId: body.paperId,
      title: body.title,
      year: body.year ?? null,
      venue: body.venue ?? null,
      authors: (body.authors ?? []).map((a: PaperAuthor) => a.name),
      paperUrl: body.paperUrl ?? null,
      pdfUrl: body.pdfUrl,
      storedPdfBlobName: pdfBlobName,
      storedJsonBlobName: jsonBlobName,
      storedAtUtc: new Date().toISOString(),
    };

    const jsonBlobClient = containerClient.getBlockBlobClient(jsonBlobName);
    await jsonBlobClient.uploadData(Buffer.from(JSON.stringify(meta, null, 2), "utf-8"), {
      blobHTTPHeaders: { blobContentType: "application/json; charset=utf-8" },
    });

    step = "done";
    return jsonResponse(200, {
      requestId,
      message: "저장 완료",
      pdfBlobName,
      jsonBlobName,
    });
  } catch (e: unknown) {
    // 서버 로그(가능한 범위)
    ctx.error(`[storePaper] requestId=${requestId}, step=${step}`);
    ctx.error(e);

    // ✅ 화면(Network Response)에 에러를 내려줌
    return jsonResponse(500, {
      requestId,
      step,
      error: errorToJson(e),
      hint:
        step.includes("upload") || step.includes("container") || step.includes("create_blob")
          ? "스토리지 권한/RBAC 또는 STORAGE_ACCOUNT_URL 설정을 확인하세요."
          : step === "download_pdf"
          ? "pdfUrl 접근 실패(403/timeout/redirect) 가능. error.axiosInfo.status를 확인하세요."
          : "step 값을 기준으로 해당 구간을 점검하세요.",
    });
  }
}

app.http("storePaper", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "store-paper",
  handler: storePaper,
});
