-- Only the trusted broker may access these columns. No credential is a task input.
CREATE TABLE delegated_operations (
    id uuid PRIMARY KEY,
    corp_id uuid NOT NULL REFERENCES corps(id),
    actor_id uuid NOT NULL REFERENCES actors(id),
    mission_id uuid NOT NULL REFERENCES missions(id),
    task_id uuid NOT NULL UNIQUE REFERENCES tasks(id),
    run_id uuid UNIQUE REFERENCES runs(id),
    issuer text NOT NULL,
    subject text NOT NULL,
    status text NOT NULL CHECK (status IN ('waiting_for_authentication', 'authenticating',
        'authorized', 'completed', 'cancelled', 'expired', 'failed')),
    expires_at timestamptz NOT NULL,
    token_ciphertext bytea,
    token_nonce bytea,
    token_expires_at timestamptz,
    preview jsonb,
    released boolean NOT NULL DEFAULT false,
    released_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX delegated_operations_owner ON delegated_operations(corp_id, actor_id);

CREATE TABLE delegated_auth_transactions (
    id uuid PRIMARY KEY,
    operation_id uuid NOT NULL REFERENCES delegated_operations(id),
    ticket_hash text NOT NULL UNIQUE,
    state_hash text NOT NULL UNIQUE,
    cookie_hash text,
    pkce_ciphertext bytea NOT NULL,
    pkce_nonce bytea NOT NULL,
    oidc_nonce text NOT NULL,
    expires_at timestamptz NOT NULL,
    opened boolean NOT NULL DEFAULT false,
    consumed boolean NOT NULL DEFAULT false
);
