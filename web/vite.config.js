import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'

// config.js 为本地私有配置（gitignore），CI / 干净检出时无此文件；
// 缺失时回退到仓库随附的 config.example.js（公共默认），保证前端构建不中断。
let PORT, WEB_BASE_PATH
try {
  ({ PORT, WEB_BASE_PATH } = await import('../config.js'))
} catch {
  ({ PORT, WEB_BASE_PATH } = await import('../config.example.js'))
}

/**
 * 部署前缀 -> vite base：
 * - '' / '/' / 缺省 → '/'（站点根，与改动前行为一致）
 * - '/dht' / 'dht/' → '/dht/'
 */
// 可选：构建时用 VITE_BASE 环境变量临时覆盖 config.js（CI / 临时验证用）
const raw = String(process.env.VITE_BASE ?? WEB_BASE_PATH ?? '').trim()
const base = !raw || raw === '/' ? '/' : `/${raw.replace(/^\/+|\/+$/g, '')}/`

export default defineConfig({
  // 产物 index.html 中 css/js 的引用前缀，交由 config.js 的 WEB_BASE_PATH 控制
  base,
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
      // target 端口与 config.js 的 PORT 保持一致，后端换端口时无需再改这里
      '/api': {
        target: `http://localhost:${PORT}`,
        changeOrigin: true,
      },
    },
  },
})
