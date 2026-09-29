//! Read-only, authorized keyset history. Cursors are positions, never capabilities.
use super::*;
use chrono::DateTime;
use crony_domain::{
    HISTORY_EVENT_TYPES, HistoryEntry, HistoryFilters, HistoryKind, HistoryPage,
    history_event_summary, history_label,
};

const MAX_CURSOR_BYTES: usize = 4096;
const CURSOR_LIFETIME_MINUTES: i64 = 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistoryReadError {
    InvalidQuery,
    InvalidCursor,
    Unavailable,
}

impl std::fmt::Display for HistoryReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::InvalidQuery => "Invalid history filters or page size.",
            Self::InvalidCursor => "History cursor expired or invalid. Refresh the search.",
            Self::Unavailable => "History scope or record is unavailable.",
        })
    }
}
impl std::error::Error for HistoryReadError {}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Position {
    Entity { created_at: DateTime<Utc>, id: Uuid },
    Event { seq: i64 },
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    version: u8,
    query: String,
    observed_at: DateTime<Utc>,
    upper_seq: Option<i64>,
    after: Position,
}

impl Cursor {
    fn decode(raw: &str, query: &str, kind: HistoryKind, now: DateTime<Utc>) -> Result<Self> {
        if raw.is_empty() || raw.len() > MAX_CURSOR_BYTES {
            return Err(HistoryReadError::InvalidCursor.into());
        }
        let invalid = || HistoryReadError::InvalidCursor;
        let bytes = hex::decode(raw).map_err(|_| invalid())?;
        let cursor: Self = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
        if cursor.version != 1
            || cursor.query != query
            || cursor.observed_at > now
            || now - cursor.observed_at > Duration::minutes(CURSOR_LIFETIME_MINUTES)
        {
            return Err(invalid().into());
        }
        match (&cursor.after, kind) {
            (Position::Event { seq }, HistoryKind::Event)
                if *seq > 0 && cursor.upper_seq.is_some_and(|upper| upper >= *seq) => {}
            (Position::Entity { created_at, id }, kind)
                if kind != HistoryKind::Event
                    && !id.is_nil()
                    && *created_at <= cursor.observed_at
                    && cursor.upper_seq.is_none() => {}
            _ => return Err(invalid().into()),
        }
        Ok(cursor)
    }

    fn encode(&self) -> Result<String> {
        Ok(hex::encode(serde_json::to_vec(self)?))
    }
}

