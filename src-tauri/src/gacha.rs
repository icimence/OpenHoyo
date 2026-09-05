//! 祈愿记录（对应原版 Service/GachaLog + GachaInfoClient + QueryProvider/*）。
//!
//! 数据链路：
//! 1. 查询提供器构造带 authkey 的查询串
//!    - SToken：genAuthKey 接口（POST binding/api/genAuthKey，DS Gen1 + LK2）
//!    - WebCache：读游戏 webCaches 的 data_2，提取内嵌祈愿页 URL
//!    - Manual：用户手动粘贴
//! 2. 按 5 种 gacha_type 分页拉取（size=20，end_id 向前翻页，页间 1-2s 随机延迟）
//! 3. 懒合并：item.Id <= 库中最新 Id 即停止当前类型；全量模式先清库
//! 4. 统计：TypedWishSummary 算法（保底进度/平均/最欧最非等）

use crate::constants::Salts;
use crate::http::{self, DsSpec, Profile, RequestSpec};
use crate::models::GameRole;
use crate::response::{unwrap_envelope, ApiError, ApiResult};
use crate::state::AppState;
use crate::store::UserRecord;
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::time::Duration;
use tauri::Emitter;
use winreg::enums::HKEY_CURRENT_USER;

pub const QUERY_TYPES: &[i32] = &[100, 200, 301, 302, 500];
pub const PAGE_SIZE: usize = 20;

// ---------------------------------------------------------------------------
// API 模型
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, Clone)]
pub struct GachaLogItem {
    #[serde(default)]
    pub uid: String,
    #[serde(default, rename = "gacha_type", deserialize_with = "crate::models::de_i32_flexible")]
    pub gacha_type: i32,
    #[serde(default, rename = "item_id")]
    pub item_id: String,
    #[serde(default)]
    pub time: String,
    #[serde(default)]
    pub name: String,
    #[serde(default, rename = "item_type")]
    pub item_type: String,
    #[serde(default, rename = "rank_type", deserialize_with = "crate::models::de_i32_flexible")]
    pub rank_type: i32,
    #[serde(default, deserialize_with = "crate::models::de_i64_flexible")]
    pub id: i64,
}

#[derive(Debug, Deserialize)]
pub struct GachaLogPage {
    #[serde(default)]
    pub list: Vec<GachaLogItem>,
}

#[derive(Debug, Deserialize)]
pub struct GameAuthKey {
    #[serde(default, rename = "authkey")]
    pub authkey: String,
    #[serde(default, rename = "authkey_ver", deserialize_with = "crate::models::de_i32_flexible")]
    pub authkey_ver: i32,
    #[serde(default, rename = "sign_type", deserialize_with = "crate::models::de_i32_flexible")]
    pub sign_type: i32,
}

// ---------------------------------------------------------------------------
// 查询提供器
// ---------------------------------------------------------------------------

/// SToken 方式：当前用户 + 指定游戏角色 → genAuthKey → 查询串
pub async fn build_query_from_stoken(
    state: &AppState,
    salts: &Salts,
    user: &UserRecord,
    role: &GameRole,
) -> ApiResult<String> {
    if user.is_oversea {
        return Err(ApiError::retcode(-10, "国际服不支持 SToken 方式获取祈愿记录"));
    }

    let data = json!({
        "auth_appid": "webview_gacha",
        "game_biz": "hk4e_cn",
        "game_uid": role.game_uid.parse::<i64>().unwrap_or(0),
        "region": role.region,
    });

    let spec = RequestSpec::post("https://api-takumi.mihoyo.com/binding/api/genAuthKey", Profile::XRpc, data)
        .with_cookie(user.stoken())
        .with_referer("https://app.mihoyo.com")
        .with_ds(DsSpec::Gen1 {
            salt: salts.cn_lk2.clone(),
            include_chars: true,
        });

    let resp = http::request::<GameAuthKey>(&state.http, salts, &state.devices, spec).await?;
    let key = unwrap_envelope(resp.envelope, "genAuthKey")?;

    // C# NameValueCollection.ToString() 会百分号编码各值，authkey 含 +/= 等字符
    Ok(format!(
        "lang=zh-cn&auth_appid=webview_gacha&authkey={}&authkey_ver={}&sign_type={}",
        crate::user_api::encode_uri_component(&key.authkey),
        key.authkey_ver,
        key.sign_type
    ))
}

