// 图片地址统一出口：所有米哈游官方图片都经后端 hoyoimg:// 协议加载（见 static_res.rs）。
// 已下载到本地的直接读盘；未下载的由后端代为请求官方地址，用户开启本地缓存时顺带落盘。
// 浏览器环境（无 Tauri）下原样返回，便于前端单独调试。

const OFFICIAL = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.(mihoyo|hoyoverse|miyoushe|hoyolab)\.com\//i;

function convert(path: string): string | null {
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { convertFileSrc?: (p: string, protocol: string) => string } }).__TAURI_INTERNALS__;
  return internals?.convertFileSrc ? internals.convertFileSrc(path, "hoyoimg") : null;
}

/** 官方图片 URL → 本地优先的地址；非官方地址一律不展示（返回空串） */
export function img(url: string | null | undefined): string {
  if (!url || !OFFICIAL.test(url)) {
    return "";
  }
  return convert(`u/${url}`) ?? url;
}

/** 观测枢图鉴里按名称索引的角色/武器图标（"角色与武器图标"资源组） */
export function wikiImg(name: string): string {
  return convert(`wiki/${name}`) ?? "";
}

/** hoyoimg 地址 → 原始官方 URL（非 u/ 前缀返回 null） */
function originalOf(src: string): string | null {
  const m = /^[a-z]+:\/\/hoyoimg\.localhost\/(.+)$|^hoyoimg:\/\/localhost\/(.+)$/i.exec(src);
  if (!m) {
    return null;
  }
  let path: string;
  try {
    path = decodeURIComponent(m[1] ?? m[2]);
  } catch {
    return null;
  }
  return path.startsWith("u/") ? path.slice(2) : null;
}

const warned = new Set<string>();

/**
 * 本地图像通道兜底：经 hoyoimg 加载失败时（缓存损坏、协议异常、后端未就绪等），
 * 立即改为直连米哈游官方地址，并拦截页面各处的 onerror（避免图片被隐藏/移除）。
 * 捕获阶段在 document 上执行，先于元素自身的 onerror。
 */
export function installImageFallback(): void {
  document.addEventListener(
    "error",
    (ev) => {
      const el = ev.target;
      if (!(el instanceof HTMLImageElement) || el.dataset.direct) {
        return;
      }
      const orig = originalOf(el.currentSrc || el.src);
      if (!orig || !OFFICIAL.test(orig)) {
        return;
      }
      ev.stopPropagation();
      el.dataset.direct = "1";
      const path = orig.split("?")[0];
      if (!warned.has(path)) {
        warned.add(path);
        console.warn(`[static] 本地图像通道加载失败，改为直连官方地址: ${path}`);
      }
      el.src = orig;
    },
    true,
  );
}
