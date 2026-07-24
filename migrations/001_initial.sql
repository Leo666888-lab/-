CREATE TABLE IF NOT EXISTS tenants (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  timezone text NOT NULL DEFAULT 'Asia/Shanghai',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  phone varchar(32) NOT NULL UNIQUE,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memberships (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role varchar(16) NOT NULL CHECK (role IN ('owner', 'finance', 'sales', 'viewer')),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_auth_idx ON sessions(token_hash, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS partners (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind varchar(16) NOT NULL CHECK (kind IN ('customer', 'supplier', 'both')),
  contact_name text,
  phone varchar(32),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partners_version_positive_check CHECK (version > 0),
  UNIQUE (tenant_id, name),
  UNIQUE (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS partners_tenant_idx ON partners(tenant_id);

CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  partner_id uuid NOT NULL,
  order_no text NOT NULL,
  direction varchar(16) NOT NULL CHECK (direction IN ('receivable', 'payable')),
  order_date date NOT NULL,
  planned_delivery_date date,
  fulfillment_status varchar(16) NOT NULL DEFAULT 'planned' CHECK (fulfillment_status IN ('planned', 'fulfilled', 'cancelled')),
  fulfilled_at timestamptz,
  settlement_days integer NOT NULL DEFAULT 0 CHECK (settlement_days BETWEEN 0 AND 3650),
  settlement_months integer NOT NULL DEFAULT 0 CHECK (settlement_months BETWEEN 0 AND 120),
  due_at timestamptz,
  currency char(3) NOT NULL DEFAULT 'CNY',
  total_cents bigint NOT NULL CHECK (total_cents > 0),
  notes text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, order_no),
  UNIQUE (tenant_id, id),
  CONSTRAINT orders_partner_tenant_fk FOREIGN KEY (tenant_id, partner_id)
    REFERENCES partners(tenant_id, id),
  CONSTRAINT orders_fulfillment_dates_check CHECK (
    (fulfillment_status = 'fulfilled' AND fulfilled_at IS NOT NULL AND due_at IS NOT NULL)
    OR (fulfillment_status <> 'fulfilled' AND fulfilled_at IS NULL AND due_at IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS orders_tenant_status_idx ON orders(tenant_id, fulfillment_status, direction);

CREATE TABLE IF NOT EXISTS order_items (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id uuid NOT NULL,
  description text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price_cents bigint NOT NULL CHECK (unit_price_cents >= 0),
  line_total_cents bigint NOT NULL CHECK (line_total_cents >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_items_order_tenant_fk FOREIGN KEY (tenant_id, order_id)
    REFERENCES orders(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS order_items_tenant_order_idx ON order_items(tenant_id, order_id);

CREATE TABLE IF NOT EXISTS payments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id uuid NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  method varchar(32) NOT NULL,
  paid_at timestamptz NOT NULL,
  note text,
  proof_key text,
  idempotency_key varchar(128) NOT NULL,
  request_hash char(64) NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT payments_order_tenant_fk FOREIGN KEY (tenant_id, order_id)
    REFERENCES orders(tenant_id, id)
);
CREATE INDEX IF NOT EXISTS payments_tenant_order_idx ON payments(tenant_id, order_id);

CREATE TABLE IF NOT EXISTS reminders (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id uuid NOT NULL,
  due_at timestamptz NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acked', 'snoozed', 'closed')),
  snoozed_until timestamptz,
  acknowledged_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reminders_order_tenant_fk FOREIGN KEY (tenant_id, order_id)
    REFERENCES orders(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS reminders_tenant_status_idx ON reminders(tenant_id, status, due_at);

CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users(id),
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_logs_tenant_created_idx ON audit_logs(tenant_id, created_at DESC);
