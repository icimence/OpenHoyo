// 构建 item_id → 名称 精简映射（src-tauri/src/data/item_names.json）
// 数据源: Snap.Metadata 镜像（Avatar/*.json 按单人拆分 + Weapon.json 单文件）
// 用法: node scripts/build-item-names.mjs [tarball路径]  （缺省时自动下载）
import { writeFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "src-tauri", "src", "data", "item_names.json");

const REPO_TARBALL = "https://api.github.com/repos/wangdage12/Snap.Metadata/tarball/main";

const work = mkdtempSync(join(tmpdir(), "snap-meta-"));
try {
  // 下载整仓库 tarball（Avatar 为按人拆分的多文件，逐个拉太慢）
  // 注: 本机网络环境的 schannel 证书吊销检查会失败，统一加 --ssl-no-revoke
  const tarball = join(work, "repo.tar.gz");
  if (process.argv[2]) {
    cpSync(process.argv[2], tarball);
  } else {
    execSync(`curl -fsSL --ssl-no-revoke --retry 3 "${REPO_TARBALL}" -o "${tarball}"`, { stdio: "inherit" });
  }
  execSync(`tar --force-local -xzf "${tarball}" -C "${work}"`, { stdio: "inherit" });

  const repoDir = readdirSync(work).find((d) => d.startsWith("wangdage12-Snap.Metadata") || d.startsWith("DGP"));
  if (!repoDir) throw new Error("tarball 中找不到仓库目录");
  const chs = join(work, repoDir, "Genshin", "CHS");

  const map = {};

  // 角色: Avatar/*.json（每文件一个对象，含 Id/Name）
  const avatarDir = join(chs, "Avatar");
  for (const f of readdirSync(avatarDir).filter((f) => f.endsWith(".json"))) {
    const a = JSON.parse(readFileSync(join(avatarDir, f), "utf8"));
    if (a.Id && a.Name) {
      map[a.Id] = a.Name;
    }
  }
  const avatarCount = Object.keys(map).length;

  // 武器: Weapon.json（数组，含 Id/Name）
  const weapons = JSON.parse(readFileSync(join(chs, "Weapon.json"), "utf8"));
  for (const w of weapons) {
    if (w.Id && w.Name) {
      map[w.Id] = w.Name;
    }
  }

  writeFileSync(out, JSON.stringify(map));
  const mb = (readFileSync(out).length / 1024).toFixed(1);
  console.log(`✓ item_names.json: 角色 ${avatarCount} + 武器 ${weapons.length - 0} 项，共 ${Object.keys(map).length} 条，${mb} KB`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
