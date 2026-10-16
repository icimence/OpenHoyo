import { wikiImg } from "./img";

/** 祈愿物品图标：优先本地已下载的观测枢图鉴资源（新角色无需等发版），否则用安装包内置图标 */
export function iconSrc(name: string): string {
  return wikiImg(name) || bundledIconSrc(name);
}

export function bundledIconSrc(name: string): string {
  return `/gacha-icons/${encodeURIComponent(name)}.webp`;
}

/** <img> 的 onerror：图鉴资源未下载时回退内置图标，再失败则移除 */
export function iconFallbackAttr(name: string): string {
  const fallback = bundledIconSrc(name).replace(/'/g, "%27");
  return `onerror="if(this.dataset.fb){this.remove()}else{this.dataset.fb=1;this.src='${fallback}'}"`;
}

export function esc(value: string): string {
  const element = document.createElement("div");
  element.textContent = value;
  return element.innerHTML;
}
