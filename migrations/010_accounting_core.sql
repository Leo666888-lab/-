-- First-stage accounting core. Business users continue to work with orders and
-- payments; the tables below hold the tenant-scoped, append-only accounting
-- result of those actions.

CREATE TABLE accounting_accounts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code varchar(32) NOT NULL,
  name varchar(200) NOT NULL,
  category varchar(16) NOT NULL CHECK (category IN ('asset', 'liability', 'equity', 'revenue', 'expense', 'cost', 'other')),
  normal_side varchar(6) NOT NULL CHECK (normal_side IN ('debit', 'credit')),
  is_system boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounting_accounts_code_check CHECK (btrim(code) <> ''),
  CONSTRAINT accounting_accounts_name_check CHECK (btrim(name) <> ''),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id)
);

CREATE INDEX accounting_accounts_tenant_active_idx
  ON accounting_accounts(tenant_id, is_active, code);

CREATE TABLE accounting_periods (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  period_end date NOT NULL,
  status varchar(12) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_at timestamptz,
  closed_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounting_periods_first_day_check CHECK (period_start = date_trunc('month', period_start)::date),
  CONSTRAINT accounting_periods_range_check CHECK (period_end = (period_start + interval '1 month - 1 day')::date),
  CONSTRAINT accounting_periods_closed_fields_check CHECK (
    (status = 'open' AND closed_at IS NULL AND closed_by IS NULL)
    OR (status = 'closed' AND closed_at IS NOT NULL AND closed_by IS NOT NULL)
  ),
  UNIQUE (tenant_id, period_start),
  UNIQUE (tenant_id, id)
);

CREATE INDEX accounting_periods_tenant_status_idx
  ON accounting_periods(tenant_id, status, period_start DESC);

CREATE TABLE bank_accounts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id uuid NOT NULL,
  name varchar(200) NOT NULL,
  account_type varchar(16) NOT NULL CHECK (account_type IN ('cash', 'bank', 'alipay', 'wechat', 'other')),
  account_no varchar(100),
  currency char(3) NOT NULL DEFAULT 'CNY' CHECK (currency ~ '^[A-Z]{3}$'),
  opening_balance_cents bigint NOT NULL DEFAULT 0,
  is_default boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bank_accounts_name_check CHECK (btrim(name) <> ''),
  CONSTRAINT bank_accounts_balance_check CHECK (opening_balance_cents >= 0),
  CONSTRAINT bank_accounts_account_fk FOREIGN KEY (tenant_id, account_id)
    REFERENCES accounting_accounts(tenant_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE INDEX bank_accounts_tenant_active_idx
  ON bank_accounts(tenant_id, is_active, is_default DESC, name);

CREATE UNIQUE INDEX bank_accounts_one_default_idx
  ON bank_accounts(tenant_id)
  WHERE is_default = true AND is_active = true;

CREATE TABLE journal_entries (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period_id uuid NOT NULL,
  entry_no bigint NOT NULL CHECK (entry_no > 0),
  entry_date date NOT NULL,
  source_type varchar(64) NOT NULL,
  source_id uuid,
  description varchar(500) NOT NULL,
  currency char(3) NOT NULL DEFAULT 'CNY' CHECK (currency ~ '^[A-Z]{3}$'),
  total_debit_cents bigint NOT NULL CHECK (total_debit_cents > 0),
  total_credit_cents bigint NOT NULL CHECK (total_credit_cents > 0),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT journal_entries_balanced_check CHECK (total_debit_cents = total_credit_cents),
  CONSTRAINT journal_entries_period_fk FOREIGN KEY (tenant_id, period_id)
    REFERENCES accounting_periods(tenant_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, entry_no)
);

CREATE INDEX journal_entries_tenant_date_idx
  ON journal_entries(tenant_id, entry_date, entry_no);

CREATE UNIQUE INDEX journal_entries_source_idx
  ON journal_entries(tenant_id, source_type, source_id)
  WHERE source_id IS NOT NULL;

-- Older installations may have only the single-column partner primary key.
-- Add the tenant-scoped key required by all accounting foreign keys.
CREATE UNIQUE INDEX IF NOT EXISTS partners_tenant_id_id_idx ON partners(tenant_id, id);

CREATE TABLE journal_lines (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  journal_entry_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no > 0),
  account_id uuid NOT NULL,
  partner_id uuid,
  bank_account_id uuid,
  description varchar(500),
  debit_cents bigint NOT NULL DEFAULT 0 CHECK (debit_cents >= 0),
  credit_cents bigint NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),
  currency char(3) NOT NULL DEFAULT 'CNY' CHECK (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT journal_lines_one_side_check CHECK (
    (debit_cents > 0 AND credit_cents = 0) OR (credit_cents > 0 AND debit_cents = 0)
  ),
  CONSTRAINT journal_lines_entry_fk FOREIGN KEY (tenant_id, journal_entry_id)
    REFERENCES journal_entries(tenant_id, id),
  CONSTRAINT journal_lines_account_fk FOREIGN KEY (tenant_id, account_id)
    REFERENCES accounting_accounts(tenant_id, id),
  CONSTRAINT journal_lines_partner_fk FOREIGN KEY (tenant_id, partner_id)
    REFERENCES partners(tenant_id, id),
  CONSTRAINT journal_lines_bank_account_fk FOREIGN KEY (tenant_id, bank_account_id)
    REFERENCES bank_accounts(tenant_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, journal_entry_id, line_no)
);

CREATE INDEX journal_lines_tenant_account_date_idx
  ON journal_lines(tenant_id, account_id, journal_entry_id);

CREATE INDEX journal_lines_tenant_bank_date_idx
  ON journal_lines(tenant_id, bank_account_id, journal_entry_id)
  WHERE bank_account_id IS NOT NULL;

