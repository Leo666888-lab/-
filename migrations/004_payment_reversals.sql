CREATE UNIQUE INDEX payments_tenant_id_order_idx
  ON payments(tenant_id, id, order_id);

CREATE TABLE payment_reversals (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  payment_id uuid NOT NULL,
  order_id uuid NOT NULL,
  reason text NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  request_hash char(64) NOT NULL,
  reversed_by uuid NOT NULL REFERENCES users(id),
  reversed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_reversals_reason_check
    CHECK (btrim(reason) <> '' AND char_length(reason) <= 2000),
  CONSTRAINT payment_reversals_request_hash_check
    CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT payment_reversals_payment_fk
    FOREIGN KEY (tenant_id, payment_id, order_id)
    REFERENCES payments(tenant_id, id, order_id),
  UNIQUE (tenant_id, payment_id),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX payment_reversals_tenant_order_idx
  ON payment_reversals(tenant_id, order_id);

CREATE FUNCTION reject_payment_reversal_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'payment reversals are append-only'
    USING ERRCODE = '55000';
END
$$;

CREATE TRIGGER payment_reversals_append_only
BEFORE UPDATE OR DELETE ON payment_reversals
FOR EACH ROW EXECUTE FUNCTION reject_payment_reversal_mutation();
