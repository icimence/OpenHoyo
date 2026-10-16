//! 图像资源本地化（对应原版 GuideViewModel 的静态资源下载 + ImageCache + 数据文件夹设置）。
//!
//! 原版首启时从胡桃服务器下载分类 zip 包；本项目只使用米哈游官方资源，资源组改为：
//! - `wiki`：官方观测枢 wiki（api-static.mihoyo.com）的角色/武器图标，供祈愿记录使用
//! - `records`：本地已保存的战绩/我的角色数据里引用的官方图片（act-webstatic 等）
//!
//! 图片经自定义协议 `hoyoimg://` 提供：命中本地缓存直接返回，未命中且用户已同意缓存时
//! 从官方地址下载并落盘（对应原版"图片将要展示时自动尝试补全"）。下载只允许米哈游官方域名。
//!
//! 数据文件夹：默认 app_data_dir；用户可改到任意目录（原版 SetDataFolderCommand），
//! 位置写在默认目录下的 `data_location.json`，重启后生效。日志目录不随之移动（反馈中心依赖固定路径）。

use crate::response::{ApiError, ApiResult};
use crate::state::AppState;
use crate::store;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::http::{Request, Response, StatusCode};
use tauri::{AppHandle, Emitter, Manager, State};

const POINTER_FILE: &str = "data_location.json";
const DB_FILE: &str = "users.db";
const STATIC_DIR: &str = "static";

const META_ENABLED: &str = "static_cache_enabled";
const META_GUIDE_STEP: &str = "guide_step";
const META_PENDING_CLEANUP: &str = "data_folder_pending_cleanup";
/// 引导完成后的步骤值（欢迎/数据文件夹/图像资源/下载/完成 = 0..4）
pub const GUIDE_COMPLETED: i64 = 4;

/// 官方观测枢 wiki 图鉴频道（与 scripts/fetch-wiki-icons.mjs 同源）
const WIKI_LIST_URL: &str =
    "https://api-static.mihoyo.com/common/blackboard/ys_obc/v1/home/content/list?app_sn=ys_obc&channel_id=189";

/// 只允许从这些米哈游官方域名下载图片
const OFFICIAL_HOST_SUFFIXES: &[&str] = &[".mihoyo.com", ".hoyoverse.com", ".miyoushe.com", ".hoyolab.com"];

const MAX_IMAGE_BYTES: usize = 15 * 1024 * 1024;
const DOWNLOAD_CONCURRENCY: usize = 8;

// ---------------------------------------------------------------------------
// 数据文件夹
// ---------------------------------------------------------------------------

#[derive(serde::Serialize, serde::Deserialize)]
struct Pointer {
    dir: String,
}

/// 启动时解析实际数据目录：指针有效则用之，否则回退默认目录
pub fn resolve_data_dir(default_dir: &Path) -> PathBuf {
    let pointer = default_dir.join(POINTER_FILE);
    let Ok(raw) = std::fs::read_to_string(&pointer) else {
        return default_dir.to_path_buf();
    };
    match serde_json::from_str::<Pointer>(&raw) {
        Ok(p) => {
            let dir = PathBuf::from(&p.dir);
            if std::fs::create_dir_all(&dir).is_ok() && dir.join(DB_FILE).exists() {
                dir
            } else {
                log::warn!("[datafolder] 自定义数据目录不可用，回退默认目录");
                default_dir.to_path_buf()
            }
        }
        Err(e) => {
            log::warn!("[datafolder] data_location.json 解析失败，回退默认目录: {e}");
            default_dir.to_path_buf()
        }
    }
}

/// 上次迁移后遗留的旧目录数据：新库已就绪，删除旧库与旧缓存（只删本应用写入的文件，不删目录本身）
pub fn cleanup_after_move(conn: &rusqlite::Connection, current: &Path) {
    let Some(old) = store::meta_get(conn, META_PENDING_CLEANUP) else {
        return;
    };
    let old = PathBuf::from(old);
    if !same_path(&old, current) {
        for name in [DB_FILE, "users.db-wal", "users.db-shm"] {
            let _ = std::fs::remove_file(old.join(name));
        }
        let _ = std::fs::remove_dir_all(old.join(STATIC_DIR));
        log::info!("[datafolder] 已清理迁移前的旧数据");
    }
    let _ = conn.execute("DELETE FROM meta WHERE key = ?1", [META_PENDING_CLEANUP]);
}

