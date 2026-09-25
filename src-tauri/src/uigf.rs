//! UIGF v4.0 祈愿记录导入/导出（https://uigf.org/zh/standards/uigf.html）。
//! 仅支持 v4.x（info.version 以 "v4" 开头）；3.0 及以下明确拒绝。
//! 存储复用 gacha_archives/gacha_items 表（INSERT OR IGNORE 幂等，重复导入无副作用）。

use crate::gacha::{self, GachaLogItem};
use crate::response::{ApiError, ApiResult};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const EXPORT_APP: &str = "OpenHoyo";

#[derive(Deserialize)]
struct UigfFile {
    info: UigfInfo,
    #[serde(default)]
    hk4e: Vec<UigfAccount>,
}

#[derive(Deserialize)]
struct UigfInfo {
    version: String,
}

#[derive(Deserialize)]
struct UigfAccount {
    uid: String,
    #[serde(default)]
    timezone: i8,
    list: Vec<UigfItem>,
}

#[derive(Deserialize)]
struct UigfItem {
    #[serde(
        default,
        rename = "uigf_gacha_type",
        deserialize_with = "crate::models::de_i32_flexible"
    )]
    uigf_gacha_type: i32,
    #[serde(
        default,
        rename = "gacha_type",
        deserialize_with = "crate::models::de_i32_flexible"
    )]
    gacha_type: i32,
    #[serde(default, rename = "item_id")]
    item_id: String,
    #[serde(default)]
    time: String,
    #[serde(default, deserialize_with = "crate::models::de_i64_flexible")]
    id: i64,
}

#[derive(Serialize)]
struct UigfExport {
    info: UigfExportInfo,
    hk4e: Vec<UigfExportAccount>,
}

#[derive(Serialize)]
struct UigfExportInfo {
    export_timestamp: i64,
    export_app: &'static str,
    export_app_version: String,
    version: &'static str,
}

#[derive(Serialize)]
struct UigfExportAccount {
    uid: String,
    timezone: i8,
    list: Vec<UigfExportItem>,
}

#[derive(Serialize)]
struct UigfExportItem {
    uigf_gacha_type: String,
    gacha_type: String,
    item_id: String,
    time: String,
    id: String,
}

#[derive(Serialize, Clone)]
pub struct UigfImportReport {
    pub uid: String,
    pub inserted: usize,
    pub skipped: usize,
}

/// 导入结果摘要（多 UID 时逐个汇报）
#[derive(Serialize)]
pub struct UigfImportDto {
    pub accounts: Vec<UigfImportReport>,
}

#[derive(Serialize, Clone)]
pub struct UigfImportProgress {
    pub uid: String,
    pub processed: usize,
    pub total: usize,
}

fn item_meta() -> &'static HashMap<String, (String, String, i32)> {
    static META: std::sync::OnceLock<HashMap<String, (String, String, i32)>> =
        std::sync::OnceLock::new();
    META.get_or_init(|| {
        // item_meta.json：id → [名称, 类型, 星级]（Snap.Hutao.Remastered 官方元数据生成）
        let raw: HashMap<String, [serde_json::Value; 3]> =
            serde_json::from_str(include_str!("data/item_meta.json")).unwrap_or_default();
        raw.into_iter()
            .map(|(id, arr)| {
                let name = arr[0].as_str().unwrap_or("").to_string();
                let ty = arr[1].as_str().unwrap_or("").to_string();
                let rank = arr[2].as_i64().unwrap_or(0) as i32;
                (id, (name, ty, rank))
            })
            .collect()
    })
}

/// 导入 UIGF v4 文件内容（INSERT OR IGNORE：已存在的记录自动跳过）
#[cfg(test)]
pub fn import_uigf(state: &AppState, content: &str) -> ApiResult<UigfImportDto> {
    import_uigf_with_progress(state, content, |_| {})
}

