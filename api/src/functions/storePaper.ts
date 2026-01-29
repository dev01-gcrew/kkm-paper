import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import axios, { AxiosError } from "axios";
import { BlobServiceClient, ContainerClient } from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";

type PaperAuthor = {
  name: string;
};

type StorePaperBody = {
  paperId: string;
  title: string;
  pdfUrl: string;
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

export async function storePaper(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  let step = "start";
  const requestId = ctx.invocationId ?? `req_${Date.now()}`;

  try {
    step = "read_env";
    const storageAccountUrl = process.env.STORAGE_ACCOUNT_URL;
    const containerName = process.env.STORAGE_CONTAINER || "papers";

    if (!storageAccountUrl) {
      return jsonResponse(500, {
        requestId,
        step,
        message: "STORAGE_ACCOUNT_URL 이 설정되지 않았습니다.",
        hint: "Static Web App > 구성(Configuration) > 애플리케이션 설정에 STORAGE_ACCOUNT_URL을 추가하세요.",
      });
    }

    step = "read_body";
    const body = (await req.json().catch((e: unknown) => {
      throw Object.assign(new Error("요청 본문(JSON) 파싱 실패"), { cause: e });
    })) as Partial<StorePaperBody>;

    if (!body?.paperId || !body?.title || !body?.pdfUrl) {
      return jsonResponse(400, {
        requestId,
        step,
        message: "paperId, title, pdfUrl 은 필수입니다.",
        receivedKeys: body ? Object.keys(body) : null,
      });
    }

    step = "create_blob_client";
    const credential = new DefaultAzureCredential();
    const blobServiceClient = new BlobServiceClient(storageAccountUrl, credential);
    const containerClient = blobServiceClient.getContainerClient(containerName);

    step = "create_container_if_not_exists";
    await containerClient.createIfNotExists();

    step = "build_blob_names";
    const base = buildBaseName(body as StorePaperBody);
    const pdfBlobName = await resolveUniqueBlobName(containerClient, base, ".pdf");
    const jsonBlobName = pdfBlobName.replace(/\.pdf$/i, ".json");

    step = "download_pdf";
    const pdfRes = await axios.get<ArrayBuffer>(body.pdfUrl, {
      responseType: "arraybuffer",
      timeout: 60000,
      maxRedirects: 5,
      headers: {
        "User-Agent": "kkm-paper-ui/1.0 (+AzureFunctions)",
        Accept: "application/pdf,application/octet-stream;q=0.9,*/*;q=0.8",
      },
      validateStatus: (s: number) => s >= 200 && s < 400,
    });

    const pdfBytes = Buffer.from(pdfRes.data);

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