fn same_path(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| {
        std::fs::canonicalize(p)
            .unwrap_or_else(|_| p.to_path_buf())
            .to_string_lossy()
            .trim_end_matches(['\\', '/'])
            .to_lowercase()
    };
    norm(a) == norm(b)
}

fn is_inside(child: &Path, parent: &Path) -> bool {
    let c = std::fs::canonicalize(child).unwrap_or_else(|_| child.to_path_buf());
    let p = std::fs::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf());
    c.starts_with(&p)
}

// ---------------------------------------------------------------------------
// 运行时状态
// ---------------------------------------------------------------------------

pub struct StaticRes {
    pub data_dir: PathBuf,
    pub default_dir: PathBuf,
    enabled: AtomicBool,
    cancel: AtomicBool,
    downloading: AtomicBool,
    /// 下载进行中又有新记录入库：本轮结束后再补一次记录图片
    rerun_records: AtomicBool,
    client: reqwest::Client,
    wiki_index: Mutex<Option<HashMap<String, String>>>,
    /// 当前/最近一次下载各资源组的进度快照（标题栏「后台任务」初始化时读取）
    activity: Mutex<Vec<GroupProgress>>,
}

impl StaticRes {
    pub fn new(data_dir: PathBuf, default_dir: PathBuf, conn: &rusqlite::Connection) -> Self {
        let enabled = store::meta_get(conn, META_ENABLED).as_deref() == Some("1");
        Self {
            data_dir,
            default_dir,
            enabled: AtomicBool::new(enabled),
            cancel: AtomicBool::new(false),
            downloading: AtomicBool::new(false),
            rerun_records: AtomicBool::new(false),
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(20))
                .build()
                .unwrap_or_default(),
            wiki_index: Mutex::new(None),
            activity: Mutex::new(Vec::new()),
        }
    }

    fn static_dir(&self) -> PathBuf {
        self.data_dir.join(STATIC_DIR)
    }

    fn cache_path(&self, url: &str) -> PathBuf {
        let hash = crate::ds::md5_hex(url);
        self.static_dir()
            .join("cache")
            .join(&hash[..2])
            .join(format!("{hash}.{}", ext_of(url)))
    }

    fn wiki_dir(&self) -> PathBuf {
        self.static_dir().join("wiki")
    }

    fn wiki_file(&self, name: &str) -> Option<PathBuf> {
        let mut guard = self.wiki_index.lock().unwrap();
        if guard.is_none() {
            let raw = std::fs::read_to_string(self.wiki_dir().join("index.json")).unwrap_or_default();
            *guard = Some(serde_json::from_str(&raw).unwrap_or_default());
        }
        guard
            .as_ref()
            .and_then(|m| m.get(name))
            .map(|f| self.wiki_dir().join(f))
    }
}

fn ext_of(url: &str) -> &'static str {
    let path = url.split(['?', '#']).next().unwrap_or(url).to_ascii_lowercase();
    if path.ends_with(".jpg") || path.ends_with(".jpeg") {
        "jpg"
    } else if path.ends_with(".webp") {
        "webp"
    } else if path.ends_with(".gif") {
        "gif"
    } else {
        "png"
    }
}

fn mime_of(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "image/png",
    }
}

