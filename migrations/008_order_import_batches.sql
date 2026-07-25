CREATE TABLE order_import_batches (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  file_name text NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  request_hash char(64) NOT NULL,
  selected_rows integer[] NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_import_batches_file_name_check
    CHECK (btrim(file_name) <> '' AND char_length(file_name) <= 255),
  CONSTRAINT order_import_batches_request_hash_check
    CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT order_import_batches_selected_rows_check
    CHECK (array_length(selected_rows, 1) > 0),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, id)
);

ALTER TABLE orders
  ADD COLUMN import_batch_id uuid;

ALTER TABLE orders
  ADD CONSTRAINT orders_import_batch_fk
  FOREIGN KEY (tenant_id, import_batch_id)
  REFERENCES order_import_batches(tenant_id, id);

CREATE INDEX order_import_batches_tenant_created_idx
  ON order_import_batches(tenant_id, created_at DESC);

CREATE INDEX orders_tenant_import_batch_idx
  ON orders(tenant_id, import_batch_id)
  WHERE import_batch_id IS NOT NULL;

CREATE TRIGGER order_import_batches_append_only
BEFORE UPDATE OR DELETE ON order_import_batches
FOR EACH ROW EXECUTE FUNCTION reject_financial_history_mutation();
