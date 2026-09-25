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
    #[serde(
        default,
        rename = "gacha_type",
        deserialize_with = "crate::models::de_i32_flexible"
    )]
    pub gacha_type: i32,
    #[serde(default, rename = "item_id")]
    pub item_id: String,
    #[serde(default)]
    pub time: String,
    #[serde(default)]
    pub name: String,
    #[serde(default, rename = "item_type")]
    pub item_type: String,
    #[serde(
        default,
        rename = "rank_type",
        deserialize_with = "crate::models::de_i32_flexible"
    )]
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
    #[serde(
        default,
        rename = "authkey_ver",
        deserialize_with = "crate::models::de_i32_flexible"
    )]
    pub authkey_ver: i32,
    #[serde(
        default,
        rename = "sign_type",
        deserialize_with = "crate::models::de_i32_flexible"
    )]
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
        return Err(ApiError::retcode(
            -10,
            "国际服不支持 SToken 方式获取祈愿记录",
        ));
    }

    let data = json!({
        "auth_appid": "webview_gacha",
        "game_biz": "hk4e_cn",
        "game_uid": role.game_uid.parse::<i64>().unwrap_or(0),
        "region": role.region,
    });

    let spec = RequestSpec::post(
        "https://api-takumi.mihoyo.com/binding/api/genAuthKey",
        Profile::XRpc,
        data,
    )
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

/// 网页缓存方式（对应原版 GachaLogQueryWebCacheProvider + UnityLogGameLocator）：
/// Unity 日志反推游戏目录 → webCaches/<version>/Cache/Cache_Data/data_2
/// → 找最后一个祈愿页 URL
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
    for (game_dir, data_folder) in game_dir_candidates() {
        let web_caches = game_dir.join(data_folder).join("webCaches");
        for cache_file in cache_files_newest_first(&web_caches) {
            if let Some(url) = match_gacha_url_in_cache(&cache_file) {
                log::info!("[gacha] 网页缓存命中: {}", cache_file.display());
                return Ok(url);
            }
        }
    }

    Err(ApiError::retcode(
        -11,
        "未能定位原神安装目录，或网页缓存中没有祈愿记录 URL（请先在游戏内打开一次祈愿记录页面）",
    ))
}