CREATE FUNCTION accounting_default_uuid(value text)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT (substr(md5(value), 1, 8) || '-' || substr(md5(value), 9, 4) || '-4' ||
          substr(md5(value), 14, 3) || '-8' || substr(md5(value), 17, 3) || '-' ||
          substr(md5(value), 20, 12))::uuid
$$;

CREATE FUNCTION seed_default_accounting_data()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO accounting_accounts (id, tenant_id, code, name, category, normal_side, is_system)
  SELECT accounting_default_uuid(NEW.id::text || ':account:' || defaults.code),
         NEW.id, defaults.code, defaults.name, defaults.category, defaults.normal_side, true
  FROM (VALUES
    ('1001', '库存现金', 'asset', 'debit'),
    ('1002', '银行存款', 'asset', 'debit'),
    ('1003', '其他货币资金', 'asset', 'debit'),
    ('1122', '应收账款', 'asset', 'debit'),
    ('1123', '预付账款', 'asset', 'debit'),
    ('1405', '库存商品', 'asset', 'debit'),
    ('2202', '应付账款', 'liability', 'credit'),
    ('2203', '预收账款', 'liability', 'credit'),
    ('2221', '应交税费', 'liability', 'credit'),
    ('2241', '其他应付款', 'liability', 'credit'),
    ('4001', '实收资本', 'equity', 'credit'),
    ('4103', '本年利润', 'equity', 'credit'),
    ('5001', '主营业务收入', 'revenue', 'credit'),
    ('5401', '主营业务成本', 'cost', 'debit'),
    ('6601', '销售费用', 'expense', 'debit'),
    ('6602', '管理费用', 'expense', 'debit'),
    ('6603', '财务费用', 'expense', 'debit')
  ) AS defaults(code, name, category, normal_side)
  ON CONFLICT (tenant_id, code) DO NOTHING;

  INSERT INTO bank_accounts (id, tenant_id, account_id, name, account_type, currency, is_default)
  SELECT accounting_default_uuid(NEW.id::text || ':bank:default'), NEW.id, account.id,
         '默认银行账户', 'bank', 'CNY', true
  FROM accounting_accounts account
  WHERE account.tenant_id = NEW.id AND account.code = '1002'
  ON CONFLICT (tenant_id, name) DO NOTHING;
  RETURN NEW;
END
$$;

CREATE TRIGGER tenants_accounting_defaults
AFTER INSERT ON tenants
FOR EACH ROW EXECUTE FUNCTION seed_default_accounting_data();

-- Backfill tenants created before this migration. IDs are deterministic so the
-- operation is repeatable and does not need an extension such as pgcrypto.
INSERT INTO accounting_accounts (id, tenant_id, code, name, category, normal_side, is_system)
SELECT accounting_default_uuid(tenant.id::text || ':account:' || defaults.code),
       tenant.id, defaults.code, defaults.name, defaults.category, defaults.normal_side, true
FROM tenants tenant
CROSS JOIN (VALUES
  ('1001', '库存现金', 'asset', 'debit'),
  ('1002', '银行存款', 'asset', 'debit'),
  ('1003', '其他货币资金', 'asset', 'debit'),
  ('1122', '应收账款', 'asset', 'debit'),
  ('1123', '预付账款', 'asset', 'debit'),
  ('1405', '库存商品', 'asset', 'debit'),
  ('2202', '应付账款', 'liability', 'credit'),
  ('2203', '预收账款', 'liability', 'credit'),
  ('2221', '应交税费', 'liability', 'credit'),
  ('2241', '其他应付款', 'liability', 'credit'),
  ('4001', '实收资本', 'equity', 'credit'),
  ('4103', '本年利润', 'equity', 'credit'),
  ('5001', '主营业务收入', 'revenue', 'credit'),
  ('5401', '主营业务成本', 'cost', 'debit'),
  ('6601', '销售费用', 'expense', 'debit'),
  ('6602', '管理费用', 'expense', 'debit'),
  ('6603', '财务费用', 'expense', 'debit')
) AS defaults(code, name, category, normal_side)
ON CONFLICT (tenant_id, code) DO NOTHING;

INSERT INTO bank_accounts (id, tenant_id, account_id, name, account_type, currency, is_default)
SELECT accounting_default_uuid(tenant.id::text || ':bank:default'), tenant.id, account.id,
       '默认银行账户', 'bank', 'CNY', true
FROM tenants tenant
JOIN accounting_accounts account ON account.tenant_id = tenant.id AND account.code = '1002'
ON CONFLICT (tenant_id, name) DO NOTHING;

CREATE FUNCTION reject_journal_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END
$$;

CREATE TRIGGER journal_entries_append_only
BEFORE UPDATE OR DELETE ON journal_entries
FOR EACH ROW EXECUTE FUNCTION reject_journal_mutation();

CREATE TRIGGER journal_lines_append_only
BEFORE UPDATE OR DELETE ON journal_lines
FOR EACH ROW EXECUTE FUNCTION reject_journal_mutation();

CREATE FUNCTION accounting_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END
$$;

CREATE TRIGGER accounting_accounts_updated_at
BEFORE UPDATE ON accounting_accounts
FOR EACH ROW
EXECUTE FUNCTION accounting_set_updated_at();

CREATE TRIGGER accounting_periods_updated_at
BEFORE UPDATE ON accounting_periods
FOR EACH ROW
EXECUTE FUNCTION accounting_set_updated_at();

CREATE TRIGGER bank_accounts_updated_at
BEFORE UPDATE ON bank_accounts
FOR EACH ROW
EXECUTE FUNCTION accounting_set_updated_at();