/// 网页缓存方式：注册表定位游戏目录 → webCaches/<version>/Cache/Cache_Data/data_2
/// → 找最后一个祈愿页 URL（对应原版 GachaLogQueryWebCacheProvider）
pub fn build_query_from_web_cache() -> ApiResult<String> {
    let url = extract_gacha_url_from_web_cache()?;
    // URL 形如 https://...index.html?query...#/log
    let query = url
        .split_once('#')
        .map(|(before, _)| before)
        .unwrap_or(url.as_str())
        .rsplit_once('?')
        .map(|(_, q)| q)
        .ok_or_else(|| ApiError::retcode(-11, "网页缓存中未找到有效的祈愿记录 URL"))?
        .to_string();
    Ok(query)
}

fn extract_gacha_url_from_web_cache() -> ApiResult<String> {
    // 国服：HKCU\Software\miHoYo\原神，国际服：HKCU\Software\miHoYo\Genshin Impact
    let candidates = [
        (r"Software\miHoYo\原神", "YuanShen.exe", "YuanShen_Data"),
        (r"Software\miHoYo\Genshin Impact", "GenshinImpact.exe", "GenshinImpact_Data"),
    ];

    for (reg_path, _default_exe, data_folder) in candidates {
        let install_path = (|| {
            let key = winreg::RegKey::predef(HKEY_CURRENT_USER).open_subkey(reg_path).ok()?;
            let path: String = key.get_value("InstallPath").ok()?;
            Some(path)
        })();
        let Some(install_path) = install_path else {
            continue;
        };

        let web_caches = std::path::Path::new(&install_path).join(data_folder).join("webCaches");
        let Some(cache_file) = latest_version_cache_file(&web_caches) else {
            continue;
        };
        if let Some(url) = match_gacha_url_in_cache(&cache_file) {
            return Ok(url);
        }
    }

    Err(ApiError::retcode(
        -11,
        "未找到原神安装目录或网页缓存中没有祈愿记录 URL（请先在游戏内打开一次祈愿记录页面）",
    ))
}

fn latest_version_cache_file(web_caches: &std::path::Path) -> Option<std::path::PathBuf> {
    // 版本目录形如 1.2.3.4，取最大者（对应原版 VersionRegex + MaxBy）
    let mut versions: Vec<(Vec<u64>, std::path::PathBuf)> = Vec::new();
    for entry in std::fs::read_dir(web_caches).ok()? {
        let entry = entry.ok()?;
        if !entry.file_type().ok().is_some_and(|t| t.is_dir()) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let parts: Vec<Option<u64>> = name.split('.').map(|p| p.parse().ok()).collect();
        if parts.is_empty() || parts.iter().any(|p| p.is_none()) {
            continue;
        }
        versions.push((parts.into_iter().map(|p| p.unwrap()).collect(), entry.path()));
    }
    versions.sort_by(|a, b| a.0.cmp(&b.0));
    let latest = versions.last()?.1.clone();
    Some(latest.join("Cache").join("Cache_Data").join("data_2"))
}

