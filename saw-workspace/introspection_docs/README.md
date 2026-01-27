# Introspection docs retention policy

This folder is for **runtime-generated** attestation / introspection outputs.

## Policy

- Tracked in git:
  - This `README.md`
  - Any hand-curated documentation that is meant to be stable

- Ignored by default:
  - Runtime outputs such as `*.yaml` produced by attestation runs

Rationale: introspection output can change frequently and would otherwise create noisy diffs.