/// 仅 https + 米哈游官方域名
pub fn is_official(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else {
        return false;
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("").to_ascii_lowercase();
    let host = host.split(':').next().unwrap_or("");
    OFFICIAL_HOST_SUFFIXES.iter().any(|s| host.ends_with(s))
}

/// 日志只记 URL 路径（AGENTS.md 隐私红线）
fn url_path(url: &str) -> &str {
    url.split('?').next().unwrap_or(url)
}

async fn fetch_image(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, String> {
    if !is_official(url) {
        return Err("非官方域名".into());
    }
    let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    let ct = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    if !(ct.starts_with("image/") || ct == "application/octet-stream") {
        return Err(format!("非图片响应: {ct}"));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("文件过大".into());
    }
    if !looks_like_image(&bytes) {
        return Err("响应内容不是有效图片".into());
    }
    Ok(bytes.to_vec())
}

/// 按文件头判断是否为 PNG / JPEG / GIF / WebP（拦截空文件、截断文件与错误页）
fn looks_like_image(b: &[u8]) -> bool {
    b.len() > 16
        && (b.starts_with(&[0x89, b'P', b'N', b'G'])
            || b.starts_with(&[0xFF, 0xD8, 0xFF])
            || b.starts_with(b"GIF8")
            || (b.starts_with(b"RIFF") && &b[8..12] == b"WEBP"))
}

/// 原子写入（临时文件 + rename），避免半截文件被当作缓存命中
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension(format!("tmp{}", std::process::id()));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

// ---------------------------------------------------------------------------
// hoyoimg:// 协议
// ---------------------------------------------------------------------------

fn respond(status: StatusCode, mime: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .header("Cache-Control", "max-age=31536000, immutable")
        .header("Access-Control-Allow-Origin", "*")
        .body(body)
        .unwrap_or_default()
}

fn not_found() -> Response<Vec<u8>> {
    respond(StatusCode::NOT_FOUND, "text/plain", Vec::new())
}

/// 路径格式（前端 convertFileSrc 整体编码）：`u/<官方图片 URL>` 或 `wiki/<物品名>`
pub async fn handle_protocol(app: AppHandle, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let res = app.state::<StaticRes>();
    let raw = request.uri().path().trim_start_matches('/');
    let decoded = percent_encoding::percent_decode_str(raw).decode_utf8_lossy().to_string();

    if let Some(name) = decoded.strip_prefix("wiki/") {
        return match res.wiki_file(name) {
            Some(path) => match std::fs::read(&path) {
                Ok(bytes) if looks_like_image(&bytes) => respond(StatusCode::OK, mime_of(&path), bytes),
                Ok(_) => {
                    // 损坏的图鉴图标：删除，前端回退到安装包内置图标，下次自动补全时重新下载
                    let _ = std::fs::remove_file(&path);
                    not_found()
                }
                Err(_) => not_found(),
            },
            None => not_found(),
        };
    }

    let Some(url) = decoded.strip_prefix("u/") else {
        return not_found();
    };
    if !is_official(url) {
        return respond(StatusCode::FORBIDDEN, "text/plain", Vec::new());
    }
    let path = res.cache_path(url);
    if let Ok(bytes) = std::fs::read(&path) {
        if looks_like_image(&bytes) {
            return respond(StatusCode::OK, mime_of(&path), bytes);
        }
        // 缓存文件损坏（截断/非图片）：删掉并重新下载
        log::warn!("[static] 本地缓存损坏，重新下载 {}", url_path(url));
        let _ = std::fs::remove_file(&path);
    }
    match fetch_image(&res.client, url).await {
        Ok(bytes) => {
            if res.enabled.load(Ordering::Relaxed) {
                if let Err(e) = write_atomic(&path, &bytes) {
                    log::warn!("[static] 缓存写入失败: {e}");
                }
            }
            respond(StatusCode::OK, mime_of(&path), bytes)
        }
        Err(e) => {
            log::warn!("[static] 图片获取失败 {}: {e}", url_path(url));
            respond(StatusCode::BAD_GATEWAY, "text/plain", Vec::new())
        }
    }
}

// ---------------------------------------------------------------------------
// 资源组
// ---------------------------------------------------------------------------

struct GroupDef {
    key: &'static str,
    name: &'static str,
    description: &'static str,
}

const GROUPS: &[GroupDef] = &[
    GroupDef {
        key: "wiki",
        name: "角色与武器图标",
        description: "来自米哈游官方观测枢图鉴，用于祈愿记录页的角色与武器图标",
    },
    GroupDef {
        key: "records",
        name: "我的角色与挑战记录图片",
        description: "本地已保存的我的角色、深境螺旋、幻想真境剧诗、幽境危战中用到的官方图片",
    },
];

fn group_meta_key(key: &str) -> String {
    format!("static_group_{key}")
}

/// 战绩数据里实际会被界面展示的官方图片（角色/武器/技能/命座/圣遗物/敌人/属性等）
fn is_record_display_image(url: &str) -> bool {
    let p = url_path(url);
    p.contains("/hk4e/e20200928calculate/") || p.contains("/game_record/genshin/avatar_prop/")
}

fn collect_strings(v: &serde_json::Value, out: &mut HashSet<String>) {
    match v {
        serde_json::Value::String(s) => {
            if is_official(s) && is_record_display_image(s) {
                out.insert(s.clone());
            }
        }
        serde_json::Value::Array(a) => a.iter().for_each(|x| collect_strings(x, out)),
        serde_json::Value::Object(o) => o.values().for_each(|x| collect_strings(x, out)),
        _ => {}
    }
}

fn record_urls(state: &AppState) -> Vec<String> {
    let mut set = HashSet::new();
    let db = state.db.lock().unwrap();
    if let Ok(mut stmt) = db.prepare("SELECT data FROM game_records") {
        if let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(0)) {
            for raw in rows.flatten() {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                    collect_strings(&v, &mut set);
                }
            }
        }
    }
    // 账号头像与游戏内头像
    for rec in store::list(&db).unwrap_or_default() {
        if let Some(a) = rec.avatar.filter(|a| is_official(a)) {
            set.insert(a);
        }
        for r in rec.game_roles {
            if is_official(&r.avatar) {
                set.insert(r.avatar);
            }
        }
    }
    let mut v: Vec<String> = set.into_iter().collect();
    v.sort();
    v
}

