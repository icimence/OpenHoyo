//! 祈愿记录解析、拉取与真机链路测试。

use super::*;

mod tests {
    use super::*;

    #[test]
    fn gacha_url_matches_new_and_old_event_suffix() {
        // 新版哈希后缀（2.52+ 缓存实测）与旧版 -v3 两种形态都要命中
        let old = b"junk\0https://webstatic.mihoyo.com/hk4e/event/e20190909gacha-v3/index.html?auth_appid=webview_gacha&lang=zh-cn&old=1\0tail";
        let new = b"junk\0https://webstatic.mihoyo.com/hk4e/event/e20190909gacha-df01aea2/index.html?win_mode=fullscreen&auth_appid=webview_gacha&init_type=301\0tail";
        assert_eq!(
            match_gacha_url_bytes(old).as_deref(),
            Some("https://webstatic.mihoyo.com/hk4e/event/e20190909gacha-v3/index.html?auth_appid=webview_gacha&lang=zh-cn&old=1")
        );
        assert!(match_gacha_url_bytes(new)
            .as_deref()
            .unwrap()
            .starts_with("https://webstatic.mihoyo.com/hk4e/event/e20190909gacha-df01aea2/index.html?win_mode=fullscreen"));
    }

    #[test]
    fn gacha_url_ignores_resource_urls_and_takes_last() {
        // 静态资源 URL（css/js）含相同事件名但无 /index.html?，必须被忽略；
        // 多个命中时取最后一个（对应原版 LastIndexOf）
        let bytes = b"css https://webstatic.mihoyo.com/hk4e/event/e20190909gacha-df01aea2/1_8338b8e48022f6cb6f85.css\0\
                      first https://webstatic.mihoyo.com/hk4e/event/e20190909gacha-v3/index.html?auth_appid=webview_gacha&first=1\0\
                      js https://webstatic.mihoyo.com/hk4e/event/e20190909gacha-df01aea2/bundle_7af5ae760bffe15a194d.js\0\
                      last https://webstatic.mihoyo.com/hk4e/event/e20190909gacha-df01aea2/index.html?auth_appid=webview_gacha&last=1\0end";
        assert_eq!(
            match_gacha_url_bytes(bytes).as_deref(),
            Some("https://webstatic.mihoyo.com/hk4e/event/e20190909gacha-df01aea2/index.html?auth_appid=webview_gacha&last=1")
        );
    }

    #[test]
    fn gacha_url_overseas_prefix() {
        let bytes = b"\0https://gs.hoyoverse.com/genshin/event/e20190909gacha-df01aea2/index.html?auth_appid=webview_gacha&os=1\0";
        assert_eq!(
            match_gacha_url_bytes(bytes).as_deref(),
            Some("https://gs.hoyoverse.com/genshin/event/e20190909gacha-df01aea2/index.html?auth_appid=webview_gacha&os=1")
        );
    }

    #[test]
    fn unity_log_path_extraction() {
        // 真实日志形态：路径含空格、正斜杠；行内最后一个盘符为路径起点
        let content = "[Subsystems] Discovering subsystems at path E:/Program Files/miHoYo Launcher/games/Genshin Impact Game/YuanShen_Data/UnitySubsystems\n\
                       [Line 2] something else";
        let pos = ascii_find_ci(content, "YuanShen_Data").unwrap();
        assert_eq!(
            path_prefix_before_marker(content, pos),
            Some("E:/Program Files/miHoYo Launcher/games/Genshin Impact Game")
        );
    }

