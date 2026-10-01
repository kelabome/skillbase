import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

export interface Source {
  /** Short unique name, used in skill ids and as the cache directory name. */
  name: string;
  /** Anything `git clone` accepts: ssh/https URL or a local path. */
  url: string;
  /** Branch to track. Defaults to the remote's default branch. */
  branch?: string;
  /** Only look for skills under this sub-directory of the repo. */
  path?: string;
  /**
   * "team" = the default sources.yaml shipped with the package,
   * "extra" = any additional yml file (~/.skillbase/sources.d/*.yml, `include:`, SKILLBASE_SOURCES_PATH),
   * "personal" = ~/.skillbase/sources.yaml itself.
   */
  origin?: "team" | "extra" | "personal";
  /** The yml file this entry was read from. */
  file?: string;
}

/** The skillbase checkout (parent of src/ or dist/). */
export const CHECKOUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const HOME = process.env.SKILLBASE_HOME
  ? path.resolve(process.env.SKILLBASE_HOME)
  : path.join(os.homedir(), ".skillbase");

export const paths = {
  home: HOME,
  sources: path.join(HOME, "sources.yaml"),
  /** Drop any number of *.yaml / *.yml files here; all are loaded (alphabetical order). */
  sourcesDir: path.join(HOME, "sources.d"),
  /** Extra yml files or directories, separated like PATH (":" on Linux/macOS, ";" on Windows). */
  sourcesPath: process.env.SKILLBASE_SOURCES_PATH ?? "",
  cache: path.join(HOME, "cache"),
  index: path.join(HOME, "index.json"),
  state: path.join(HOME, "state.json"),
  models: path.join(HOME, "models"),
  /** Default list, shipped in the package; updated with `npm update -g @kelabome/skillbase` (or `make update` in a checkout). */
  teamSources: process.env.SKILLBASE_TEAM_SOURCES ?? path.join(CHECKOUT, "sources.yaml"),
  logs: process.env.SKILLBASE_LOG_DIR ?? path.join(HOME, "logs"),
};

/** Minutes between automatic `git pull`s done by the MCP server. */
export const SYNC_INTERVAL_MIN = Number(process.env.SKILLBASE_SYNC_INTERVAL ?? 60);

const SOURCES_TEMPLATE = `# YOUR OWN extra skill repositories (on top of the default list shipped with skillbase).
# Each entry is a git repo containing */SKILL.md folders (any depth).
# Add one with:  skillbase sources add <git-url> [--name n] [--branch b] [--path sub/dir]
#
# Want several yml files (per project, per team, ...)? Either:
#   - drop them into ~/.skillbase/sources.d/   (all *.yaml / *.yml there are loaded), or
#   - list them below:  include: [~/work/skills.yml, ./team-skills/]   (a file, or a directory of ymls)
#   - or set SKILLBASE_SOURCES_PATH=/a/one.yml:/b/dir
# Later files override earlier ones by source name; this file wins over all of them.
#
# include: []
# sources:
#   - name: my-skills
#     url: git@github.com:me/my-skills.git
#     # branch: main
#     # path: skills
sources: []
`;

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;

export function ensureHome(): void {
  fs.mkdirSync(paths.cache, { recursive: true });
  if (!fs.existsSync(paths.sources)) fs.writeFileSync(paths.sources, SOURCES_TEMPLATE);
}

function expandPath(p: string, baseDir: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return path.resolve(baseDir, p);
}

/** A file -> [file]; a directory -> its *.yaml / *.yml files, sorted; anything else -> []. */
function ymlFilesIn(p: string): string[] {
  try {
    const st = fs.statSync(p);
    if (st.isFile()) return [p];
    if (st.isDirectory()) {
      return fs
        .readdirSync(p)
        .filter((f) => /\.ya?ml$/i.test(f))
        .sort()
        .map((f) => path.join(p, f))
        .filter((f) => fs.statSync(f).isFile());
    }
  } catch {
    // missing path: handled by the caller
  }
  return [];
}

/** Reads one yml file: its own sources and its `include:` entries (string or list). No recursion here. */
function parseFile(file: string): { sources: Source[]; includes: string[] } {
  if (!fs.existsSync(file)) return { sources: [], includes: [] };
  let doc: any;
  try {
    doc = YAML.parse(fs.readFileSync(file, "utf8")) ?? {};
  } catch (e) {
    throw new Error(`${file}: ${(e as Error).message.split("\n")[0]}`);
  }
  const list: unknown[] = Array.isArray(doc.sources) ? doc.sources : [];
  const inc = doc.include ?? [];
  const includes = (Array.isArray(inc) ? inc : [inc]).filter((x): x is string => typeof x === "string" && !!x.trim());
  const sources: Source[] = [];
  for (const raw of list) {
    const s = raw as Partial<Source>;
    if (!s || typeof s.url !== "string") continue;
    const name = s.name ?? deriveName(s.url);
    if (!NAME_RE.test(name) || sources.some((o) => o.name === name)) {
      throw new Error(`${file}: invalid or duplicate source name "${name}"`);
    }
    sources.push({ name, url: s.url, branch: s.branch, path: s.path });
  }
  return { sources, includes };
}

