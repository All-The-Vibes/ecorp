-- Login subject and delegated-provider subject have independent purposes. In
-- Entra this allows a pairwise login sub and a tenant's stable oid to coexist.
ALTER TABLE actors ADD CONSTRAINT actors_id_corp_unique UNIQUE (id, corp_id);
CREATE TABLE delegated_identities (
    corp_id uuid NOT NULL REFERENCES corps(id),
    actor_id uuid NOT NULL,
    issuer text NOT NULL CHECK (issuer <> ''),
    subject text NOT NULL CHECK (subject <> ''),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (corp_id, actor_id, issuer),
    UNIQUE (corp_id, issuer, subject),
    FOREIGN KEY (actor_id, corp_id) REFERENCES actors(id, corp_id)
);

ALTER TABLE delegated_operations
    ADD COLUMN runner_id text,
    ADD COLUMN connection_epoch uuid,
    ADD COLUMN assignment_token uuid,
    ADD COLUMN authentication_id uuid REFERENCES delegated_auth_transactions(id);

-- Old operations did not retain the original runner/epoch/assignment or a
-- distinct delegated binding. Do not infer that authority during migration.
-- Retain their metadata and audit history; discard all old bearer material.
UPDATE delegated_operations
SET status = CASE WHEN status IN ('completed','cancelled','expired','failed')
        THEN status ELSE 'failed' END,
    token_ciphertext = NULL, token_nonce = NULL, token_expires_at = NULL;
UPDATE delegated_auth_transactions
SET consumed = true, pkce_ciphertext = ''::bytea, pkce_nonce = ''::bytea,
    cookie_hash = NULL;

ALTER TABLE delegated_operations ADD CONSTRAINT delegated_assignment_complete CHECK (
    (runner_id IS NULL AND connection_epoch IS NULL AND assignment_token IS NULL)
    OR (run_id IS NOT NULL AND runner_id IS NOT NULL AND connection_epoch IS NOT NULL
        AND assignment_token IS NOT NULL)
);
CREATE INDEX delegated_operations_expiry ON delegated_operations(expires_at, id)
    WHERE status NOT IN ('completed','cancelled','expired','failed');
CREATE INDEX delegated_auth_transactions_expiry ON delegated_auth_transactions(expires_at, id)
    WHERE octet_length(pkce_ciphertext) > 0;
