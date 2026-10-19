import { defineConfig } from 'vite';
export default defineConfig({ build: { outDir: '../cli/local-assets/web', emptyOutDir: true }, server: { host: '127.0.0.1' } });
