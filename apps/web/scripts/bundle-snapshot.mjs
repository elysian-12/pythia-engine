#!/usr/bin/env node
// Copies data/swarm-snapshot.json → apps/web/public/swarm-snapshot.json
// at build time, so Vercel (which has no filesystem access to the repo
// root) can still serve the most recent swarm run as a static asset.
//
// Falls back to the latest reports/swarm/<ts>/swarm.json if the canonical
// snapshot is missing.

import { promises as fs } from "node:fs";
import path from "node:path";
import { existsSync } from "node:fs";

const webDir = path.resolve(process.cwd());
const repoRoot = path.resolve(webDir, "..", "..");
const srcPrimary = path.join(repoRoot, "data", "swarm-snapshot.json");
const dest = path.join(webDir, "public", "swarm-snapshot.json");

async function latestBacktest() {
  const base = path.join(repoRoot, "reports", "swarm");
  if (!existsSync(base)) return null;
  const entries = await fs.readdir(base, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((n) => /^\d+$/.test(n))
    .sort((a, b) => Number(b) - Number(a));
  for (const d of dirs) {
    const p = path.join(base, d, "swarm.json");
    if (existsSync(p)) return p;
  }
  return null;
}

async function toSnapshotShape(p) {
  const raw = await fs.readFile(p, "utf8");
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    // Raw AgentStats[] from swarm-backtest (pre-snapshot format) — wrap it.
    return {
      generated_at: Math.floor(Date.now() / 1000),
      generation: 0,
      n_agents: parsed.length,
      champion: parsed[0] ?? null,
      agents: parsed,
      recent_decisions: [],
      consensus: { fires: 0 },
      source: "backtest",
    };
  }
  return parsed;
}

async function main() {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  let src = null;
  if (existsSync(srcPrimary)) src = srcPrimary;
  else src = await latestBacktest();
  if (!src) {
    console.warn(
      "[bundle-snapshot] no snapshot or backtest found. " +
        "Run `cargo run -p swarm --bin swarm-backtest` first."
    );
    const empty = {
      generated_at: Math.floor(Date.now() / 1000),
      generation: 0,
      n_agents: 0,
      champion: null,
      agents: [],
      recent_decisions: [],
      consensus: { fires: 0 },
      source: "empty",
    };
    await fs.writeFile(dest, JSON.stringify(empty, null, 2));
    return;
  }
  const snap = await toSnapshotShape(src);
  await fs.writeFile(dest, JSON.stringify(snap, null, 2));
  console.log(
    `[bundle-snapshot] ${path.relative(repoRoot, src)} → public/swarm-snapshot.json (${snap.agents.length} agents)`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
