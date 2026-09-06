// 一次性调研脚本：用已登录用户生成 authkey，探测祈愿 H5 的内部端点
// 运行: node scripts/probe-gacha-api.mjs
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

const APPDATA = process.env.APPDATA;
const SRC = join(APPDATA, "com.learnrepo.hoyoauth", "users.db");
const TMP = join(tmpdir(), "probe-users.db");
copyFileSync(SRC, TMP);

const db = new DatabaseSync(TMP, { readOnly: true });
const user = db
  .prepare(
    "SELECT aid, mid, stoken, game_roles FROM users WHERE is_oversea = 0 AND game_roles LIKE '%hk4e_cn%' LIMIT 1",
  )
  .get();
db.close();
rmSync(TMP, { force: true });

if (!user) throw new Error("数据库中无国服用户");

// 从 game_roles 提取国服角色
const roles = JSON.parse(user.game_roles);
const role = roles.find((r) => r.game_biz.includes("hk4e_cn"));

// ---------- DS Gen1 (LK2) ----------
const CN_LK2 = "21d2764ed385827b2005dc5d38b2a844";
const t = Math.floor(Date.now() / 1000);
const r = Array.from(randomBytes(6))
  .map((b) => "0123456789abcdefghijklmnopqrstuvwxyz"[b % 36])
  .join("");
const ds = `${t},${r},${createHash("md5").update(`salt=${CN_LK2}&t=${t}&r=${r}`).digest("hex")}`;

const DEVICE_ID = "9f0d1c6e-2b7a-4d3e-8f5a-1c2b3d4e5f6a";
const headers = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) miHoYoBBS/2.114.0",
  Accept: "application/json",
  "x-rpc-app_version": "2.114.0",
  "x-rpc-client_type": "5",
  "x-rpc-device_id": DEVICE_ID,
  Referer: "https://app.mihoyo.com",
  DS: ds,
};

// ① genAuthKey
// stoken 列存的是完整 cookie 字符串（mid=..;stoken=..;stuid=..），解析出 stoken 值
const stokenVal = user.stoken.match(/stoken=([^;]+)/)?.[1] ?? "";

const authResp = await fetch("https://api-takumi.mihoyo.com/binding/api/genAuthKey", {
  method: "POST",
  headers: {
    ...headers,
    "Content-Type": "application/json",
    Cookie: `mid=${user.mid};stoken=${stokenVal};stuid=${user.aid}`,
  },
  body: JSON.stringify({
    auth_appid: "webview_gacha",
    game_biz: "hk4e_cn",
    game_uid: Number(role.game_uid),
    region: role.region,
  }),
}).then((r) => r.json());

console.log("genAuthKey retcode:", authResp.retcode, authResp.message);
if (authResp.retcode !== 0) throw new Error(authResp.message);
const ak = authResp.data.authkey;

const qs = `lang=zh-cn&auth_appid=webview_gacha&authkey=${encodeURIComponent(ak)}&authkey_ver=${authResp.data.authkey_ver}&sign_type=${authResp.data.sign_type}`;

// ② getConfigList
const configList = await fetch(`https://public-operation-hk4e.mihoyo.com/gacha_info/api/getConfigList?${qs}`).then((r) => r.json());
console.log("\n=== getConfigList ===");
console.log("retcode:", configList.retcode, configList.message);
console.log(JSON.stringify(configList.data, null, 1)?.slice(0, 1200));

// ③ getGachaInfo（多种参数形态探测）
for (const suffix of ["", `?${qs}`, `?${qs}&gacha_type=301`, `?${qs}&page=1&size=5&gacha_type=301&end_id=0`]) {
  try {
    const resp = await fetch(`https://public-operation-hk4e.mihoyo.com/gacha_info/api/getGachaInfo${suffix}`);
    const text = await resp.text();
    console.log(`\n=== getGachaInfo${suffix.slice(0, 30) || "(no qs)"} === HTTP ${resp.status}`);
    console.log(text.slice(0, 400));
  } catch (e) {
    console.log("getGachaInfo ERR:", e.message);
  }
}
