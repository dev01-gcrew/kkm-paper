<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute } from "vue-router";
import { getPaper, type Paper } from "@/api/semanticScholar";
// (선택) 백엔드 업로드 API
import { uploadToSharePoint, storeToAzureBlob } from "@/api/uploadApi";

const route = useRoute();
const paperId = String(route.params.paperId);

const loading = ref(false);
const error = ref<string | null>(null);
const paper = ref<Paper | null>(null);

const authorText = computed(() =>
  (paper.value?.authors ?? []).map(a => a.name).join(", ")
);

async function load() {
  loading.value = true;
  error.value = null;
  try {
    paper.value = await getPaper(paperId);
  } catch (e: any) {
    error.value = e?.message ?? "상세 조회 실패";
  } finally {
    loading.value = false;
  }
}

// ✅ Azure(Functions) 서버에서 PDF를 직접 다운로드하면 403(봇/클라우드 IP 차단)이 자주 발생할 수 있어서
//    브라우저에서 PDF를 받아 base64로 전달하는 방식을 기본으로 사용합니다.
async function fetchPdfBase64(pdfUrl: string): Promise<string> {
  const response = await fetch(pdfUrl, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`PDF 접근 실패: ${response.status} ${response.statusText}`);
  }
  const blob = await response.blob();

  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result;
      if (typeof result !== "string") return reject(new Error("파일 읽기 결과가 문자열이 아닙니다."));

      // data:application/pdf;base64,AAAA...
      const idx = result.indexOf(",");
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(new Error("파일 읽기 오류"));
    reader.readAsDataURL(blob);
  });

  return base64;
}

async function downloadPdf() {
  const pdfUrl = paper.value?.openAccessPdf?.url;
  if (!pdfUrl) return;

  // 1) 먼저 Azure Storage에 저장(PDF + JSON 메타)
  //    (서버가 pdfUrl을 직접 다운받지 않도록 pdfBase64를 같이 보냄)
  try {
    const pdfBase64 = await fetchPdfBase64(pdfUrl);

    await storeToAzureBlob({
      paperId: paper.value!.paperId,
      title: paper.value!.title,
      year: typeof paper.value!.year === "string" ? parseInt(paper.value!.year, 10) : paper.value!.year,
      venue: paper.value!.venue,
      authors: paper.value!.authors,
      paperUrl: paper.value!.url,
      pdfUrl,
      pdfBase64,
    });
  } catch (e: any) {
    // 저장 실패해도 사용자는 PDF를 볼 수 있게 다운로드는 진행
    console.warn("스토리지 저장 실패:", e?.message ?? e);
  }

  // 2) 사용자 다운로드(새 탭)
  window.open(pdfUrl, "_blank", "noreferrer");
}


/*
async function downloadPdf() {
  const url = paper.value?.openAccessPdf?.url;
  if (!url) return;

  // 1) 먼저 Azure Storage에 저장(PDF + JSON 메타)
  try {

    await storeToAzureBlob({
      paperId: paper.value!.paperId,
      title: paper.value!.title,
      year: paper.value!.year,
      venue: paper.value!.venue,
      authors: paper.value!.authors,
      paperUrl: paper.value!.url,
      pdfUrl: url,
    });
  } catch (e: any) {
    // 저장 실패해도 사용자는 PDF를 볼 수 있게 다운로드는 진행
    console.warn("스토리지 저장 실패:", e?.message ?? e);
  }

  // 2) 사용자 다운로드(새 탭)
  window.open(url, "_blank", "noreferrer");
}
*/



