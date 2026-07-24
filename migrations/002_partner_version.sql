ALTER TABLE partners
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'partners_version_positive_check'
  ) THEN
    ALTER TABLE partners
      ADD CONSTRAINT partners_version_positive_check CHECK (version > 0);
  END IF;
END
$$;
