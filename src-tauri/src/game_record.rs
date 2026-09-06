//! 周期挑战记录（对应原版 GameRecordClient 的 SpiralAbyss / RoleCombat / HardChallenge）。
//!
//! 请求规格与实时便签一致（XRpc + 组合 Cookie + 指纹 + webstatic Referer
//! + x-rpc-tool_verison + DS Gen2(X4)），复用 daily_note::record_spec。
//! 同样支持 1034/5003 风控验证后带 x-rpc-challenge 重试。

use crate::constants::{self, Salts};
use crate::daily_note::record_spec;
use crate::http::{self, Devices, RequestSpec};
use crate::models::{de_i32_flexible, de_i64_flexible};
use crate::response::{unwrap_envelope, ApiError, ApiResult};
use crate::store::UserRecord;
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// 持久化：官方 API 只返回近期期数，历史期由客户端按 (uid, kind, 期号) 落库保存
// （对应原版 SpiralAbyssEntry / RoleCombatEntry / HardChallengeEntry 实体）
// ---------------------------------------------------------------------------

pub fn init_tables(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS game_records (
            uid        TEXT    NOT NULL,
            kind       TEXT    NOT NULL,
            period_id  INTEGER NOT NULL,
            data       TEXT    NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (uid, kind, period_id)
        );",
    )
}

fn db_err(e: rusqlite::Error) -> ApiError {
    ApiError::retcode(-4, format!("数据库错误: {e}"))
}

/// upsert 一期记录
pub fn save_period(conn: &rusqlite::Connection, uid: &str, kind: &str, period_id: i64, data: &serde_json::Value) -> ApiResult<()> {
    let json = serde_json::to_string(data).map_err(|e| ApiError::transport(format!("序列化失败: {e}")))?;
    conn.execute(
        "INSERT INTO game_records (uid, kind, period_id, data, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(uid, kind, period_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
        rusqlite::params![uid, kind, period_id, json, crate::service::now_ms()],
    )
    .map_err(db_err)?;
    Ok(())
}

/// 读取某 uid 某玩法的全部历史期（期号倒序，最新在前）
pub fn list_periods(conn: &rusqlite::Connection, uid: &str, kind: &str) -> ApiResult<Vec<serde_json::Value>> {
    let mut stmt = conn
        .prepare("SELECT data FROM game_records WHERE uid = ?1 AND kind = ?2 ORDER BY period_id DESC")
        .map_err(db_err)?;
    let rows = stmt
        .query_map(rusqlite::params![uid, kind], |row| {
            let raw: String = row.get(0)?;
            Ok(serde_json::from_str::<serde_json::Value>(&raw).unwrap_or(serde_json::Value::Null))
        })
        .map_err(db_err)?;
    Ok(rows.filter_map(|r| r.ok()).filter(|v| !v.is_null()).collect())
}

/// 通用拉取：GameRecord 系 GET 接口，返回整个 data JSON
async fn fetch_record(
    client: &reqwest::Client,
    salts: &Salts,
    devices: &Devices,
    user: &UserRecord,
    url: String,
    xrpc_challenge: Option<&str>,
) -> ApiResult<serde_json::Value> {
    let mut spec = record_spec(user, url, reqwest::Method::GET, None)?;
    if let Some(challenge) = xrpc_challenge {
        spec = spec.with_header("x-rpc-challenge", challenge);
    }
    let resp = match http::request::<serde_json::Value>(client, salts, devices, spec).await {
        Ok(r) => r,
        Err(e) if e.code == 1034 || e.code == 5003 => {
            return Err(ApiError::retcode(e.code, "当前账号被标记风险，需要完成安全验证后重试"));
        }
        Err(e) => return Err(e),
    };
    unwrap_envelope(resp.envelope, "game_record")
}

