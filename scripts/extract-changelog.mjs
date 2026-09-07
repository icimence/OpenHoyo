// 提取 CHANGELOG.md 中指定版本的段落（## vX.Y.Z 到下一个 ## 之间）
// 用法: node scripts/extract-changelog.mjs 0.1.6
// 无对应段落时输出空串（退出码 0），由调用方决定回退策略。
import { readFileSync } from "node:fs";

const version = process.argv[2];
if (!version) {
  console.error("用法: extract-changelog.mjs <version>");
  process.exit(1);
}

const text = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const lines = text.split(/\r?\n/);
const header = `## v${version}`;

let started = false;
const out = [];
for (const line of lines) {
  if (started) {
    if (/^## /.test(line)) {
      break;
    }
    out.push(line);
  } else if (line.trim() === header) {
    started = true;
  }
}

// 去掉首尾空行
while (out.length && out[0].trim() === "") out.shift();
while (out.length && out[out.length - 1].trim() === "") out.pop();
console.log(out.join("\n"));
