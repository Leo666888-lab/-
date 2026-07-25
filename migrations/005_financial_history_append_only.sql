CREATE FUNCTION reject_financial_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$$;

CREATE TRIGGER payments_append_only
BEFORE UPDATE OR DELETE ON payments
FOR EACH ROW EXECUTE FUNCTION reject_financial_history_mutation();

CREATE TRIGGER audit_logs_append_only
BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION reject_financial_history_mutation();
