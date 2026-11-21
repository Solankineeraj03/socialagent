CREATE TABLE oauth_states (
 state_hash text PRIMARY KEY,
 org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 channel text NOT NULL CHECK(channel IN('instagram','youtube','linkedin')),
 account_id text NOT NULL,
 verifier_encrypted text,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oauth_states_expiry ON oauth_states(expires_at);
