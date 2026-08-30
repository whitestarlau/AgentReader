import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import electron from "vite-plugin-electron/simple";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	root: resolve(__dirname, "src/renderer"),
	server: { port: 5173, strictPort: true },
	plugins: [
		react(),
		electron({
			main: {
				entry: resolve(__dirname, "src/main/index.ts"),
				vite: { build: { outDir: resolve(__dirname, "dist-electron"), rollupOptions: { output: { entryFileNames: "main.js" } } } },
			},
			preload: {
				input: resolve(__dirname, "src/preload/index.ts"),
				vite: { build: { outDir: resolve(__dirname, "dist-electron"), rollupOptions: { output: { entryFileNames: "preload.js" } } } },
			},
		}),
	],
});
