import fs from "node:fs";
import path from "node:path";
import { paths, type Source, loadState, saveState } from "./config.js";
import { git } from "./git.js";

export interface SyncResult {
  name: string;
  ok: boolean;
  commit?: string;
  error?: string;
  /** true when the pull failed but an older clone is still usable */
  stale?: boolean;
}

export function cacheDir(s: Source): string {
  return path.join(paths.cache, s.name);
}

/** Directory to scan for skills: the clone, or a sub-path of it. */
export function scanRoot(s: Source): string {
  return s.path ? path.join(cacheDir(s), s.path) : cacheDir(s);
}

/**
 * Clone or fast-forward one source. The cache is read-only by contract, so we
 * hard-reset to the remote rather than merging.
 */
export async function syncSource(s: Source): Promise<SyncResult> {
  const dir = cacheDir(s);
  const exists = fs.existsSync(path.join(dir, ".git"));
  if (!exists) {
    fs.rmSync(dir, { recursive: true, force: true });
    const args = ["clone", "--quiet", "--no-tags"];
    if (s.branch) args.push("--branch", s.branch);
    const r = await git([...args, s.url, dir]);
    if (!r.ok) return { name: s.name, ok: false, error: firstLine(r.stderr) };
  } else {
    const r = await git(["fetch", "--quiet", "--prune", "--no-tags", "origin"], { cwd: dir });
    if (!r.ok) return { name: s.name, ok: false, stale: true, error: firstLine(r.stderr), commit: await head(dir) };
    const target = s.branch ? `origin/${s.branch}` : await remoteHead(dir);
    const reset = await git(["reset", "--quiet", "--hard", target], { cwd: dir });
    if (!reset.ok) return { name: s.name, ok: false, stale: true, error: firstLine(reset.stderr), commit: await head(dir) };
  }
  return { name: s.name, ok: true, commit: await head(dir) };
}

export async function syncAll(sources: Source[]): Promise<SyncResult[]> {
  const results = await Promise.all(sources.map(syncSource));
  const state = loadState();
  const at = new Date().toISOString();
  state.lastSync = at;
  state.sources = {};
  for (const r of results) state.sources[r.name] = { ok: r.ok, commit: r.commit, error: r.error, at };
  saveState(state);
  // Drop clones of sources that were removed from sources.yaml.
  if (fs.existsSync(paths.cache)) {
    const keep = new Set(sources.map((s) => s.name));
    for (const d of fs.readdirSync(paths.cache)) if (!keep.has(d)) fs.rmSync(path.join(paths.cache, d), { recursive: true, force: true });
  }
  return results;
}

async function head(dir: string): Promise<string | undefined> {
  const r = await git(["rev-parse", "--short", "HEAD"], { cwd: dir });
  return r.ok ? r.stdout.trim() : undefined;
}

async function remoteHead(dir: string): Promise<string> {
  const r = await git(["rev-parse", "--abbrev-ref", "origin/HEAD"], { cwd: dir });
  if (r.ok && r.stdout.trim() && r.stdout.trim() !== "origin/HEAD") return r.stdout.trim();
  const b = await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir });
  return `origin/${b.stdout.trim() || "master"}`;
}

function firstLine(s: string): string {
  const lines = s.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /^(fatal|error)/i.test(l)) ?? lines[0] ?? "git failed";
}
