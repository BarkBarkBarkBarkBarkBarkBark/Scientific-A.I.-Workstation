## SAW API (local DB + embeddings)

### Run Postgres (pgvector)

```bash
docker compose up -d
```

### Run API (FastAPI)

> Python requirement: use **Python <= 3.13** for this service. Python 3.14 currently breaks `pydantic-core`/`jiter` builds.

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r services/saw_api/requirements.txt
python -m uvicorn services.saw_api.app.main:app --host 127.0.0.1 --port 5127
```

### Migrate

```bash
curl -X POST http://127.0.0.1:5127/db/migrate
```

### Plugins (workspace)

The default workspace root is `saw-workspace/` in the repo.

```bash
curl http://127.0.0.1:5127/plugins/list
```

### Index (ingest) a workspace directory

This uses the workspace plugin `saw.ingest.directory` to read text-like files under `saw-workspace/` and call `/embed/upsert`.

> Requires `OPENAI_API_KEY` in the SAW API process environment.

```bash
curl -X POST http://127.0.0.1:5127/plugins/execute \
  -H "Content-Type: application/json" \
  -d '{
    "plugin_id":"saw.ingest.directory",
    "inputs":{"directory":{"data":"."}},
    "params":{"max_bytes":200000,"chunk_max_chars":4000,"chunk_overlap_chars":300}
  }'
```

### Vector search

```bash
curl -X POST http://127.0.0.1:5127/search/vector \
  -H "Content-Type: application/json" \
  -d '{"query":"patch engine", "top_k": 8}'
```

### Env vars

- `OPENAI_API_KEY`: required for `/embed/*` and `/search/*`
- `SAW_DB_URL`: default `postgresql://saw_app:saw_app@127.0.0.1:54329/saw`
- `SAW_EMBED_MODEL`: default `text-embedding-3-small`
 - `SAW_WORKSPACE_ROOT`: override workspace path (default is `./saw-workspace`)