fn match_gacha_url_in_cache(path: &std::path::Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let needles: [&[u8]; 2] = [
        b"https://webstatic.mihoyo.com/hk4e/event/e20190909gacha-v3/index.html?",
        b"https://gs.hoyoverse.com/genshin/event/e20190909gacha-v3/index.html?",
    ];
    let mut best: Option<usize> = None;
    for needle in needles {
        let mut search_from = 0usize;
        while let Some(pos) = find_subslice(&bytes[search_from..], needle) {
            let abs = search_from + pos + needle.len();
            best = Some(match best {
                Some(b) if b >= abs => b,
                _ => abs,
            });
            search_from += pos + needle.len();
        }
    }
    let start = best?;
    let rest = &bytes[start..];
    let end = rest.iter().position(|&b| b == 0).unwrap_or(rest.len());
    String::from_utf8(rest[..end].to_vec()).ok()
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// 手动方式：接受完整 URL 或纯查询串
pub fn build_query_from_manual(input: &str) -> ApiResult<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(ApiError::retcode(-12, "输入为空"));
    }
    if let Some((_, query)) = trimmed.split_once('?') {
        return Ok(query.split('#').next().unwrap_or("").to_string());
    }
    Ok(trimmed.to_string())
}

// ---------------------------------------------------------------------------
// 分页拉取（对应 FetchGachaLogsAsync / GachaLogFetchContext）
// ---------------------------------------------------------------------------

/// 拉取进度事件（对应 GachaLogFetchStatus，含当前页物品清单）
#[derive(Serialize, Clone)]
pub struct ProgressItem {
    pub name: String,
    pub item_type: String,
    pub rank_type: i32,
}

#[derive(Serialize, Clone)]
pub struct GachaProgress {
    pub uid: String,
    pub gacha_type: i32,
    pub fetched: usize,
    pub done: bool,
    pub authkey_timeout: bool,
    pub message: String,
    /// 当前页获取到的物品（对应原版 Status.Items）
    pub items: Vec<ProgressItem>,
}

pub async fn refresh_gacha_log(
    state: &AppState,
    handle: &tauri::AppHandle,
    query: &str,
    is_oversea: bool,
    aggressive: bool,
) -> ApiResult<String> {
    refresh_gacha_log_with_progress(state, query, is_oversea, aggressive, |p| {
        let _ = handle.emit("gacha://progress", &p);
    })
    .await
}

