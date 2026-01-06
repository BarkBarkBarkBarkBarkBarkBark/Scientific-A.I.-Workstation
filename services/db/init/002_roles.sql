DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'saw_app') THEN
    CREATE ROLE saw_app LOGIN PASSWORD 'saw_app';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE saw TO saw_app;