#[derive(serde::Deserialize, Default)]
#[serde(default)]
struct WikiChannel {
    name: String,
    list: Vec<WikiEntry>,
    children: Vec<WikiChannel>,
}

#[derive(serde::Deserialize, Default)]
#[serde(default)]
struct WikiEntry {
    title: String,
    icon: String,
}

#[derive(serde::Deserialize, Default)]
#[serde(default)]
struct WikiList {
    list: Vec<WikiChannel>,
}

/// (物品名, 官方图标 URL)
async fn wiki_items(state: &AppState) -> ApiResult<Vec<(String, String)>> {
    let salts = crate::state::salts(state).await;
    let spec = crate::http::RequestSpec::get(WIKI_LIST_URL, crate::http::Profile::Bbs);
    let resp = crate::http::request::<WikiList>(&state.http, &salts, &state.devices, spec).await?;
    let data = crate::response::unwrap_envelope(resp.envelope, "wiki content list")?;
    let mut out = Vec::new();
    for root in data.list {
        for ch in root.children.into_iter().filter(|c| c.name == "角色" || c.name == "武器") {
            for e in ch.list {
                if !e.title.is_empty() && is_official(&e.icon) {
                    out.push((e.title, e.icon));
                }
            }
        }
    }
    if out.is_empty() {
        return Err(ApiError::retcode(-40, "图鉴接口结构变化，未找到角色/武器分组"));
    }
    Ok(out)
}

#[derive(Serialize, Clone)]
pub struct GroupProgress {
    pub key: String,
    pub done: usize,
    pub total: usize,
    pub failed: usize,
    pub bytes: u64,
    /// pending / running / done / failed / cancelled
    pub state: String,
    pub message: String,
}

#[derive(Serialize)]
pub struct GroupStatus {
    pub key: String,
    pub name: String,
    pub description: String,
    /// 上次完整下载时间（unix 毫秒），0 表示从未完成
    pub fulfilled_at: i64,
}

#[derive(Serialize)]
pub struct StaticStatus {
    pub data_dir: String,
    pub default_dir: String,
    pub is_default_dir: bool,
    pub enabled: bool,
    pub guide_step: i64,
    pub cache_files: u64,
    pub cache_bytes: u64,
    pub downloading: bool,
    pub groups: Vec<GroupStatus>,
}

fn dir_usage(dir: &Path) -> (u64, u64) {
    let mut files = 0;
    let mut bytes = 0;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let Ok(md) = e.metadata() else { continue };
            if md.is_dir() {
                stack.push(e.path());
            } else {
                files += 1;
                bytes += md.len();
            }
        }
    }
    (files, bytes)
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn static_res_status(state: State<'_, AppState>, res: State<'_, StaticRes>) -> StaticStatus {
    let db = state.db.lock().unwrap();
    let guide_step = store::meta_get(&db, META_GUIDE_STEP)
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let groups = GROUPS
        .iter()
        .map(|g| GroupStatus {
            key: g.key.into(),
            name: g.name.into(),
            description: g.description.into(),
            fulfilled_at: store::meta_get(&db, &group_meta_key(g.key))
                .and_then(|v| v.parse().ok())
                .unwrap_or(0),
        })
        .collect();
    drop(db);
    let (cache_files, cache_bytes) = dir_usage(&res.static_dir());
    StaticStatus {
        data_dir: res.data_dir.display().to_string(),
        default_dir: res.default_dir.display().to_string(),
        is_default_dir: same_path(&res.data_dir, &res.default_dir),
        enabled: res.enabled.load(Ordering::Relaxed),
        guide_step,
        cache_files,
        cache_bytes,
        downloading: res.downloading.load(Ordering::Relaxed),
        groups,
    }
}

