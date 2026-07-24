ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS timezone text;

UPDATE tenants SET timezone = 'Asia/Shanghai'
WHERE timezone IS NULL OR btrim(timezone) = '';

ALTER TABLE tenants
  ALTER COLUMN timezone SET DEFAULT 'Asia/Shanghai',
  ALTER COLUMN timezone SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tenants_timezone_nonempty_check'
      AND conrelid = 'tenants'::regclass
  ) THEN
    ALTER TABLE tenants
      ADD CONSTRAINT tenants_timezone_nonempty_check
      CHECK (btrim(timezone) <> '') NOT VALID;
  END IF;
END
$$;

ALTER TABLE tenants VALIDATE CONSTRAINT tenants_timezone_nonempty_check;

ALTER TABLE partners
  ADD COLUMN IF NOT EXISTS version integer;

UPDATE partners SET version = 1 WHERE version IS NULL;

ALTER TABLE partners
  ALTER COLUMN version SET DEFAULT 1,
  ALTER COLUMN version SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'partners_version_positive_check'
      AND conrelid = 'partners'::regclass
  ) THEN
    ALTER TABLE partners
      ADD CONSTRAINT partners_version_positive_check
      CHECK (version > 0) NOT VALID;
  END IF;
END
$$;

ALTER TABLE partners VALIDATE CONSTRAINT partners_version_positive_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'orders_fulfillment_dates_check'
      AND conrelid = 'orders'::regclass
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT orders_fulfillment_dates_check CHECK (
        (fulfillment_status = 'fulfilled' AND fulfilled_at IS NOT NULL AND due_at IS NOT NULL)
        OR (fulfillment_status <> 'fulfilled' AND fulfilled_at IS NULL AND due_at IS NULL)
      ) NOT VALID;
  END IF;
END
$$;

ALTER TABLE orders VALIDATE CONSTRAINT orders_fulfillment_dates_check;
