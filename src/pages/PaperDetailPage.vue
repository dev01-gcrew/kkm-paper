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


// Azure Blob Storage 저장: 프론트 -> Azure Functions -> Blob(PDF) + JSON(메타) 저장
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
