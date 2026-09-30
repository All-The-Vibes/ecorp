use crony_domain::{HistoryFilters, HistoryKind};
use serde::Deserialize;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HistoryQuery {
    pub actor_id: Uuid,
    #[serde(default)]
    pub kind: HistoryKind,
    pub room_id: Option<Uuid>,
    pub mission_id: Option<Uuid>,
    pub attributed_actor_id: Option<Uuid>,
    pub record_id: Option<Uuid>,
    pub status: Option<String>,
    #[serde(default)]
    pub search: String,
    pub cursor: Option<String>,
    #[serde(default = "default_page_size")]
    pub page_size: u32,
}

const fn default_page_size() -> u32 {
    25
}

impl HistoryQuery {
    pub fn filters(&self) -> HistoryFilters {
        HistoryFilters {
            kind: self.kind,
            room_id: self.room_id,
            mission_id: self.mission_id,
            attributed_actor_id: self.attributed_actor_id,
            record_id: self.record_id,
            status: self.status.clone(),
            search: self.search.clone(),
        }
    }
}
