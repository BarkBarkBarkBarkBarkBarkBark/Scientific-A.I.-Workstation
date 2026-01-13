"""SAW Plugin: Plugin Generator

Creates a new plugin folder under saw-workspace/plugins from:
  - a repo URL (cloned into saw-workspace/sources)
  - a code path (workspace-relative)
  - or an inline code snippet

Notes:
  - Uses OpenAI API for wrapper generation when OPENAI_API_KEY is present.
  - Falls back to a deterministic template wrapper if OpenAI is unavailable.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import textwrap
import urllib.request
from pathlib import Path
from typing import Any, Iterable


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


def _truthy(s: str) -> bool:
    return str(s or "").strip().lower() in ("1", "true", "yes", "y", "on")


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


def _call_openai(model: str, system_prompt: str, user_prompt: str) -> tuple[str | None, str | None]:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        return None, "OPENAI_API_KEY is not set"
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
        return content, None
    except Exception as exc:
        return None, str(exc)


def _render_manifest(
    plugin_id: str,
    plugin_name: str,
    plugin_description: str,
    plugin_category_path: str,
    plugin_version: str,
) -> str:
    manifest = {
        "id": plugin_id,
        "name": plugin_name,
        "version": plugin_version,
        "description": plugin_description,
        "category_path": plugin_category_path,
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


def _default_wrapper(plugin_id: str, notes: Iterable[str]) -> str:
    notes_block = "\n".join(f"# - {note}" for note in notes if note)
    return textwrap.dedent(
        f"""
        \"\"\"SAW Plugin: {plugin_id}

        TODO:
        {notes_block or "# - Fill in the implementation for your lab code."}
        \"\"\"

        from __future__ import annotations

        def main(inputs: dict, params: dict, context) -> dict:
            text_input = (inputs or {{}}).get("input", {{}}).get("data")
            options = (params or {{}}).get("options") or {{}}
            context.log("info", "generated_plugin:start", options=options)
            result = {{
                "echo": text_input,
                "options": options,
                "message": "Generated wrapper stub. Implement logic in wrapper.py.",
            }}
            context.log("info", "generated_plugin:done")
            return {{"result": {{"data": result, "metadata": {{"plugin": "{plugin_id}"}}}}}}
        """
    ).lstrip()


def _build_openai_prompt(code_text: str) -> tuple[str, str]:
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

        Code excerpt (may be partial):
        {code_text}
        """
    ).strip()
    return system_prompt, user_prompt


