// 从米哈游官方观测枢 wiki 拉取角色/武器图标，本地打包进 public/gacha-icons
// 下载 → sharp 缩放 144px → WebP（带透明度），一条龙；已存在的 .webp 自动跳过（增量）
// 运行：node scripts/fetch-wiki-icons.mjs
// 版本节奏参考：米哈游约每 6 周(42天)一个版本，新版本上线后跑一次即可补齐新角色
import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "public", "gacha-icons");
mkdirSync(outDir, { recursive: true });

const API =
  "https://api-static.mihoyo.com/common/blackboard/ys_obc/v1/home/content/list?app_sn=ys_obc&channel_id=189";

const resp = await fetch(API);
if (!resp.ok) {
  throw new Error(`wiki API 请求失败: HTTP ${resp.status}`);
}
const json = await resp.json();
if (json.retcode !== 0) {
  throw new Error(`wiki API 返回错误: ${json.message}`);
}

const groups = json.data.list[0]?.children ?? [];
const wanted = groups.filter((g) => ["角色", "武器"].includes(g.name));
if (wanted.length !== 2) {
  throw new Error(`wiki 分组结构变化: ${groups.map((g) => g.name).join(",")}`);
}

let downloaded = 0;
let skipped = 0;
let failed = 0;

for (const group of wanted) {
  for (const item of group.list) {
    const { title, icon } = item;
    if (!title || !icon) {
      continue;
    }
    // Windows 文件名非法字符兜底
    const safe = title.replace(/[\\/:*?"<>|]/g, "_");
    const file = join(outDir, `${safe}.webp`);
    if (existsSync(file)) {
      skipped++;
      continue;
    }
    try {
      const r = await fetch(icon);
      if (!r.ok) {
        failed++;
        console.error(`✗ ${title}: HTTP ${r.status}`);
        continue;
      }
      const buf = Buffer.from(await r.arrayBuffer());
      const out = await sharp(buf)
        .resize(144, 144, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .webp({ quality: 82 })
        .toBuffer();
      writeFileSync(file, out);
      downloaded++;
      // 控制请求节奏
      await new Promise((resolve) => setTimeout(resolve, 120));
    } catch (e) {
      failed++;
      console.error(`✗ ${title}: ${e.message}`);
    }
  }
}

// 统计总体积（仅统计 .webp，忽略历史 .png 残留）
const files = readdirSync(outDir).filter((f) => f.endsWith(".webp"));
const sizeMb = (files.reduce((acc, f) => acc + statSync(join(outDir, f)).size, 0) / 1024 / 1024).toFixed(2);
console.log(`✓ 新增 ${downloaded}，跳过 ${skipped}，失败 ${failed}；共 ${files.length} 个 webp，${sizeMb} MB`);
if (failed > 0) {
  process.exitCode = 1;
}