#[tauri::command]
pub fn static_res_set_enabled(state: State<'_, AppState>, res: State<'_, StaticRes>, enabled: bool) {
    log::info!("[static] 本地图像缓存: {}", if enabled { "开启" } else { "关闭" });
    res.enabled.store(enabled, Ordering::Relaxed);
    let db = state.db.lock().unwrap();
    store::meta_set(&db, META_ENABLED, if enabled { "1" } else { "0" });
}

#[tauri::command]
pub fn guide_set_step(state: State<'_, AppState>, step: i64) {
    log::info!("[guide] 首次启动引导进入第 {step} 步");
    let db = state.db.lock().unwrap();
    store::meta_set(&db, META_GUIDE_STEP, &step.clamp(0, GUIDE_COMPLETED).to_string());
}

#[tauri::command]
pub fn static_res_cancel(res: State<'_, StaticRes>) {
    log::info!("[static] 用户取消下载");
    res.cancel.store(true, Ordering::Relaxed);
}

#[tauri::command]
pub fn static_res_clear(res: State<'_, StaticRes>, state: State<'_, AppState>) -> ApiResult<()> {
    if res.downloading.load(Ordering::Relaxed) {
        return Err(ApiError::retcode(-41, "资源下载进行中，请稍后再试"));
    }
    log::info!("[static] 清空本地图像缓存");
    let dir = res.static_dir();
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| ApiError::retcode(-42, format!("清理失败: {e}")))?;
    }
    *res.wiki_index.lock().unwrap() = None;
    let db = state.db.lock().unwrap();
    for g in GROUPS {
        let _ = db.execute("DELETE FROM meta WHERE key = ?1", [group_meta_key(g.key)]);
    }
    Ok(())
}

/// 推送进度并记入快照（标题栏「后台任务」据此展示）
fn emit_progress(app: &AppHandle, p: &GroupProgress) {
    {
        let res = app.state::<StaticRes>();
        let mut act = res.activity.lock().unwrap();
        match act.iter_mut().find(|x| x.key == p.key) {
            Some(x) => *x = p.clone(),
            None => act.push(p.clone()),
        }
    }
    let _ = app.emit("static://progress", p);
}

fn group_name(key: &str) -> &'static str {
    GROUPS.iter().find(|g| g.key == key).map(|g| g.name).unwrap_or("图像资源")
}

#[derive(Serialize)]
pub struct ActivityItem {
    pub key: String,
    pub name: String,
    #[serde(flatten)]
    pub progress: GroupProgress,
}

#[derive(Serialize)]
pub struct ActivitySnapshot {
    pub downloading: bool,
    pub items: Vec<ActivityItem>,
}

/// 后台任务快照（前端标题栏初始化或重载后读取，之后靠 static://progress 增量更新）
#[tauri::command]
pub fn static_res_activity(res: State<'_, StaticRes>) -> ActivitySnapshot {
    let items = res
        .activity
        .lock()
        .unwrap()
        .iter()
        .map(|p| ActivityItem {
            key: p.key.clone(),
            name: group_name(&p.key).to_string(),
            progress: p.clone(),
        })
        .collect();
    ActivitySnapshot {
        downloading: res.downloading.load(Ordering::Relaxed),
        items,
    }
}

/// 下载所选资源组，过程通过 `static://progress` 事件推送；返回各组最终结果
#[tauri::command]
pub async fn static_res_download(
    app: AppHandle,
    state: State<'_, AppState>,
    res: State<'_, StaticRes>,
    groups: Vec<String>,
) -> ApiResult<Vec<GroupProgress>> {
    run_groups(&app, &state, &res, &groups, "手动").await
}