// ---------------------------------------------------------------------------
// 深境螺旋（SpiralAbyss）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct SpiralAbyss {
    #[serde(deserialize_with = "de_i64_flexible")]
    pub schedule_id: i64,
    #[serde(deserialize_with = "de_i64_flexible")]
    pub start_time: i64,
    #[serde(deserialize_with = "de_i64_flexible")]
    pub end_time: i64,
    #[serde(deserialize_with = "de_i32_flexible")]
    pub total_battle_times: i32,
    #[serde(deserialize_with = "de_i32_flexible")]
    pub total_win_times: i32,
    pub max_floor: String,
    pub reveal_rank: Vec<AbyssRank>,
    pub defeat_rank: Vec<AbyssRank>,
    pub damage_rank: Vec<AbyssRank>,
    pub take_damage_rank: Vec<AbyssRank>,
    pub normal_skill_rank: Vec<AbyssRank>,
    pub energy_skill_rank: Vec<AbyssRank>,
    pub floors: Vec<AbyssFloor>,
    #[serde(deserialize_with = "de_i32_flexible")]
    pub total_star: i32,
    pub is_unlock: bool,
    pub is_just_skipped_floor: bool,
    pub skipped_floor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct AbyssRank {
    pub avatar_icon: String,
    #[serde(deserialize_with = "de_i32_flexible")]
    pub value: i32,
    #[serde(deserialize_with = "de_i32_flexible")]
    pub rarity: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct AbyssFloor {
    #[serde(deserialize_with = "de_i32_flexible")]
    pub index: i32,
    pub icon: String,
    pub is_unlock: bool,
    #[serde(deserialize_with = "de_i64_flexible")]
    pub settle_time: i64,
    #[serde(deserialize_with = "de_i32_flexible")]
    pub star: i32,
    #[serde(deserialize_with = "de_i32_flexible")]
    pub max_star: i32,
    pub levels: Vec<AbyssLevel>,
    pub ley_line_disorder: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct AbyssLevel {
    #[serde(deserialize_with = "de_i32_flexible")]
    pub index: i32,
    #[serde(deserialize_with = "de_i32_flexible")]
    pub star: i32,
    #[serde(deserialize_with = "de_i32_flexible")]
    pub max_star: i32,
    pub battles: Vec<AbyssBattle>,
    pub top_half_floor_monster: Option<Vec<AbyssMonster>>,
    pub bottom_half_floor_monster: Option<Vec<AbyssMonster>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct AbyssBattle {
    #[serde(deserialize_with = "de_i32_flexible")]
    pub index: i32,
    #[serde(deserialize_with = "de_i64_flexible")]
    pub timestamp: i64,
    pub avatars: Vec<AbyssAvatar>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct AbyssAvatar {
    pub icon: String,
    #[serde(deserialize_with = "de_i32_flexible")]
    pub level: i32,
    #[serde(deserialize_with = "de_i32_flexible")]
    pub rarity: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct AbyssMonster {
    pub name: String,
    pub icon: String,
    #[serde(deserialize_with = "de_i32_flexible")]
    pub level: i32,
}

/// schedule_type: 1=本期, 2=上期
pub async fn fetch_spiral_abyss(
    client: &reqwest::Client,
    salts: &Salts,
    devices: &Devices,
    user: &UserRecord,
    uid: &str,
    region: &str,
    schedule_type: u8,
    xrpc_challenge: Option<&str>,
) -> ApiResult<SpiralAbyss> {
    let url = constants::url_spiral_abyss(uid, region, user.is_oversea, schedule_type);
    let value = fetch_record(client, salts, devices, user, url, xrpc_challenge).await?;
    serde_json::from_value(value).map_err(|e| ApiError::transport(format!("spiralAbyss 解析失败: {e}")))
}

// ---------------------------------------------------------------------------
// 幻想真境剧诗（RoleCombat / Imaginarium Theater）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct RoleCombat {
    pub data: Vec<RoleCombatData>,
    pub is_unlock: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct RoleCombatData {
    pub detail: RoleCombatDetail,
    pub stat: RoleCombatStat,
    pub schedule: RoleCombatSchedule,
    pub has_data: bool,
    pub has_detail_data: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct RoleCombatDetail {
    pub rounds_data: Vec<RoleCombatRoundData>,
    pub detail_stat: Option<RoleCombatStat>,
    pub backup_avatars: Vec<TheaterAvatar>,
    /// 注意：米哈游原始字段拼写就是 fight_statisic（sic），对外序列化恢复规范拼写
    #[serde(rename(serialize = "fight_statistics", deserialize = "fight_statisic"))]
    pub fight_statistics: RoleCombatFightStatistics,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct RoleCombatStat {
    #[serde(deserialize_with = "de_i32_flexible")]
    pub difficulty_id: i32,
    #[serde(deserialize_with = "de_i32_flexible")]
    pub max_round_id: i32,
    #[serde(deserialize_with = "de_i32_flexible")]
    pub heraldry: i32,
    pub get_medal_round_list: Vec<i32>,
    #[serde(deserialize_with = "de_i32_flexible")]
    pub medal_num: i32,
    #[serde(deserialize_with = "de_i32_flexible")]
    pub coin_num: i32,
    #[serde(deserialize_with = "de_i32_flexible")]
    pub avatar_bonus_num: i32,
    #[serde(deserialize_with = "de_i32_flexible")]
    pub rent_cnt: i32,
    #[serde(deserialize_with = "de_i32_flexible")]
    pub tarot_finished_cnt: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct RoleCombatSchedule {
    #[serde(deserialize_with = "de_i64_flexible")]
    pub start_time: i64,
    #[serde(deserialize_with = "de_i64_flexible")]
    pub end_time: i64,
    #[serde(rename = "schedule_type", deserialize_with = "de_i32_flexible")]
    pub schedule_type: i32,
    #[serde(deserialize_with = "de_i64_flexible")]
    pub schedule_id: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct RoleCombatRoundData {
    pub avatars: Vec<TheaterAvatar>,
    pub choice_cards: Vec<TheaterBuff>,
    pub buffs: Vec<TheaterBuff>,
    pub is_get_medal: bool,
    #[serde(deserialize_with = "de_i32_flexible")]
    pub round_id: i32,
    #[serde(deserialize_with = "de_i64_flexible")]
    pub finish_time: i64,
    pub enemies: Vec<TheaterEnemy>,
    pub splendour_buff: Option<TheaterSplendourBuff>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct TheaterAvatar {
    pub name: String,
    /// 1=正常 2=试用 3=支援（对应 RoleCombatAvatarType）
    #[serde(deserialize_with = "de_i32_flexible")]
    pub avatar_type: i32,
    pub element: String,
    pub image: String,
    #[serde(deserialize_with = "de_i32_flexible")]
    pub level: i32,
    #[serde(deserialize_with = "de_i32_flexible")]
    pub rarity: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct TheaterBuff {
    pub icon: String,
    pub name: String,
    pub desc: String,
    pub is_enhanced: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct TheaterEnemy {
    pub name: String,
    pub icon: String,
    #[serde(deserialize_with = "de_i32_flexible")]
    pub level: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct TheaterSplendourBuff {
    pub summary: Option<TheaterSplendourSummary>,
    pub buffs: Vec<TheaterSplendourBuffItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct TheaterSplendourSummary {
    pub icon: String,
    pub name: String,
    pub desc: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct TheaterSplendourBuffItem {
    pub icon: String,
    pub name: String,
    pub desc: String,
    #[serde(deserialize_with = "de_i32_flexible")]
    pub level: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct RoleCombatFightStatistics {
    pub max_defeat_avatar: Option<TheaterStatAvatar>,
    pub max_damage_avatar: Option<TheaterStatAvatar>,
    pub max_take_damage_avatar: Option<TheaterStatAvatar>,
    pub total_coin_consumed: Option<TheaterStatAvatar>,
    pub shortest_avatar_list: Vec<TheaterStatAvatar>,
    #[serde(deserialize_with = "de_i32_flexible")]
    pub total_use_time: i32,
    pub is_show_battle_stats: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct TheaterStatAvatar {
    pub avatar_icon: String,
    /// 可能为空字符串
    pub value: String,
    #[serde(deserialize_with = "de_i32_flexible")]
    pub rarity: i32,
}

pub async fn fetch_role_combat(
    client: &reqwest::Client,
    salts: &Salts,
    devices: &Devices,
    user: &UserRecord,
    uid: &str,
    region: &str,
    xrpc_challenge: Option<&str>,
) -> ApiResult<RoleCombat> {
    let url = constants::url_role_combat(uid, region, user.is_oversea);
    let value = fetch_record(client, salts, devices, user, url, xrpc_challenge).await?;
    serde_json::from_value(value).map_err(|e| ApiError::transport(format!("role_combat 解析失败: {e}")))
}

// ---------------------------------------------------------------------------
// 幽境危战（HardChallenge）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct HardChallenge {
    pub data: Vec<HardChallengeData>,
    pub is_unlock: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct HardChallengeData {
    pub schedule: HardChallengeSchedule,
    pub single: HardChallengeEntry,
    pub mp: HardChallengeEntry,
    pub blings: Vec<BlingAvatar>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct HardChallengeSchedule {
    #[serde(deserialize_with = "de_i64_flexible")]
    pub schedule_id: i64,
    #[serde(deserialize_with = "de_i64_flexible")]
    pub start_time: i64,
    #[serde(deserialize_with = "de_i64_flexible")]
    pub end_time: i64,
    pub is_valid: bool,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct HardChallengeEntry {
    pub best: Option<HardChallengeBest>,
    pub challenge: Vec<HardChallengeChallenge>,
    pub has_data: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct HardChallengeBest {
    #[serde(deserialize_with = "de_i32_flexible")]
    pub difficulty: i32,
    #[serde(deserialize_with = "de_i32_flexible")]
    pub seconds: i32,
    pub icon: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct HardChallengeChallenge {
    pub name: String,
    #[serde(deserialize_with = "de_i32_flexible")]
    pub second: i32,
    pub teams: Vec<HcAvatar>,
    pub best_avatar: Vec<HcBestAvatar>,
    pub monster: HcMonster,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct HcAvatar {
    pub name: String,
    pub image: String,
    #[serde(deserialize_with = "de_i32_flexible")]
    pub level: i32,
    /// 实际为命座数
    #[serde(deserialize_with = "de_i32_flexible")]
    pub rank: i32,
    #[serde(deserialize_with = "de_i32_flexible")]
    pub rarity: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct HcBestAvatar {
    pub side_icon: String,
    #[serde(deserialize_with = "de_i64_flexible")]
    pub dps: i64,
    /// 1=最强一击 2=最高总伤害
    #[serde(rename(serialize = "kind", deserialize = "type"), deserialize_with = "de_i32_flexible")]
    pub kind: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct HcMonster {
    pub name: String,
    #[serde(deserialize_with = "de_i32_flexible")]
    pub level: i32,
    pub icon: String,
    pub desc: Vec<String>,
    pub tags: Vec<HcMonsterTag>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct HcMonsterTag {
    #[serde(rename(serialize = "description", deserialize = "desc"))]
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BlingAvatar {
    pub name: String,
    pub image: String,
    /// 最终是否上榜
    pub is_plus: bool,
    #[serde(deserialize_with = "de_i32_flexible")]
    pub rarity: i32,
}

pub async fn fetch_hard_challenge(
    client: &reqwest::Client,
    salts: &Salts,
    devices: &Devices,
    user: &UserRecord,
    uid: &str,
    region: &str,
    xrpc_challenge: Option<&str>,
) -> ApiResult<HardChallenge> {
    let url = constants::url_hard_challenge(uid, region, user.is_oversea);
    let value = fetch_record(client, salts, devices, user, url, xrpc_challenge).await?;
    serde_json::from_value(value).map_err(|e| ApiError::transport(format!("hard_challenge 解析失败: {e}")))
}
