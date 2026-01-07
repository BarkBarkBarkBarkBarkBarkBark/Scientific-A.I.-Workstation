-- Async plugin run tracking + service registry (MVP)

CREATE TABLE IF NOT EXISTS saw_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_id text NOT NULL,
  plugin_version text NOT NULL,
  run_id text NOT NULL UNIQUE,
  env_key text NOT NULL,
  run_dir text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  inputs_json jsonb,
  params_json jsonb,
  outputs_json jsonb,
  error_text text
);

CREATE INDEX IF NOT EXISTS saw_runs_plugin_run_idx ON saw_runs(plugin_id, run_id);

CREATE TABLE IF NOT EXISTS saw_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id text NOT NULL UNIQUE,
  plugin_id text NOT NULL,
  run_id text NOT NULL,
  name text NOT NULL,
  pid int,
  port int,
  url text,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS saw_services_plugin_run_idx ON saw_services(plugin_id, run_id);

-- App role privileges (local dev)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'saw_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON saw_runs, saw_services TO saw_app;
  END IF;
END
$$;


