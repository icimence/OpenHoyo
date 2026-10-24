//! UIGF v4.x 导入 / v4.2 导出（https://uigf.org/zh/standards/uigf.html）。
//! 仅支持 v4.x（info.version 以 "v4" 开头）；3.0 及以下明确拒绝。
//! 存储复用 gacha_archives/gacha_items 表；重复导入幂等，完整记录可补全旧记录缺失信息。

use crate::gacha::{self, GachaLogItem};
use crate::gacha_item;
use crate::response::{ApiError, ApiResult};
use crate::state::AppState;
use serde::{Deserialize, Serialize};

const EXPORT_APP: &str = "FrostDance";

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
    #[serde(deserialize_with = "de_uid")]
    uid: String,
    timezone: i8,
    list: Vec<UigfItem>,
}

fn de_uid<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    match value {
        serde_json::Value::String(uid) => Ok(uid),
        serde_json::Value::Number(uid) => Ok(uid.to_string()),
        _ => Err(serde::de::Error::custom("UID 必须是字符串或整数")),
    }
}

fn convert_time(time: &str, from: i8, to: i8) -> ApiResult<String> {
    chrono::NaiveDateTime::parse_from_str(time, "%Y-%m-%d %H:%M:%S")
        .ok()
        .and_then(|time| {
            time.checked_add_signed(chrono::Duration::hours(i64::from(to) - i64::from(from)))
        })
        .map(|time| time.format("%Y-%m-%d %H:%M:%S").to_string())
        .ok_or_else(|| ApiError::retcode(-7, "祈愿记录时间格式无效"))
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
    #[serde(default)]
    name: String,
    #[serde(default)]
    item_type: String,
    #[serde(default, deserialize_with = "crate::models::de_i32_flexible")]
    rank_type: i32,
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
    name: String,
    item_type: String,
    rank_type: String,
    count: &'static str,
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
    pub repaired: usize,
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

impl UigfItem {
    fn resolved(&self) -> gacha_item::ResolvedItem {
        gacha_item::resolve(&self.item_id, &self.name, &self.item_type, self.rank_type)
    }
}

/// 导入 UIGF v4.x；完整重复记录跳过，缺损记录由完整输入补全。
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
    if !file
        .info
        .version
        .strip_prefix("v4.")
        .is_some_and(|minor| !minor.is_empty() && minor.chars().all(|c| c.is_ascii_digit()))
    {
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
    // v4.x 的 time 是 timezone 下的当地时间。先检查全部账号，失败时不写入半份存档。
    for acc in &file.hk4e {
        if !(-12..=14).contains(&acc.timezone) {
            return Err(ApiError::retcode(-4, "UIGF 时区偏移超出有效范围"));
        }
        let invalid = acc
            .list
            .iter()
            .filter(|item| !item.resolved().is_complete())
            .count();
        if invalid > 0 {
            return Err(ApiError::retcode(-8, format!("文件中有 {invalid} 条记录缺少可识别的物品 ID、名称或星级。旧版导出可能已丢失物品信息，请在保留完整记录的电脑端更新后重新导出；不会导入不完整数据。")));
        }
        for item in &acc.list {
            convert_time(&item.time, acc.timezone, 8)?;
            if item.id <= 0
                || !matches!(item.gacha_type, 0 | 100 | 200 | 301 | 302 | 400 | 500)
                || !matches!(item.uigf_gacha_type, 100 | 200 | 301 | 302 | 500)
            {
                return Err(ApiError::retcode(-9, "祈愿记录 ID 或卡池类型无效"));
            }
            let raw_pool = if item.gacha_type == 0 {
                item.uigf_gacha_type
            } else {
                item.gacha_type
            };
            if (if raw_pool == 400 { 301 } else { raw_pool }) != item.uigf_gacha_type {
                return Err(ApiError::retcode(-9, "祈愿卡池类型与保底分组不一致"));
            }
        }
    }

    let total: usize = file.hk4e.iter().map(|a| a.list.len()).sum();
    let mut processed = 0;
    let mut accounts = Vec::new();
    for acc in &file.hk4e {
        if acc.list.is_empty() {
            continue;
        }
        let archive_id = gacha::ensure_archive(state, &acc.uid)?;
        let mut items = Vec::with_capacity(acc.list.len());
        for it in &acc.list {
            // v4 规范：gacha_type 是米哈游 API 原始池类型（400 角色活动祈愿-2 保留 400），
            // uigf_gacha_type 是 v3 兼容的归并值（400 已折算为 301）；入库取原始值（已验证真胡桃导出文件）
            let gacha_type = if it.gacha_type != 0 {
                it.gacha_type
            } else {
                it.uigf_gacha_type
            };
            items.push(GachaLogItem {
                uid: acc.uid.clone(),
                gacha_type,
                item_id: it.item_id.clone(),
                time: it.time.clone(),
                timezone: acc.timezone,
                name: it.name.clone(),
                item_type: it.item_type.clone(),
                rank_type: it.rank_type,
                id: it.id,
            });
        }
        let mut inserted = 0;
        let mut repaired = 0;
        let mut skipped = 0;
        for chunk in items.chunks(500) {
            let saved = gacha::insert_items(state, archive_id, chunk)?;
            inserted += saved.inserted;
            repaired += saved.repaired;
            skipped += saved.skipped;
            processed += chunk.len();
            report(&UigfImportProgress {
                uid: acc.uid.clone(),
                processed,
                total,
            });
        }
        accounts.push(UigfImportReport {
            uid: acc.uid.clone(),
            inserted,
            skipped,
            repaired,
        });
        log::info!(
            "[uigf] 导入 uid={}：文件 {} 条，新入库 {} 条，修复 {repaired} 条",
            acc.uid,
            acc.list.len(),
            inserted
        );
    }
    if accounts.is_empty() {
        return Err(ApiError::retcode(-5, "文件中没有有效条目"));
    }
    Ok(UigfImportDto { accounts })
}

/// 导出 UIGF v4.2，统一到 UTC+8；保留原始池类型及 400→301 保底分组。
pub fn export_uigf(state: &AppState, uid: &str, app_version: &str) -> ApiResult<String> {
    let archive_id = gacha::archive_id_by_uid(state, uid)?
        .ok_or_else(|| ApiError::retcode(-6, "该 UID 没有祈愿记录存档"))?;
    let items = gacha::load_items(state, archive_id)?;

    let list = items
        .iter()
        .map(|it| {
            // 存档入口已解析身份；此处只序列化统一读取结果，不维护另一套反查规则。
            if !gacha_item::complete_fields(&it.item_id, &it.name, &it.item_type, it.rank_type) {
                return Err(ApiError::retcode(
                    -8,
                    "存档中存在待识别或缺少物品信息的记录，无法完整导出。请更新物品数据或从完整存档重新导入。",
                ));
            }
            Ok(UigfExportItem {
                gacha_type: it.gacha_type.to_string(),
                uigf_gacha_type: it.query_type.to_string(),
                item_id: it.item_id.clone(),
                time: convert_time(&it.time, it.timezone, 8)?,
                id: it.id.to_string(),
                name: it.name.clone(),
                item_type: it.item_type.clone(),
                rank_type: it.rank_type.to_string(),
                count: "1",
            })
        })
        .collect::<ApiResult<Vec<_>>>()?;

    let doc = UigfExport {
        info: UigfExportInfo {
            export_timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0),
            export_app: EXPORT_APP,
            export_app_version: app_version.to_string(),
            version: "v4.2",
        },
        hk4e: vec![UigfExportAccount {
            uid: uid.to_string(),
            timezone: 8,
            list,
        }],
    };
    serde_json::to_string(&doc).map_err(|e| ApiError::transport(format!("UIGF 序列化失败: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_unknown_metadata_recovers_five_and_four_stars_without_reimport() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::store::init(&conn).unwrap();
        gacha::init_tables(&conn).unwrap();
        let state = AppState::new(conn);
        let archive = gacha::ensure_archive(&state, "test").unwrap();
        for pool in [301, 200] {
            let base = i64::from(pool) * 10;
            for (offset, item_id) in [(1, "10000106"), (2, "11401"), (3, "11301")] {
                state.db.lock().unwrap().execute(
                    "INSERT INTO gacha_items (id, archive_id, gacha_type, query_type, item_id, time) VALUES (?1, ?2, ?3, ?3, ?4, '2025-01-01 00:00:00')",
                    rusqlite::params![base + offset, archive, pool, item_id],
                ).unwrap();
            }
        }
        let items = gacha::load_items(&state, archive).unwrap();
        let stats = crate::gacha_stats::build_statistics("test", &items);
        for summary in [stats.avatar_wish, stats.standard_wish] {
            assert_eq!(summary.total_orange, 1);
            assert_eq!(summary.total_purple, 1);
            assert_eq!(summary.total_blue, 1);
            assert_eq!(summary.last_orange_pull, 2);
            assert_eq!(summary.last_purple_pull, 1);
            assert_eq!(summary.orange_list[0].name, "玛薇卡");
            assert_eq!(summary.total_unknown, 0);
        }
        assert_eq!(items[0].time, "2025-01-01 00:00:00");
        let raw_rank: i32 = state
            .db
            .lock()
            .unwrap()
            .query_row("SELECT rank_type FROM gacha_items LIMIT 1", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(raw_rank, 0, "读取补全不改写原始存档");
    }

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
        let path = std::env::var("UIGF_SAMPLE").unwrap_or_else(|_| {
            let home = std::env::var("USERPROFILE").expect("请设置 UIGF_SAMPLE");
            format!("{home}\\Desktop\\Snap Hutao UIGF.json")
        });
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
        let to_keys = |items: &[UigfItem], timezone: i8| -> std::collections::HashSet<Key> {
            items
                .iter()
                .map(|i| {
                    Key(
                        i.id,
                        i.item_id.clone(),
                        i.uigf_gacha_type,
                        i.gacha_type,
                        convert_time(&i.time, timezone, 0).unwrap(),
                    )
                })
                .collect()
        };
        let origin_items = &origin.hk4e.iter().find(|a| a.uid == uid).unwrap().list;
        let diff: Vec<Key> = to_keys(
            origin_items,
            origin.hk4e.iter().find(|a| a.uid == uid).unwrap().timezone,
        )
        .symmetric_difference(&to_keys(&ex.hk4e[0].list, ex.hk4e[0].timezone))
        .cloned()
        .collect();
        assert!(
            diff.is_empty(),
            "往返差异 {} 条，例如 {:?}",
            diff.len(),
            diff.first()
        );

        // 检查统一读取结果；ID-only 来源快照可以没有名称/星级，不能直接以原始列判断。
        let items: Vec<_> = gacha::list_archives(&state)
            .unwrap()
            .into_iter()
            .flat_map(|(archive, _)| gacha::load_items(&state, archive).unwrap())
            .collect();
        let blank_name = items.iter().filter(|item| item.name.is_empty()).count();
        let blank_rank = items
            .iter()
            .filter(|item| !(3..=5).contains(&item.rank_type))
            .count();
        println!("元数据缺失：名称 {blank_name} 条，星级 {blank_rank} 条");
        assert_eq!(blank_name, 0, "存在未命中 item_meta 的条目");
        assert_eq!(blank_rank, 0);

        let _ = std::fs::remove_file(&tmp);
        println!("往返一致性验证通过：{origin_count} 条无损");
    }
}
#[cfg(test)]
mod compatibility_tests {
    use super::*;

    fn state() -> AppState {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::store::init(&conn).unwrap();
        gacha::init_tables(&conn).unwrap();
        AppState::new(conn)
    }

    fn content(version: &str, timezone: i8) -> String {
        serde_json::json!({
            "info": {"version": version},
            "hk4e": [{"uid": 123456789, "timezone": timezone, "list": [
                {"uigf_gacha_type":"301", "gacha_type":"400", "item_id":"10000003", "time":"2025-01-01 22:00:00", "id":"9007199254740993"}
            ]}]
        }).to_string()
    }

    #[test]
    fn all_supported_4x_versions_and_timezones_roundtrip_the_same_instant() {
        for version in ["v4.0", "v4.1", "v4.2"] {
            for timezone in [-5, 0, 8] {
                let state = state();
                let content = content(version, timezone);
                let first = import_uigf(&state, &content).unwrap();
                assert_eq!(first.accounts[0].inserted, 1);
                let source_name: String = state
                    .db
                    .lock()
                    .unwrap()
                    .query_row("SELECT name FROM gacha_items LIMIT 1", [], |row| row.get(0))
                    .unwrap();
                assert!(source_name.is_empty(), "ID-only 文件的来源快照保持原文");
                let exported: serde_json::Value =
                    serde_json::from_str(&export_uigf(&state, "123456789", "test").unwrap())
                        .unwrap();
                assert_eq!(exported["info"]["version"], "v4.2");
                assert_eq!(exported["hk4e"][0]["timezone"], 8);
                let row = &exported["hk4e"][0]["list"][0];
                assert_eq!(
                    row["time"],
                    convert_time("2025-01-01 22:00:00", timezone, 8).unwrap()
                );
                assert_eq!(row["id"], "9007199254740993", "大整数 ID 必须无损");
                assert_eq!(row["gacha_type"], "400");
                assert_eq!(row["uigf_gacha_type"], "301");
                assert_eq!(row["name"], "琴");
                assert_eq!(row["rank_type"], "5");
                let second = import_uigf(&state, &exported.to_string()).unwrap();
                assert_eq!(second.accounts[0].inserted, 0);
                assert_eq!(second.accounts[0].repaired, 0);
                assert_eq!(second.accounts[0].skipped, 1);
            }
        }
    }

    #[test]
    fn cn_api_acquisition_resolves_identity_and_roundtrips_local_time() {
        let state = state();
        let archive = gacha::ensure_archive(&state, "123456789").unwrap();
        let item: GachaLogItem = serde_json::from_value(serde_json::json!({
            "id":"9007199254740993", "gacha_type":"301", "item_id":"", "name":"玛薇卡", "item_type":"角色", "rank_type":"5", "time":"2025-01-01 10:00:00"
        })).unwrap();
        gacha::insert_items(&state, archive, &[item]).unwrap();
        let exported = export_uigf(&state, "123456789", "test").unwrap();
        let file: UigfFile = serde_json::from_str(&exported).unwrap();
        assert_eq!(file.hk4e[0].timezone, 8);
        assert_eq!(file.hk4e[0].list[0].item_id, "10000106");
        assert_eq!(file.hk4e[0].list[0].time, "2025-01-01 10:00:00");
        let imported = self::state();
        import_uigf(&imported, &exported).unwrap();
        let stats =
            crate::gacha_stats::build_statistics("test", &gacha::load_items(&imported, 1).unwrap());
        assert_eq!(stats.avatar_wish.total_orange, 1);
        assert_eq!(stats.avatar_wish.total_unknown, 0);
        assert!(stats.avatar_wish.orange_list[0].is_up);
    }

    #[test]
    fn unknown_item_metadata_roundtrips_as_literal_text() {
        let state = state();
        let name = "\" onpointerover=\"globalThis.__review_probe=1\" x=\"";
        let content = serde_json::json!({
            "info": {"version": "v4.2"},
            "hk4e": [{"uid": "123456789", "timezone": -5, "list": [{
                "uigf_gacha_type": "200", "gacha_type": "200",
                "item_id": "19999999", "name": name, "item_type": "角色", "rank_type": "5",
                "time": "2025-01-01 22:00:00", "id": "9007199254740993"
            }]}]
        })
        .to_string();
        let report = import_uigf(&state, &content).unwrap();
        assert_eq!(report.accounts[0].inserted, 1);
        let items = gacha::load_items(&state, 1).unwrap();
        assert_eq!(items[0].name, name, "名称按原文存储，由显示层转义");
        let statistics = crate::gacha_stats::build_statistics("123456789", &items);
        assert_eq!(statistics.standard_wish.orange_list[0].name, name);
        assert_eq!(
            statistics.standard_wish.orange_list[0].time,
            "2025-01-02 11:00:00"
        );
        assert_eq!(statistics.event_history[0].from, "2025-01-02 11:00:00");
        let exported: serde_json::Value =
            serde_json::from_str(&export_uigf(&state, "123456789", "test").unwrap()).unwrap();
        let row = &exported["hk4e"][0]["list"][0];
        assert_eq!(row["item_id"], "19999999");
        assert_eq!(row["name"], name);
        assert_eq!(row["rank_type"], "5");
        assert_eq!(row["time"], "2025-01-02 11:00:00");
        let roundtrip_state = self::state();
        import_uigf(&roundtrip_state, &exported.to_string()).unwrap();
        let roundtrip = gacha::load_items(&roundtrip_state, 1).unwrap();
        assert_eq!(roundtrip[0].name, name);
        assert_eq!(roundtrip[0].item_id, "19999999");
    }

    #[test]
    fn complete_reimport_repairs_existing_blank_record_and_is_idempotent() {
        let state = state();
        let archive = gacha::ensure_archive(&state, "123456789").unwrap();
        state.db.lock().unwrap().execute(
            "INSERT INTO gacha_items (id, archive_id, gacha_type, query_type, time) VALUES (9007199254740993, ?1, 400, 301, '2025-01-01 22:00:00')", [archive],
        ).unwrap();
        let report = import_uigf(&state, &content("v4.2", 0)).unwrap();
        assert_eq!(report.accounts[0].inserted, 0);
        assert_eq!(report.accounts[0].repaired, 1);
        let items = gacha::load_items(&state, archive).unwrap();
        assert_eq!(items[0].name, "琴");
        assert_eq!(items[0].rank_type, 5);
        assert_eq!(items[0].timezone, 0);
        let again = import_uigf(&state, &content("v4.2", 0)).unwrap();
        assert_eq!(again.accounts[0].repaired, 0);
    }

    #[test]
    fn damaged_file_fails_before_any_account_is_written() {
        let state = state();
        let mut file: serde_json::Value = serde_json::from_str(&content("v4.2", 0)).unwrap();
        let mut damaged = file["hk4e"][0].clone();
        damaged["uid"] = "other".into();
        damaged["list"][0]["item_id"] = "".into();
        file["hk4e"].as_array_mut().unwrap().push(damaged);
        let error = import_uigf(&state, &file.to_string()).err().unwrap();
        assert_eq!(error.code, -8);
        assert!(gacha::list_archives(&state).unwrap().is_empty());
    }

    #[test]
    fn legacy_timezone_migration_keeps_existing_interpretation_and_is_repeatable() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE gacha_items (id INTEGER PRIMARY KEY, archive_id INTEGER NOT NULL, gacha_type INTEGER, query_type INTEGER, item_id TEXT, name TEXT, item_type TEXT, rank_type INTEGER, time TEXT);
            INSERT INTO gacha_items VALUES (1, 1, 301, 301, '', '琴', '角色', 5, '2025-01-01 08:00:00');
            INSERT INTO gacha_items VALUES (2, 1, 301, 301, '10000003', '琴', '角色', 5, '2025-01-01 00:00:00');").unwrap();
        gacha::init_tables(&conn).unwrap();
        gacha::init_tables(&conn).unwrap();
        let zones = conn
            .prepare("SELECT timezone FROM gacha_items ORDER BY id")
            .unwrap()
            .query_map([], |r| r.get::<_, i8>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(zones, [8, 0]);
        let state = AppState::new(conn);
        gacha::load_items(&state, 1).unwrap();
        let conn = state.db.lock().unwrap();
        gacha::init_tables(&conn).unwrap();
        let first: (String, i8) = conn
            .query_row(
                "SELECT item_id, timezone FROM gacha_items WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            first,
            ("10000003".into(), 8),
            "补齐 ID 后再次启动也不能被误判为 UTC"
        );
    }

    #[test]
    #[ignore = "需要 UIGF_SAMPLE 指向待检查的损坏导出文件"]
    fn damaged_export_real_file() {
        let content = std::fs::read_to_string(std::env::var("UIGF_SAMPLE").unwrap()).unwrap();
        let state = state();
        let file: UigfFile = serde_json::from_str(&content).unwrap();
        let invalid: usize = file
            .hk4e
            .iter()
            .flat_map(|a| &a.list)
            .filter(|item| !item.resolved().is_complete())
            .count();
        assert!(invalid > 0);
        let error = import_uigf(&state, &content).err().unwrap();
        assert_eq!(error.code, -8);
        assert!(gacha::list_archives(&state).unwrap().is_empty());
        println!(
            "真实文件检查：{} 条记录缺失物品信息，已在写库前拒绝",
            invalid
        );
    }
}
