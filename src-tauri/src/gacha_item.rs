//! 祈愿物品身份解析：获取、导入、存档读取共用，与 UIGF 文件格式无关。

use std::collections::HashMap;
use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolutionStatus {
    Known,
    UnknownId,
    MissingId,
    Ambiguous,
    InvalidId,
    Conflict,
}

#[derive(Debug, Clone)]
pub struct ResolvedItem {
    pub item_id: String,
    pub name: String,
    pub item_type: String,
    pub rank_type: i32,
    pub status: ResolutionStatus,
}

impl ResolvedItem {
    pub fn is_complete(&self) -> bool {
        complete_fields(&self.item_id, &self.name, &self.item_type, self.rank_type)
    }
}

pub fn complete_fields(item_id: &str, name: &str, kind: &str, rank: i32) -> bool {
    valid_id(item_id) && !name.is_empty() && !kind.is_empty() && (3..=5).contains(&rank)
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.bytes().all(|byte| byte.is_ascii_digit())
        && id.parse::<u64>().is_ok_and(|id| id > 0)
}

struct ItemCatalog {
    by_id: HashMap<String, (String, String, i32)>,
    by_name: HashMap<String, Vec<String>>,
}

impl ItemCatalog {
    fn new(by_id: HashMap<String, (String, String, i32)>) -> Self {
        let mut by_name: HashMap<String, Vec<String>> = HashMap::new();
        for (id, (name, _, _)) in &by_id {
            by_name.entry(name.clone()).or_default().push(id.clone());
        }
        Self { by_id, by_name }
    }

    fn resolve(&self, item_id: &str, name: &str, kind: &str, rank: i32) -> ResolvedItem {
        let mut result = ResolvedItem {
            item_id: item_id.into(),
            name: name.into(),
            item_type: kind.into(),
            rank_type: rank,
            status: ResolutionStatus::MissingId,
        };
        if !item_id.is_empty() {
            if !valid_id(item_id) {
                result.status = ResolutionStatus::InvalidId;
                return result;
            }
            result.status = ResolutionStatus::UnknownId;
        } else if let Some(ids) = self.by_name.get(name) {
            // 类型区分同名角色/武器，星级辅助校验；只接受唯一结果。
            let mut candidates = ids.iter().filter(|id| {
                let (_, candidate_kind, candidate_rank) = &self.by_id[*id];
                (kind.is_empty() || kind == candidate_kind)
                    && (rank == 0 || rank == *candidate_rank)
            });
            if let Some(id) = candidates.next() {
                if candidates.next().is_some() {
                    result.status = ResolutionStatus::Ambiguous;
                    return result;
                }
                result.item_id.clone_from(id);
            }
        }
        if let Some((canonical_name, canonical_kind, canonical_rank)) =
            self.by_id.get(&result.item_id)
        {
            result.status = if (!name.is_empty() && name != canonical_name)
                || (!kind.is_empty() && kind != canonical_kind)
                || (rank != 0 && rank != *canonical_rank)
            {
                ResolutionStatus::Conflict
            } else {
                ResolutionStatus::Known
            };
            result.name.clone_from(canonical_name);
            result.item_type.clone_from(canonical_kind);
            result.rank_type = *canonical_rank;
        }
        result
    }
}

fn catalog() -> &'static ItemCatalog {
    static CATALOG: OnceLock<ItemCatalog> = OnceLock::new();
    CATALOG.get_or_init(|| {
        let metadata =
            serde_json::from_str(include_str!("data/item_meta.json")).unwrap_or_else(|error| {
                log::error!("[gacha-item] 内置物品元数据解析失败: {error}");
                HashMap::new()
            });
        ItemCatalog::new(metadata)
    })
}

pub fn resolve(item_id: &str, name: &str, kind: &str, rank: i32) -> ResolvedItem {
    catalog().resolve(item_id, name, kind, rank)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog() -> ItemCatalog {
        ItemCatalog::new(HashMap::from([
            ("1".into(), ("同名".into(), "角色".into(), 5)),
            ("2".into(), ("同名".into(), "武器".into(), 4)),
            ("3".into(), ("重名".into(), "武器".into(), 3)),
            ("4".into(), ("重名".into(), "武器".into(), 3)),
        ]))
    }

    #[test]
    fn reverse_lookup_requires_one_candidate_and_checks_type_and_rank() {
        let catalog = catalog();
        let resolved = catalog.resolve("", "同名", "角色", 5);
        assert_eq!(resolved.item_id, "1");
        assert_eq!(resolved.status, ResolutionStatus::Known);
        assert_eq!(
            catalog.resolve("", "同名", "", 0).status,
            ResolutionStatus::Ambiguous
        );
        assert_eq!(
            catalog.resolve("", "重名", "武器", 3).status,
            ResolutionStatus::Ambiguous
        );
        assert_eq!(
            catalog.resolve("", "同名", "角色", 4).status,
            ResolutionStatus::MissingId
        );
        assert!(!catalog.resolve("", "不存在", "角色", 5).is_complete());
    }

    #[test]
    fn explicit_id_wins_and_conflicting_source_fields_are_reported() {
        let resolved = catalog().resolve("1", "旧名称", "武器", 4);
        assert_eq!(resolved.item_id, "1");
        assert_eq!(resolved.name, "同名");
        assert_eq!(resolved.item_type, "角色");
        assert_eq!(resolved.rank_type, 5);
        assert_eq!(resolved.status, ResolutionStatus::Conflict);
    }

    #[test]
    fn unknown_ids_keep_source_fields_and_missing_ids_can_resolve_after_metadata_update() {
        let original = catalog().resolve("99", "新物品", "角色", 5);
        assert_eq!(original.status, ResolutionStatus::UnknownId);
        assert!(original.is_complete());
        assert_eq!(original.name, "新物品");
        assert_eq!(
            catalog().resolve("", "新物品", "角色", 5).status,
            ResolutionStatus::MissingId
        );
        let updated = ItemCatalog::new(HashMap::from([(
            "99".into(),
            ("新物品".into(), "角色".into(), 5),
        )]));
        assert_eq!(updated.resolve("", "新物品", "角色", 5).item_id, "99");
        assert_eq!(
            updated.resolve("99", "", "", 0).status,
            ResolutionStatus::Known
        );
        for invalid in ["0", "-1", "not-an-id"] {
            assert!(!updated.resolve(invalid, "新物品", "角色", 5).is_complete());
        }
    }
}