/// 核心拉取循环（进度通过回调上报，便于测试注入）
pub async fn refresh_gacha_log_with_progress(
    state: &AppState,
    query: &str,
    is_oversea: bool,
    aggressive: bool,
    mut report: impl FnMut(GachaProgress),
) -> ApiResult<String> {
    let salts = crate::state::salts(state).await;
    let base = if is_oversea {
        "https://public-operation-hk4e-sg.hoyoverse.com/gacha_info/api/getGachaLog"
    } else {
        "https://public-operation-hk4e.mihoyo.com/gacha_info/api/getGachaLog"
    };

    let mut target_archive_id: Option<i64> = None;
    let mut target_uid = String::new();
    let mut authkey_timeout = false;

    for &gacha_type in QUERY_TYPES {
        let mut end_id: i64 = 0;
        let mut fetched: usize = 0;
        let mut items_to_add: Vec<GachaLogItem> = Vec::new();
        // 每种类型独立计算库中最新 Id（对应 ResetType 中重置 DbEndId）
        let mut db_end_id: Option<i64> = None;
        let mut type_completed = false;

        loop {
            let url = format!("{base}?{query}&gacha_type={gacha_type}&size={PAGE_SIZE}&end_id={end_id}");
            let spec = RequestSpec::get(url, Profile::Bbs);
            let resp = http::request::<GachaLogPage>(&state.http, &salts, &state.devices, spec).await?;

            if resp.envelope.retcode != 0 {
                authkey_timeout = true;
                report(GachaProgress {
                    uid: target_uid.clone(),
                    gacha_type,
                    fetched,
                    done: false,
                    authkey_timeout: true,
                    message: format!("authkey 失效: {}", resp.envelope.message),
                    items: vec![],
                });
                break;
            }

            let Some(page) = resp.envelope.data else { break };
            let items = page.list;
            // 当前页新增的物品（对应原版 ResetCurrentPage + Status.Items）
            let mut page_items: Vec<ProgressItem> = Vec::with_capacity(items.len());

            for item in &items {
                if target_archive_id.is_none() {
                    let archive_id = ensure_archive(state, &item.uid)?;
                    target_archive_id = Some(archive_id);
                    target_uid = item.uid.clone();
                }
                if db_end_id.is_none() {
                    db_end_id = newest_item_id(state, target_archive_id.expect("ensured"), gacha_type);
                }

                // 懒合并：遇到已存在的旧记录则提前结束当前类型
                if !aggressive {
                    if let Some(db_id) = db_end_id {
                        if item.id <= db_id {
                            type_completed = true;
                            break;
                        }
                    }
                }

                items_to_add.push(item.clone());
                page_items.push(ProgressItem {
                    name: item.name.clone(),
                    item_type: item.item_type.clone(),
                    rank_type: item.rank_type,
                });
                end_id = item.id;
                fetched += 1;
            }

            // 每页上报一次进度（对应 fetchContext.Report(progress)）
            report(GachaProgress {
                uid: target_uid.clone(),
                gacha_type,
                fetched,
                done: false,
                authkey_timeout: false,
                message: format!("正在获取 {} · 已获取 {fetched} 条", pool_display_name(gacha_type)),
                items: page_items,
            });

            let page_end = items.len() < PAGE_SIZE;
            if page_end || type_completed {
                break;
            }

            // 页间随机延迟，规避风控（对应 Task.Delay(Random 1000-2000)）
            let delay = rand::thread_rng().gen_range(1000..2000u64);
            tokio::time::sleep(Duration::from_millis(delay)).await;
        }

        if authkey_timeout {
            break;
        }

        // 保存当前类型（INSERT OR IGNORE 兜底去重）
        if let Some(archive_id) = target_archive_id {
            if !items_to_add.is_empty() {
                insert_items(state, archive_id, &items_to_add)?;
            }
        }
        report(GachaProgress {
            uid: target_uid.clone(),
            gacha_type,
            fetched,
            done: true,
            authkey_timeout: false,
            message: format!("类型 {gacha_type} 完成，新增 {fetched} 条"),
            items: vec![],
        });

        // 类型间随机延迟
        let delay = rand::thread_rng().gen_range(1000..2000u64);
        tokio::time::sleep(Duration::from_millis(delay)).await;
    }

    if authkey_timeout {
        return Err(ApiError::retcode(-101, "authkey 已失效，请稍后重试或在游戏内重新打开祈愿记录页面"));
    }
    Ok(target_uid)
}

// ---------------------------------------------------------------------------
// 持久化（对应 gacha_archives / gacha_items 表）
// ---------------------------------------------------------------------------

pub fn init_tables(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS gacha_archives (
            id  INTEGER PRIMARY KEY AUTOINCREMENT,
            uid TEXT NOT NULL UNIQUE
        );
        CREATE TABLE IF NOT EXISTS gacha_items (
            id          INTEGER PRIMARY KEY,
            archive_id  INTEGER NOT NULL,
            gacha_type  INTEGER NOT NULL,
            query_type  INTEGER NOT NULL,
            item_id     TEXT    NOT NULL DEFAULT '',
            name        TEXT    NOT NULL DEFAULT '',
            item_type   TEXT    NOT NULL DEFAULT '',
            rank_type   INTEGER NOT NULL DEFAULT 0,
            time        TEXT    NOT NULL DEFAULT '',
            UNIQUE(archive_id, id)
        );
        CREATE INDEX IF NOT EXISTS idx_gacha_items_archive ON gacha_items(archive_id, query_type, id);",
    )
}

fn db_err(e: rusqlite::Error) -> ApiError {
    ApiError::retcode(-4, format!("数据库错误: {e}"))
}

pub fn ensure_archive(state: &AppState, uid: &str) -> ApiResult<i64> {
    use rusqlite::OptionalExtension;
    let conn = state.db.lock().unwrap();
    if let Some(id) = conn
        .query_row("SELECT id FROM gacha_archives WHERE uid = ?1", [uid], |r| r.get(0))
        .optional()
        .map_err(db_err)?
    {
        return Ok(id);
    }
    conn.execute("INSERT INTO gacha_archives (uid) VALUES (?1)", [uid])
        .map_err(db_err)?;
    Ok(conn.last_insert_rowid())
}