/// 启动后自动补全（仅在用户同意本地保存时）：新版本可能新增角色/武器，图鉴图标与
/// 新同步的战绩图片都需要补下。已存在的文件会被跳过，只下载缺失部分。
pub async fn auto_sync(app: AppHandle) {
    // 给启动时的登录恢复、首屏加载让出带宽
    tokio::time::sleep(Duration::from_secs(8)).await;
    let res = app.state::<StaticRes>();
    let state = app.state::<AppState>();
    if !res.enabled.load(Ordering::Relaxed) {
        return;
    }
    let guide_done = {
        let db = state.db.lock().unwrap();
        store::meta_get(&db, META_GUIDE_STEP)
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(0)
            >= GUIDE_COMPLETED
    };
    if !guide_done {
        return;
    }
    let groups: Vec<String> = GROUPS.iter().map(|g| g.key.to_string()).collect();
    match run_groups(&app, &state, &res, &groups, "自动").await {
        Ok(_) => {}
        Err(e) => log::info!("[static] 自动补全跳过: {}", e.message),
    }
}

/// 战绩刷新后补下新出现的图片（如新角色的技能/命座图标），静默在后台进行
pub fn sync_records_later(app: &AppHandle) {
    let res = app.state::<StaticRes>();
    if !res.enabled.load(Ordering::Relaxed) {
        return;
    }
    if res.downloading.load(Ordering::Relaxed) {
        res.rerun_records.store(true, Ordering::Relaxed);
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let res = app.state::<StaticRes>();
        let state = app.state::<AppState>();
        let groups = vec!["records".to_string()];
        if let Err(e) = run_groups(&app, &state, &res, &groups, "记录更新后").await {
            log::info!("[static] 记录图片补全跳过: {}", e.message);
        }
    });
}

async fn run_groups(
    app: &AppHandle,
    state: &AppState,
    res: &StaticRes,
    groups: &[String],
    trigger: &str,
) -> ApiResult<Vec<GroupProgress>> {
    if res.downloading.swap(true, Ordering::SeqCst) {
        return Err(ApiError::retcode(-41, "资源下载已在进行中"));
    }
    res.cancel.store(false, Ordering::Relaxed);
    res.activity.lock().unwrap().clear();
    log::info!("[static] 开始下载资源组（{trigger}）: {}", groups.join(","));
    let mut results = Vec::new();
    for key in groups {
        let r = run_group(app, state, res, key).await;
        log::info!(
            "[static] 资源组 {key} 结束: {} {}/{}（失败 {}，{} KB）",
            r.state,
            r.done,
            r.total,
            r.failed,
            r.bytes / 1024
        );
        if r.state == "done" {
            let db = state.db.lock().unwrap();
            store::meta_set(&db, &group_meta_key(key), &crate::service::now_ms().to_string());
        }
        let cancelled = r.state == "cancelled";
        results.push(r);
        if cancelled {
            break;
        }
    }
    res.downloading.store(false, Ordering::SeqCst);
    let _ = app.emit("static://idle", ());
    if res.rerun_records.swap(false, Ordering::Relaxed) && !res.cancel.load(Ordering::Relaxed) {
        sync_records_later(app);
    }
    Ok(results)
}

/// 单个下载任务：(目标文件, 官方 URL)
type Job = (PathBuf, String);

