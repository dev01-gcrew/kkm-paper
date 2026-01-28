import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import axios from "axios";
import { BlobServiceClient } from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";

type StorePaperRequest = {
  paperId: string;
  title: string;
  year?: number;
  venue?: string;
  authors?: { name: string }[];
  paperUrl?: string;
  pdfUrl: string;
};

function sanitizeFileName(input: string): string {
  // Windows/Blob 호환을 위해 파일명에 들어가면 안 되는 문자 제거
  // 길이 제한도 적당히 적용
  const cleaned = input
    .replace(/[\/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 140 ? cleaned.slice(0, 140).trim() : cleaned;
}

function buildBaseName(p: StorePaperRequest): string {
  const year = p.year ? String(p.year) : "noyear";
  const firstAuthor = p.authors?.[0]?.name ? sanitizeFileName(p.authors[0].name) : "noauthor";
  const title = sanitizeFileName(p.title || "untitled");
  // 예: 2022_Kim_Title...
  return `${year}_${firstAuthor}_${title}`.replace(/\s/g, "_");
}

async function resolveUniqueBlobName(containerClient: any, base: string, ext: string): Promise<string> {
  // base.ext가 있으면 base(1).ext, base(2).ext ... 형태로 증가
  let candidate = `${base}${ext}`;
  let i = 0;

  // 최대 999까지 시도 (실무적으로 충분)
  while (i < 999) {
    const blobClient = containerClient.getBlockBlobClient(candidate);
    const exists = await blobClient.exists();
    if (!exists) return candidate;
    i += 1;
    candidate = `${base}(${i})${ext}`;
  }
  throw new Error("동일 파일명이 너무 많아 저장할 수 없습니다.");
}

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

app.http("storePaper", {
  methods: ["POST"],
  authLevel: "anonymous", // SWA에서는 인증/권한을 SWA에서 제어 가능(필요 시 변경)
  route: "store-paper",
  handler: async (req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> => {
    try {
      const storageAccountUrl = process.env.STORAGE_ACCOUNT_URL; // 예: https://<account>.blob.core.windows.net
      const containerName = process.env.STORAGE_CONTAINER || "papers";

      if (!storageAccountUrl) {
        return jsonResponse(500, { message: "STORAGE_ACCOUNT_URL 이 설정되지 않았습니다." });
      }

      const body = (await req.json()) as StorePaperRequest;
      if (!body?.pdfUrl || !body?.title || !body?.paperId) {
        return jsonResponse(400, { message: "paperId, title, pdfUrl 은 필수입니다." });
      }

      // BlobServiceClient (권장: Managed Identity + RBAC)
      const credential = new DefaultAzureCredential();
      const blobServiceClient = new BlobServiceClient(storageAccountUrl, credential);
      const containerClient = blobServiceClient.getContainerClient(containerName);
      await containerClient.createIfNotExists();

      const base = buildBaseName(body);

      // 파일명 충돌 처리
      const pdfBlobName = await resolveUniqueBlobName(containerClient, base, ".pdf");
      const jsonBlobName = pdfBlobName.replace(/\.pdf$/i, ".json");

      // 1) PDF 다운로드 (서버에서 직접 가져와 저장)
      const pdfRes = await axios.get<ArrayBuffer>(body.pdfUrl, {
        responseType: "arraybuffer",
        timeout: 60000,
        maxRedirects: 5,
        headers: {
          // 일부 서버가 UA 없으면 차단하는 경우가 있어 최소 헤더 지정
          "User-Agent": "kkm-paper-ui/1.0 (+AzureFunctions)",
          "Accept": "application/pdf,application/octet-stream;q=0.9,*/*;q=0.8",
        },
        validateStatus: (s) => s >= 200 && s < 400,
      });

      const pdfBytes = Buffer.from(pdfRes.data);

      // 2) PDF 업로드
      const pdfBlobClient = containerClient.getBlockBlobClient(pdfBlobName);
      await pdfBlobClient.uploadData(pdfBytes, {
        blobHTTPHeaders: { blobContentType: "application/pdf" },
      });

      // 3) 메타정보 JSON 생성/업로드 (파일명 동일 베이스)
      const meta = {
        paperId: body.paperId,
        title: body.title,
        year: body.year ?? null,
        venue: body.venue ?? null,
        authors: (body.authors ?? []).map(a => a.name),
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

      // (선택) blob URL 반환 - private 컨테이너면 직접 접근 불가할 수 있음(SAS 필요)
      return jsonResponse(200, {
        message: "저장 완료",
        pdfBlobName,
        jsonBlobName,
      });
    } catch (e: any) {
      ctx.error(e);
      return jsonResponse(500, { message: e?.message ?? "서버 오류" });
    }
  },
});
