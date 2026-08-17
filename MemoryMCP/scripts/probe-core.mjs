#!/usr/bin/env node
/** Optional live Core evidence. Never fails the P0 gate. */
import { writeFileSync, mkdirSync } from "node:fs";

const scratch =
  process.env.TDAI_VERIFY_SCRATCH ||
  "/var/folders/nq/w629yzfx38qcyxx4rztxzc5w0000gn/T/grok-goal-2a07e6ebbd73/implementer";
mkdirSync(scratch, { recursive: true });
const out = `${scratch}/core-skip.log`;

const endpoint = process.env.TDAI_ENDPOINT || "http://127.0.0.1:8420";
try {
  const res = await fetch(`${endpoint.replace(/\/+$/, "")}/health`, {
    signal: AbortSignal.timeout(2000),
  });
  const text = await res.text();
  if (!res.ok) {
    writeFileSync(out, `Core ${endpoint} health HTTP ${res.status}\n${text}\n`);
    process.exit(0);
  }
  writeFileSync(
    `${scratch}/core-health.log`,
    `Core healthy at ${endpoint}\n${text}\nTwo-scope live probe skipped: P0 gate uses HTTP stand-in fixtures.\n`,
  );
  writeFileSync(out, "Core is up; two-scope live seed probe not run in this P0 gate (stand-in covers isolation contract in unit/e2e stand-in).\n");
} catch (err) {
  writeFileSync(out, `Core ${endpoint} unreachable: ${err instanceof Error ? err.message : String(err)}\n`);
}