pub fn import_uigf_with_progress(
    state: &AppState,
    content: &str,
    mut report: impl FnMut(&UigfImportProgress),
) -> ApiResult<UigfImportDto> {
    let file: UigfFile = serde_json::from_str(content)
        .map_err(|e| ApiError::retcode(-1, format!("UIGF 文件解析失败: {e}")))?;
    if !file.info.version.starts_with("v4") {
        return Err(ApiError::retcode(
            -2,
            format!(
                "暂不支持 UIGF {}（仅支持 v4.0 及以上版本）",
                file.info.version
            ),
        ));
    }
    if file.hk4e.is_empty() {
        return Err(ApiError::retcode(-3, "文件中没有祈愿记录（hk4e 为空）"));
    }
    // UIGF 规范：timezone +8 的条目已折算为 UTC+0 时间
    if file.hk4e.iter().any(|a| a.timezone != 0) {
        return Err(ApiError::retcode(-4, "暂不支持非 UTC+0 时区的文件"));
    }

    let meta = item_meta();
    let total: usize = file.hk4e.iter().map(|a| a.list.len()).sum();
    let mut processed = 0;
    let mut accounts = Vec::new();
    for acc in &file.hk4e {
        if acc.list.is_empty() {
            continue;
        }
        let archive_id = gacha::ensure_archive(state, &acc.uid)?;
        let mut items = Vec::with_capacity(acc.list.len());
        let mut skipped = 0usize;
        for it in &acc.list {
            // v4 规范：gacha_type 是米哈游 API 原始池类型（400 集录保留 400），
            // uigf_gacha_type 是 v3 兼容的归并值（400 已折算为 301）；入库取原始值（已验证真胡桃导出文件）
            let gacha_type = if it.gacha_type != 0 {
                it.gacha_type
            } else {
                it.uigf_gacha_type
            };
            if gacha_type == 0 {
                skipped += 1;
                continue;
            }
            let (name, item_type, rank) = meta
                .get(&it.item_id)
                .cloned()
                .unwrap_or_else(|| (String::new(), String::new(), 0));
            items.push(GachaLogItem {
                uid: acc.uid.clone(),
                gacha_type,
                item_id: it.item_id.clone(),
                time: it.time.clone(),
                name,
                item_type,
                rank_type: rank,
                id: it.id,
            });
        }
        let before = gacha::count_items(state, archive_id)?;
        for chunk in items.chunks(500) {
            gacha::insert_items(state, archive_id, chunk)?;
            processed += chunk.len();
            report(&UigfImportProgress {
                uid: acc.uid.clone(),
                processed,
                total,
            });
        }
        if skipped > 0 {
            processed += skipped;
            report(&UigfImportProgress {
                uid: acc.uid.clone(),
                processed,
                total,
            });
        }
        let after = gacha::count_items(state, archive_id)?;
        let inserted = (after - before) as usize;
        accounts.push(UigfImportReport {
            uid: acc.uid.clone(),
            inserted,
            skipped: acc.list.len().saturating_sub(inserted),
        });
        log::info!(
            "[uigf] 导入 uid={}：文件 {} 条，新入库 {} 条",
            acc.uid,
            acc.list.len(),
            after - before
        );
    }
    if accounts.is_empty() {
        return Err(ApiError::retcode(-5, "文件中没有有效条目"));
    }
    Ok(UigfImportDto { accounts })
}

