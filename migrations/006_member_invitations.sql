CREATE TABLE member_invitations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT member_invitations_membership_fk
    FOREIGN KEY (tenant_id, user_id)
    REFERENCES memberships(tenant_id, user_id) ON DELETE CASCADE,
  CONSTRAINT member_invitations_one_per_member
    UNIQUE (tenant_id, user_id),
  CONSTRAINT member_invitations_token_hash_check
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT member_invitations_expiry_check
    CHECK (expires_at > created_at),
  CONSTRAINT member_invitations_terminal_state_check
    CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);

CREATE INDEX member_invitations_pending_expiry_idx
  ON member_invitations(expires_at)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
