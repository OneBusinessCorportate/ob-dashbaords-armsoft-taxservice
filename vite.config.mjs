import { defineConfig } from 'vite';

// Дашборд — внутренний инструмент, раздаётся как статический сайт.
// allowedHosts: true — иначе dev-сервер Vite (npm start) блокирует запросы
// с внешних доменов (Render/Railway/и т.п.: "Blocked request. This host is not allowed").
export default defineConfig({
  server: {
    host: true,
    allowedHosts: true,
  },
  preview: {
    host: true,
    allowedHosts: true,
  },
});