def _build_readme_prompt(
    plugin_id: str,
    plugin_name: str,
    plugin_description: str,
    plugin_author: str,
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
        Author/Lab: {plugin_author or "Unknown"}
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


def _default_readme(
    plugin_id: str,
    plugin_name: str,
    plugin_description: str,
    plugin_author: str,
    repo_url: str,
    user_request: str,
) -> str:
    return textwrap.dedent(
        f"""
        # {plugin_name}

        **Plugin ID:** `{plugin_id}`
        **Author/Lab:** {plugin_author or "Unknown"}
        **Source Repo:** {repo_url or "N/A"}

        ## Overview
        {plugin_description or "Generated plugin scaffold."}

        ## Inputs
        - `input` (text): Primary input payload.

        ## Parameters
        - `options` (object): Free-form options for the wrapper.

        ## Outputs
        - `result` (object): Structured response.

        ## Usage
        1. Configure inputs and parameters in the SAW UI.
        2. Run the plugin to execute the wrapper.
        3. Inspect `result` for outputs and logs.

        ## Notes/Assumptions
        - User request: {user_request or "N/A"}
        - This README is a template. Update sections with lab-specific details.
        """
    ).lstrip()


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

    plugin_id = str((params or {}).get("plugin_id") or "").strip()
    plugin_name = str((params or {}).get("plugin_name") or "").strip()
    plugin_description = str((params or {}).get("plugin_description") or "").strip()
    plugin_author = str((params or {}).get("plugin_author") or "").strip()
    plugin_category_path = str((params or {}).get("plugin_category_path") or "generated").strip()
    plugin_version = str((params or {}).get("plugin_version") or "0.1.0").strip()
    plugin_dir = str((params or {}).get("plugin_dir") or "").strip()
    repo_ref = str((params or {}).get("repo_ref") or "").strip()
    overwrite = _truthy(str((params or {}).get("overwrite") or "false"))
    openai_model = str((params or {}).get("openai_model") or "gpt-4o-mini").strip()
    openai_system_prompt = str((params or {}).get("openai_system_prompt") or "").strip()
    readme_enabled = _truthy(str((params or {}).get("readme_enabled") or "true"))
    max_code_bytes = int(float((params or {}).get("max_code_bytes") or 60000))

    warnings: list[str] = []
    source_repo_dir = ""

    if repo_url:
        source_repo_dir, repo_warnings = _clone_or_update_repo(repo_url, repo_ref, sources_root)
        warnings.extend(repo_warnings)

    if not plugin_id:
        if repo_url:
            plugin_id = f"saw.generated.{_slugify(Path(repo_url).stem)}"
        else:
            plugin_id = "saw.generated.plugin"

    if not plugin_name:
        plugin_name = plugin_id.split(".")[-1].replace("-", " ").title()

    if not plugin_description:
        plugin_description = f"Generated plugin for {plugin_name}."

    if not plugin_dir:
        plugin_dir = _slugify(plugin_id)

    plugin_path = _safe_join_under(plugins_root, plugin_dir)
    if os.path.exists(plugin_path):
        if overwrite:
            warnings.append(f"overwriting existing plugin folder: {plugin_path}")
        else:
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
        plugin_category_path=plugin_category_path,
        plugin_version=plugin_version,
    )

    wrapper_text = None
    openai_error = None
    if code_text:
        system_prompt, user_prompt = _build_openai_prompt(code_text)
        if openai_system_prompt:
            system_prompt = openai_system_prompt
        content, openai_error = _call_openai(openai_model, system_prompt, user_prompt)
        wrapper_text = _extract_code_block(content or "")
        if not wrapper_text and content:
            wrapper_text = content

    if not wrapper_text:
        if openai_error:
            warnings.append(f"openai_error: {openai_error}")
        wrapper_text = _default_wrapper(
            plugin_id,
            notes=[
                "Generated using fallback template wrapper.",
                "Provide OPENAI_API_KEY to auto-generate wrapper.py from code context.",
            ],
        )

    (Path(plugin_path) / "plugin.yaml").write_text(manifest_text, encoding="utf-8")
    (Path(plugin_path) / "wrapper.py").write_text(wrapper_text, encoding="utf-8")

    readme_text = ""
    if readme_enabled:
        readme_prompt_sys, readme_prompt_user = _build_readme_prompt(
            plugin_id=plugin_id,
            plugin_name=plugin_name,
            plugin_description=plugin_description,
            plugin_author=plugin_author,
            repo_url=repo_url,
            user_request=user_request,
            code_text=code_text,
        )
        if openai_system_prompt:
            readme_prompt_sys = openai_system_prompt
        readme_content, readme_error = _call_openai(
            openai_model,
            readme_prompt_sys,
            readme_prompt_user,
        )
        readme_text = readme_content or ""
        if not readme_text:
            if readme_error:
                warnings.append(f"readme_openai_error: {readme_error}")
            readme_text = _default_readme(
                plugin_id=plugin_id,
                plugin_name=plugin_name,
                plugin_description=plugin_description,
                plugin_author=plugin_author,
                repo_url=repo_url,
                user_request=user_request,
            )
        (Path(plugin_path) / "README.md").write_text(readme_text, encoding="utf-8")

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
        "readme_path": os.path.join(plugin_path, "README.md") if readme_enabled else "",
        "source_repo_dir": source_repo_dir,
        "openai_used": bool(code_text and not openai_error),
        "warnings": warnings,
    }
    return {"result": {"data": result, "metadata": {"plugin": "saw.plugin.generator"}}}
