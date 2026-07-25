ALTER TABLE orders
  ADD COLUMN version integer NOT NULL DEFAULT 1;

ALTER TABLE orders
  ADD CONSTRAINT orders_version_positive_check CHECK (version > 0);

CREATE TABLE order_corrections (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  order_id uuid NOT NULL,
  reason text NOT NULL,
  changed_fields text[] NOT NULL,
  before_snapshot jsonb NOT NULL,
  after_snapshot jsonb NOT NULL,
  corrected_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_corrections_order_fk
    FOREIGN KEY (tenant_id, order_id)
    REFERENCES orders(tenant_id, id),
  CONSTRAINT order_corrections_reason_check
    CHECK (btrim(reason) <> '' AND char_length(reason) <= 2000),
  CONSTRAINT order_corrections_changed_fields_check
    CHECK (array_length(changed_fields, 1) > 0)
);

CREATE INDEX order_corrections_tenant_order_created_idx
  ON order_corrections(tenant_id, order_id, created_at DESC);

CREATE TRIGGER order_corrections_append_only
BEFORE UPDATE OR DELETE ON order_corrections
FOR EACH ROW EXECUTE FUNCTION reject_financial_history_mutation();
