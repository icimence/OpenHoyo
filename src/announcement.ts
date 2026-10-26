import createDOMPurify from "dompurify";
import { img } from "./img";

const purifier = createDOMPurify(window);

function linkUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

// 官方旧公告用 JS SDK 包装外链，只提取这个固定调用中的 HTTPS 地址，不执行脚本。
purifier.addHook("uponSanitizeAttribute", (node, data) => {
  if (node.nodeName === "A" && data.attrName === "href") {
    const match = /^javascript:\s*miHoYoGameJSSDK\.openInBrowser\(\s*(['"])(https:\/\/[^'"]+)\1\s*\);?$/i.exec(data.attrValue);
    if (match) data.attrValue = linkUrl(match[2]) ?? "";
  }
});

const textStyles = ["color", "background-color", "font-size", "font-weight", "font-style", "text-align", "text-decoration", "white-space", "line-height", "letter-spacing", "text-indent", "vertical-align"];

/** 保留公告图文结构，图片沿用应用的官方图片通道；移除脚本、事件和覆盖应用的布局样式。 */
export function announcementFragment(html: string): DocumentFragment {
  const fragment = purifier.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: ["p","div","span","br","hr","h1","h2","h3","h4","h5","h6","b","strong","i","em","u","s","del","sub","sup","font","ol","ul","li","blockquote","pre","code","a","img","figure","figcaption","table","caption","thead","tbody","tfoot","tr","th","td","colgroup","col","time"],
    ALLOWED_ATTR: ["href","src","data-src","alt","title","style","align","color","colspan","rowspan","datetime"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
  // 官方把本地时间标记 <t ...> 编码成了文本；只移除标记，不把解码文本重新当 HTML 解析。
  const textNodes = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
  while (textNodes.nextNode()) {
    const text = textNodes.currentNode;
    text.textContent = text.textContent?.replace(/<\/?t\b[^>]*>/gi, "") ?? "";
  }
  fragment.querySelectorAll<HTMLElement>("[style]").forEach(element => {
    const styles = textStyles.map(property => [property, element.style.getPropertyValue(property)]);
    element.removeAttribute("style");
    for (const [property, value] of styles) {
      if (value && !/url\s*\(|expression\s*\(|var\s*\(/i.test(value)) element.style.setProperty(property, value);
    }
  });
  fragment.querySelectorAll<HTMLAnchorElement>("a").forEach(anchor => {
    const url = linkUrl(anchor.getAttribute("href") ?? "");
    if (url) {
      anchor.href = url;
      anchor.rel = "noopener noreferrer";
    } else anchor.removeAttribute("href");
  });
  fragment.querySelectorAll<HTMLImageElement>("img").forEach(image => {
    const source = img(image.getAttribute("src") || image.getAttribute("data-src"));
    image.removeAttribute("data-src");
    if (!source) { image.remove(); return; }
    image.src = source;
    image.alt ||= "公告配图";
    image.loading = "lazy";
    image.decoding = "async";
    image.addEventListener("error", () => { console.warn("[home] 公告配图加载失败"); });
  });
  return fragment;
}