interface LoadCtx {
  seen: Set<string>;
  files: { file: string; origin: NonNullable<Source["origin"]>; count: number }[];
  missing: string[];
}

const warned = new Set<string>();

/**
 * Loads `entry` (file or directory) and everything it includes. A file's includes come before its own
 * entries, so the file itself wins on a name clash. A file reachable twice is read once (also stops cycles).
 */
function collect(entry: string, origin: NonNullable<Source["origin"]>, ctx: LoadCtx, out: Source[]): void {
  const files = ymlFilesIn(entry);
  if (!files.length && !fs.existsSync(entry)) ctx.missing.push(entry);
  for (const f of files) {
    const real = fs.realpathSync(f);
    if (ctx.seen.has(real)) continue;
    ctx.seen.add(real);
    const { sources, includes } = parseFile(real);
    for (const inc of includes) collect(expandPath(inc, path.dirname(real)), "extra", ctx, out);
    for (const x of sources) out.push({ ...x, origin, file: real });
    ctx.files.push({ file: real, origin, count: sources.length });
  }
}

function resolveAll(): { sources: Source[]; files: LoadCtx["files"] } {
  ensureHome();
  const ctx: LoadCtx = { seen: new Set(), files: [], missing: [] };
  const all: Source[] = [];
  // Precedence, lowest to highest: default list < sources.d < SKILLBASE_SOURCES_PATH < personal sources.yaml.
  collect(paths.teamSources, "team", ctx, all);
  collect(paths.sourcesDir, "extra", ctx, all);
  for (const e of paths.sourcesPath.split(path.delimiter).filter(Boolean)) collect(expandPath(e, process.cwd()), "extra", ctx, all);
  collect(paths.sources, "personal", ctx, all);
  for (const m of ctx.missing) {
    if (warned.has(m)) continue;
    warned.add(m);
    console.error(`[skillbase] sources file not found, skipped: ${m}`);
  }
  const byName = new Map<string, Source>();
  for (const s of all) byName.set(s.name, s); // later wins; keeps the first position
  return { sources: [...byName.values()], files: ctx.files };
}

/** Default + extra files + personal. A later entry with the same name overrides an earlier one. */
export function loadSources(): Source[] {
  return resolveAll().sources;
}

/** Every yml file that was read, in load order, with how many sources each contributed. */
export function loadedSourceFiles(): LoadCtx["files"] {
  return resolveAll().files;
}

/** Only the entries written in ~/.skillbase/sources.yaml itself (not its includes). */
export function loadPersonalSources(): Source[] {
  ensureHome();
  return parseFile(paths.sources).sources.map((s) => ({ ...s, origin: "personal" as const, file: paths.sources }));
}

/** Writes the personal list only; default and extra files are edited by hand. Keeps `include:` intact. */
export function saveSources(sources: Source[]): void {
  ensureHome();
  const doc = YAML.parseDocument(fs.readFileSync(paths.sources, "utf8"));
  doc.set(
    "sources",
    sources
      .filter((s) => s.origin !== "team" && s.origin !== "extra")
      .map((s) => Object.fromEntries(Object.entries({ ...s, origin: undefined, file: undefined }).filter(([, v]) => v !== undefined))),
  );
  fs.writeFileSync(paths.sources, doc.toString());
}

/** The `include:` list of ~/.skillbase/sources.yaml, as written. */
export function loadIncludes(): string[] {
  ensureHome();
  return parseFile(paths.sources).includes;
}

/** Adds (or removes) an entry in the `include:` list of ~/.skillbase/sources.yaml. Returns whether it changed. */
export function setInclude(entry: string, mode: "add" | "remove"): boolean {
  ensureHome();
  const doc = YAML.parseDocument(fs.readFileSync(paths.sources, "utf8"));
  const cur = loadIncludes();
  const same = (a: string, b: string) => a === b || expandPath(a, process.cwd()) === expandPath(b, process.cwd());
  const has = cur.some((c) => same(c, entry));
  if (mode === "add" ? has : !has) return false;
  const next = mode === "add" ? [...cur, entry] : cur.filter((c) => !same(c, entry));
  if (next.length) doc.set("include", next);
  else doc.delete("include");
  fs.writeFileSync(paths.sources, doc.toString());
  return true;
}

/** git@host:org/dev-skills.git -> dev-skills */
export function deriveName(url: string): string {
  const base = url.replace(/[\/\\]+$/, "").split(/[\/:\\]/).pop() ?? "source";
  return base.replace(/\.git$/, "").toLowerCase().replace(/[^a-z0-9._-]/g, "-") || "source";
}

export interface State {
  lastSync?: string;
  sources?: Record<string, { ok: boolean; commit?: string; error?: string; at: string }>;
}

export function loadState(): State {
  try {
    return JSON.parse(fs.readFileSync(paths.state, "utf8"));
  } catch {
    return {};
  }
}

export function saveState(s: State): void {
  ensureHome();
  fs.writeFileSync(paths.state, JSON.stringify(s, null, 2));
}
