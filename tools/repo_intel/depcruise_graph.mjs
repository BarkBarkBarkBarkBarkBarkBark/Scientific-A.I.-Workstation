#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

function argValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

const repoRoot = argValue("--root") || process.cwd();
const scope = argValue("--scope") || "src";

// Prefer local binary (devDependency)
const bin = path.join(repoRoot, "node_modules", ".bin", "depcruise");

function runDepcruise() {
  const tsconfig = path.join(repoRoot, "tsconfig.json");
  const args = [
    "--output-type",
    "json",
    "--exclude",
    "node_modules|\\.venv|dist|build",
  ];
  if (fs.existsSync(tsconfig)) {
    args.push("--ts-config", tsconfig);
  }
  args.push(scope);

  const stdout = execFileSync(bin, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return stdout;
}

try {
  if (!fs.existsSync(bin)) {
    process.stdout.write(
      JSON.stringify({
        tool: "dependency-cruiser",
        tool_version: null,
        edges: [],
        error: "dependency-cruiser_not_installed",
      })
    );
    process.exit(0);
  }

  const raw = runDepcruise();
  const payload = JSON.parse(raw);

  const modules = payload?.modules || [];
  const edges = [];

  for (const m of modules) {
    const src = m?.source;
    if (!src) continue;
    const deps = m?.dependencies || [];
    for (const d of deps) {
      const resolved = d?.resolved;
      const kind = d?.dependencyTypes?.includes("npm") ? "import" : "import";
      if (resolved) {
        // depcruise uses relative paths already; normalize
        const dst = resolved.replace(/\\\\/g, "/");
        edges.push({ src: src.replace(/\\\\/g, "/"), dst, kind, raw: d?.module });
      } else if (d?.module) {
        edges.push({ src: src.replace(/\\\\/g, "/"), dst: `<external>:${d.module}`, kind: "import", raw: d.module });
      }
    }
  }

  process.stdout.write(
    JSON.stringify({
      tool: "dependency-cruiser",
      tool_version: payload?.summary?.cruiseResult?.cruiseOptionsUsed ? "unknown" : "unknown",
      edges,
    })
  );
} catch (e) {
  process.stdout.write(
    JSON.stringify({
      tool: "dependency-cruiser",
      tool_version: null,
      edges: [],
      error: String(e?.message || e),
    })
  );
  process.exit(0);
}
