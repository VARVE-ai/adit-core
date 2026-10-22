import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({ build: { outDir: '../cli/local-assets/web', emptyOutDir: true, rollupOptions: { input: { app: fileURLToPath(new URL('./index.html', import.meta.url)), reader: fileURLToPath(new URL('./share-reader.html', import.meta.url)) } } }, server: { host: '127.0.0.1' } });