    #[test]
    fn unity_log_path_prefers_last_drive_letter_on_line() {
        // 同一行出现两个盘符时取离 marker 最近的一个
        let content = "compare D:/old/path with E:\\Games\\YuanShen_Data/data.unity3d";
        let pos = ascii_find_ci(content, "YuanShen_Data").unwrap();
        assert_eq!(path_prefix_before_marker(content, pos), Some("E:\\Games"));
    }
}

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
        let role = user
            .game_roles
            .iter()
            .find(|r| r.game_biz.contains("hk4e_cn"))
            .unwrap();
        println!(
            "测试用户: {} ({})",
            user.nickname.clone().unwrap_or_default(),
            role.game_uid
        );

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
        assert_eq!(
            resp.envelope.retcode, 0,
            "getGachaLog 返回错误: {}",
            resp.envelope.message
        );
        let page = resp.envelope.data.expect("响应缺少 data");
        assert!(!page.list.is_empty(), "返回列表为空");
        println!(
            "[2/4] getGachaLog 解析成功，本页 {} 条，示例：",
            page.list.len()
        );
        for item in page.list.iter().take(3) {
            println!(
                "      {} | {} | rank={} | gacha_type={} | id={}",
                item.time, item.name, item.rank_type, item.gacha_type, item.id
            );
        }
        assert!(
            (3..=5).contains(&page.list[0].rank_type),
            "rank_type 解析异常"
        );
        assert!(page.list[0].id > 0, "id 解析异常");

        // ③ 用完整真实数据验证统计与 UP/歪判定
        let uid = page.list[0].uid.clone();
        let archive_id = ensure_archive(&state, &uid).expect("创建存档失败");
        let full = load_items(&state, archive_id).expect("读取失败");
        let stats = crate::gacha_stats::build_statistics(&uid, &full);
        println!(
            "[3/5] 统计构建成功：总 {} 抽，角色池 {} 抽（五星 {} 个），武器池五星 {} 个",
            stats.total_count,
            stats.avatar_wish.total_count,
            stats.avatar_wish.total_orange,
            stats.weapon_wish.total_orange
        );

        let aw = &stats.avatar_wish;
        let ww = &stats.weapon_wish;
        assert_eq!(
            aw.total_up_orange + aw.total_lost_orange,
            aw.total_orange,
            "角色池 UP+歪 应等于五星总数"
        );
        assert_eq!(
            ww.total_up_orange + ww.total_lost_orange,
            ww.total_orange,
            "武器池 UP+歪 应等于五星总数"
        );
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
            if aw.guaranteed {
                "大保底"
            } else {
                "小保底"
            },
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
            conn.execute(
                "DELETE FROM gacha_items WHERE archive_id = ?1",
                [archive_id],
            )
            .expect("清空临时存档失败");
        }
        insert_items(&state, archive_id, &page.list).expect("写入失败");
        insert_items(&state, archive_id, &page.list).expect("重复写入应被忽略");
        let stored = load_items(&state, archive_id).expect("读取失败");
        assert_eq!(stored.len(), page.list.len(), "INSERT OR IGNORE 去重失败");
        println!(
            "[5/5] 存储往返成功：写入 {} 条（重复写入被正确忽略）",
            stored.len()
        );

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
        let role = user
            .game_roles
            .iter()
            .find(|r| r.game_biz.contains("hk4e_cn"))
            .unwrap();

        let query = build_query_from_stoken(&state, &salts, user, role)
            .await
            .expect("genAuthKey 失败");

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
            assert_eq!(
                resp.envelope.retcode, 0,
                "种子拉取错误: {}",
                resp.envelope.message
            );
            let Some(page) = resp.envelope.data else {
                continue;
            };
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
            before
                .iter()
                .fold(std::collections::HashMap::new(), |mut m, i| {
                    *m.entry(i.query_type).or_insert(0) += 1;
                    m
                });
        let max_before: std::collections::HashMap<i32, i64> =
            before
                .iter()
                .fold(std::collections::HashMap::new(), |mut m, i| {
                    let e = m.entry(i.query_type).or_insert(0);
                    if i.id > *e {
                        *e = i.id;
                    }
                    m
                });
        println!(
            "种子完成：{:?} 条，各类型上界 {:?}",
            count_before, max_before
        );

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
            assert!(seen.insert(item.id), "出现重复记录 id={}", item.id);
        }

        // ---- 断言：不漏（旧数据全保留；新增恰为 id > 种子上界的部分）----
        let count_after: std::collections::HashMap<i32, usize> =
            after
                .iter()
                .fold(std::collections::HashMap::new(), |mut m, i| {
                    *m.entry(i.query_type).or_insert(0) += 1;
                    m
                });
        let new_items: std::collections::HashMap<i32, usize> =
            after
                .iter()
                .fold(std::collections::HashMap::new(), |mut m, i| {
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

    /// 真机验证网页缓存链路：Unity 日志定位游戏目录 → 各版本 data_2 → 提取祈愿 URL。
    /// 前置：本机装有原神且游戏内打开过一次祈愿记录页。
    /// 运行：cargo test web_cache_real_machine -- --ignored --nocapture
    #[test]
    #[ignore = "需要本机安装原神并打开过祈愿记录页"]
    fn web_cache_real_machine() {
        let candidates = game_dir_candidates();
        assert!(
            !candidates.is_empty(),
            "未能定位游戏目录（Unity 日志与注册表均无结果）"
        );
        for (dir, data_folder) in &candidates {
            println!("候选游戏目录: {} ({data_folder})", dir.display());
            for f in cache_files_newest_first(&dir.join(data_folder).join("webCaches")) {
                match std::fs::read(&f) {
                    Ok(b) => {
                        let hit = match_gacha_url_bytes(&b);
                        println!(
                            "  {} ({} 字节) → {:?}",
                            f.display(),
                            b.len(),
                            hit.as_deref().map(|s| &s[..s.len().min(40)])
                        );
                    }
                    Err(e) => println!("  {} 读取失败: {e}", f.display()),
                }
            }
        }

        let url = extract_gacha_url_from_web_cache().expect("网页缓存中未找到祈愿 URL");
        let query = build_query_from_web_cache().expect("URL 解析失败");
        assert!(url.contains("index.html"), "URL 缺少 index.html: {url}");
        assert!(
            query.contains("auth_appid=webview_gacha"),
            "query 缺少 auth_appid: {query}"
        );
        let redacted: String = query.chars().take(80).collect();
        println!("✓ 网页缓存链路通过，query 前 80 字符: {redacted}...");
    }
}
