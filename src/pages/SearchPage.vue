<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { searchPapers, type Paper } from "@/api/semanticScholar";

const router = useRouter();

const q = ref("cosmetic formulation");
const loading = ref(false);
const error = ref<string | null>(null);

const total = ref(0);
const offset = ref(0);
const limit = ref(10);
const papers = ref<Paper[]>([]);

async function onSearch(reset = true) {
  if (!q.value.trim()) return;

  loading.value = true;
  error.value = null;

  try {
    const res = await searchPapers({
      query: q.value,
      limit: limit.value,
      offset: reset ? 0 : offset.value,
    });

    total.value = res.total ?? 0;
    offset.value = res.offset ?? 0;
    papers.value = res.data ?? [];
  } catch (e: any) {
    error.value = e?.message ?? "검색 실패";
  } finally {
    loading.value = false;
  }
}

function openDetail(p: Paper) {
  router.push(`/paper/${p.paperId}`);
}

function nextPage() {
  offset.value = offset.value + limit.value;
  onSearch(false);
}

function prevPage() {
  offset.value = Math.max(0, offset.value - limit.value);
  onSearch(false);
}

onSearch(true);
</script>

<template>
  <div style="max-width: 1000px; margin: 24px auto; padding: 0 16px;">
    <h2>논문 검색 (Semantic Scholar)</h2>

    <div style="display:flex; gap:8px; margin: 12px 0;">
      <input
        v-model="q"
        placeholder="키워드 입력"
        style="flex:1; padding:10px;"
        @keyup.enter="onSearch(true)"
      />
      <button style="padding:10px 14px;" @click="onSearch(true)" :disabled="loading">
        검색
      </button>
    </div>

    <div v-if="error" style="color:#b00020; margin: 8px 0;">{{ error }}</div>
    <div v-if="loading">불러오는 중...</div>

    <div v-if="!loading" style="margin-top: 8px;">
      <div style="display:flex; justify-content: space-between; align-items:center;">
        <div>총 {{ total }}건</div>
        <div style="display:flex; gap:8px;">
          <button @click="prevPage" :disabled="offset===0 || loading">이전</button>
          <button @click="nextPage" :disabled="papers.length < limit || loading">다음</button>
        </div>
      </div>

      <hr style="margin: 12px 0;" />

      <div v-for="p in papers" :key="p.paperId" style="padding: 12px 0; border-bottom: 1px solid #eee;">
        <div style="font-weight: 700; cursor: pointer;" @click="openDetail(p)">
          {{ p.title }}
        </div>
        <div style="font-size: 13px; color: #555; margin-top: 4px;">
          {{ p.year ?? "-" }} · {{ p.venue ?? "-" }}
        </div>
        <div style="font-size: 13px; color: #555;">
          저자: {{ (p.authors ?? []).slice(0,5).map(a => a.name).join(", ") }}
          <span v-if="(p.authors?.length ?? 0) > 5"> ...</span>
        </div>
        <div style="margin-top: 6px; display:flex; gap:8px; flex-wrap: wrap;">
          <a v-if="p.url" :href="p.url" target="_blank" rel="noreferrer">Semantic Scholar</a>
          <a v-if="p.openAccessPdf?.url" :href="p.openAccessPdf.url" target="_blank" rel="noreferrer">
            PDF(오픈액세스)
          </a>
          <span v-else style="color:#888;">PDF 링크 없음</span>
        </div>
      </div>
    </div>
  </div>
</template>
