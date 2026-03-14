import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:6920',
    },
  },
  build: {
    outDir: '../dist/dashboard',
    emptyOutDir: true,
  },
});
