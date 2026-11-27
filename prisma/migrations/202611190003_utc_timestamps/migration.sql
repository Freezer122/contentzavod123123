-- Only a verified legacy installation opts in; fresh databases do not shift data.
DO $$
DECLARE
  legacy_zone TEXT;
  column_info RECORD;
BEGIN
  SELECT value INTO legacy_zone FROM system_settings WHERE id = 'v15-verified-legacy-prisma-timezone';
  IF legacy_zone IS NOT NULL THEN
    IF legacy_zone <> 'Europe/Moscow' THEN
      RAISE EXCEPTION 'Unverified legacy timezone';
    END IF;
    FOR column_info IN
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND data_type = 'timestamp with time zone'
        AND table_name <> '_prisma_migrations'
    LOOP
      EXECUTE format(
        'UPDATE %I SET %I = (%I AT TIME ZONE %L) AT TIME ZONE ''UTC'' WHERE %I IS NOT NULL AND id <> ''v15-verified-legacy-prisma-timezone''',
        column_info.table_name, column_info.column_name, column_info.column_name,
        legacy_zone, column_info.column_name
      );
    END LOOP;
    DELETE FROM system_settings WHERE id = 'v15-verified-legacy-prisma-timezone';
  END IF;
END $$;
