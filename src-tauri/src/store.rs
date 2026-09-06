//! SQLite 持久化（对应原版 users 表：三组 Cookie + 时间戳 + 基本信息）。

use crate::cookie::Cookie;
use crate::models::GameRole;
use rusqlite::{params, Connection, OptionalExtension};

#[derive(Debug, Clone)]
pub struct UserRecord {
    pub id: i64,
    pub aid: String,
    pub mid: String,
    pub is_oversea: bool,
    pub stoken: Cookie,
    pub ltoken: Option<Cookie>,
    pub cookie_token: Option<Cookie>,
    pub fingerprint: Option<String>,
    /// unix 毫秒
    pub cookie_token_updated_at: i64,
    pub fingerprint_updated_at: i64,
    pub nickname: Option<String>,
    pub uid: Option<String>,
    pub avatar: Option<String>,
    pub game_roles: Vec<GameRole>,
}

impl UserRecord {
    pub fn stoken(&self) -> &Cookie {
        &self.stoken
    }

    /// 拼接三组凭证为完整 Cookie 字符串（对应原版 UserViewModel.CopyCookieCommand）
    pub fn full_cookie_string(&self) -> String {
        let mut parts: Vec<String> = Vec::new();
        if !self.stoken.is_empty() {
            parts.push(self.stoken.to_string());
        }
        if let Some(c) = &self.ltoken {
            parts.push(c.to_string());
        }
        if let Some(c) = &self.cookie_token {
            parts.push(c.to_string());
        }
        parts.join(";")
    }

    #[allow(dead_code)]
    pub fn stoken_value(&self) -> Option<&String> {
        self.stoken.get(crate::cookie::STOKEN)
    }
}

pub fn init(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS users (
            id                       INTEGER PRIMARY KEY AUTOINCREMENT,
            aid                      TEXT    NOT NULL DEFAULT '',
            mid                      TEXT    NOT NULL UNIQUE,
            is_oversea               INTEGER NOT NULL DEFAULT 0,
            stoken                   TEXT    NOT NULL,
            ltoken                   TEXT,
            cookie_token             TEXT,
            fingerprint              TEXT,
            cookie_token_updated_at  INTEGER NOT NULL DEFAULT 0,
            fingerprint_updated_at   INTEGER NOT NULL DEFAULT 0,
            nickname                 TEXT,
            uid                      TEXT,
            avatar                   TEXT,
            game_roles               TEXT    NOT NULL DEFAULT '[]',
            created_at               INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
        );
        CREATE TABLE IF NOT EXISTS meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );",
    )?;
    // 旧库迁移：v0.1 前的表没有 avatar 列
    let _ = conn.execute_batch("ALTER TABLE users ADD COLUMN avatar TEXT;");
    Ok(())
}

/// 读取 meta 键值（设备标识等跨启动持久数据）
pub fn meta_get(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| row.get(0))
        .ok()
}

pub fn meta_set(conn: &Connection, key: &str, value: &str) {
    let _ = conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    );
}

fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<UserRecord> {
    let stoken_raw: String = row.get("stoken")?;
    let ltoken_raw: Option<String> = row.get("ltoken")?;
    let cookie_token_raw: Option<String> = row.get("cookie_token")?;
    let roles_raw: String = row.get("game_roles")?;
    Ok(UserRecord {
        id: row.get("id")?,
        aid: row.get("aid")?,
        mid: row.get("mid")?,
        is_oversea: row.get::<_, i64>("is_oversea")? != 0,
        stoken: Cookie::parse(&stoken_raw),
        ltoken: ltoken_raw.map(|s| Cookie::parse(&s)),
        cookie_token: cookie_token_raw.map(|s| Cookie::parse(&s)),
        fingerprint: row.get("fingerprint")?,
        cookie_token_updated_at: row.get("cookie_token_updated_at")?,
        fingerprint_updated_at: row.get("fingerprint_updated_at")?,
        nickname: row.get("nickname")?,
        uid: row.get("uid")?,
        avatar: row.get("avatar")?,
        game_roles: serde_json::from_str(&roles_raw).unwrap_or_default(),
    })
}

static COLS: &str = "id, aid, mid, is_oversea, stoken, ltoken, cookie_token, fingerprint, cookie_token_updated_at, fingerprint_updated_at, nickname, uid, avatar, game_roles";

pub fn list(conn: &Connection) -> rusqlite::Result<Vec<UserRecord>> {
    let mut stmt = conn.prepare(&format!("SELECT {COLS} FROM users ORDER BY id"))?;
    let rows = stmt.query_map([], |row| row_to_record(row))?;
    rows.collect()
}

pub fn find_by_mid(conn: &Connection, mid: &str) -> rusqlite::Result<Option<UserRecord>> {
    let mut stmt = conn.prepare(&format!("SELECT {COLS} FROM users WHERE mid = ?1"))?;
    stmt.query_row([mid], |row| row_to_record(row)).optional()
}

/// 按 mid 插入或更新，返回行 id
pub fn upsert(conn: &Connection, rec: &UserRecord) -> rusqlite::Result<i64> {
    let roles = serde_json::to_string(&rec.game_roles).unwrap_or_else(|_| "[]".into());
    if let Some(existing) = find_by_mid(conn, &rec.mid)? {
        conn.execute(
            "UPDATE users SET aid=?1, is_oversea=?2, stoken=?3, ltoken=?4, cookie_token=?5,
             fingerprint=?6, cookie_token_updated_at=?7, fingerprint_updated_at=?8,
             nickname=?9, uid=?10, avatar=?11, game_roles=?12 WHERE id=?13",
            params![
                rec.aid,
                rec.is_oversea as i64,
                rec.stoken.to_string(),
                rec.ltoken.as_ref().map(|c| c.to_string()),
                rec.cookie_token.as_ref().map(|c| c.to_string()),
                rec.fingerprint,
                rec.cookie_token_updated_at,
                rec.fingerprint_updated_at,
                rec.nickname,
                rec.uid,
                rec.avatar,
                roles,
                existing.id,
            ],
        )?;
        Ok(existing.id)
    } else {
        conn.execute(
            "INSERT INTO users (aid, mid, is_oversea, stoken, ltoken, cookie_token, fingerprint,
             cookie_token_updated_at, fingerprint_updated_at, nickname, uid, avatar, game_roles)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                rec.aid,
                rec.mid,
                rec.is_oversea as i64,
                rec.stoken.to_string(),
                rec.ltoken.as_ref().map(|c| c.to_string()),
                rec.cookie_token.as_ref().map(|c| c.to_string()),
                rec.fingerprint,
                rec.cookie_token_updated_at,
                rec.fingerprint_updated_at,
                rec.nickname,
                rec.uid,
                rec.avatar,
                roles,
            ],
        )?;
        Ok(conn.last_insert_rowid())
    }
}

pub fn delete(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM users WHERE id = ?1", [id])?;
    Ok(())
}
