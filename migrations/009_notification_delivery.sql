ALTER TABLE users
  ADD COLUMN phone_verified_at timestamptz;

ALTER TABLE reminders
  ADD COLUMN version integer NOT NULL DEFAULT 1;

ALTER TABLE reminders
  ADD CONSTRAINT reminders_version_positive_check CHECK (version > 0),
  ADD CONSTRAINT reminders_wakeup_state_check CHECK (
    status NOT IN ('acked', 'snoozed') OR snoozed_until IS NOT NULL
  ),
  ADD CONSTRAINT reminders_tenant_id_unique UNIQUE (tenant_id, id);

-- Fail the migration if legacy data contains more than one active reminder for an
-- order. Silently choosing one could suppress a real settlement obligation.
CREATE UNIQUE INDEX reminders_one_active_per_order_idx
  ON reminders(tenant_id, order_id)
  WHERE status IN ('open', 'acked', 'snoozed');

CREATE INDEX reminders_wakeup_idx
  ON reminders(snoozed_until, tenant_id)
  WHERE status IN ('acked', 'snoozed');

CREATE TABLE notification_endpoints (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  channel varchar(16) NOT NULL CHECK (channel IN ('sms')),
  destination varchar(64) NOT NULL,
  destination_hash char(64) NOT NULL,
  destination_hint varchar(32) NOT NULL,
  verified_at timestamptz,
  consented_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_endpoints_membership_fk
    FOREIGN KEY (tenant_id, user_id)
    REFERENCES memberships(tenant_id, user_id) ON DELETE CASCADE,
  CONSTRAINT notification_endpoints_destination_check
    CHECK (btrim(destination) <> '' AND char_length(destination) <= 64),
  CONSTRAINT notification_endpoints_destination_hash_check
    CHECK (destination_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT notification_endpoints_hint_check
    CHECK (btrim(destination_hint) <> '' AND char_length(destination_hint) <= 32),
  CONSTRAINT notification_endpoints_consent_check
    CHECK (consented_at IS NULL OR verified_at IS NOT NULL),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, user_id, channel, destination_hash)
);

CREATE INDEX notification_endpoints_active_member_idx
  ON notification_endpoints(tenant_id, user_id, channel)
  WHERE verified_at IS NOT NULL AND consented_at IS NOT NULL AND disabled_at IS NULL;

CREATE UNIQUE INDEX notification_endpoints_one_enabled_channel_idx
  ON notification_endpoints(tenant_id, user_id, channel)
  WHERE disabled_at IS NULL;

CREATE TABLE notification_preferences (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  channel varchar(16) NOT NULL CHECK (channel IN ('sms')),
  enabled boolean NOT NULL DEFAULT false,
  send_local_time time NOT NULL DEFAULT time '09:00',
  advance_days smallint NOT NULL DEFAULT 7 CHECK (advance_days BETWEEN 0 AND 365),
  overdue_daily boolean NOT NULL DEFAULT true,
  receivable_enabled boolean NOT NULL DEFAULT true,
  payable_enabled boolean NOT NULL DEFAULT true,
  locale varchar(16) NOT NULL DEFAULT 'zh-CN',
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, channel),
  CONSTRAINT notification_preferences_membership_fk
    FOREIGN KEY (tenant_id, user_id)
    REFERENCES memberships(tenant_id, user_id) ON DELETE CASCADE,
  CONSTRAINT notification_preferences_locale_check
    CHECK (locale ~ '^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$')
);

CREATE TABLE notification_outbox (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  endpoint_id uuid NOT NULL,
  event_type varchar(64) NOT NULL CHECK (event_type IN ('settlement_daily_digest')),
  occurrence_on date NOT NULL,
  locale varchar(16) NOT NULL,
  template_key varchar(100) NOT NULL,
  template_params jsonb NOT NULL DEFAULT '{}'::jsonb,
  scheduled_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  available_at timestamptz NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'leased', 'retry', 'submitted', 'delivered', 'ambiguous', 'failed', 'cancelled', 'expired')),
  lease_token uuid,
  lease_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  provider varchar(32),
  provider_message_id varchar(200),
  last_error_code varchar(100),
  submitted_at timestamptz,
  delivered_at timestamptz,
  failed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_outbox_endpoint_fk
    FOREIGN KEY (tenant_id, endpoint_id)
    REFERENCES notification_endpoints(tenant_id, id),
  CONSTRAINT notification_outbox_schedule_check CHECK (expires_at > scheduled_at),
  CONSTRAINT notification_outbox_lease_check CHECK (
    (status = 'leased' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'leased' AND lease_token IS NULL AND lease_expires_at IS NULL)
  ),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, endpoint_id, event_type, occurrence_on)
);