/// 导出指定 UID 为 UIGF v4.0 JSON（时区 UTC+0，400 池归并展示为 301 语义由 uigf_gacha_type 保留）
pub fn export_uigf(state: &AppState, uid: &str, app_version: &str) -> ApiResult<String> {
    let archive_id = gacha::archive_id_by_uid(state, uid)?
        .ok_or_else(|| ApiError::retcode(-6, "该 UID 没有祈愿记录存档"))?;
    let items = gacha::load_items(state, archive_id)?;

    let list = items
        .iter()
        .map(|it| UigfExportItem {
            // v4 规范：gacha_type 保留 API 原始池类型（400），uigf_gacha_type 是 v3 兼容的归并值（400→301）
            gacha_type: it.gacha_type.to_string(),
            uigf_gacha_type: it.query_type.to_string(),
            item_id: it.item_id.clone(),
            time: it.time.clone(),
            id: it.id.to_string(),
        })
        .collect();

    let doc = UigfExport {
        info: UigfExportInfo {
            export_timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0),
            export_app: EXPORT_APP,
            export_app_version: app_version.to_string(),
            version: "v4.0",
        },
        hk4e: vec![UigfExportAccount {
            uid: uid.to_string(),
            timezone: 0,
            list,
        }],
    };
    serde_json::to_string(&doc).map_err(|e| ApiError::transport(format!("UIGF 序列化失败: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_v3() {
        let doc = r#"{"info":{"version":"v3.0"},"hk4e":[]}"#;
        // 不经过 AppState 的纯校验路径：解析成功但版本被拒
        let file: Result<UigfFile, _> = serde_json::from_str(doc);
        assert!(file.is_ok());
        assert!(!file.unwrap().info.version.starts_with("v4"));
    }

    #[test]
    fn parses_v4_sample() {
        let doc = r#"{"info":{"export_timestamp":1,"export_app":"x","export_app_version":"1","version":"v4.1"},"hk4e":[{"uid":"1","timezone":0,"list":[{"uigf_gacha_type":"302","gacha_type":"302","item_id":"15301","time":"2024-04-02 16:03:34","id":"1712073960000715209"}]}]}"#;
        let file: UigfFile = serde_json::from_str(doc).unwrap();
        assert!(file.info.version.starts_with("v4"));
        assert_eq!(file.hk4e[0].list[0].id, 1712073960000715209i64);
        assert_eq!(file.hk4e[0].list[0].item_id, "15301");
    }

    #[test]
    fn roundtrip_preserves_400_pool() {
        // 400（集录）条目：gacha_type=301 原始、uigf_gacha_type 归并为 301；导入后导出必须原样还原
        let doc = r#"{"info":{"export_timestamp":1,"export_app":"x","export_app_version":"1","version":"v4.0"},"hk4e":[{"uid":"1","timezone":0,"list":[{"uigf_gacha_type":"301","gacha_type":"400","item_id":"11509","time":"2024-04-02 16:03:34","id":"1712073960000715209"}]}]}"#;
        let file: UigfFile = serde_json::from_str(doc).unwrap();
        let it = &file.hk4e[0].list[0];
        let gacha_type = if it.gacha_type != 0 {
            it.gacha_type
        } else {
            it.uigf_gacha_type
        };
        assert_eq!(gacha_type, 400, "入库必须保留原始池类型 400");
        let uigf_gacha_type = if gacha_type == 400 { 301 } else { gacha_type };
        assert_eq!(uigf_gacha_type, 301, "导出的 uigf_gacha_type 归并为 301");
    }

    #[test]
    fn import_reports_real_progress_and_skips_duplicates() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::store::init(&conn).unwrap();
        crate::gacha::init_tables(&conn).unwrap();
        let state = AppState::new(conn);
        let list: Vec<_> = (1..=1001)
            .map(|id| {
                serde_json::json!({
                    "uigf_gacha_type": "302", "gacha_type": "302", "item_id": "15301",
                    "time": "2024-04-02 16:03:34", "id": id.to_string(),
                })
            })
            .collect();
        let content = serde_json::json!({
            "info": {"version": "v4.0"},
            "hk4e": [{"uid": "123456789", "timezone": 0, "list": list}],
        })
        .to_string();
        let mut progress = Vec::new();
        let first =
            import_uigf_with_progress(&state, &content, |p| progress.push((p.processed, p.total)))
                .unwrap();
        assert_eq!(first.accounts[0].inserted, 1001);
        assert_eq!(first.accounts[0].skipped, 0);
        assert_eq!(progress, [(500, 1001), (1000, 1001), (1001, 1001)]);
        let second = import_uigf(&state, &content).unwrap();
        assert_eq!(second.accounts[0].inserted, 0);
        assert_eq!(second.accounts[0].skipped, 1001);
    }
}

#[cfg(test)]
mod live_tests {
    use super::*;

