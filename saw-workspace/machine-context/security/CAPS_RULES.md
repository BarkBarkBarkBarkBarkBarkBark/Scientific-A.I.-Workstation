# CAPS_RULES.md

## Purpose and threat model

SAW uses capability rules (“caps”) to control which paths can be read/written/deleted by dev tooling and agents.
The goal is to reduce blast radius from mistakes and prevent writes to sensitive areas.

Threat model assumptions:

- The browser/UI should not directly perform privileged filesystem operations.
- Agents may propose or attempt writes; Patch Engine must enforce caps server-side.
- Paths may be user-provided; normalization and precedence must be deterministic to avoid bypasses.

## Path normalization rules

All caps rules and all request paths are treated as **repo-relative POSIX-like paths**.

Normalization rules (conceptual):

1. Convert backslashes to forward slashes.
2. Reject empty paths.
3. Reject any path that attempts traversal (e.g. starts with `..` or contains `/../`).
4. Treat `.` as the repo root.
5. Do not allow sensitive prefixes regardless of caps (Patch Engine hard-blocks these):
   - `.git/`
   - `node_modules/`
   - `dist/`
   - `.env` and `.env.*`

Trailing slash policy:

- Caps rules may refer to either a file-like path (`src/App.tsx`) or a directory prefix (`src/`).
- A directory prefix is represented by a path that ends with `/`.

## Precedence rules

When multiple caps rules could match a requested path, SAW applies:

1. **Longest matching prefix wins**.
2. If there is a tie (same prefix length), the most recently defined rule wins (later in the list).

Matching behavior:

- A rule `src/` matches `src/index.ts`.
- A rule `src/index.ts` matches only that file.
- A rule `.` matches everything (except globally blocked paths).

## Examples

Allow read-only under a workspace directory:

- Rule: `saw-workspace/` with `r=true, w=false, d=false`
- Result: agents can read workspace files but cannot write/delete.

Allow writes to a specific file:

- Rule: `saw-workspace/todo.md` with `r=true, w=true, d=false`
- Result: only that file becomes writable.

Deny writes everywhere except one subtree:

- Rule A: `.` with `r=true, w=false, d=false`
- Rule B: `src/` with `r=true, w=true, d=false`
- Result: `src/*` is writable (B wins by longer prefix), everything else remains read-only.

## How to update .saw/caps.json safely

Recommended workflow:

1. Start from least privilege (`w=false`, `d=false`).
2. Prefer narrowly-scoped directory prefixes (e.g. `saw-workspace/` or `src/components/`) over `.`.
3. Avoid overlapping rules unless you intend to override via precedence.
4. After changing caps, re-run:
   - `GET /api/dev/caps/validate` to detect conflicts.
5. Keep the repo clean:
   - `.saw/` is gitignored by default.
