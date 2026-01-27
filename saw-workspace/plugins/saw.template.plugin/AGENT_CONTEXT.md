# Agent Context: saw.template.plugin

This folder is the canonical *copy-from-here* SAW plugin template.

If you are an agent (or a tool) creating new plugins, use this as the reference for:
- `plugin.yaml` structure and required fields
- the Python wrapper contract (`main(inputs, params, context) -> dict`)
- safe path handling for workspace-relative paths
- writing run artifacts under `SAW_RUN_DIR/output/` (and returning only output-relative paths)

## UI (Declarative UI default)

New plugins should ship an **Declarative UI** declarative UI document at:

- `ui/declarative_ui.yaml`

And set in `plugin.yaml`:

```yaml
ui:
  mode: schema
  schema_file: ui/declarative_ui.yaml
  bundle_file: ui/ui.bundle.js
  sandbox: true
```

The legacy schema UI file (`ui.yaml` with `version: 1` + `sections:`) is deprecated.

## Ground rules (to avoid breaking plugin discovery)

SAW plugin discovery is strict: **any invalid `plugin.yaml` can break indexing**.

When generating a new plugin manifest, ensure:
- The manifest file is named exactly `plugin.yaml`.
- Required top-level fields exist: `id`, `name`, `version`, `description`, `category_path`, `entrypoint`, `environment`, `inputs`, `params`, `outputs`, `execution`, `side_effects`, `resources`.
- Enum values are valid:
  - `side_effects.disk`: `read_only` or `read_write` (NOT `none`)
  - `side_effects.network`: `none` or `allowed`
  - `side_effects.subprocess`: `forbidden` or `allowed`
  - `resources.gpu`: `forbidden` | `optional` | `required`

## Wrapper contract

Your wrapper must export:

- `main(inputs: dict, params: dict, context) -> dict`

Where:
- Every input value is shaped like `{ "data": <value>, "metadata": { ... } }`.
- Every output value must be shaped like `{ "data": <value>, "metadata": { ... } }`.
- `context.log(level, event, **fields)` is the standard way to log structured events.

## File IO and safety

- Workspace root is available via `SAW_WORKSPACE_ROOT`.
- Run directory is available via `SAW_RUN_DIR`.
- If you accept a path from a user, it should be workspace-relative and must be validated (see `_safe_join_under`).

### Run artifacts

If you write files during execution:
- Write them to `<SAW_RUN_DIR>/output/`.
- If you return a path in outputs, return it as a **relative filename** like `"hello.html"`.
  - SAW validates that anything that looks like a `*_path`/`*_file` is under the run output directory.

## Creating plugins via agent tools

If you are calling SAW agent tools (server-side):

1) **Validate first** using the read-only tool:
- `validate_plugin_manifest(manifest=...)`

2) If validation passes, create the plugin folder and files:
- `create_plugin(manifest=..., wrapper_code=..., readme=...)`

Important:
- Tool arguments must be **nested**. Do NOT flatten manifest keys at the tool call top-level.
- The plugin’s files must be written to:
  - `saw-workspace/plugins/<plugin_id>/plugin.yaml`
  - `saw-workspace/plugins/<plugin_id>/wrapper.py`
  - `saw-workspace/plugins/<plugin_id>/README.md`

## Minimal manifest example (copy/paste skeleton)

```yaml
id: "my.plugin.id"
name: "My Plugin"
version: "0.1.0"
description: "One-line description."
category_path: "examples"
entrypoint:
  file: "wrapper.py"
  callable: "main"
environment:
  python: ">=3.11,<3.13"
  pip: []
inputs: {}
params: {}
outputs:
  result:
    type: "object"
execution:
  deterministic: true
  cacheable: true
side_effects:
  network: "none"
  disk: "read_only"
  subprocess: "forbidden"
resources:
  gpu: "forbidden"
  threads: 1
```

## Minimal wrapper example

```python
def main(inputs: dict, params: dict, context) -> dict:
    context.log("info", "my_plugin:start")
    return {"result": {"data": {"ok": True}, "metadata": {}}}
```
