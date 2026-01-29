-- Repo Intel (MR-SAW-RepoGraph-Introspection-v0.1)

CREATE SCHEMA IF NOT EXISTS repo_intel;

CREATE TABLE IF NOT EXISTS repo_intel.repos (
  repo_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  root_path text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS repo_intel.scans (
  scan_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id uuid NOT NULL REFERENCES repo_intel.repos(repo_id) ON DELETE CASCADE,
  git_commit text NOT NULL,
  git_branch text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL,
  tool_versions jsonb,
  config jsonb,
  error text
);

CREATE INDEX IF NOT EXISTS repo_intel_scans_repo_commit_idx ON repo_intel.scans(repo_id, git_commit);

CREATE TABLE IF NOT EXISTS repo_intel.files (
  file_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id uuid NOT NULL REFERENCES repo_intel.repos(repo_id) ON DELETE CASCADE,
  rel_path text NOT NULL,
  language text NOT NULL,
  sha256 text NOT NULL,
  loc int,
  is_generated boolean NOT NULL DEFAULT false,
  is_test boolean NOT NULL DEFAULT false
);

CREATE UNIQUE INDEX IF NOT EXISTS repo_intel_files_repo_rel_path_idx ON repo_intel.files(repo_id, rel_path);

CREATE TABLE IF NOT EXISTS repo_intel.scan_files (
  scan_id uuid NOT NULL REFERENCES repo_intel.scans(scan_id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES repo_intel.files(file_id) ON DELETE CASCADE,
  present boolean NOT NULL,
  PRIMARY KEY (scan_id, file_id)
);

CREATE INDEX IF NOT EXISTS repo_intel_scan_files_scan_idx ON repo_intel.scan_files(scan_id, file_id);

CREATE TABLE IF NOT EXISTS repo_intel.import_edges (
  edge_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id uuid NOT NULL REFERENCES repo_intel.scans(scan_id) ON DELETE CASCADE,
  src_file_id uuid NOT NULL REFERENCES repo_intel.files(file_id) ON DELETE CASCADE,
  dst_file_id uuid NOT NULL REFERENCES repo_intel.files(file_id) ON DELETE CASCADE,
  kind text NOT NULL,
  raw text
);

CREATE INDEX IF NOT EXISTS repo_intel_import_edges_scan_src_idx ON repo_intel.import_edges(scan_id, src_file_id);
CREATE INDEX IF NOT EXISTS repo_intel_import_edges_scan_dst_idx ON repo_intel.import_edges(scan_id, dst_file_id);

CREATE TABLE IF NOT EXISTS repo_intel.symbols (
  symbol_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id uuid NOT NULL REFERENCES repo_intel.scans(scan_id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES repo_intel.files(file_id) ON DELETE CASCADE,
  fqname text NOT NULL,
  kind text NOT NULL,
  start_line int,
  end_line int
);

CREATE INDEX IF NOT EXISTS repo_intel_symbols_scan_fqname_idx ON repo_intel.symbols(scan_id, fqname);

CREATE TABLE IF NOT EXISTS repo_intel.runs (
  run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id uuid NOT NULL REFERENCES repo_intel.repos(repo_id) ON DELETE CASCADE,
  git_commit text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  entrypoint text NOT NULL,
  args jsonb,
  env_fingerprint text,
  status text NOT NULL,
  stdout text,
  stderr text,
  error text
);

CREATE INDEX IF NOT EXISTS repo_intel_runs_repo_commit_idx ON repo_intel.runs(repo_id, git_commit);

CREATE TABLE IF NOT EXISTS repo_intel.evidence_file_exec (
  run_id uuid NOT NULL REFERENCES repo_intel.runs(run_id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES repo_intel.files(file_id) ON DELETE CASCADE,
  executed_lines int,
  total_lines int,
  exec_hits bigint,
  source text NOT NULL,
  PRIMARY KEY (run_id, file_id, source)
);

CREATE INDEX IF NOT EXISTS repo_intel_evidence_file_exec_run_idx ON repo_intel.evidence_file_exec(run_id, file_id);

CREATE TABLE IF NOT EXISTS repo_intel.evidence_symbol_calls (
  run_id uuid NOT NULL REFERENCES repo_intel.runs(run_id) ON DELETE CASCADE,
  symbol_id uuid NOT NULL REFERENCES repo_intel.symbols(symbol_id) ON DELETE CASCADE,
  call_count bigint NOT NULL,
  cumulative_time_ms double precision,
  source text NOT NULL,
  PRIMARY KEY (run_id, symbol_id, source)
);

CREATE INDEX IF NOT EXISTS repo_intel_evidence_symbol_calls_run_idx ON repo_intel.evidence_symbol_calls(run_id, symbol_id);

CREATE TABLE IF NOT EXISTS repo_intel.recommendations (
  rec_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id uuid NOT NULL REFERENCES repo_intel.repos(repo_id) ON DELETE CASCADE,
  scan_id uuid NOT NULL REFERENCES repo_intel.scans(scan_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  type text NOT NULL,
  severity int NOT NULL,
  payload jsonb,
  rationale text,
  suggested_actions jsonb
);

CREATE INDEX IF NOT EXISTS repo_intel_recommendations_scan_idx ON repo_intel.recommendations(repo_id, scan_id);

-- App role privileges (local dev)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'saw_app') THEN
    GRANT USAGE ON SCHEMA repo_intel TO saw_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA repo_intel TO saw_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA repo_intel
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO saw_app;
  END IF;
END
$$;
