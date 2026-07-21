import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Дашборд — внутренний инструмент, раздаётся как статический сайт.
// allowedHosts: true — иначе dev-сервер Vite (npm start) блокирует запросы
// с внешних доменов (Render/Railway/и т.п.: "Blocked request. This host is not allowed").
export default defineConfig({
  // Многостраничная сборка: главный дашборд + дневной отчёт бухгалтера.
  // Обе страницы — отдельные входы Rollup, поэтому `npm run build` собирает обе.
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        'daily-report': resolve(__dirname, 'daily-report.html'),
      },
    },
  },
  server: {
    host: true,
    allowedHosts: true,
  },
  preview: {
    host: true,
    allowedHosts: true,
  },
});