impl PgStore {
    /// Each page has its own repeatable-read snapshot and current authorization.
    /// Separate pages are intentionally not a frozen export: changes to status,
    /// membership and late commits require a fresh first page. No payload is read.
    pub async fn history_page(
        &self,
        corp_id: Uuid,
        viewer_actor_id: Uuid,
        filters: HistoryFilters,
        page_size: u32,
        cursor: Option<&str>,
    ) -> Result<HistoryPage> {
        let filters = filters.normalize().ok_or(HistoryReadError::InvalidQuery)?;
        if !(1..=100).contains(&page_size) || corp_id.is_nil() || viewer_actor_id.is_nil() {
            return Err(HistoryReadError::InvalidQuery.into());
        }
        let query = hex::encode(Sha256::digest(serde_json::to_vec(&(
            corp_id,
            viewer_actor_id,
            &filters,
            page_size,
        ))?));
        let mut tx = self.pool.begin().await?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
            .execute(&mut *tx)
            .await?;
        sqlx::query("SET LOCAL statement_timeout = '5s'")
            .execute(&mut *tx)
            .await?;
        let now: DateTime<Utc> = sqlx::query_scalar("SELECT transaction_timestamp()")
            .fetch_one(&mut *tx)
            .await?;
        // The store independently rechecks the human Read role. A stale API
        // authorization, a forged actor UUID or a cursor cannot confer access.
        let allowed: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM actors WHERE corp_id=$1 AND id=$2
             AND kind='human' AND role IN ('owner','admin','manager','member','guest','spectator'))",
        ).bind(corp_id).bind(viewer_actor_id).fetch_one(&mut *tx).await?;
        if !allowed {
            return Err(HistoryReadError::Unavailable.into());
        }
        // An explicit missing/revoked room or mission is never broadened to all.
        let scope_exists: bool = sqlx::query_scalar(
            "SELECT
              ($3::uuid IS NULL OR EXISTS(
                SELECT 1 FROM rooms r JOIN room_memberships rm ON rm.room_id=r.id
                WHERE r.corp_id=$1 AND r.id=$3 AND rm.actor_id=$2))
              AND ($4::uuid IS NULL OR EXISTS(
                SELECT 1 FROM missions m
                JOIN rooms r ON r.id=m.room_id AND r.corp_id=m.corp_id
                JOIN room_memberships rm ON rm.room_id=r.id AND rm.actor_id=$2
                WHERE m.corp_id=$1 AND m.id=$4 AND ($3::uuid IS NULL OR m.room_id=$3)))",
        )
        .bind(corp_id)
        .bind(viewer_actor_id)
        .bind(filters.room_id)
        .bind(filters.mission_id)
        .fetch_one(&mut *tx)
        .await?;
        if !scope_exists {
            return Err(HistoryReadError::Unavailable.into());
        }
        let cursor = cursor
            .map(|raw| Cursor::decode(raw, &query, filters.kind, now))
            .transpose()?;
        let observed_at = cursor.as_ref().map_or(now, |c| c.observed_at);
        let upper_seq = cursor
            .as_ref()
            .and_then(|c| c.upper_seq)
            .unwrap_or(i64::MAX);
        let (after_seq, after_time, after_id) = match cursor.as_ref().map(|c| &c.after) {
            Some(Position::Event { seq }) => (Some(*seq), None, None),
            Some(Position::Entity { created_at, id }) => (None, Some(*created_at), Some(*id)),
            None => (None, None, None),
        };
        let rows = sqlx::query(include_str!("history.sql"))
            .bind(corp_id)
            .bind(viewer_actor_id)
            .bind(filters.kind.as_str())
            .bind(filters.room_id)
            .bind(filters.mission_id)
            .bind(filters.attributed_actor_id)
            .bind(filters.record_id)
            .bind(&filters.status)
            .bind(&filters.search)
            .bind(observed_at)
            .bind(upper_seq)
            .bind(after_seq)
            .bind(after_time)
            .bind(after_id)
            .bind(i64::from(page_size) + 1)
            .bind(HISTORY_EVENT_TYPES)
            .bind(filters.kind.known_statuses())
            .fetch_all(&mut *tx)
            .await?;
        let mut entries = rows
            .into_iter()
            .map(|row| {
                let status: String = row.try_get("status")?;
                let title: String = row.try_get("title")?;
                let summary = match filters.kind {
                    HistoryKind::Event => history_event_summary(&status),
                    HistoryKind::Mission => {
                        "Mission state. Open the exact mission for its task graph and evidence."
                    }
                    HistoryKind::Task => {
                        "Task state. Open the exact task for its contract and executions."
                    }
                    HistoryKind::Run => {
                        "Execution state. Open the exact run for its persisted evidence."
                    }
                };
                Ok(HistoryEntry {
                    id: row.try_get("id")?,
                    kind: filters.kind,
                    room_id: row.try_get("room_id")?,
                    title: history_label(&title),
                    status,
                    summary: summary.to_owned(),
                    actor_id: row.try_get("actor_id")?,
                    actor_name: row
                        .try_get::<Option<String>, _>("actor_name")?
                        .map(|v| history_label(&v)),
                    created_at: row.try_get("created_at")?,
                    seq: row.try_get::<Option<i64>, _>("seq")?.map(|v| v.to_string()),
                    mission_id: row.try_get("mission_id")?,
                    task_id: row.try_get("task_id")?,
                    run_id: row.try_get("run_id")?,
                    cause_id: row.try_get("cause_id")?,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        if filters.record_id.is_some() && entries.is_empty() {
            return Err(HistoryReadError::Unavailable.into());
        }
        let more = entries.len() > page_size as usize;
        entries.truncate(page_size as usize);
        let next_cursor = if more {
            let last = entries.last().context("nonempty bounded history page")?;
            let after = match filters.kind {
                HistoryKind::Event => Position::Event {
                    seq: last.seq.as_deref().context("event sequence")?.parse()?,
                },
                _ => Position::Entity {
                    created_at: last.created_at,
                    id: last.id,
                },
            };
            let upper_seq = if filters.kind == HistoryKind::Event {
                Some(
                    cursor.as_ref().and_then(|c| c.upper_seq).unwrap_or(
                        entries[0]
                            .seq
                            .as_deref()
                            .context("first event sequence")?
                            .parse()?,
                    ),
                )
            } else {
                None
            };
            Some(
                Cursor {
                    version: 1,
                    query,
                    observed_at,
                    upper_seq,
                    after,
                }
                .encode()?,
            )
        } else {
            None
        };
        tx.commit().await?;
        Ok(HistoryPage {
            corp_id,
            actor_id: viewer_actor_id,
            filters,
            page_size,
            entries,
            next_cursor,
            observed_at,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_cursors_bind_query_kind_size_time_and_exclusive_position() -> Result<()> {
        let now = Utc::now();
        let mut cursor = Cursor {
            version: 1,
            query: "test-query".into(),
            observed_at: now,
            upper_seq: Some(101),
            after: Position::Event { seq: 99 },
        };
        let raw = cursor.encode()?;
        assert!(Cursor::decode(&raw, "test-query", HistoryKind::Event, now).is_ok());
        assert!(Cursor::decode(&raw, "another-query", HistoryKind::Event, now).is_err());
        assert!(Cursor::decode(&raw, "test-query", HistoryKind::Task, now).is_err());
        assert!(
            Cursor::decode(
                &raw,
                "test-query",
                HistoryKind::Event,
                now + Duration::minutes(31)
            )
            .is_err()
        );
        assert!(
            Cursor::decode(
                &raw,
                "test-query",
                HistoryKind::Event,
                now - Duration::seconds(1)
            )
            .is_err()
        );
        for bad in [
            "".to_owned(),
            "zz".to_owned(),
            "a".repeat(MAX_CURSOR_BYTES + 1),
            hex::encode("{\"version\":1}"),
        ] {
            assert!(Cursor::decode(&bad, "test-query", HistoryKind::Event, now).is_err());
        }
        cursor.upper_seq = Some(98);
        assert!(Cursor::decode(&cursor.encode()?, "test-query", HistoryKind::Event, now).is_err());
        cursor.upper_seq = None;
        cursor.after = Position::Entity {
            created_at: now,
            id: Uuid::new_v4(),
        };
        assert!(Cursor::decode(&cursor.encode()?, "test-query", HistoryKind::Task, now).is_ok());
        Ok(())
    }
}
