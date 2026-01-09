# SAW Plugin Template (Immutable)

This folder is a **template** for creating new SAW plugins.

It is **not** discovered as a plugin because it does not contain `plugin.yaml`.

## Contract

- `plugin.yaml` describes the manifest (id/name/version/io/side-effects/resources).
- `wrapper.py` must export:

```python
def main(inputs: dict, params: dict, context) -> dict:
    ...
```

- Inputs/params/outputs follow the convention:
  - Each value is an object: `{ "data": <value>, "metadata": <dict> }`

## Safety expectations

- For any `path` inputs, validate that paths are **relative** and stay **inside** `SAW_WORKSPACE_ROOT`.
- Respect `side_effects` in the manifest (network/disk/subprocess).


