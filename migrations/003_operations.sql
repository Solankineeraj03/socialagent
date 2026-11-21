ALTER TABLE source_cursors ADD COLUMN next_poll_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN lease_until timestamptz, ADD COLUMN lease_token uuid, ADD COLUMN failures integer NOT NULL DEFAULT 0;
ALTER TABLE connections ADD COLUMN write_enabled boolean NOT NULL DEFAULT false, ADD COLUMN enabled_by uuid REFERENCES users(id), ADD COLUMN rate_until timestamptz;
ALTER TABLE deliveries ADD COLUMN provider_state jsonb NOT NULL DEFAULT '{}', ADD COLUMN next_check_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE webhook_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),org_id uuid NOT NULL REFERENCES organizations(id),connection_id uuid NOT NULL,event_key text NOT NULL,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(org_id,connection_id,event_key));
CREATE TABLE invitations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),org_id uuid NOT NULL REFERENCES organizations(id),email text NOT NULL,role text NOT NULL CHECK(role IN('editor','approver','viewer')),token_hash text UNIQUE NOT NULL,expires_at timestamptz NOT NULL,accepted_at timestamptz,created_by uuid NOT NULL REFERENCES users(id));
CREATE INDEX source_due ON source_cursors(next_poll_at);
CREATE UNIQUE INDEX observation_entity_identity ON entities(org_id,(data->>'id')) WHERE kind='observation';