async fn run_group(app: &AppHandle, state: &AppState, res: &StaticRes, key: &str) -> GroupProgress {
    let mut p = GroupProgress {
        key: key.into(),
        done: 0,
        total: 0,
        failed: 0,
        bytes: 0,
        state: "running".into(),
        message: "正在准备…".into(),
    };
    emit_progress(app, &p);

    let jobs: Vec<Job> = match key {
        "wiki" => match wiki_items(state).await {
            Ok(items) => {
                let dir = res.wiki_dir();
                let mut index = HashMap::new();
                let mut jobs = Vec::new();
                for (name, url) in items {
                    // Windows 文件名非法字符兜底（与 fetch-wiki-icons.mjs 一致）
                    let safe: String = name
                        .chars()
                        .map(|c| if "\\/:*?\"<>|".contains(c) { '_' } else { c })
                        .collect();
                    let file = format!("{safe}.{}", ext_of(&url));
                    index.insert(name, file.clone());
                    jobs.push((dir.join(file), url));
                }
                let written = std::fs::create_dir_all(&dir).and_then(|_| {
                    write_atomic(&dir.join("index.json"), serde_json::to_string(&index).unwrap_or_default().as_bytes())
                });
                if let Err(e) = written {
                    p.state = "failed".into();
                    p.message = format!("写入失败: {e}");
                    emit_progress(app, &p);
                    return p;
                }
                *res.wiki_index.lock().unwrap() = Some(index);
                jobs
            }
            Err(e) => {
                p.state = "failed".into();
                p.message = format!("获取图鉴列表失败: {}", e.message);
                emit_progress(app, &p);
                return p;
            }
        },
        "records" => record_urls(state)
            .into_iter()
            .map(|u| (res.cache_path(&u), u))
            .collect(),
        _ => {
            p.state = "failed".into();
            p.message = "未知资源组".into();
            return p;
        }
    };

    p.total = jobs.len();
    // 已存在的文件视为完成（增量下载）
    let pending: Vec<Job> = jobs.into_iter().filter(|(path, _)| !path.exists()).collect();
    p.done = p.total - pending.len();
    p.message = String::new();
    emit_progress(app, &p);

    let progress = Arc::new(Mutex::new(p));
    let sem = Arc::new(tokio::sync::Semaphore::new(DOWNLOAD_CONCURRENCY));
    let mut set = tokio::task::JoinSet::new();
    let last_emit = Arc::new(Mutex::new(std::time::Instant::now()));
    for (path, url) in pending {
        let sem = sem.clone();
        let client = res.client.clone();
        let progress = progress.clone();
        let app = app.clone();
        let last_emit = last_emit.clone();
        set.spawn(async move {
            let Ok(_permit) = sem.acquire_owned().await else { return };
            if app.state::<StaticRes>().cancel.load(Ordering::Relaxed) {
                return;
            }
            let outcome = fetch_image(&client, &url).await;
            let mut g = progress.lock().unwrap();
            match outcome {
                Ok(bytes) => match write_atomic(&path, &bytes) {
                    Ok(()) => {
                        g.done += 1;
                        g.bytes += bytes.len() as u64;
                    }
                    Err(e) => {
                        g.failed += 1;
                        log::warn!("[static] 写入失败: {e}");
                    }
                },
                Err(e) => {
                    g.failed += 1;
                    log::warn!("[static] 下载失败 {}: {e}", url_path(&url));
                }
            }
            // 进度事件节流：200ms 一次
            let mut last = last_emit.lock().unwrap();
            if last.elapsed() >= Duration::from_millis(200) {
                *last = std::time::Instant::now();
                emit_progress(&app, &g);
            }
        });
    }
    while set.join_next().await.is_some() {}

    let mut p = progress.lock().unwrap().clone();
    p.state = if res.cancel.load(Ordering::Relaxed) {
        "cancelled".into()
    } else if p.failed > 0 {
        "failed".into()
    } else {
        "done".into()
    };
    p.message = match p.state.as_str() {
        "cancelled" => "已跳过".into(),
        "failed" => format!("{} 个文件下载失败，展示时会自动重试", p.failed),
        _ => "完成".into(),
    };
    emit_progress(app, &p);
    p
}

// ---------------------------------------------------------------------------
// 数据文件夹迁移（对应 SettingStorageSetDataFolderOperation）
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct FolderCheck {
    /// 目标目录已有本应用数据（会被覆盖）
    pub has_existing_data: bool,
}

fn validate_target(res: &StaticRes, target: &Path) -> ApiResult<()> {
    if target.as_os_str().is_empty() || target.parent().is_none() {
        return Err(ApiError::retcode(-43, "不能选择磁盘根目录，请选择或新建一个文件夹"));
    }
    if same_path(target, &res.data_dir) {
        return Err(ApiError::retcode(-44, "所选文件夹就是当前数据目录"));
    }
    if is_inside(target, &res.data_dir) || is_inside(&res.data_dir, target) {
        return Err(ApiError::retcode(-45, "新目录不能位于当前数据目录之内（或包含当前数据目录）"));
    }
    std::fs::create_dir_all(target).map_err(|e| ApiError::retcode(-46, format!("无法创建目录: {e}")))?;
    let probe = target.join(".hoyoauth-write-test");
    std::fs::write(&probe, b"ok").map_err(|e| ApiError::retcode(-47, format!("目录不可写: {e}")))?;
    let _ = std::fs::remove_file(probe);
    Ok(())
}

#[tauri::command]
pub fn data_folder_check(res: State<'_, StaticRes>, path: String) -> ApiResult<FolderCheck> {
    let target = PathBuf::from(&path);
    validate_target(&res, &target)?;
    Ok(FolderCheck {
        has_existing_data: target.join(DB_FILE).exists() || target.join(STATIC_DIR).exists(),
    })
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)? {
        let e = e?;
        let dest = to.join(e.file_name());
        if e.file_type()?.is_dir() {
            copy_dir(&e.path(), &dest)?;
        } else {
            std::fs::copy(e.path(), dest)?;
        }
    }
    Ok(())
}

