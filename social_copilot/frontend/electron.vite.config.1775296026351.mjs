// electron.vite.config.ts
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
var __electron_vite_injected_dirname = "D:\\SC_project\\SocialClaw\\social_copilot\\frontend";
var electron_vite_config_default = defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "dist/main",
      rollupOptions: {
        input: {
          index: resolve(__electron_vite_injected_dirname, "src/main/index.ts")
        },
        // Externalize native modules like better-sqlite3
        external: ["better-sqlite3"]
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "dist/preload",
      rollupOptions: {
        input: {
          index: resolve(__electron_vite_injected_dirname, "src/preload/index.ts")
        }
      }
    }
  },
  renderer: {
    root: "src/renderer",
    build: {
      outDir: "dist/renderer",
      rollupOptions: {
        input: {
          index: resolve(__electron_vite_injected_dirname, "src/renderer/index.html"),
          assistant: resolve(__electron_vite_injected_dirname, "src/renderer/assistant.html"),
          overlay: resolve(__electron_vite_injected_dirname, "src/renderer/overlay.html")
        }
      }
    },
    plugins: [react()]
  }
});
export {
  electron_vite_config_default as default
};
