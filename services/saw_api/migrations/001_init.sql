CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS saw_meta;
CREATE SCHEMA IF NOT EXISTS saw_ingest;
CREATE SCHEMA IF NOT EXISTS saw_ops;

CREATE TABLE IF NOT EXISTS saw_meta.instance (
  instance_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  saw_version text,
  workspace_root text
);

CREATE TABLE IF NOT EXISTS saw_ingest.document (
  doc_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  uri text UNIQUE NOT NULL,
  doc_type text,
  content_hash text,
  content_text text,
  metadata_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS saw_ingest.embedding (
  doc_id uuid NOT NULL REFERENCES saw_ingest.document(doc_id) ON DELETE CASCADE,
  model text NOT NULL,
  dims int NOT NULL,
  embedding vector(1536) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (doc_id, model)
);

-- Optional: pgvector index (requires extension already installed)
CREATE INDEX IF NOT EXISTS saw_ingest_embedding_hnsw_cos
  ON saw_ingest.embedding
  USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS saw_ops.audit_event (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at timestamptz NOT NULL DEFAULT now(),
  actor text,
  event_type text,
  details_json jsonb
);

CREATE TABLE IF NOT EXISTS saw_ops.patch_proposal (
  proposal_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  author text,
  diff_unified text,
  target_paths text[],
  validation_status text,
  validation_log text,
  applied_commit text
);

-- App role privileges (local dev)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'saw_app') THEN
    GRANT USAGE ON SCHEMA saw_meta, saw_ingest, saw_ops TO saw_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA saw_meta, saw_ingest, saw_ops TO saw_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA saw_meta, saw_ingest, saw_ops
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO saw_app;
  END IF;
END
$$;


