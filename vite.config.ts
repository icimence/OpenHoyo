import { defineConfig } from "vite";

// `tauri android dev` 会注入 TAURI_DEV_HOST（本机局域网地址），手机/模拟器经此访问开发服务器
const host = process.env.TAURI_DEV_HOST;
// 5173 可能落在 Windows 动态保留端口段内，可用 VITE_PORT 覆盖（需同步 tauri devUrl）
const port = Number(process.env.VITE_PORT) || 5173;

export default defineConfig({
  clearScreen: false,
  server: {
    port,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: port + 1 } : undefined,
  },
  build: {
    target: "chrome110",
  },
});