// Azure Blob Storage 저장: 프론트 -> Azure Functions -> Blob(PDF) + JSON(메타) 저장
/*
async function storeToBlob() {
  if (!paper.value?.openAccessPdf?.url) {
    alert("오픈액세스 PDF 링크가 없어서 저장할 수 없습니다.");
    return;
  }
  
  const res = await storeToAzureBlob({
    paperId: paper.value.paperId,
    title: paper.value.title,
    year: paper.value.year,
    venue: paper.value.venue,
    authors: paper.value.authors,
    paperUrl: paper.value.url,
    pdfUrl: paper.value.openAccessPdf.url,
  });
  alert(`저장 완료\nPDF: ${res.pdfBlobName}\nMETA: ${res.jsonBlobName}`);
}
*/
// PaperDetailPage.vue 내의 storeToBlob 함수를 아래와 같이 교체하세요.
async function storeToBlob() {
  const pdfUrl = paper.value?.openAccessPdf?.url;
  if (!pdfUrl) {
    alert("오픈액세스 PDF 링크가 없어서 저장할 수 없습니다.");
    return;
  }

  loading.value = true;

  try {
    // 1. 브라우저에서 직접 PDF fetch
    const response = await fetch(pdfUrl);
    if (!response.ok) {
      throw new Error(`PDF 접근 실패: ${response.status} ${response.statusText}`);
    }
    const blob = await response.blob();

    // 2. Blob -> Base64 변환 (TS2345 에러 해결 지점)
    const pdfBase64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      
      reader.onloadend = () => {
        const result = reader.result;
        if (typeof result === "string") {
          const splitData = result.split(",");
          // 배열의 두 번째 요소([1])가 존재하는지 확인하여 undefined 에러 방지
          const base64Part = splitData[1];
          if (base64Part !== undefined) {
            resolve(base64Part);
          } else {
            // 콤마가 없는 경우 전체 결과 반환
            resolve(result);
          }
        } else {
          reject(new Error("파일 읽기 결과가 문자열이 아닙니다."));
        }
      };

      reader.onerror = () => reject(new Error("파일 읽기 오류"));
      reader.readAsDataURL(blob);
    });

    // 3. 서버 API 호출
    // paper.value!.year가 string일 경우를 대비해 숫자로 변환 처리 추가
    const res = await storeToAzureBlob({
      paperId: paper.value!.paperId,
      title: paper.value!.title,
      year: typeof paper.value!.year === 'string' ? parseInt(paper.value!.year, 10) : paper.value!.year,
      venue: paper.value!.venue,
      authors: paper.value!.authors,
      paperUrl: paper.value!.url,
      pdfUrl: pdfUrl,
      pdfBase64: pdfBase64,
    });

    alert(`저장 완료\nPDF: ${res.pdfBlobName}`);
  } catch (e: any) {
    console.error("저장 중 오류:", e);
    alert(`저장 실패: ${e.message || "알 수 없는 오류"}`);
  } finally {
    loading.value = false;
  }
}

// (선택) SharePoint 업로드: 프론트 -> Azure Functions -> Graph/SharePoint 처리
async function upload() {
  if (!paper.value?.openAccessPdf?.url) {
    alert("오픈액세스 PDF 링크가 없어서 업로드할 수 없습니다.");
    return;
  }
  await uploadToSharePoint({
    paperId: paper.value.paperId,
    title: paper.value.title,
    pdfUrl: paper.value.openAccessPdf.url,
  });
  alert("업로드 요청 완료");
}

load();
</script>

<template>
  <div style="max-width: 1000px; margin: 24px auto; padding: 0 16px;">
    <a href="/">← 검색으로</a>

    <div v-if="loading" style="margin-top: 12px;">불러오는 중...</div>
    <div v-if="error" style="margin-top: 12px; color:#b00020;">{{ error }}</div>

    <div v-if="paper" style="margin-top: 12px;">
      <h2 style="margin-bottom: 8px;">{{ paper.title }}</h2>
      <div style="color:#555; font-size: 13px;">
        {{ paper.year ?? "-" }} · {{ paper.venue ?? "-" }}
      </div>
      <div style="color:#555; font-size: 13px; margin-top: 4px;">
        저자: {{ authorText || "-" }}
      </div>

      <div style="margin-top: 12px; white-space: pre-wrap;">
        <strong>Abstract</strong>
        <div style="margin-top: 6px; color:#333;">
          {{ paper.abstract ?? "초록 없음" }}
        </div>
      </div>

      <div style="margin-top: 12px; display:flex; gap:8px; flex-wrap: wrap;">
        <a v-if="paper.url" :href="paper.url" target="_blank" rel="noreferrer">Semantic Scholar 페이지</a>
        <button @click="downloadPdf" :disabled="!paper.openAccessPdf?.url">
          PDF 다운로드(오픈액세스)
        </button>

        <button @click="storeToBlob" :disabled="!paper.openAccessPdf?.url">
          Azure Storage 저장(PDF+JSON)
        </button>

        <button @click="upload">SharePoint 업로드</button> 
      </div>

      <div v-if="!paper.openAccessPdf?.url" style="margin-top: 8px; color:#888;">
        이 논문은 API 응답에 오픈액세스 PDF 링크(openAccessPdf.url)가 없습니다.
        (저작권/배포 정책에 따라 다름)
      </div>
    </div>
  </div>
</template>