    /// 往返一致性：用真实导出文件验证 导入→幂等重导→导出 后逐条无损。
    /// 运行：cargo test -p app --lib uigf -- --ignored --nocapture
    /// 文件路径默认取桌面 "Snap Hutao UIGF.json"，可用环境变量 UIGF_SAMPLE 覆盖。
    #[test]
    #[ignore = "需要桌面上的真实 UIGF 导出文件"]
    fn uigf_roundtrip_real_file() {
        let home = std::env::var("USERPROFILE").expect("USERPROFILE 未设置");
        let path = std::env::var("UIGF_SAMPLE")
            .unwrap_or_else(|_| format!("{home}\\Desktop\\Snap Hutao UIGF.json"));
        let content =
            std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("读取 {path} 失败: {e}"));

        let tmp = std::env::temp_dir().join(format!("uigf-roundtrip-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&tmp);
        let conn = rusqlite::Connection::open(&tmp).unwrap();
        crate::store::init(&conn).unwrap();
        crate::gacha::init_tables(&conn).unwrap();
        let state = crate::state::AppState::new(conn);

        // 第一次导入
        let dto = import_uigf(&state, &content).unwrap();
        assert!(!dto.accounts.is_empty());
        let uid = dto.accounts[0].uid.clone();
        let total: usize = dto.accounts.iter().map(|a| a.inserted).sum();
        let origin: UigfFile = serde_json::from_str(&content).unwrap();
        let origin_count: usize = origin.hk4e.iter().map(|a| a.list.len()).sum();
        println!(
            "导入 uid={uid}：文件 {origin_count} 条，新入库 {total} 条，跳过 {}",
            dto.accounts[0].skipped
        );
        assert_eq!(total, origin_count, "空库首次导入应全部入库");

        // 重复导入幂等
        let dto2 = import_uigf(&state, &content).unwrap();
        let again: usize = dto2.accounts.iter().map(|a| a.inserted).sum();
        assert_eq!(again, 0, "重复导入不应产生新记录");

        // 导出并逐条对比（id/item_id/池类型/时间）
        let exported = export_uigf(&state, &uid, "test").unwrap();
        let ex: UigfFile = serde_json::from_str(&exported).unwrap();
        assert_eq!(ex.hk4e.len(), 1);
        assert_eq!(ex.hk4e[0].uid, uid);
        assert_eq!(
            ex.hk4e[0].list.len(),
            origin
                .hk4e
                .iter()
                .find(|a| a.uid == uid)
                .unwrap()
                .list
                .len()
        );

        #[derive(Hash, PartialEq, Eq, Clone, Debug)]
        struct Key(i64, String, i32, i32, String);
        let to_keys = |items: &[UigfItem]| -> std::collections::HashSet<Key> {
            items
                .iter()
                .map(|i| {
                    Key(
                        i.id,
                        i.item_id.clone(),
                        i.uigf_gacha_type,
                        i.gacha_type,
                        i.time.clone(),
                    )
                })
                .collect()
        };
        let origin_items = &origin.hk4e.iter().find(|a| a.uid == uid).unwrap().list;
        let diff: Vec<Key> = to_keys(origin_items)
            .symmetric_difference(&to_keys(&ex.hk4e[0].list))
            .cloned()
            .collect();
        assert!(
            diff.is_empty(),
            "往返差异 {} 条，例如 {:?}",
            diff.len(),
            diff.first()
        );

        // 元数据覆盖率：所有条目都应查到名称与星级
        let conn = state.db.lock().unwrap();
        let (blank_name, blank_rank): (i64, i64) = conn
            .query_row(
                "SELECT COALESCE(SUM(name=''),0), COALESCE(SUM(rank_type=0),0) FROM gacha_items",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        println!("元数据缺失：名称 {blank_name} 条，星级 {blank_rank} 条");
        assert_eq!(blank_name, 0, "存在未命中 item_meta 的条目");
        assert_eq!(blank_rank, 0);

        drop(conn);
        let _ = std::fs::remove_file(&tmp);
        println!("往返一致性验证通过：{origin_count} 条无损");
    }
}
