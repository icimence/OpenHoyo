//! 首页公开内容：当期祈愿使用内置公告元数据，游戏公告走统一 HTTP 层。
use crate::http::{self, Profile, RequestSpec};
use crate::response::{unwrap_envelope, ApiError, ApiResult};
use crate::state::{salts, AppState};
use serde::Serialize;
use serde_json::Value;
use tauri::State;

#[derive(Debug, Serialize)]
pub struct HomePool {
    gacha_type: i32,
    name: String,
    version: String,
    end_time: i64,
    names: Vec<String>,
}

fn active_pools(now: i64) -> Vec<HomePool> {
    crate::gacha_events::events()
        .iter()
        .filter(|e| matches!(e.gacha_type, 301 | 400 | 302))
        .filter_map(|e| {
            let from = chrono::DateTime::parse_from_rfc3339(&e.from)
                .ok()?
                .timestamp();
            let to = chrono::DateTime::parse_from_rfc3339(&e.to)
                .ok()?
                .timestamp();
            (from <= now && now <= to).then(|| HomePool {
                gacha_type: e.gacha_type,
                name: e.name.clone(),
                version: e.version.clone(),
                end_time: to,
                names: e
                    .up_orange
                    .iter()
                    .filter_map(|id| crate::gacha_events::item_name(*id).map(str::to_owned))
                    .collect(),
            })
        })
        .collect()
}

#[derive(Debug, Serialize)]
pub struct HomeAnnouncement {
    id: String,
    title: String,
    category: String,
    date: String,
}

#[derive(Serialize)]
pub struct HomeFeed {
    pools: Vec<HomePool>,
    announcements: Vec<HomeAnnouncement>,
    announcement_error: Option<ApiError>,
}

fn announcement_url(oversea: bool, content: bool) -> String {
    let (host, biz, region) = if oversea {
        ("sg-hk4e-api.hoyoverse.com", "hk4e_global", "os_usa")
    } else {
        ("hk4e-ann-api.mihoyo.com", "hk4e_cn", "cn_gf01")
    };
    let method = if content {
        "getAnnContent"
    } else {
        "getAnnList"
    };
    // 无 level 时正文接口只返回基础 FAQ，无法匹配活动公告；与游戏公告公开入口一致。
    format!("https://{host}/common/{biz}/announcement/api/{method}?game=hk4e&game_biz={biz}&lang=zh-cn&bundle_id={biz}&platform=pc&region={region}&level=55&uid=100000000")
}

fn parse_announcements(data: &Value) -> Vec<HomeAnnouncement> {
    let mut result = Vec::new();
    for group in data["list"].as_array().into_iter().flatten() {
        for item in group["list"].as_array().into_iter().flatten() {
            let id = item["ann_id"]
                .as_str()
                .map(str::to_owned)
                .or_else(|| item["ann_id"].as_i64().map(|id| id.to_string()));
            let title = item["title"].as_str().unwrap_or("");
            if let Some(id) = id.filter(|_| !title.trim().is_empty()) {
                if result.iter().any(|a: &HomeAnnouncement| a.id == id) {
                    continue;
                }
                result.push(HomeAnnouncement {
                    id,
                    title: title.to_string(),
                    category: item["tag_label"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .unwrap_or("公告")
                        .to_string(),
                    date: item["start_time"].as_str().unwrap_or("").to_string(),
                });
            }
        }
    }
    result.sort_by(|a, b| b.date.cmp(&a.date));
    result.truncate(20);
    result
}

#[tauri::command]
pub async fn home_feed(state: State<'_, AppState>, is_oversea: bool) -> ApiResult<HomeFeed> {
    log::info!("[home] 加载公开内容（oversea={is_oversea}）");
    let salts = salts(&state).await;
    let response = http::request::<Value>(
        &state.http,
        &salts,
        &state.devices,
        RequestSpec::get(announcement_url(is_oversea, false), Profile::Public),
    )
    .await;
    let (announcements, announcement_error) =
        match response.and_then(|r| unwrap_envelope(r.envelope, "游戏公告")) {
            Ok(data) => (parse_announcements(&data), None),
            Err(e) => {
                log::warn!(
                    "[home] 公告加载失败 retcode={} message={}",
                    e.code,
                    e.message
                );
                (Vec::new(), Some(e))
            }
        };
    // 国服元数据不能套用到国际服的祈愿时间。
    let pools = if is_oversea {
        Vec::new()
    } else {
        active_pools(chrono::Utc::now().timestamp())
    };
    log::info!(
        "[home] 公开内容就绪（卡池={}，公告={}）",
        pools.len(),
        announcements.len()
    );
    Ok(HomeFeed {
        pools,
        announcements,
        announcement_error,
    })
}

#[tauri::command]
pub async fn home_announcement(
    state: State<'_, AppState>,
    is_oversea: bool,
    announcement_id: String,
) -> ApiResult<String> {
    log::info!("[home] 获取公告正文（oversea={is_oversea}）");
    let result = async {
        let salts = salts(&state).await;
        let response = http::request::<Value>(
            &state.http,
            &salts,
            &state.devices,
            RequestSpec::get(announcement_url(is_oversea, true), Profile::Public),
        )
        .await?;
        let data = unwrap_envelope(response.envelope, "公告正文")?;
        data["list"]
            .as_array()
            .into_iter()
            .flatten()
            .find_map(|item| {
                let id = item["ann_id"]
                    .as_str()
                    .map(str::to_owned)
                    .or_else(|| item["ann_id"].as_i64().map(|id| id.to_string()));
                (id.as_deref() == Some(announcement_id.as_str()))
                    .then(|| item["content"].as_str().map(str::to_owned))
                    .flatten()
            })
            .ok_or_else(|| ApiError::empty_data("公告正文已下架，请刷新公告列表"))
    }
    .await;
    match &result {
        Ok(_) => log::info!("[home] 公告正文加载成功"),
        Err(e) => log::warn!(
            "[home] 公告正文失败 retcode={} message={}",
            e.code,
            e.message
        ),
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pools_only_use_the_active_window() {
        let event = crate::gacha_events::events()
            .iter()
            .find(|e| e.gacha_type == 301)
            .unwrap();
        let start = chrono::DateTime::parse_from_rfc3339(&event.from)
            .unwrap()
            .timestamp();
        let pools = active_pools(start);
        assert!(pools.iter().any(|p| p.name == event.name));
        let weapon = pools
            .iter()
            .find(|p| p.gacha_type == 302)
            .expect("当期武器池必须与角色池一起返回");
        assert_eq!(weapon.names.len(), 2, "武器池应展示双 UP 五星");
        assert!(pools
            .iter()
            .all(|p| p.end_time >= start && !p.names.is_empty()));
        assert!(active_pools(0).is_empty());
    }
    #[test]
    fn announcement_ids_accept_strings_and_numbers_and_deduplicate() {
        let value = serde_json::json!({"list":[{"list":[{"ann_id":1,"title":"公告","start_time":"2026-10-25"},{"ann_id":"1","title":"重复"},{"ann_id":"2","title":"活动"},{"ann_id":3,"title":""}]}]});
        let anns = parse_announcements(&value);
        assert_eq!(anns.len(), 2);
        assert_eq!(anns[0].id, "1");
    }
}
