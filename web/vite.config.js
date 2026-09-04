import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [
    tailwindcss(),
  ],
  build: {
    // 产物直接覆盖仓库根的 public/：后端 express.static(PUBLIC_DIR) 零改动即可生效
    outDir: '../public',
    // outDir 位于项目根之外，Vite 默认不会清空，必须显式声明
    emptyOutDir: true,
  },
  server: {
    proxy: {
      // 前端统一用相对路径（fetch('api/search')），dev 期只需一条转发规则；
      // SSE（/api/stats/stream）由 http-proxy 原生流式透传
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
})