fn newest_item_id(state: &AppState, archive_id: i64, query_type: i32) -> Option<i64> {
    let conn = state.db.lock().unwrap();
    conn.query_row(
        "SELECT MAX(id) FROM gacha_items WHERE archive_id = ?1 AND query_type = ?2",
        rusqlite::params![archive_id, query_type],
        |r| r.get::<_, Option<i64>>(0),
    )
    .ok()
    .flatten()
}

fn insert_items(state: &AppState, archive_id: i64, items: &[GachaLogItem]) -> ApiResult<()> {    let conn = state.db.lock().unwrap();
    for item in items {
        // 400（角色活动祈愿-2）查询/存储归并到 301（对应 ToQueryType）
        let query_type = if item.gacha_type == 400 { 301 } else { item.gacha_type };
        conn.execute(
            "INSERT OR IGNORE INTO gacha_items (id, archive_id, gacha_type, query_type, item_id, name, item_type, rank_type, time)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            rusqlite::params![
                item.id,
                archive_id,
                item.gacha_type,
                query_type,
                item.item_id,
                item.name,
                item.item_type,
                item.rank_type,
                item.time,
            ],
        )
        .map_err(db_err)?;
    }
    Ok(())
}

pub fn list_archives(state: &AppState) -> ApiResult<Vec<(i64, String)>> {
    let conn = state.db.lock().unwrap();
    let mut stmt = conn
        .prepare("SELECT id, uid FROM gacha_archives ORDER BY ROWID")
        .map_err(db_err)?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
        .map_err(db_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_err)?;
    Ok(rows)
}

pub fn remove_archive(state: &AppState, id: i64) -> ApiResult<()> {
    let conn = state.db.lock().unwrap();
    conn.execute("DELETE FROM gacha_items WHERE archive_id = ?1", [id])
        .map_err(db_err)?;
    conn.execute("DELETE FROM gacha_archives WHERE id = ?1", [id])
        .map_err(db_err)?;
    Ok(())
}

/// 取档内全部条目（按 id 升序 = 从旧到新）
pub fn load_items(state: &AppState, archive_id: i64) -> ApiResult<Vec<StoredItem>> {
    let conn = state.db.lock().unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT id, gacha_type, query_type, item_id, name, item_type, rank_type, time
             FROM gacha_items WHERE archive_id = ?1 ORDER BY id ASC",
        )
        .map_err(db_err)?;
    let rows = stmt
        .query_map([archive_id], |r| {
            Ok(StoredItem {
                id: r.get(0)?,
                gacha_type: r.get(1)?,
                query_type: r.get(2)?,
                item_id: r.get(3)?,
                name: r.get(4)?,
                item_type: r.get(5)?,
                rank_type: r.get(6)?,
                time: r.get(7)?,
                is_up: false,
            })
        })
        .map_err(db_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_err)?;
    Ok(rows)
}

#[derive(Debug, Clone, Serialize)]
pub struct StoredItem {
    pub id: i64,
    pub gacha_type: i32,
    pub query_type: i32,
    pub item_id: String,
    pub name: String,
    pub item_type: String,
    pub rank_type: i32,
    pub time: String,
    /// 五星是否命中当期 UP（统计构建时填充）
    #[serde(default)]
    pub is_up: bool,
}

// 保底阈值（对应 TypedWishSummaryBuilderContext）：角色/常驻/集录 90，武器 80
pub fn guarantee_thresholds(gacha_type_eval: i32) -> (i32, i32) {
    match gacha_type_eval {
        302 => (80, 10),
        _ => (90, 10),
    }
}

