//! 身份解析、来源快照及旧存档补齐的内存数据库回归测试。

use super::*;

type Snapshot = (String, String, String, i32, String, i8);

fn state() -> AppState {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    crate::store::init(&conn).unwrap();
    init_tables(&conn).unwrap();
    AppState::new(conn)
}

fn item(id: i64) -> GachaLogItem {
    GachaLogItem {
        id,
        uid: "123456789".into(),
        gacha_type: 301,
        item_id: String::new(),
        name: "玛薇卡".into(),
        item_type: "角色".into(),
        rank_type: 5,
        time: "2025-01-01 10:00:00".into(),
        timezone: 8,
    }
}

fn snapshot(state: &AppState, id: i64) -> Snapshot {
    state.db.lock().unwrap().query_row(
        "SELECT item_id, name, item_type, rank_type, time, timezone FROM gacha_items WHERE id = ?1",
        [id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
    ).unwrap()
}

#[test]
fn acquisition_persists_identity_before_any_read_or_export() {
    let state = state();
    let archive = ensure_archive(&state, "123456789").unwrap();
    let source = item(1);
    let report = insert_items(&state, archive, std::slice::from_ref(&source)).unwrap();
    assert_eq!(
        (report.inserted, report.repaired, report.skipped),
        (1, 0, 0)
    );
    assert_eq!(
        snapshot(&state, 1),
        (
            "10000106".into(),
            source.name.clone(),
            source.item_type.clone(),
            source.rank_type,
            source.time.clone(),
            source.timezone,
        )
    );
    let again = insert_items(&state, archive, &[source]).unwrap();
    assert_eq!((again.inserted, again.repaired, again.skipped), (0, 0, 1));
}

#[test]
fn unresolved_acquisition_keeps_every_source_record_and_rejects_incomplete_export() {
    let state = state();
    let archive = ensure_archive(&state, "123456789").unwrap();
    let mut pending = item(1);
    pending.name = "尚未更新元数据的物品".into();
    let mut partial = item(2);
    partial.name = "另一未知物品".into();
    partial.rank_type = 0;
    let saved = insert_items(&state, archive, &[pending, partial]).unwrap();
    assert_eq!(saved.inserted, 2);
    assert!(snapshot(&state, 1).0.is_empty());
    assert_eq!(snapshot(&state, 1).1, "尚未更新元数据的物品");
    assert_eq!(snapshot(&state, 2).3, 0);
    assert_eq!(load_items(&state, archive).unwrap().len(), 2);
    assert_eq!(
        crate::uigf::export_uigf(&state, "123456789", "test")
            .unwrap_err()
            .code,
        -8
    );
}

#[test]
fn old_blank_ids_backfill_without_changing_source_time_or_metadata() {
    let state = state();
    let archive = ensure_archive(&state, "123456789").unwrap();
    state.db.lock().unwrap().execute(
        "INSERT INTO gacha_items (id, archive_id, gacha_type, query_type, name, item_type, rank_type, time, timezone)
         VALUES (1, ?1, 301, 301, '玛薇卡', '角色', 5, '2025-01-01 22:00:00', -5)",
        [archive],
    ).unwrap();
    let before = snapshot(&state, 1);
    assert!(before.0.is_empty());
    let first = load_items(&state, archive).unwrap();
    assert_eq!(first[0].item_id, "10000106");
    let mut expected = before;
    expected.0 = "10000106".into();
    assert_eq!(snapshot(&state, 1), expected);
    load_items(&state, archive).unwrap();
    assert_eq!(snapshot(&state, 1), expected, "重复读取也不能改变时间解释");
}

#[test]
fn canonical_display_and_export_do_not_overwrite_conflicting_source_snapshot() {
    let state = state();
    let archive = ensure_archive(&state, "123456789").unwrap();
    let mut source = item(1);
    source.item_id = "10000003".into();
    source.name = "来源中的旧名称".into();
    source.item_type = "武器".into();
    source.rank_type = 4;
    insert_items(&state, archive, &[source]).unwrap();
    let before = snapshot(&state, 1);
    let displayed = load_items(&state, archive).unwrap();
    assert_eq!(displayed[0].name, "琴");
    assert_eq!(displayed[0].item_type, "角色");
    assert_eq!(displayed[0].rank_type, 5);
    let exported = crate::uigf::export_uigf(&state, "123456789", "test").unwrap();
    let json: serde_json::Value = serde_json::from_str(&exported).unwrap();
    assert_eq!(json["hk4e"][0]["list"][0]["name"], displayed[0].name);
    let reimport = crate::uigf::import_uigf(&state, &exported).unwrap();
    assert_eq!(reimport.accounts[0].skipped, 1);
    assert_eq!(snapshot(&state, 1), before);
    // 相同记录 ID 却指向另一物品时，拒绝覆盖已有身份。
    let conflict = insert_items(&state, archive, &[item(1)]).unwrap();
    assert_eq!(conflict.skipped, 1);
    assert_eq!(snapshot(&state, 1), before);
}

#[test]
fn reimport_backfills_identity_without_replacing_complete_source_time() {
    let state = state();
    let archive = ensure_archive(&state, "123456789").unwrap();
    state.db.lock().unwrap().execute(
        "INSERT INTO gacha_items (id, archive_id, gacha_type, query_type, name, item_type, rank_type, time, timezone)
         VALUES (1, ?1, 301, 301, '玛薇卡', '角色', 5, '2025-01-01 22:00:00', -5)",
        [archive],
    ).unwrap();
    let report = insert_items(&state, archive, &[item(1)]).unwrap();
    assert_eq!(
        (report.inserted, report.repaired, report.skipped),
        (0, 1, 0)
    );
    let raw = snapshot(&state, 1);
    assert_eq!(raw.0, "10000106");
    assert_eq!(raw.4, "2025-01-01 22:00:00");
    assert_eq!(raw.5, -5);
}
