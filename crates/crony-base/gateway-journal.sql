-- Install with a separate administrative principal in a separate retained database.
-- Gateway runtime receives SELECT/INSERT and sequence USAGE, never UPDATE/DELETE/TRUNCATE/DDL.
CREATE TABLE base_gateway_identity (
    singleton boolean PRIMARY KEY CHECK (singleton),
    epoch uuid NOT NULL UNIQUE DEFAULT gen_random_uuid()
);
INSERT INTO base_gateway_identity(singleton) VALUES (true);
CREATE TABLE base_gateway_attempts (
    attempt_id uuid PRIMARY KEY,
    journal_cursor bigserial NOT NULL UNIQUE,
    request jsonb NOT NULL CHECK (jsonb_typeof(request) = 'object')
        CHECK (request->>'attempt_id' IS NOT NULL AND request->>'attempt_id' = attempt_id::text),
    frozen_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE base_gateway_results (
    attempt_id uuid PRIMARY KEY REFERENCES base_gateway_attempts(attempt_id),
    raw_transaction bytea NOT NULL CHECK (octet_length(raw_transaction) BETWEEN 1 AND 4096),
    transaction_hash bytea NOT NULL CHECK (octet_length(transaction_hash) = 32),
    committed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION base_gateway_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'signing journal is append-only';
END
$$;
CREATE TRIGGER base_gateway_attempts_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
ON base_gateway_attempts FOR EACH STATEMENT EXECUTE FUNCTION base_gateway_immutable();
CREATE TRIGGER base_gateway_results_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
ON base_gateway_results FOR EACH STATEMENT EXECUTE FUNCTION base_gateway_immutable();
CREATE TRIGGER base_gateway_identity_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
ON base_gateway_identity FOR EACH STATEMENT EXECUTE FUNCTION base_gateway_immutable();
