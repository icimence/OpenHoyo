// 极简 markdown → html（标题/粗体/行内代码/列表/段落），
// 供更新说明类弹窗（首启 CHANGELOG 弹窗、更新提示弹窗）展示 latest.json/releases md 用。
export function mdToHtml(md: string): string {
  const esc = (s: string): string =>
    s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
  const inline = (s: string): string =>
    esc(s)
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");

  const out: string[] = [];
  let inList = false;
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^#{1,3}\s+/.test(line)) {
      if (inList) { out.push("</ul>"); inList = false; }
      out.push(`<h3>${inline(line.replace(/^#{1,3}\s+/, ""))}</h3>`);
    } else if (/^[-*]\s+/.test(line)) {
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${inline(line.replace(/^[-*]\s+/, ""))}</li>`);
    } else if (line === "") {
      if (inList) { out.push("</ul>"); inList = false; }
    } else {
      if (inList) { out.push("</ul>"); inList = false; }
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  if (inList) { out.push("</ul>"); }
  return out.join("\n");
}
