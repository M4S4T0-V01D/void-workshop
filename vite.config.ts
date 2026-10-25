import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Tauri expects a fixed dev port and no host exposure beyond localhost.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: '127.0.0.1' },
  build: { target: 'es2022', sourcemap: false, outDir: 'dist', emptyOutDir: true },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    fileParallelism: false,
    pool: 'forks',
    maxWorkers: 1,
  },
});
