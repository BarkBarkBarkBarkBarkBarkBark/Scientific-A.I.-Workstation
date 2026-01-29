# Repo Intel Viewer

A SAW plugin that launches a small local web viewer for a repository import graph.

The viewer fetches graph data from the SAW API (`/repo-intel/simple-graph`) and renders it with Cytoscape.

## Features
- Import graph visualization (Cytoscape)
- Export graph as JSON
- Defaults to scanning Python + JS/TS (including tests)

## Usage
1. Start SAW API (default: `http://127.0.0.1:5127`).
2. Run the `repo_intel_viewer` plugin in the SAW UI.
3. Click **Run** to scan and report counts.
4. Click **Launch Viewer** to open the interactive graph in your browser.

The plugin defaults the scan root to the repository root. The scan respects `.gitignore` (via `git ls-files --exclude-standard` when available; otherwise a lightweight `.gitignore` glob fallback is used).

## Retrieve graph via API

### SAW API (source of truth)

`GET /repo-intel/simple-graph`

Query params:
- `repo_root` (required): absolute path to repo root
- `include_python` (default `true`)
- `include_ts` (default `false`)
- `include_tests` (default `false`)
- `scope_prefix` (default empty)
- `max_files` (default `6000`)

Example:

`curl 'http://127.0.0.1:5127/repo-intel/simple-graph?repo_root=/ABS/PATH/TO/REPO&include_python=true&include_ts=false&include_tests=false&scope_prefix=&max_files=6000'`

Response shape:
- `nodes`: `[{ id, rel_path }, ...]`
- `edges`: `[{ src, dst, kind }, ...]`
- `not_imported`: `[rel_path, ...]`
- `isolated`: `[rel_path, ...]`
- `stats`: `{ node_count, edge_count, not_imported_count, isolated_count }`

### Viewer endpoint

The launched viewer also exposes:

`GET /graph.json`

It returns the same JSON payload as the SAW API call, using the same query params (and defaults).
