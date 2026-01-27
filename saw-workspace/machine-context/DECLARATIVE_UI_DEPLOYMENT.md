# Declarative UI (Declarative Plugin UI) — Deployment Guide

This document describes how to deploy **Declarative UI-style declarative UIs** for SAW workspace plugins.

## What it is

- Declarative UI is a **YAML/JSON declarative UI document** rendered by the frontend.
- It is designed to be **safe-by-default**: no arbitrary JavaScript execution from YAML.
- Rendering uses a **host-owned component registry** (plugins cannot inject arbitrary Tailwind classes).

## Where to put your UI file

For a workspace plugin at:

- `saw-workspace/plugins/<plugin_id>/`

Place your Declarative UI document at one of:

- `saw-workspace/plugins/<plugin_id>/ui/declarative_ui.yaml`
- `saw-workspace/plugins/<plugin_id>/ui/declarative_ui.yml`

### Plugin manifest (`plugin.yaml`)

Use schema UI mode:

```yaml
ui:
  mode: schema
  schema_file: ui/declarative_ui.yaml
```

Notes:
- The backend schema endpoint prefers `ui/declarative_ui.yaml`/`.yml` when present.
- `schema_file` is still supported for backwards compatibility and explicitness.

## Runtime wiring (what happens at runtime)

1. Frontend requests: `GET /api/saw/plugins/ui/schema/<plugin_id>`
2. Backend loads YAML (safe parser) and returns JSON.
3. Frontend detects Declarative UI by `declarative_ui_spec_version` and validates it.
4. Frontend renders the `view` tree via the strict registry.
5. Optional document pieces:
   - `computed`: derived bindings
   - `queries`: safe probes (filesystem reads via Patch Engine)
   - `actions`: safe state + execution operations
   - `lifecycle`: when to run queries

## Document shape (high-level)

Minimum:

```yaml
declarative_ui_spec_version: "0.1"
view:
  component: Stack
  children:
    - component: Text
      props:
        text: "Hello Declarative UI"
```

Common top-level keys:
- `declarative_ui_spec_version` (required)
- `context.defaults.uiState` (optional)
- `computed` (optional)
- `queries` (optional)
- `actions` (optional)
- `lifecycle` (optional)
- `view` (required)

## Bindings and expressions

Bindings are strings like:

- `${node.data.status}`
- `${node.data.params.patient}`
- `${computed.rawSessionDir}`
- `${uiState.status.uploaded}`
- `${event.value}`

The evaluator is intentionally limited (no JS eval). Supported ops include:

- `concat`, `trim`, `lower`, `upper`, `len`
- `eq`, `neq`, `gt`, `gte`, `lt`, `lte`
- `and`, `or`, `not`, `if`

Convenience comparison form is supported:

- `${computed.step != 'upload'}`
- `${node.data.status == 'error'}`

## Components (default registry)

The current built-in components you can use in `view`:

- Layout: `Stack`, `Row`, `Grid`, `Panel`, `Toolbar`
- Display: `Text`, `Badge`, `InlineError`, `CodeBlock`, `ProgressSteps`
- Inputs: `TextField`, `PathField`
- Actions: `Button`

Notes:
- Styling is host-owned. Avoid expecting arbitrary className support.
- `Grid` supports fixed columns (mapped to `grid-cols-1..6`).

## Actions

### Dispatch model

UI events dispatch an action by id (preferred) or by host-kind:

- `action: "setParam"` (document-defined action id)
- `action: "state.updateNodeParam"` (host action kind)

### Supported action kinds

Document-defined action `kind` values supported right now:

- `sequence` (runs `steps` in order)
- `conditional` (runs `then` if `if` is truthy)
- `state.updateNodeParam`
- `state.updateNodeInput`
- `actions.runPluginNode`
- `ui.toast` (currently logs to console/log stream)

Example: `runStep` style (used by `zlab_sort`)

```yaml
actions:
  - id: runStep
    kind: sequence
    steps:
      - kind: conditional
        if: ${event.step != 'upload'}
        then:
          - kind: state.updateNodeParam
            input:
              nodeId: ${node.id}
              key: recording_path
              value: ""
      - kind: state.updateNodeParam
        input:
          nodeId: ${node.id}
          key: step
          value: ${event.step}
      - kind: actions.runPluginNode
        input:
          nodeId: ${node.id}
```

## Queries (filesystem probes)

Queries are safe probes that set values under `uiState.*`.

Supported query kinds:

- `fsFileExists` with input `{ path }`
- `fsDirNonEmpty` with input `{ root, depth }`
- `fsTreeSearch` with input `{ root, depth, match: { type: 'file', nameEndsWith } }`

Example:

```yaml
queries:
  - id: uploaded
    kind: fsFileExists
    input:
      path: ${computed.uploadedWav}
    output:
      into: uiState.status.uploaded
```

If filesystem read fails (caps, missing Patch Engine, etc), the query safely returns `false`.

## Lifecycle

Lifecycle hooks currently supported:

- `lifecycle.onMount`: array of steps; supports `{ kind: runQueries, queries: [...] }`
- `lifecycle.onBindingChange`:
  - `bindings`: list of dependency keys (e.g. `computed.patient`)
  - `do`: array of steps; supports `{ kind: runQueries, queries: [...] }`

Example:

```yaml
lifecycle:
  onMount:
    - kind: runQueries
      queries: [uploaded, sorted, analyzed, curation]
  onBindingChange:
    bindings: [computed.patient, computed.session]
    do:
      - kind: runQueries
        queries: [uploaded, sorted, analyzed, curation]
```

## Reference implementation

A working example document exists here:

- `saw-workspace/plugins/zlab_sort/ui/declarative_ui.yaml`

Key runtime code:

- Frontend loader + detection: `src/components/plugin_ui/SchemaPluginUi.tsx`
- Renderer + primitives: `src/plugins/declarative_ui/**` and `src/components/declarative_ui/DeclarativeUiPrimitives.tsx`
- Action runtime: `src/plugins/declarative_ui/runtime/actionRuntime.ts`
- Query runtime: `src/plugins/declarative_ui/runtime/queryRuntime.ts`

## Troubleshooting checklist

- Declarative UI not detected:
  - Ensure `declarative_ui_spec_version: "0.1"` is present.
  - Ensure the plugin UI is `mode: schema`.
- UI renders but buttons do nothing:
  - Verify action ids match exactly (case-sensitive).
  - Check DeveloperPanel → **Declarative UI Dev** snapshots for `lastAction` and `lastActionErr`.
- Probes always false:
  - Confirm Patch Engine is running and read caps allow the probed paths.
  - Check DeveloperPanel caps UI for the relevant directory.
