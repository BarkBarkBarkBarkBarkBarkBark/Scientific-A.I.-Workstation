from __future__ import annotations

from dataclasses import dataclass
import os


@dataclass(frozen=True)
class Settings:
    db_url: str
    db_admin_url: str
    embed_model: str
    openai_api_key: str | None
    auto_approve_vector_search: bool
    workspace_root: str
    allowed_origins: list[str]


def _truthy(s: str | None) -> bool:
    return str(s or "").strip().lower() in ("1", "true", "yes", "y", "on")

def _repo_root_from_workspace(workspace_root: str) -> str:
    return os.path.abspath(os.path.join(workspace_root, ".."))


def _load_dotenv(path: str) -> dict[str, str]:
    """
    Minimal .env reader (no external deps).
    Supports lines like:
      KEY=value
      KEY="value"
      export KEY=value
    Ignores comments and blank lines.
    """
    out: dict[str, str] = {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            for raw in f.read().splitlines():
                line = raw.strip()
                if not line or line.startswith("#"):
                    continue
                if line.startswith("export "):
                    line = line[len("export ") :].strip()
                if "=" not in line:
                    continue
                k, v = line.split("=", 1)
                key = k.strip()
                val = v.strip()
                if not key:
                    continue
                if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
                    val = val[1:-1]
                out[key] = val
    except Exception:
        return {}
    return out


def get_settings() -> Settings:
    workspace_root = os.environ.get("SAW_WORKSPACE_ROOT") or os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "..", "..", "saw-workspace")
    )

    # If env vars aren't exported for the SAW API process, fall back to repo .env (same as Vite local dev).
    repo_root = _repo_root_from_workspace(workspace_root)
    dotenv_path = os.path.join(repo_root, ".env")
    dotenv = _load_dotenv(dotenv_path)

    def env_or_dotenv(key: str) -> str | None:
        return os.environ.get(key) or dotenv.get(key)

    db_url = env_or_dotenv("SAW_DB_URL") or "postgresql://saw_app:saw_app@127.0.0.1:54329/saw"
    db_admin_url = env_or_dotenv("SAW_DB_ADMIN_URL") or "postgresql://saw_admin:saw_admin@127.0.0.1:54329/saw"
    embed_model = env_or_dotenv("SAW_EMBED_MODEL") or "text-embedding-3-small"
    openai_api_key = env_or_dotenv("OPENAI_API_KEY")
    auto_approve_vector_search = _truthy(env_or_dotenv("SAW_AUTO_APPROVE_VECTOR_SEARCH"))
    allowed_origins = [
        os.environ.get("SAW_ALLOWED_ORIGIN") or "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]
    return Settings(
        db_url=db_url,
        db_admin_url=db_admin_url,
        embed_model=embed_model,
        openai_api_key=openai_api_key,
        auto_approve_vector_search=auto_approve_vector_search,
        workspace_root=workspace_root,
        allowed_origins=allowed_origins,
    )


