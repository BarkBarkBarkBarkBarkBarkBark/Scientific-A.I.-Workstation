# Agent Actions

This folder contains type-safe actions the SAW agent can perform.

## `createPlugin`

- Provides a runtime-validated `PluginManifest` schema using Zod, aligned with the backend `PluginManifest`.
- Includes a helper to build a valid Dice Roller manifest and wrapper.
- Exposes `createPluginFromPython()` which calls `/plugins/create_from_python` on the SAW API.
- Use `createDiceRollerPlugin()` to create the dice roller via API with pre-validated defaults.

## Tests

Run schema tests with:

```bash
npm run test
```

These tests verify invalid manifests (e.g., `side_effects.disk: 'none'`) are caught before writing files.