/// 祈愿类型显示名（进度提示用）
pub fn pool_display_name(gacha_type: i32) -> &'static str {
    match gacha_type {
        100 => "新手祈愿",
        200 => "常驻祈愿",
        301 => "角色活动祈愿",
        302 => "武器活动祈愿",
        400 => "角色活动祈愿-2",
        500 => "集录祈愿",
        _ => "未知祈愿",
    }
}

#[cfg(test)]
mod live_tests {
    use super::*;
    use crate::constants::Salts;
    use crate::state::AppState;

    /// 端到端冒烟测试：用应用数据库中已登录的国服用户，
    /// 走 SToken → genAuthKey → 一页 getGachaLog → 解析 → 存储 → 统计 全链路。
    /// 运行：cargo test -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "需要本机已登录用户与外网访问"]
    async fn stoken_gacha_end_to_end() {
        let appdata = std::env::var("APPDATA").expect("APPDATA 未设置");
        let src = std::path::Path::new(&appdata)
            .join("com.learnrepo.hoyoauth")
            .join("users.db");
        assert!(src.exists(), "应用数据库不存在: {}", src.display());

        // 复制一份，避免与应用进程抢锁
        let tmp = std::env::temp_dir().join(format!("hoyo-auth-test-{}.db", std::process::id()));
        std::fs::copy(&src, &tmp).expect("复制数据库失败");
        let conn = rusqlite::Connection::open(&tmp).unwrap();
        crate::store::init(&conn).unwrap();
        init_tables(&conn).unwrap();

        let state = AppState::new(conn);
        let salts = Salts::default();

        let users = crate::store::list(&state.db.lock().unwrap()).unwrap();
        let user = users
            .iter()
            .find(|u| !u.is_oversea && u.game_roles.iter().any(|r| r.game_biz.contains("hk4e_cn")))
            .expect("数据库中没有可用的国服用户，请先在应用中登录");
        let role = user.game_roles.iter().find(|r| r.game_biz.contains("hk4e_cn")).unwrap();
        println!("测试用户: {} ({})", user.nickname.clone().unwrap_or_default(), role.game_uid);

        // ① genAuthKey 换取 authkey
        let query = build_query_from_stoken(&state, &salts, user, role)
            .await
            .expect("genAuthKey 失败");
        let redacted: String = query.chars().take(60).collect();
        println!("[1/4] genAuthKey 成功，query 前 60 字符: {redacted}...");

        // ② 拉一页角色活动祈愿并解析（覆盖字符串数字字段的反序列化）
        let url = format!(
            "https://public-operation-hk4e.mihoyo.com/gacha_info/api/getGachaLog?{query}&gacha_type=301&size={PAGE_SIZE}&end_id=0"
        );
        let resp = http::request::<GachaLogPage>(
            &state.http,
            &salts,
            &state.devices,
            RequestSpec::get(url, Profile::Bbs),
        )
        .await
        .expect("getGachaLog 请求失败");
        assert_eq!(resp.envelope.retcode, 0, "getGachaLog 返回错误: {}", resp.envelope.message);
        let page = resp.envelope.data.expect("响应缺少 data");
        assert!(!page.list.is_empty(), "返回列表为空");
        println!("[2/4] getGachaLog 解析成功，本页 {} 条，示例：", page.list.len());
        for item in page.list.iter().take(3) {
            println!(
                "      {} | {} | rank={} | gacha_type={} | id={}",
                item.time, item.name, item.rank_type, item.gacha_type, item.id
            );
        }
        assert!((3..=5).contains(&page.list[0].rank_type), "rank_type 解析异常");
        assert!(page.list[0].id > 0, "id 解析异常");

        // ③ 用完整真实数据验证统计与 UP/歪判定
        let uid = page.list[0].uid.clone();
        let archive_id = ensure_archive(&state, &uid).expect("创建存档失败");
        let full = load_items(&state, archive_id).expect("读取失败");
        let stats = crate::gacha_stats::build_statistics(&uid, &full);
        println!(
            "[3/5] 统计构建成功：总 {} 抽，角色池 {} 抽（五星 {} 个），武器池五星 {} 个",
            stats.total_count, stats.avatar_wish.total_count, stats.avatar_wish.total_orange, stats.weapon_wish.total_orange
        );

        let aw = &stats.avatar_wish;
        let ww = &stats.weapon_wish;
        assert_eq!(aw.total_up_orange + aw.total_lost_orange, aw.total_orange, "角色池 UP+歪 应等于五星总数");
        assert_eq!(ww.total_up_orange + ww.total_lost_orange, ww.total_orange, "武器池 UP+歪 应等于五星总数");
        // 大保底规则：歪之后紧接的五星必须是 UP
        let mut expect_up = false;
        for e in &aw.orange_list {
            if expect_up {
                assert!(e.is_up, "歪后紧接的五星 [{}] 应为大保底 UP", e.name);
            }
            expect_up = !e.is_up;
        }
        println!(
            "[4/5] UP 判定通过：角色池五星 {}（中UP {} / 歪 {}），当前{}，UP平均 {} 抽",
            aw.total_orange,
            aw.total_up_orange,
            aw.total_lost_orange,
            if aw.guaranteed { "大保底" } else { "小保底" },
            aw.average_up_orange_pull
        );
        if aw.total_orange > 0 {
            println!(
                "      五星序列: {}",
                aw.orange_list
                    .iter()
                    .map(|e| format!("{}{}", if e.is_up { "" } else { "歪:" }, e.name))
                    .collect::<Vec<_>>()
                    .join(" → ")
            );
        }

        // ⑤ 存储往返（含重复写入去重）——临时库中清空后用本页数据模拟全新场景
        {
            let conn = state.db.lock().unwrap();
            conn.execute("DELETE FROM gacha_items WHERE archive_id = ?1", [archive_id])
                .expect("清空临时存档失败");
        }
        insert_items(&state, archive_id, &page.list).expect("写入失败");
        insert_items(&state, archive_id, &page.list).expect("重复写入应被忽略");
        let stored = load_items(&state, archive_id).expect("读取失败");
        assert_eq!(stored.len(), page.list.len(), "INSERT OR IGNORE 去重失败");
        println!("[5/5] 存储往返成功：写入 {} 条（重复写入被正确忽略）", stored.len());

        let _ = std::fs::remove_file(&tmp);
    }

