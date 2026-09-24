use super::*;

#[test]
fn controlled_session_options_cannot_be_overridden_by_secret_url() {
    let url = connection_url("postgres://reader:synthetic@intent.customer.invalid/app?sslmode=verify-full&options=-c%20default_transaction_read_only=off", true).unwrap();
    let parsed = url::Url::parse(&url).unwrap();
    let options: Vec<_> = parsed
        .query_pairs()
        .filter(|(key, _)| key == "options")
        .map(|(_, value)| value.into_owned())
        .collect();
    assert_eq!(options.len(), 1);
    assert!(options[0].contains("default_transaction_read_only=on"));
    assert!(!options[0].contains("default_transaction_read_only=off"));
}

#[sqlx::test]
#[ignore = "requires explicitly authorized isolated PostgreSQL fixture with role creation"]
async fn database_roles_require_readonly_intents_and_append_only_journal(pool: sqlx::PgPool) {
    let reader = format!("gateway_reader_{}", Uuid::new_v4().simple());
    let writer = format!("gateway_writer_{}", Uuid::new_v4().simple());
    sqlx::raw_sql(include_str!("../../crony-base/gateway-journal.sql"))
        .execute(&pool)
        .await
        .unwrap();
    sqlx::raw_sql(&format!(
        "REVOKE CREATE ON SCHEMA public FROM PUBLIC; CREATE ROLE {reader} NOLOGIN; CREATE ROLE {writer} NOLOGIN;
         GRANT USAGE ON SCHEMA public TO {reader},{writer};
         GRANT SELECT ON ALL TABLES IN SCHEMA public TO {reader},{writer};
         GRANT INSERT ON base_gateway_attempts,base_gateway_results TO {writer};
         GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO {writer};"
    )).execute(&pool).await.unwrap();
    let session = PgPoolOptions::new()
        .max_connections(1)
        .connect_with(pool.connect_options().as_ref().clone())
        .await
        .unwrap();
    let administrator_rejected = qualify_role(&session, true).await.is_err();
    sqlx::raw_sql(&format!(
        "SET ROLE {reader}; SET default_transaction_read_only=on"
    ))
    .execute(&session)
    .await
    .unwrap();
    let readonly_accepted = qualify_role(&session, true).await.is_ok();
    let reader_write_rejected =
        sqlx::query("INSERT INTO base_gateway_identity(singleton) VALUES(false)")
            .execute(&session)
            .await
            .is_err();
    sqlx::raw_sql(&format!(
        "SET default_transaction_read_only=off; RESET ROLE; SET ROLE {writer}"
    ))
    .execute(&session)
    .await
    .unwrap();
    let journal_accepted = qualify_role(&session, false).await.is_ok();
    let journal = PostgresSigningJournal::new(session.clone());
    let snapshot = journal.snapshot(84532, Address::repeat_byte(1)).await;
    sqlx::raw_sql(&format!(
        "GRANT UPDATE ON base_gateway_attempts TO {writer}"
    ))
    .execute(&pool)
    .await
    .unwrap();
    let journal_update_rejected = qualify_role(&session, false).await.is_err();
    session.close().await;
    sqlx::raw_sql(&format!(
        "DROP OWNED BY {reader},{writer}; DROP ROLE {reader}; DROP ROLE {writer};"
    ))
    .execute(&pool)
    .await
    .unwrap();
    assert!(administrator_rejected);
    assert!(readonly_accepted);
    assert!(reader_write_rejected);
    assert!(journal_accepted);
    let snapshot = snapshot.unwrap();
    assert!(snapshot.complete && snapshot.requests.is_empty());
    assert_ne!(snapshot.epoch, Uuid::nil().to_string());
    assert!(journal_update_rejected);
}
