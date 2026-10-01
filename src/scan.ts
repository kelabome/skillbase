import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { git } from "./git.js";

export interface Skill {
  /** "<source>:<dir relative to repo root>", e.g. "anthropic-skills:pdf" */
  id: string;
  name: string;
  description: string;
  source: string;
  /** Directory relative to the repo root. */
  relDir: string;
  /** Absolute path of the skill folder in the local cache. */
  dir: string;
  author?: string;
  authorEmail?: string;
  contributors: string[];
  created?: string;
  updated?: string;
  lastCommit?: string;
  /** From frontmatter metadata.status, e.g. "deprecated". */
  status?: string;
  replacedBy?: string;
  files: string[];
  body: string;
  hash: string;
}

const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build"]);
const MAX_DEPTH = 6;
const MAX_FILES_LISTED = 60;

/** Find every folder containing a SKILL.md. Nested SKILL.md under a skill are treated as part of it. */
export function findSkillDirs(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === "SKILL.md")) {
      out.push(dir);
      return;
    }
    if (depth >= MAX_DEPTH) return;
    for (const e of entries) if (e.isDirectory() && !SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), depth + 1);
  };
  walk(root, 0);
  return out.sort();
}

export interface Frontmatter {
  name?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
}

export function parseSkillMd(text: string): { fm: Frontmatter; body: string } {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { fm: {}, body: text };
  let fm: Frontmatter = {};
  try {
    fm = (YAML.parse(m[1]) as Frontmatter) ?? {};
  } catch {
    // Tolerate sloppy YAML (e.g. unquoted colons in descriptions): fall back to line parsing.
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
      if (kv) fm[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
    }
  }
  return { fm, body: text.slice(m[0].length) };
}

interface GitFileInfo {
  created?: string;
  updated?: string;
  lastCommit?: string;
  author?: string;
  authorEmail?: string;
  contributors: string[];
}

/**
 * One `git log` for the whole repo, then attribute commits to skill folders.
 * created/author = oldest commit touching the folder; updated = newest.
 */
async function gitInfo(repoRoot: string, relDirs: string[]): Promise<Map<string, GitFileInfo>> {
  const info = new Map<string, GitFileInfo>(relDirs.map((d) => [d, { contributors: [] }]));
  const r = await git(["log", "--no-merges", "--format=%x1e%h%x1f%an%x1f%ae%x1f%aI", "--name-only"], { cwd: repoRoot });
  if (!r.ok) return info;
  // Longest dirs first so a file is attributed to its innermost skill.
  const dirs = [...relDirs].sort((a, b) => b.length - a.length);
  for (const block of r.stdout.split("\x1e")) {
    if (!block.trim()) continue;
    const [header, ...files] = block.split("\n");
    const [hash, an, ae, date] = header.split("\x1f");
    const touched = new Set<string>();
    for (const f of files) {
      if (!f) continue;
      const d = dirs.find((d) => d === "" || f === d || f.startsWith(d + "/"));
      if (d !== undefined) touched.add(d);
    }
    for (const d of touched) {
      const i = info.get(d)!;
      // git log is newest first
      if (!i.updated) {
        i.updated = date;
        i.lastCommit = hash;
      }
      i.created = date;
      i.author = an;
      i.authorEmail = ae;
      if (!i.contributors.includes(an)) i.contributors.push(an);
    }
  }
  return info;
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (out.length >= MAX_FILES_LISTED) return;
      if (SKIP_DIRS.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** Scan one source. `repoRoot` is the git clone, `scanRoot` is where to look (may be a sub-path). */
export async function scanSource(source: string, repoRoot: string, scanRoot = repoRoot): Promise<Skill[]> {
  const dirs = findSkillDirs(scanRoot);
  const relDirs = dirs.map((d) => path.relative(repoRoot, d).split(path.sep).join("/"));
  const gi = await gitInfo(repoRoot, relDirs);
  return dirs.map((dir, i) => {
    const rel = relDirs[i];
    const text = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
    const { fm, body } = parseSkillMd(text);
    const md = (fm.metadata && typeof fm.metadata === "object" ? fm.metadata : {}) as Record<string, unknown>;
    const g = gi.get(rel)!;
    const stat = fs.statSync(path.join(dir, "SKILL.md"));
    const idPath = path.relative(scanRoot, dir).split(path.sep).join("/");
    return {
      id: `${source}:${idPath || path.basename(dir)}`,
      name: str(fm.name) ?? path.basename(dir),
      description: str(fm.description) ?? "",
      source,
      relDir: rel,
      dir,
      author: str(md.owner) ?? str(md.author) ?? str(fm.author) ?? g.author,
      authorEmail: g.authorEmail,
      contributors: g.contributors,
      created: g.created ?? stat.birthtime.toISOString(),
      updated: g.updated ?? stat.mtime.toISOString(),
      lastCommit: g.lastCommit,
      status: str(md.status),
      replacedBy: str(md.replaced_by) ?? str(md.replacedBy),
      files: listFiles(dir),
      body,
      hash: crypto.createHash("sha1").update(text).digest("hex"),
    };
  });
}
