// 提取指定版本的用户更新说明；找不到时输出零字节，便于调用方判断缺失。
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function extractChangelog(text, version) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## v${version}`);
  if (start < 0) return "";
  const next = lines.findIndex((line, i) => i > start && /^## /.test(line));
  return lines.slice(start + 1, next < 0 ? undefined : next).join("\n").trim();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = process.argv[2];
  if (!version) throw new Error("用法: extract-changelog.mjs <version>");
  const text = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
  const notes = extractChangelog(text, version);
  if (notes) process.stdout.write(`${notes}\n`);
}
