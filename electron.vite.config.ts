import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

const sharedAlias = resolve("src/shared");

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        "@shared": sharedAlias
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        "@shared": sharedAlias
      }
    }
  },
  renderer: {
    root: "src/renderer",
    resolve: {
      alias: {
        "@shared": sharedAlias
      }
    },
    plugins: [react()]
  }
});