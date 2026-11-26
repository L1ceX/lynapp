import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/renderer",
  clearScreen: false,
  plugins: [react()],
  resolve: {
    alias: {
      "@shared": resolve("src/shared")
    }
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"]
    }
  },
  build: {
    outDir: resolve("dist"),
    emptyOutDir: true,
    target: "es2022"
  }
});
