from __future__ import annotations

import json
import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SAW_API_DIR = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))
if SAW_API_DIR not in sys.path:
    sys.path.insert(0, SAW_API_DIR)

from app.plugins_runtime import validate_plugin_manifest  # noqa: E402
from app.settings import get_settings  # noqa: E402


def main() -> int:
    settings = get_settings()
    plugins_dir = os.path.join(settings.workspace_root, "plugins")
    results: list[dict[str, str | bool]] = []
    invalid = 0

    if not os.path.isdir(plugins_dir):
        print(json.dumps({"ok": False, "error": "plugins_dir_not_found", "path": plugins_dir}))
        return 1

    for dirpath, dirnames, filenames in os.walk(plugins_dir):
        if "plugin.yaml" not in filenames:
            continue
        manifest_path = os.path.join(dirpath, "plugin.yaml")
        manifest, err = validate_plugin_manifest(manifest_path)
        if err:
            invalid += 1
        results.append(
            {
                "manifest_path": manifest_path,
                "ok": err is None,
                "error": err or "",
                "plugin_id": manifest.id if manifest else "",
            }
        )
        dirnames[:] = []

    print(json.dumps({"ok": invalid == 0, "invalid": invalid, "results": results}, indent=2))
    return 0 if invalid == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
