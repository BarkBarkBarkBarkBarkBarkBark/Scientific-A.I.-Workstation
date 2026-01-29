"""SAW Plugin: Repo Intel Viewer

Contract:
  - main(inputs: dict, params: dict, context) -> dict
  - Each input/output value is: {"data": <value>, "metadata": <dict>}
  - Return value is: {<output_name>: {"data": ..., "metadata": {...}}, ...}

Notes:
  - Use SAW_WORKSPACE_ROOT to safely resolve workspace-relative paths.
  - Use SAW_RUN_DIR if you want to write run artifacts (respect manifest side_effects.disk).
"""

import os

def main(inputs, params, context):
    repo_root = os.environ.get("SAW_WORKSPACE_ROOT", os.getcwd())
    return {
        "status": {
            "data": f"repo_intel_viewer disabled (repo root: {repo_root})",
            "metadata": {},
        }
    }
