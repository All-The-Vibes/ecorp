use super::*;
use crony_domain::{MissionContext, MissionOrigin};

impl PgStore {
    /// Read one mission's exact Factory relationship under the viewer's current
    /// Corp, human-operator and room membership. This never reads claim tokens.
    pub async fn mission_context(
        &self,
        corp_id: Uuid,
        viewer_actor_id: Uuid,
        mission_id: Uuid,
    ) -> Result<Option<MissionContext>> {
        // Adoption changes the selected mission, but persisted refresh and
        // correction links retain the origin of historical and pending work.
        // Keep linkage and current authorization in the same snapshot, and
        // fail closed if a mission has ambiguous or cross-Corp ownership.
        let rows = sqlx::query(
            r#"
            WITH links AS (
                SELECT id AS work_item_id, corp_id, mission_id FROM factory_work_items WHERE mission_id=$3
                UNION
                SELECT factory_work_item_id, corp_id, source_mission_id FROM factory_base_refreshes WHERE source_mission_id=$3
                UNION
                SELECT factory_work_item_id, corp_id, mission_id FROM factory_base_refreshes WHERE mission_id=$3
                UNION
                SELECT factory_work_item_id, corp_id, source_mission_id FROM factory_review_revisions WHERE source_mission_id=$3
                UNION
                SELECT factory_work_item_id, corp_id, mission_id FROM factory_review_revisions WHERE mission_id=$3
            )
            SELECT mission.id AS mission_id, mission.corp_id, mission.room_id,
                   item.id AS work_item_id,
                   item.source_repository_owner, item.source_repository_name,
                   item.source_issue_number, item.source_issue_url
            FROM missions mission
            JOIN rooms room
              ON room.id = mission.room_id AND room.corp_id = mission.corp_id
            JOIN room_memberships membership
              ON membership.room_id = room.id AND membership.actor_id = $2
            JOIN actors viewer
              ON viewer.id = membership.actor_id AND viewer.corp_id = mission.corp_id
             AND viewer.kind = 'human'
             AND viewer.role IN ('owner', 'admin', 'manager', 'member')
            LEFT JOIN links link ON link.mission_id = mission.id
            LEFT JOIN factory_work_items item
              ON item.id = link.work_item_id AND item.corp_id = link.corp_id
             AND item.corp_id = mission.corp_id
            WHERE mission.corp_id = $1 AND mission.id = $3
              AND NOT EXISTS (
                  SELECT 1 FROM links invalid_link
                  WHERE invalid_link.mission_id = mission.id
                    AND (invalid_link.corp_id <> mission.corp_id OR NOT EXISTS (
                        SELECT 1 FROM factory_work_items owner
                        WHERE owner.id=invalid_link.work_item_id AND owner.corp_id=invalid_link.corp_id
                    ))
              )
            LIMIT 2
            "#,
        )
        .bind(corp_id)
        .bind(viewer_actor_id)
        .bind(mission_id)
        .fetch_all(&self.pool)
        .await?;
        if rows.len() != 1 {
            return Ok(None);
        }
        rows.into_iter()
            .next()
            .map(|row| {
                let origin = match row.try_get::<Option<Uuid>, _>("work_item_id")? {
                    Some(work_item_id) => MissionOrigin::Factory {
                        work_item_id,
                        source_repository: format!(
                            "{}/{}",
                            row.try_get::<String, _>("source_repository_owner")?,
                            row.try_get::<String, _>("source_repository_name")?
                        ),
                        source_issue_number: row.try_get("source_issue_number")?,
                        source_issue_url: row.try_get("source_issue_url")?,
                    },
                    None => MissionOrigin::Direct,
                };
                Ok(MissionContext {
                    corp_id: row.try_get("corp_id")?,
                    actor_id: viewer_actor_id,
                    mission_id: row.try_get("mission_id")?,
                    room_id: row.try_get("room_id")?,
                    origin,
                })
            })
            .transpose()
    }
}
