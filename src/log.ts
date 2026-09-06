// 前端日志桥：console.* → 后端日志文件（%LOCALAPPDATA%/com.learnrepo.hoyoauth/logs/）
//
// 方向说明：@tauri-apps/plugin-log 的 attachConsole 是「后端→前端」方向（把 Rust 日志
// 打到 webview 控制台），把前端日志写进文件必须调用它的 info/warn/error 函数。
// 这里挂接 console.info/warn/error 统一转发，业务代码只需照常 console.info(...)。
//
// 注意：不要同时调用 attachConsole——那会把后端日志回显到 console，再次触发本桥形成回环。
// forwarding 守卫仅防御意外的重入。

let forwarding = false;

function fmt(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return `${a.message}`;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

async function forward(level: "info" | "warn" | "error", args: unknown[]): Promise<void> {
  if (forwarding) return;
  forwarding = true;
  try {
    const plug = await import("@tauri-apps/plugin-log");
    await plug[level === "warn" ? "warn" : level === "error" ? "error" : "info"](`[js] ${fmt(args)}`);
  } catch {
    // 插件不可用（如单元测试环境）时静默
  } finally {
    forwarding = false;
  }
}

/** 在 main() 最早期调用：此后所有 console.info/warn/error 都会进入日志文件 */
export function initFrontendLog(): void {
  for (const level of ["info", "warn", "error"] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      orig(...args);
      void forward(level, args);
    };
  }
  console.info("前端日志桥已挂接");
}
