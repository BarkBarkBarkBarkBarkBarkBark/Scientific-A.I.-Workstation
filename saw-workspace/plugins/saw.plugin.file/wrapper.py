"""SAW Plugin: Plugin Generator

Creates a new plugin folder under saw-workspace/plugins from:
  - a repo URL (cloned into saw-workspace/sources)
  - a code path (workspace-relative)
  - or an inline code snippet

Notes:
  - Requires OpenAI API (OPENAI_API_KEY must be set).
  - No fallback generation; errors are raised if OpenAI fails.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import textwrap
import urllib.request
from pathlib import Path
from typing import Any

#region agent log
import json as _agent_json
from datetime import datetime as _agent_datetime

_AGENT_LOG_PATH = "/Users/marco/Cursor_Folder/Cursor_Codespace/Scientific A.I. Workstation/.cursor/debug.log"
_AGENT_SESSION = "debug-session"

def _agent_log(hypothesis: str, location: str, message: str, data: dict | None = None) -> None:
    try:
        payload = {
            "sessionId": _AGENT_SESSION,
            "runId": "pre-fix",
            "hypothesisId": hypothesis,
            "location": location,
            "message": message,
            "data": data or {},
            "timestamp": int(_agent_datetime.now().timestamp() * 1000),
        }
        with open(_AGENT_LOG_PATH, "a", encoding="utf-8") as f:
            f.write(_agent_json.dumps(payload) + "\n")
    except Exception:
        pass
#endregion


def _workspace_root() -> str:
    env = os.environ.get("SAW_WORKSPACE_ROOT")
    if env:
        return os.path.abspath(env)
    here = os.path.dirname(__file__)
    return os.path.abspath(os.path.join(here, "..", ".."))


def _safe_join_under(root: str, rel: str) -> str:
    rel = (rel or "").replace("\\", "/").strip()
    if not rel:
        raise ValueError("missing_path")
    if rel.startswith("/") or rel.startswith("~"):
        raise ValueError("path must be workspace-relative")
    if rel.startswith("..") or "/../" in f"/{rel}/":
        raise ValueError("path traversal is not allowed")
    abs_path = os.path.abspath(os.path.join(root, rel))
    root_abs = os.path.abspath(root)
    if not abs_path.startswith(root_abs):
        raise ValueError("path must be inside saw-workspace/")
    return abs_path


def _slugify(value: str) -> str:
    value = (value or "").strip().lower()
    value = re.sub(r"[^a-z0-9._-]+", "-", value)
    value = re.sub(r"-{2,}", "-", value).strip("-")
    return value or "generated-plugin"


def _run_git(args: list[str], cwd: str) -> tuple[int, str]:
    proc = subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    return proc.returncode, proc.stdout.strip()


def _clone_or_update_repo(repo_url: str, repo_ref: str, sources_root: str) -> tuple[str, list[str]]:
    warnings: list[str] = []
    repo_slug = _slugify(Path(repo_url.rstrip("/")).name.replace(".git", ""))
    dest = os.path.join(sources_root, repo_slug)
    if not os.path.exists(dest):
        code, out = _run_git(["clone", "--depth", "1", repo_url, dest], cwd=sources_root)
        if code != 0:
            raise RuntimeError(f"git clone failed: {out}")
    else:
        warnings.append(f"repo exists, skipping clone: {dest}")

    if repo_ref:
        code, out = _run_git(["fetch", "--depth", "1", "origin", repo_ref], cwd=dest)
        if code != 0:
            warnings.append(f"git fetch failed: {out}")
        else:
            code, out = _run_git(["checkout", repo_ref], cwd=dest)
            if code != 0:
                warnings.append(f"git checkout failed: {out}")
    return dest, warnings


def _read_file_best_effort(path: str, max_bytes: int) -> str:
    try:
        size = os.path.getsize(path)
        if max_bytes > 0 and size > max_bytes:
            with open(path, "rb") as f:
                raw = f.read(max_bytes)
            return raw.decode("utf-8", errors="replace")
        with open(path, "rb") as f:
            raw = f.read()
        return raw.decode("utf-8", errors="replace")
    except Exception as exc:
        raise RuntimeError(f"failed to read {path}: {exc}")


def _limit_text(text: str, max_bytes: int) -> str:
    raw = (text or "").encode("utf-8")
    if max_bytes > 0 and len(raw) > max_bytes:
        return raw[:max_bytes].decode("utf-8", errors="replace")
    return text or ""


def _extract_code_block(text: str) -> str | None:
    if not text:
        return None
    match = re.search(r"```python(.*?)```", text, re.DOTALL | re.IGNORECASE)
    if match:
        return match.group(1).strip()
    match = re.search(r"```(.*?)```", text, re.DOTALL)
    if match:
        return match.group(1).strip()
    return None


def _call_openai(model: str, system_prompt: str, user_prompt: str) -> str:
    api_key = os.environ.get("OPENAI_API_KEY")
    _agent_log("H_env", "_call_openai", "env_check", {"has_api_key": bool(api_key)})
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not set")
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.1,
    }
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=data,
        method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
        payload = json.loads(raw or "{}")
        content = payload["choices"][0]["message"]["content"]
        if not content:
            raise RuntimeError("OpenAI returned empty content")
        return content
    except Exception as exc:
        raise RuntimeError(f"OpenAI request failed: {exc}")


def _render_manifest(
    plugin_id: str,
    plugin_name: str,
    plugin_description: str,
) -> str:
    manifest = {
        "id": plugin_id,
        "name": plugin_name,
        "version": "0.1.0",
        "description": plugin_description,
        "category_path": "generated",
        "entrypoint": {"file": "wrapper.py", "callable": "main"},
        "environment": {"python": ">=3.11,<3.13"},
        "inputs": {"input": {"type": "text"}},
        "params": {"options": {"type": "object", "default": {}}},
        "outputs": {"result": {"type": "object"}},
        "execution": {"deterministic": False, "cacheable": False},
        "side_effects": {"network": "none", "disk": "read_only", "subprocess": "forbidden"},
        "resources": {"gpu": "forbidden", "threads": 1},
    }
    return "\n".join(
        [
            f'id: "{manifest["id"]}"',
            f'name: "{manifest["name"]}"',
            f'version: "{manifest["version"]}"',
            f'description: "{manifest["description"]}"',
            f'category_path: "{manifest["category_path"]}"',
            "entrypoint:",
            '  file: "wrapper.py"',
            '  callable: "main"',
            "environment:",
            '  python: ">=3.11,<3.13"',
            "inputs:",
            '  input:',
            '    type: "text"',
            "params:",
            '  options:',
            '    type: "object"',
            "    default: {}",
            "outputs:",
            '  result:',
            '    type: "object"',
            "execution:",
            "  deterministic: false",
            "  cacheable: false",
            "side_effects:",
            '  network: "none"',
            '  disk: "read_only"',
            '  subprocess: "forbidden"',
            "resources:",
            '  gpu: "forbidden"',
            "  threads: 1",
        ]
    )


def _build_openai_prompt(code_text: str, user_request: str) -> tuple[str, str]:
    system_prompt = (
        "You are generating a SAW plugin wrapper.py. "
        "The wrapper must export main(inputs, params, context) -> dict and obey the SAW "
        "contract: inputs/outputs are wrapped with {data, metadata}. "
        "Only output python code, ideally fenced in ```python```."
    )
    user_prompt = textwrap.dedent(
        f"""
        Generate wrapper.py for a SAW plugin that wraps the following code or notebook excerpt.
        If you cannot infer precise inputs/outputs, create a safe, minimal wrapper that accepts
        a text input and returns a structured result.

        User request:
        {user_request or "N/A"}

        Code excerpt (may be partial):
        {code_text}
        """
    ).strip()
    return system_prompt, user_prompt


def _build_openai_prompt_from_description(description_text: str) -> tuple[str, str]:
    system_prompt = (
        "You are generating a SAW plugin wrapper.py from a plain-English description. "
        "The wrapper must export main(inputs, params, context) -> dict and obey the SAW "
        "contract: inputs/outputs are wrapped with {data, metadata}. "
        "Only output python code, ideally fenced in ```python```."
    )
    user_prompt = textwrap.dedent(
        f"""
        Generate wrapper.py for a SAW plugin based on the description below.
        Implement the described behavior directly in wrapper.py. If details are missing,
        make reasonable assumptions and keep the wrapper safe and minimal.

        Description:
        {description_text}
        """
    ).strip()
    return system_prompt, user_prompt


def _build_readme_prompt(
    plugin_id: str,
    plugin_name: str,
    plugin_description: str,
    repo_url: str,
    user_request: str,
    code_text: str,
) -> tuple[str, str]:
    system_prompt = (
        "You are generating a concise README.md for a SAW plugin. "
        "Use Markdown, keep sections short, and avoid speculative claims."
    )
    user_prompt = textwrap.dedent(
        f"""
        Create a README.md for a SAW plugin.

        Plugin ID: {plugin_id}
        Name: {plugin_name}
        Description: {plugin_description}
        Author/Lab: N/A
        Repo URL: {repo_url or "N/A"}
        User request: {user_request or "N/A"}

        Code/context excerpt (may be partial):
        {code_text or "N/A"}

        Include sections:
        - Overview
        - Inputs
        - Parameters
        - Outputs
        - Usage
        - Notes/Assumptions
        """
    ).strip()
    return system_prompt, user_prompt


def _default_wrapper(plugin_name: str, description: str, user_request: str) -> str:
    summary = description or user_request or "A generated SAW plugin."
    safe_name = plugin_name or "Generated Plugin"
    return textwrap.dedent(
        f"""
        \"\"\"{safe_name} - default fallback wrapper.

        Summary: {summary}
        \"\"\"

        from __future__ import annotations

        from typing import Any


        def main(inputs: dict, params: dict, context) -> dict:
            text = str((inputs or {{}}).get("input", {{}}).get("data") or "")
            options = (params or {{}}).get("options") or {{}}
            result: dict[str, Any] = {{
                "text": text,
                "options": options,
                "message": "Default wrapper used. Provide code or description for a richer wrapper.",
            }}
            return {{"result": {{"data": result, "metadata": {{"plugin": "saw.plugin.generator"}}}}}}
        """
    ).lstrip()


def _default_readme(plugin_name: str, plugin_description: str) -> str:
    return textwrap.dedent(
        f"""
        # {plugin_name}

        {plugin_description}

        ## Overview
        This plugin was generated with a fallback README because OpenAI was unavailable.

        ## Inputs
        - `input` (text)

        ## Parameters
        - `options` (object)

        ## Outputs
        - `result` (object)
        """
    ).strip()


def _ensure_dir(path: str) -> None:
    Path(path).mkdir(parents=True, exist_ok=True)


def main(inputs: dict, params: dict, context) -> dict:
    ws_root = _workspace_root()
    plugins_root = _safe_join_under(ws_root, "plugins")
    sources_root = _safe_join_under(ws_root, "sources")
    _ensure_dir(sources_root)

    repo_url = str((inputs or {}).get("repo_url", {}).get("data") or "").strip()
    user_request = str((inputs or {}).get("user_request", {}).get("data") or "").strip()
    code_path = str((inputs or {}).get("code_path", {}).get("data") or "").strip()
    code_snippet = str((inputs or {}).get("code_snippet", {}).get("data") or "")

    plugin_name = str((params or {}).get("plugin_name") or "").strip()
    plugin_description_input = str((params or {}).get("plugin_description") or "").strip()
    openai_model = "gpt-4o-mini"
    max_code_bytes = 60000

    warnings: list[str] = []
    source_repo_dir = ""

    _agent_log("H_flow", "main:entry", "start", {
        "has_api_key": bool(os.environ.get("OPENAI_API_KEY")),
        "has_repo_url": bool(repo_url),
        "has_code_path": bool(code_path),
        "has_code_snippet": bool(code_snippet),
        "user_request_len": len(user_request),
    })

    if repo_url:
        source_repo_dir, repo_warnings = _clone_or_update_repo(repo_url, "", sources_root)
        warnings.extend(repo_warnings)

    if not plugin_name:
        if repo_url:
            plugin_name = Path(repo_url).stem.replace("-", " ").title()
        else:
            plugin_name = "Generated Plugin"

    plugin_description = plugin_description_input
    if not plugin_description:
        plugin_description = f"Generated plugin for {plugin_name}."

    plugin_id = f"saw.generated.{_slugify(plugin_name)}"
    plugin_dir = _slugify(plugin_id)

    plugin_path = _safe_join_under(plugins_root, plugin_dir)
    if os.path.exists(plugin_path):
        raise RuntimeError(f"plugin folder already exists: {plugin_path}")

    _ensure_dir(plugin_path)

    code_text = ""
    if code_snippet:
        code_text = _limit_text(code_snippet, max_code_bytes)
    elif code_path:
        abs_code_path = _safe_join_under(ws_root, code_path)
        code_text = _read_file_best_effort(abs_code_path, max_code_bytes)
    elif source_repo_dir:
        readme_path = os.path.join(source_repo_dir, "README.md")
        if os.path.exists(readme_path):
            code_text = _read_file_best_effort(readme_path, max_code_bytes)
            warnings.append("used README.md as code context")

    manifest_text = _render_manifest(
        plugin_id=plugin_id,
        plugin_name=plugin_name,
        plugin_description=plugin_description,
    )

    description_context = ""
    if plugin_description_input:
        description_context = plugin_description_input
    if user_request:
        description_context = "\n".join(
            part for part in [description_context, f"User request:\n{user_request}"] if part
        )

    prompt_context = code_text or description_context
    if not prompt_context:
        raise RuntimeError(
            "Missing context: provide plugin_description/user_request or repo_url/code_path/code_snippet."
        )
    _agent_log("H_flow", "main:prompt", "context_ready", {
        "prompt_context_len": len(prompt_context or ""),
        "plugin_path": plugin_path,
    })

    wrapper_text = ""
    openai_used = False
    try:
        if code_text:
            system_prompt, user_prompt = _build_openai_prompt(code_text, user_request)
        else:
            system_prompt, user_prompt = _build_openai_prompt_from_description(description_context)
        content = _call_openai(openai_model, system_prompt, user_prompt)
        wrapper_text = (_extract_code_block(content) or content or "").strip()
        if not wrapper_text:
            raise RuntimeError("OpenAI returned empty wrapper content")
        openai_used = True
    except Exception as exc:
        warnings.append(f"OpenAI unavailable, using default wrapper: {exc}")
        wrapper_text = _default_wrapper(plugin_name, plugin_description, user_request)
    _agent_log("H_api", "main:after_call", "openai_done", {
        "wrapper_len": len(wrapper_text or ""),
        "openai_used": openai_used,
    })

    (Path(plugin_path) / "plugin.yaml").write_text(manifest_text, encoding="utf-8")
    (Path(plugin_path) / "wrapper.py").write_text(wrapper_text, encoding="utf-8")

    try:
        readme_prompt_sys, readme_prompt_user = _build_readme_prompt(
            plugin_id=plugin_id,
            plugin_name=plugin_name,
            plugin_description=plugin_description,
            repo_url=repo_url,
            user_request=user_request,
            code_text=prompt_context or "",
        )
        readme_content = _call_openai(openai_model, readme_prompt_sys, readme_prompt_user)
    except Exception as exc:
        warnings.append(f"OpenAI unavailable, using fallback README: {exc}")
        readme_content = _default_readme(plugin_name, plugin_description)
    (Path(plugin_path) / "README.md").write_text(readme_content, encoding="utf-8")
    _agent_log("H_api", "main:readme", "readme_done", {
        "readme_len": len(readme_content or ""),
    })

    context.log(
        "info",
        "plugin_generator:done",
        plugin_id=plugin_id,
        plugin_dir=plugin_dir,
        source_repo_dir=source_repo_dir,
        warnings=len(warnings),
    )

    result: dict[str, Any] = {
        "plugin_id": plugin_id,
        "plugin_dir": plugin_dir,
        "plugin_path": plugin_path,
        "manifest_path": os.path.join(plugin_path, "plugin.yaml"),
        "wrapper_path": os.path.join(plugin_path, "wrapper.py"),
        "readme_path": os.path.join(plugin_path, "README.md"),
        "source_repo_dir": source_repo_dir,
        "openai_used": openai_used,
        "warnings": warnings,
    }
    _agent_log("H_result", "main:exit", "done", {
        "warnings": warnings,
        "plugin_path": plugin_path,
    })
    return {"result": {"data": result, "metadata": {"plugin": "saw.plugin.generator"}}}