/// 复制数据库与图像缓存到新目录并写入位置指针；调用方随后重启应用使其生效
#[tauri::command]
pub fn data_folder_set(state: State<'_, AppState>, res: State<'_, StaticRes>, path: String) -> ApiResult<()> {
    let target = PathBuf::from(&path);
    validate_target(&res, &target)?;
    if res.downloading.load(Ordering::Relaxed) {
        return Err(ApiError::retcode(-41, "资源下载进行中，请稍后再试"));
    }
    log::info!("[datafolder] 迁移数据目录（默认目录={}）", same_path(&target, &res.default_dir));

    // 覆盖目标中已有的本应用数据（前端已二次确认）
    for name in [DB_FILE, "users.db-wal", "users.db-shm"] {
        let _ = std::fs::remove_file(target.join(name));
    }
    let _ = std::fs::remove_dir_all(target.join(STATIC_DIR));

    // VACUUM INTO：在打开的连接上生成一致的数据库副本
    let dest_db = target.join(DB_FILE);
    {
        let db = state.db.lock().unwrap();
        db.execute("VACUUM INTO ?1", [dest_db.to_string_lossy().to_string()])
            .map_err(|e| ApiError::retcode(-48, format!("数据库复制失败: {e}")))?;
    }
    // 新库记下待清理的旧目录：重启后确认新库可用再删旧数据
    let new_conn = rusqlite::Connection::open(&dest_db)
        .map_err(|e| ApiError::retcode(-48, format!("新数据库无法打开: {e}")))?;
    store::meta_set(&new_conn, META_PENDING_CLEANUP, &res.data_dir.to_string_lossy());
    drop(new_conn);

    let src_static = res.static_dir();
    if src_static.exists() {
        if let Err(e) = copy_dir(&src_static, &target.join(STATIC_DIR)) {
            let _ = std::fs::remove_file(&dest_db);
            return Err(ApiError::retcode(-49, format!("图像缓存复制失败: {e}")));
        }
    }

    let pointer = res.default_dir.join(POINTER_FILE);
    if same_path(&target, &res.default_dir) {
        let _ = std::fs::remove_file(&pointer);
    } else {
        let body = serde_json::to_string(&Pointer { dir: target.to_string_lossy().to_string() }).unwrap_or_default();
        std::fs::write(&pointer, body).map_err(|e| ApiError::retcode(-50, format!("位置信息写入失败: {e}")))?;
    }
    log::info!("[datafolder] 迁移完成，等待重启生效");
    Ok(())
}

#[tauri::command]
pub fn data_folder_open(app: AppHandle, res: State<'_, StaticRes>) -> ApiResult<()> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(res.data_dir.to_string_lossy(), None::<&str>)
        .map_err(|e| ApiError::retcode(-51, format!("打开文件夹失败: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn official_host_whitelist() {
        assert!(is_official("https://act-webstatic.mihoyo.com/hk4e/x.png"));
        assert!(is_official("https://bbs-static.miyoushe.com/a.png"));
        assert!(is_official("https://upload-os-bbs.hoyolab.com/a.png"));
        assert!(!is_official("http://act-webstatic.mihoyo.com/x.png"));
        assert!(!is_official("https://enka.network/ui/a.png"));
        assert!(!is_official("https://mihoyo.com.evil.net/a.png"));
        assert!(!is_official("https://evilmihoyo.com/a.png"));
    }

    #[test]
    fn image_magic() {
        assert!(looks_like_image(&[0x89, b'P', b'N', b'G', 13, 10, 26, 10, 0, 0, 0, 13, b'I', b'H', b'D', b'R', 0]));
        assert!(looks_like_image(b"RIFF\x10\x00\x00\x00WEBPVP8 \x00\x00"));
        assert!(!looks_like_image(b""));
        assert!(!looks_like_image(b"<html><body>error</body></html>"));
    }

    #[test]
    fn ext_detection() {
        assert_eq!(ext_of("https://a.mihoyo.com/x.JPG?y=1"), "jpg");
        assert_eq!(ext_of("https://a.mihoyo.com/x.webp"), "webp");
        assert_eq!(ext_of("https://a.mihoyo.com/x"), "png");
    }
}
