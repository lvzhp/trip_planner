import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * 多端开发配置。
 *
 * - 5180：避开本机 5173 上常驻的其他 Vite 项目
 * - host: true：手机 / 微信开发者工具可通过局域网 IP 访问
 * - TP_API_TARGET：本地联调时把 /api 代理到真实后端（默认 8010）
 */
export default defineConfig(({ mode }) => {
  const apiTarget = process.env.TP_API_TARGET || 'http://127.0.0.1:8010'
  return {
    plugins: [react()],
    server: {
      host: true,
      port: 5180,
      strictPort: true,
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
        },
      },
    },
    preview: {
      host: true,
      port: 5181,
      strictPort: true,
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
      target: 'es2020',
    },
    define: {
      __TP_MODE__: JSON.stringify(mode),
    },
  }
})
