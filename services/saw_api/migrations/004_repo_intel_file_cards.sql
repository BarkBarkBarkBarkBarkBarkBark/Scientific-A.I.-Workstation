-- Add file_cards table for per-file descriptions
CREATE TABLE IF NOT EXISTS repo_intel.file_cards (
  repo_id uuid NOT NULL REFERENCES repo_intel.repos(repo_id),
  scan_id uuid NOT NULL REFERENCES repo_intel.scans(scan_id),
  rel_path text NOT NULL,
  description_md text,
  author text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repo_id, scan_id, rel_path)
);
CREATE INDEX IF NOT EXISTS repo_intel_file_cards_repo_idx ON repo_intel.file_cards(repo_id);
CREATE INDEX IF NOT EXISTS repo_intel_file_cards_scan_idx ON repo_intel.file_cards(scan_id);
CREATE INDEX IF NOT EXISTS repo_intel_file_cards_rel_path_idx ON repo_intel.file_cards(rel_path);