CREATE INDEX notification_outbox_ready_idx
  ON notification_outbox(available_at, scheduled_at, id)
  WHERE status IN ('pending', 'retry');

CREATE INDEX notification_outbox_expired_lease_idx
  ON notification_outbox(lease_expires_at, id)
  WHERE status = 'leased';

CREATE UNIQUE INDEX notification_outbox_provider_message_idx
  ON notification_outbox(provider, provider_message_id)
  WHERE provider IS NOT NULL AND provider_message_id IS NOT NULL;

CREATE TABLE notification_outbox_items (
  tenant_id uuid NOT NULL,
  outbox_id uuid NOT NULL,
  reminder_id uuid NOT NULL,
  order_id uuid NOT NULL,
  reminder_version integer NOT NULL CHECK (reminder_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (outbox_id, reminder_id),
  CONSTRAINT notification_outbox_items_outbox_fk
    FOREIGN KEY (tenant_id, outbox_id)
    REFERENCES notification_outbox(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT notification_outbox_items_reminder_fk
    FOREIGN KEY (tenant_id, reminder_id)
    REFERENCES reminders(tenant_id, id),
  CONSTRAINT notification_outbox_items_order_fk
    FOREIGN KEY (tenant_id, order_id)
    REFERENCES orders(tenant_id, id)
);

CREATE INDEX notification_outbox_items_reminder_idx
  ON notification_outbox_items(tenant_id, reminder_id, outbox_id);

CREATE TABLE notification_delivery_attempts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  outbox_id uuid NOT NULL,
  attempt_no integer NOT NULL CHECK (attempt_no > 0),
  provider varchar(32) NOT NULL,
  out_id uuid NOT NULL,
  status varchar(16) NOT NULL
    CHECK (status IN ('started', 'accepted', 'rejected', 'ambiguous')),
  provider_request_id varchar(200),
  provider_message_id varchar(200),
  provider_code varchar(100),
  error_class varchar(32) CHECK (error_class IN ('retryable', 'permanent', 'ambiguous')),
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  next_retry_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_attempts_outbox_fk
    FOREIGN KEY (tenant_id, outbox_id)
    REFERENCES notification_outbox(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT notification_attempts_completion_check CHECK (
    (status = 'started' AND finished_at IS NULL)
    OR (status <> 'started' AND finished_at IS NOT NULL)
  ),
  UNIQUE (tenant_id, id),
  UNIQUE (outbox_id, attempt_no),
  UNIQUE (provider, out_id)
);

CREATE INDEX notification_attempts_provider_message_idx
  ON notification_delivery_attempts(provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

CREATE TABLE notification_delivery_receipts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  outbox_id uuid NOT NULL,
  attempt_id uuid,
  provider varchar(32) NOT NULL,
  receipt_key char(64) NOT NULL UNIQUE,
  provider_message_id varchar(200) NOT NULL,
  status varchar(16) NOT NULL CHECK (status IN ('delivered', 'failed', 'unknown')),
  provider_code varchar(100),
  reported_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_receipts_key_check CHECK (receipt_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT notification_receipts_outbox_fk
    FOREIGN KEY (tenant_id, outbox_id)
    REFERENCES notification_outbox(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT notification_receipts_attempt_fk
    FOREIGN KEY (tenant_id, attempt_id)
    REFERENCES notification_delivery_attempts(tenant_id, id)
);

CREATE INDEX notification_receipts_message_idx
  ON notification_delivery_receipts(provider, provider_message_id, reported_at);

CREATE TRIGGER notification_delivery_receipts_append_only
BEFORE UPDATE OR DELETE ON notification_delivery_receipts
FOR EACH ROW EXECUTE FUNCTION reject_financial_history_mutation();

CREATE TABLE notification_worker_heartbeats (
  worker_name varchar(100) PRIMARY KEY,
  instance_id uuid NOT NULL,
  release_id varchar(100) NOT NULL,
  provider varchar(32) NOT NULL,
  started_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  last_schedule_at timestamptz,
  last_delivery_at timestamptz,
  last_error_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_worker_name_check CHECK (btrim(worker_name) <> ''),
  CONSTRAINT notification_worker_release_check CHECK (btrim(release_id) <> '')
);
