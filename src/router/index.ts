import { createRouter, createWebHistory } from "vue-router";
import SearchPage from "@/pages/SearchPage.vue";
import PaperDetailPage from "@/pages/PaperDetailPage.vue";

export default createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", component: SearchPage },
    { path: "/paper/:paperId", component: PaperDetailPage },
  ],
});
