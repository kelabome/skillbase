import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { paths } from "./config.js";

/**
 * Usage log: one JSON object per line in <data dir>/logs/skillbase-YYYY-MM-DD.jsonl.
 * Written so the logs can be shared (`make logs`, or tar the folder) and replayed to tune search:
 * every search records the query, the ranking components of each hit, and later
 * which of them the user actually loaded.
 *
 * Contains search queries. It never contains skill bodies, file contents or credentials.
 * Disable with SKILLBASE_LOG=off.
 */
const KEEP_DAYS = 30;
const disabled = /^(0|off|false|no)$/i.test(process.env.SKILLBASE_LOG ?? "");
const session = Math.random().toString(36).slice(2, 10);
let pruned = false;

export type LogEvent =
  | { ev: "search"; client?: string; query: string; limit: number; source?: string; mode: string; ms: number; hits: unknown[]; pool: number; params: unknown }
  | { ev: "get_skill"; client?: string; id: string; found: boolean; fromSearch?: { query: string; rank: number; ageSec: number } }
  | { ev: "sync"; trigger: string; ms: number; changed: boolean; rebuilt: boolean; skills: number; sources: unknown[] }
  | { ev: "index"; ms: number; skills: number; embedded: number; model: string | null; embeddingError?: string }
  | { ev: "server_start"; client?: string; version: string }
  | { ev: "setup"; action: string; agent: string; status: string }
  | { ev: "error"; where: string; message: string };

export function logEvent(e: LogEvent): void {
  if (disabled) return;
  try {
    fs.mkdirSync(paths.logs, { recursive: true });
    const now = new Date();
    const file = path.join(paths.logs, `skillbase-${now.toISOString().slice(0, 10)}.jsonl`);
    const line = JSON.stringify({ t: now.toISOString(), user: os.userInfo().username, host: os.hostname(), pid: process.pid, session, ...e });
    fs.appendFileSync(file, line + "\n");
    if (!pruned) prune();
  } catch {
    // logging must never break the tool
  }
}

function prune() {
  pruned = true;
  const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
  for (const f of fs.readdirSync(paths.logs)) {
    const m = /^skillbase-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
    if (m && Date.parse(m[1]) < cutoff) fs.rmSync(path.join(paths.logs, f), { force: true });
  }
}

export const round = (x: number | undefined, d = 4) => (x === undefined ? undefined : Math.round(x * 10 ** d) / 10 ** d);
