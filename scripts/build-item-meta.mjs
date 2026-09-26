// 从 Snap.Hutao.Remastered 官方元数据仓库生成 item_id → (名称, 类型, 星级) 完整表
// 源：https://github.com/SnapHutaoRemasteringProject/Snap.Metadata（Remastered 项目维护的元数据 fork）
// 输出 src-tauri/src/data/item_meta.json：{ id: [name, type, rank] }
// 类型：角色 / 武器；星级：角色 4-5（Quality 字段）、武器 1-5（RankLevel 字段）
import { writeFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, cpSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, sep, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "src-tauri", "src", "data", "item_meta.json");
const REPO_TARBALL = "https://api.github.com/repos/SnapHutaoRemasteringProject/Snap.Metadata/tarball/main";
const REPO_PREFIX = "SnapHutaoRemasteringProject-Snap.Metadata";

const work = mkdtempSync(join(tmpdir(), "snap-meta2-"));
try {
  const tarball = join(work, "repo.tar.gz");
  if (process.argv[2]) {
    cpSync(process.argv[2], tarball);
  } else {
    const tlsOption = process.platform === "win32" ? "--ssl-no-revoke " : "";
    execSync(`curl -fsSL ${tlsOption}--retry 3 "${REPO_TARBALL}" -o "${tarball}"`, { stdio: "inherit" });
  }
  execSync(`tar --force-local -xzf "${tarball}" -C "${work}"`, { stdio: "inherit" });

  const repoDir = readdirSync(work).find((d) => d.startsWith(REPO_PREFIX));
  if (!repoDir) throw new Error("tarball 中找不到仓库目录");
  const chs = join(work, repoDir, "Genshin", "CHS");

  const map = {};

  // 角色: Avatar/<id>.json —— 每文件含 Id/Name/Quality(星级)
  let avatarCount = 0;
  for (const f of readdirSync(join(chs, "Avatar")).filter((f) => f.endsWith(".json"))) {
    const a = JSON.parse(readFileSync(join(chs, "Avatar", f), "utf8"));
    if (a.Id && a.Name) {
      map[String(a.Id)] = [a.Name, "角色", a.Quality ?? 5];
      avatarCount++;
    }
  }

  // 武器: Weapon.json —— 数组，含 Id/Name/RankLevel
  const weapons = JSON.parse(readFileSync(join(chs, "Weapon.json"), "utf8"));
  for (const w of weapons) {
    if (w.Id && w.Name) {
      map[String(w.Id)] = [w.Name, "武器", w.RankLevel ?? 3];
    }
  }

  writeFileSync(out, JSON.stringify(map));
  console.log(`✓ item_meta.json: 角色 ${avatarCount} + 武器 ${weapons.length}，共 ${Object.keys(map).length} 条`);
} finally {
  const tempRoot = realpathSync(tmpdir());
  const target = realpathSync(work);
  if (!target.startsWith(`${tempRoot}${sep}`) || !basename(target).startsWith("snap-meta2-")) {
    throw new Error(`拒绝清理非预期临时目录: ${target}`);
  }
  rmSync(work, { recursive: true, force: true });
}
