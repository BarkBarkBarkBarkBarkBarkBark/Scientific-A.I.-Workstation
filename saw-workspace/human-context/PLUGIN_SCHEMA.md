# SAW Plugin Schema (Hardened)

This document describes the hardened, recommended layout and manifest schema for SAW *workspace plugins*.

## Plugin folder layout

A plugin lives at:

- `saw-workspace/plugins/<plugin_id>/`

Canonical files:

- `plugin.yaml` — manifest (validated)
- `wrapper.py` — Python entrypoint (`main(inputs, params, context)`)
- `ui/declarative_ui.yaml` — Declarative UI declarative UI document (schema-mode UI)
- `README.md` — human docs (optional but recommended)

Optional:

- `src/` — helper code that `wrapper.py` imports
- `ui/ui.bundle.js` — legacy/advanced UI bundle (discouraged for new plugins)

## Manifest (`plugin.yaml`) — required fields

`plugin.yaml` is required for discovery.

Required top-level keys:

- `id`, `name`, `version`, `description`, `category_path`
- `entrypoint: { file, callable }`
- `environment: { python, pip }`
- `inputs`, `params`, `outputs` (typed ports)
- `execution: { deterministic, cacheable }`
- `side_effects: { network, disk, subprocess }`
- `resources: { gpu, threads }`

Recommended keys:

- `ui: { mode: schema, schema_file: ui/declarative_ui.yaml, bundle_file: ui/ui.bundle.js, sandbox: true }`
- `meta:` — optional descriptive metadata (human + machine descriptions)

## UI (Declarative UI)

New plugins should use schema mode with an Declarative UI document:

- `ui/declarative_ui.yaml`

The Declarative UI document is declarative: it renders host-owned primitives and may dispatch *actions* to host capabilities (e.g., run node, update params).

## Runtime filesystem conventions

- Preferred scratch/output location for a run is `SAW_RUN_DIR` (per-run sandbox).
- If you need to persist results across runs, prefer explicitly copying/promoting outputs into `saw-workspace/artifacts/<plugin_id>/...` (long-lived).
- If a plugin depends on vendored code or an editable repo checkout, place it under `saw-workspace/sources/<name>/` and reference it from your wrapper (or via params). Keep plugin code under `saw-workspace/plugins/<plugin_id>/`.

## Notes on YAML

YAML is still the intended format for:

- `plugin.yaml` (manifest)
- `ui/declarative_ui.yaml` (Declarative UI UI document)

What is deprecated is the *legacy schema UI* format (`ui.yaml` with `version: 1` + `sections:`).
