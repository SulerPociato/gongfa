import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE ?? '/',
  server: {
    proxy: {
      // 2026-11-27 社区版：开发时 /api 交给本地 Node 服务（pnpm dev:server）。
      '/api': 'http://127.0.0.1:8787',
    },
  },
});
