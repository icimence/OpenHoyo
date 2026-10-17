// 运行平台识别：安卓 WebView 走移动端布局（抽屉导航、底部弹层、触控尺寸），桌面保持原样
let mobile = false;

/** MainActivity 注入的 JS 接口（仅安卓） */
interface AndroidBridge {
  insets(): string;
  moveToBack(): void;
}

function bridge(): AndroidBridge | undefined {
  return (window as unknown as { HoyoAndroid?: AndroidBridge }).HoyoAndroid;
}

/** 把原生层给出的系统栏边距写入 --safe-*（旧版 WebView 的 env(safe-area-inset-*) 恒为 0） */
function applyInsets(): void {
  const b = bridge();
  if (!b) {
    return;
  }
  try {
    const v = JSON.parse(b.insets()) as Record<"top" | "right" | "bottom" | "left", number>;
    const root = document.documentElement.style;
    for (const side of ["top", "right", "bottom", "left"] as const) {
      root.setProperty(`--safe-${side}`, `${v[side] ?? 0}px`);
    }
  } catch (e) {
    console.warn(`[platform] 读取系统栏边距失败: ${String(e)}`);
  }
}

export function initPlatform(): void {
  mobile = /Android/i.test(navigator.userAgent);
  document.documentElement.dataset.platform = mobile ? "android" : "desktop";
  if (mobile) {
    applyInsets();
    window.addEventListener("hoyo-insets", applyInsets);
  }
}

export function isMobile(): boolean {
  return mobile;
}

/** 安卓：应用退到后台（首页按返回键） */
export function moveTaskToBack(): void {
  bridge()?.moveToBack();
}