    /// 懒合并去重验证：种入每种类型的第一页 → 跑真实懒合并刷新 →
    /// 断言结果恰好等于「旧数据 ∪ 线上新增」，无重复、无遗漏。
    /// 运行：cargo test -- --ignored --nocapture gacha_lazy_merge_dedup
    #[tokio::test]
    #[ignore = "需要本机已登录用户与外网访问"]
    async fn gacha_lazy_merge_dedup() {
        let appdata = std::env::var("APPDATA").expect("APPDATA 未设置");
        let src = std::path::Path::new(&appdata)
            .join("com.learnrepo.hoyoauth")
            .join("users.db");
        assert!(src.exists(), "应用数据库不存在");

        let tmp = std::env::temp_dir().join(format!("hoyo-auth-dedup-{}.db", std::process::id()));
        std::fs::copy(&src, &tmp).expect("复制数据库失败");
        let conn = rusqlite::Connection::open(&tmp).unwrap();
        crate::store::init(&conn).unwrap();
        init_tables(&conn).unwrap();

        let state = AppState::new(conn);
        let salts = Salts::default();

        let users = crate::store::list(&state.db.lock().unwrap()).unwrap();
        let user = users
            .iter()
            .find(|u| !u.is_oversea && u.game_roles.iter().any(|r| r.game_biz.contains("hk4e_cn")))
            .expect("数据库中没有国服用户");
        let role = user.game_roles.iter().find(|r| r.game_biz.contains("hk4e_cn")).unwrap();

        let query = build_query_from_stoken(&state, &salts, user, role).await.expect("genAuthKey 失败");

        // ---- 种子：拉每种类型的第一页并入库（模拟历史同步）----
        let mut seed_uid = String::new();
        for &gacha_type in QUERY_TYPES {
            let url = format!(
                "https://public-operation-hk4e.mihoyo.com/gacha_info/api/getGachaLog?{query}&gacha_type={gacha_type}&size={PAGE_SIZE}&end_id=0"
            );
            let resp = http::request::<GachaLogPage>(
                &state.http,
                &salts,
                &state.devices,
                RequestSpec::get(url, Profile::Bbs),
            )
            .await
            .expect("种子拉取失败");
            assert_eq!(resp.envelope.retcode, 0, "种子拉取错误: {}", resp.envelope.message);
            let Some(page) = resp.envelope.data else { continue };
            if page.list.is_empty() {
                continue;
            }
            if seed_uid.is_empty() {
                seed_uid = page.list[0].uid.clone();
            }
            let archive_id = ensure_archive(&state, &seed_uid).unwrap();
            insert_items(&state, archive_id, &page.list).unwrap();
            // 与真实刷新相同的防风控节奏
            let delay = rand::thread_rng().gen_range(1000..2000u64);
            tokio::time::sleep(Duration::from_millis(delay)).await;
        }
        let archive_id = ensure_archive(&state, &seed_uid).unwrap();

        // 种子后的按类型计数与最大 id
        let before = load_items(&state, archive_id).unwrap();
        let count_before: std::collections::HashMap<i32, usize> =
            before.iter().fold(std::collections::HashMap::new(), |mut m, i| {
                *m.entry(i.query_type).or_insert(0) += 1;
                m
            });
        let max_before: std::collections::HashMap<i32, i64> =
            before.iter().fold(std::collections::HashMap::new(), |mut m, i| {
                let e = m.entry(i.query_type).or_insert(0);
                if i.id > *e {
                    *e = i.id;
                }
                m
            });
        println!("种子完成：{:?} 条，各类型上界 {:?}", count_before, max_before);

        // ---- 执行真实的懒合并刷新 ----
        refresh_gacha_log_with_progress(&state, &query, false, false, |p| {
            if p.done {
                println!("  刷新进度: {}", p.message);
            }
        })
        .await
        .expect("懒合并刷新失败");

        // ---- 断言：不重 ----
        let after = load_items(&state, archive_id).unwrap();
        let mut seen = std::collections::HashSet::new();
        for item in &after {
            assert!(seen.insert((item.id)), "出现重复记录 id={}", item.id);
        }

        // ---- 断言：不漏（旧数据全保留；新增恰为 id > 种子上界的部分）----
        let count_after: std::collections::HashMap<i32, usize> =
            after.iter().fold(std::collections::HashMap::new(), |mut m, i| {
                *m.entry(i.query_type).or_insert(0) += 1;
                m
            });
        let new_items: std::collections::HashMap<i32, usize> =
            after.iter().fold(std::collections::HashMap::new(), |mut m, i| {
                if *max_before.get(&i.query_type).unwrap_or(&0) < i.id {
                    *m.entry(i.query_type).or_insert(0) += 1;
                }
                m
            });

        for (query_type, seeded) in &count_before {
            let now = count_after.get(query_type).copied().unwrap_or(0);
            let added = new_items.get(query_type).copied().unwrap_or(0);
            assert!(
                now >= *seeded,
                "类型 {query_type} 数据减少：{now} < {seeded}，旧数据丢失"
            );
            assert_eq!(
                now,
                seeded + added,
                "类型 {query_type} 计数不符：现 {now}，种子 {seeded} + 线上新增 {added}"
            );
        }
        for id in before.iter().map(|i| i.id) {
            assert!(seen.contains(&id), "种子记录 id={id} 在刷新后丢失");
        }

        println!(
            "验证通过：二次刷新后 {} 条（种子 {} 条，线上新增 {:?}），无重复、无遗漏",
            after.len(),
            before.len(),
            new_items
        );

        let _ = std::fs::remove_file(&tmp);
    }
}