/// 游戏目录候选：(游戏 exe 所在目录, 数据文件夹名)。
/// 优先 Unity 日志反推（HoYoPlay 安装时注册表 InstallPath 为空），
/// 注册表旧键作为兜底（对应原版 UnityLogGameLocator 的定位方式）。
fn game_dir_candidates() -> Vec<(std::path::PathBuf, &'static str)> {
    let mut out: Vec<(std::path::PathBuf, &'static str)> = Vec::new();

    // %APPDATA%\..\LocalLow\miHoYo\<游戏名>\output_log.txt
    if let Some(local_low) = std::env::var("APPDATA").ok().and_then(|appdata| {
        std::path::Path::new(&appdata)
            .parent()
            .map(|p| p.join("LocalLow"))
    }) {
        for (sub, data_folder) in [
            ("Genshin Impact", "GenshinImpact_Data"),
            ("原神", "YuanShen_Data"),
        ] {
            let log = local_low.join("miHoYo").join(sub).join("output_log.txt");
            if let Some(dir) = game_dir_from_unity_log(&log) {
                out.push((dir, data_folder));
            }
        }
    }

    for (reg_path, data_folder) in [
        (r"Software\miHoYo\原神", "YuanShen_Data"),
        (r"Software\miHoYo\Genshin Impact", "GenshinImpact_Data"),
    ] {
        let install_path = (|| {
            let key = winreg::RegKey::predef(HKEY_CURRENT_USER)
                .open_subkey(reg_path)
                .ok()?;
            let path: String = key.get_value("InstallPath").ok()?;
            Some(path)
        })();
        if let Some(path) = install_path {
            out.push((std::path::PathBuf::from(path), data_folder));
        }
    }

    out
}

/// Unity 日志中形如 `E:/Games/.../YuanShen_Data/...` 的行反推游戏目录
/// （对应原版 WarmupFileLine 正则，路径可含空格与正反斜杠）
fn game_dir_from_unity_log(log: &std::path::Path) -> Option<std::path::PathBuf> {
    let content = String::from_utf8_lossy(&std::fs::read(log).ok()?).to_string();
    let dir = game_dir_from_log_content(&content)?;
    Some(std::path::PathBuf::from(dir))
}

fn game_dir_from_log_content(content: &str) -> Option<String> {
    for marker in ["YuanShen_Data", "GenshinImpact_Data"] {
        let mut from = 0usize;
        while let Some(marker_pos) = ascii_find_ci(&content[from..], marker).map(|i| from + i) {
            if let Some(dir) = dir_before_marker(content, marker_pos, marker) {
                return Some(dir);
            }
            from = marker_pos + marker.len();
        }
    }
    None
}

/// marker 前同一行内找最后一个盘符 X:/ 或 X:\ 作为路径起点，截到 marker 为止
fn dir_before_marker(content: &str, marker_pos: usize, marker: &str) -> Option<String> {
    let dir = path_prefix_before_marker(content, marker_pos)?;
    if dir.len() < 3 {
        return None;
    }
    let exe = if marker == "YuanShen_Data" {
        "YuanShen.exe"
    } else {
        "GenshinImpact.exe"
    };
    if std::path::Path::new(&format!("{dir}\\{exe}")).is_file() {
        Some(dir.to_string())
    } else {
        None
    }
}

fn path_prefix_before_marker(content: &str, marker_pos: usize) -> Option<&str> {
    let line_start = content[..marker_pos]
        .rfind('\n')
        .map(|i| i + 1)
        .unwrap_or(0);
    let line = &content[line_start..marker_pos];
    let bytes = line.as_bytes();
    let mut start = None;
    for i in 0..bytes.len().saturating_sub(2) {
        if bytes[i].is_ascii_alphabetic()
            && bytes[i + 1] == b':'
            && (bytes[i + 2] == b'/' || bytes[i + 2] == b'\\')
        {
            start = Some(i);
        }
    }
    Some(line[start?..].trim_end_matches(['\\', '/']))
}

/// ASCII 大小写不敏感子串查找
fn ascii_find_ci(haystack: &str, needle: &str) -> Option<usize> {
    let h = haystack.as_bytes();
    let n = needle.as_bytes();
    if n.is_empty() || h.len() < n.len() {
        return None;
    }
    (0..=h.len() - n.len()).position(|i| h[i..i + n.len()].eq_ignore_ascii_case(n))
}

/// 版本目录（形如 1.2.3.4）从新到旧的 data_2 候选；
/// 无版本子目录时回退 webCaches 本身（对应原版 latestVersionCacheFolder ??= webCacheFolder）
fn cache_files_newest_first(web_caches: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut versions: Vec<(Vec<u64>, std::path::PathBuf)> = Vec::new();
    let Ok(entries) = std::fs::read_dir(web_caches) else {
        return Vec::new();
    };
    for entry in entries.flatten() {
        if !entry.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let parts: Vec<&str> = name.split('.').collect();
        if parts.len() != 4 {
            continue;
        }
        let nums: Vec<u64> = match parts
            .iter()
            .map(|p| p.parse::<u64>().ok())
            .collect::<Option<Vec<_>>>()
        {
            Some(v) => v,
            None => continue,
        };
        versions.push((nums, entry.path()));
    }
    versions.sort_by(|a, b| b.0.cmp(&a.0));
    if versions.is_empty() {
        return vec![web_caches.join("Cache").join("Cache_Data").join("data_2")];
    }
    versions
        .into_iter()
        .map(|(_, dir)| dir.join("Cache").join("Cache_Data").join("data_2"))
        .collect()
}

/// 在缓存文件中找最后一个祈愿页 URL。事件名后缀随版本变化
/// （e20190909gacha-v3 → e20190909gacha-df01aea2），故匹配到事件名后
/// 向后找 /index.html?（对应原版 Match 的字节级 LastIndexOf）
fn match_gacha_url_in_cache(path: &std::path::Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    match_gacha_url_bytes(&bytes)
}

fn match_gacha_url_bytes(bytes: &[u8]) -> Option<String> {
    let prefixes: [&[u8]; 2] = [
        b"https://webstatic.mihoyo.com/hk4e/event/e20190909gacha-",
        b"https://gs.hoyoverse.com/genshin/event/e20190909gacha-",
    ];
    let index_html = b"/index.html?";
    let mut best: Option<usize> = None; // 完整 URL 起始（https:// 处）
    for prefix in prefixes {
        let mut search_from = 0usize;
        while let Some(pos) = find_subslice(&bytes[search_from..], prefix) {
            let abs = search_from + pos;
            // 事件名后缀 ≤ 32 字节且不含路径分隔符，随后应为 /index.html?
            let suffix_zone =
                &bytes[abs + prefix.len()..(abs + prefix.len() + 48).min(bytes.len())];
            if find_subslice(suffix_zone, index_html).is_some() {
                best = best.map_or(Some(abs), |b| Some(b.max(abs)));
            }
            search_from = abs + prefix.len();
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
        log::info!(
            "[gacha] 开始拉取 {}（gacha_type={gacha_type}）",
            pool_display_name(gacha_type)
        );
        let mut end_id: i64 = 0;
        let mut fetched: usize = 0;
        let mut items_to_add: Vec<GachaLogItem> = Vec::new();
        // 每种类型独立计算库中最新 Id（对应 ResetType 中重置 DbEndId）
        let mut db_end_id: Option<i64> = None;
        let mut type_completed = false;

        loop {
            let url =
                format!("{base}?{query}&gacha_type={gacha_type}&size={PAGE_SIZE}&end_id={end_id}");
            let spec = RequestSpec::get(url, Profile::Bbs);
            let resp =
                http::request::<GachaLogPage>(&state.http, &salts, &state.devices, spec).await?;

            if resp.envelope.retcode != 0 {
                authkey_timeout = true;
                log::warn!(
                    "[gacha] {} authkey 失效（retcode={}）",
                    pool_display_name(gacha_type),
                    resp.envelope.retcode
                );
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

            let Some(page) = resp.envelope.data else {
                break;
            };
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
                    db_end_id =
                        newest_item_id(state, target_archive_id.expect("ensured"), gacha_type);
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
                message: format!(
                    "正在获取 {} · 已获取 {fetched} 条",
                    pool_display_name(gacha_type)
                ),
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
                log::info!(
                    "[gacha] {} 入库新增 {} 条",
                    pool_display_name(gacha_type),
                    items_to_add.len()
                );
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
        return Err(ApiError::retcode(
            -101,
            "authkey 已失效，请稍后重试或在游戏内重新打开祈愿记录页面",
        ));
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
        .query_row("SELECT id FROM gacha_archives WHERE uid = ?1", [uid], |r| {
            r.get(0)
        })
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

pub fn insert_items(state: &AppState, archive_id: i64, items: &[GachaLogItem]) -> ApiResult<()> {
    let mut conn = state.db.lock().unwrap();
    let transaction = conn.transaction().map_err(db_err)?;
    for item in items {
        // 400（角色活动祈愿-2）查询/存储归并到 301（对应 ToQueryType）
        let query_type = if item.gacha_type == 400 {
            301
        } else {
            item.gacha_type
        };
        transaction.execute(
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
    transaction.commit().map_err(db_err)
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
#[path = "gacha_tests.rs"]
mod gacha_tests;

/// 档内条目总数（导入摘要用）
pub fn count_items(state: &AppState, archive_id: i64) -> ApiResult<i64> {
    let conn = state.db.lock().unwrap();
    conn.query_row(
        "SELECT COUNT(*) FROM gacha_items WHERE archive_id = ?1",
        [archive_id],
        |r| r.get(0),
    )
    .map_err(db_err)
}

/// 按 UID 查存档 ID（导出用；不存在返回 None）
pub fn archive_id_by_uid(state: &AppState, uid: &str) -> ApiResult<Option<i64>> {
    use rusqlite::OptionalExtension;
    let conn = state.db.lock().unwrap();
    conn.query_row("SELECT id FROM gacha_archives WHERE uid = ?1", [uid], |r| {
        r.get(0)
    })
    .optional()
    .map_err(db_err)
}
