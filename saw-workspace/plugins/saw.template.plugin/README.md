# saw.template.plugin

Copy this folder to create a new SAW plugin.

## Files

- `plugin.yaml`: manifest (id/name/version/io/env/side-effects/resources)
- `wrapper.py`: exports `main(inputs, params, context) -> dict`
- `ui/a2ui.yaml`: declarative UI document for the fullscreen module view

## Quick copy checklist

- Change `id`, `name`, `version`, `description`, `category_path`
- Define `inputs`, `params`, `outputs`
- Implement logic in `wrapper.py::main`

## Runtime contract (important)

- Each input is shaped like:
  - `{ "data": <value>, "metadata": { ... } }`
- Return outputs shaped like:
  - `{ "<output_name>": { "data": <value>, "metadata": { ... } } }`
- Use `context.log(level, event, **fields)` for structured logs.

## Paths / file IO

- Workspace root: `SAW_WORKSPACE_ROOT`
- Run directory (if present): `SAW_RUN_DIR`
- For user-provided paths, validate they are workspace-relative (see `_safe_join_under`).

## UI (schema mode, A2UI)

This plugin uses the A2UI declarative renderer (schema mode). In `plugin.yaml`:

```yaml
ui:
  mode: "schema"
  schema_file: "ui/a2ui.yaml"
  bundle_file: "ui/ui.bundle.js"
  sandbox: true
```

And the schema file `ui/a2ui.yaml` controls what the fullscreen module shows.

## UI (bundle mode, advanced)

You can ship an advanced UI as a prebuilt JS bundle stored in the plugin folder.

- For workspace/dev plugins: `ui.sandbox: true` is required.
- For stock/locked plugins: bundles are blocked unless `ui.sandbox: false` (treat as approved bundle).


