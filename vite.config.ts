import { fileURLToPath, URL } from "node:url";
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  // ✅ 로컬 개발에서만 /api 요청을 Azure Functions(localhost:7071)로 프록시
  // 배포(Azure Static Web Apps)에서는 /api가 같은 도메인으로 붙기 때문에 그대로 둬도 됨
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:7071",
        changeOrigin: true,
      },
    },
  },  
})
