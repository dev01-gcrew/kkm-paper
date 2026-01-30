import axios from "axios";

const api = axios.create({
  // Azure Static Web Apps에서는 Functions가 같은 도메인의 /api 아래로 노출됩니다.
  // 로컬 개발/별도 배포 시에는 VITE_UPLOAD_API_BASE 로 오버라이드 가능합니다.
  //baseURL: import.meta.env.VITE_UPLOAD_API_BASE || "",
  timeout: 60000,
});

export async function uploadToSharePoint(payload: {
  paperId: string;
  title: string;
  pdfUrl: string;
}) {
  // (기존) 백엔드가 pdfUrl로 원본을 가져와 SharePoint에 업로드 + 메타 저장
  const res = await api.post("/api/upload", payload);
  return res.data;
}

export async function storeToAzureBlob(payload: {
  paperId: string;
  title: string;
  year?: number;
  venue?: string;
  authors?: { name: string }[];
  paperUrl?: string;
  pdfUrl: string;
  pdfBase64?: string;
  pdfFileName?: string;
}) {
  // Azure Functions (api/store-paper)로 저장 요청
  const res = await api.post("/api/store-paper", payload);
  return res.data as { message: string; pdfBlobName: string; jsonBlobName: string };
}
