import { SYNC_INTERVAL_MIN, type Source, loadSources, loadState } from "./config.js";
import { git } from "./git.js";
import { type Hit, type IndexData, type IndexedSkill, PARAMS, type SearchOptions, Searcher, buildIndex, loadIndex } from "./index.js";
import { logEvent, round } from "./log.js";
import { type SyncResult, cacheDir, syncAll } from "./sources.js";

const log = (m: string) => process.stderr.write(`[skillbase] ${m}\n`);

export interface RefreshResult {
  results: SyncResult[];
  /** sources or their commits differ from what the index was built from */
  changed: boolean;
  rebuilt: boolean;
  skills: number;
}

/** What an index was built from: source definition + checked-out commit, per source. */
export async function fingerprint(sources: Source[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const s of sources) {
    const r = await git(["rev-parse", "HEAD"], { cwd: cacheDir(s) });
    out[s.name] = `${s.url}#${s.branch ?? ""}:${s.path ?? ""}@${r.ok ? r.stdout.trim() : "missing"}`;
  }
  return out;
}

const same = (a: Record<string, string> = {}, b: Record<string, string> = {}) =>
  JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

/** Owns the index for a long-running process (the MCP server) or a one-shot CLI call. */
export class SkillBase {
  private searcher: Searcher | null = null;
  private refreshing: Promise<RefreshResult> | null = null;

  constructor(private quiet = false) {
    const data = loadIndex();
    if (data) this.searcher = new Searcher(data);
  }

  private log(m: string) {
    if (!this.quiet) log(m);
  }

  get data(): IndexData | null {
    return this.searcher?.data ?? null;
  }

  isStale(): boolean {
    const last = loadState().lastSync;
    return !last || Date.now() - Date.parse(last) > SYNC_INTERVAL_MIN * 60_000;
  }

  /**
   * Pull every source (unless pull=false), then rebuild the index only if something changed:
   * a new commit, an added/removed/edited source, or no index yet. force=true always rebuilds.
   * Concurrent callers share one run.
   */
  refresh(opts: { pull?: boolean; force?: boolean; trigger?: string } = {}): Promise<RefreshResult> {
    const { pull = true, force = false, trigger = "manual" } = opts;
    this.refreshing ??= (async () => {
      const t0 = Date.now();
      try {
        const sources = loadSources();
        const results = pull ? await syncAll(sources) : [];
        for (const r of results) if (!r.ok) this.log(`sync ${r.name} failed: ${r.error}${r.stale ? " (using cached copy)" : ""}`);
        const fp = await fingerprint(sources);
        const prev = loadIndex();
        const changed = !prev || !same(prev.builtFrom, fp);
        let rebuilt = false;
        if (changed || force) {
          const data = await buildIndex(sources, (m) => this.log(m), fp);
          this.searcher = new Searcher(data);
          rebuilt = true;
        } else if (!this.searcher && prev) this.searcher = new Searcher(prev);
        const skills = this.searcher?.data.skills.length ?? 0;
        logEvent({
          ev: "sync",
          trigger,
          ms: Date.now() - t0,
          changed,
          rebuilt,
          skills,
          sources: results.map((r) => ({ name: r.name, ok: r.ok, commit: r.commit, error: r.error, stale: r.stale })),
        });
        return { results, changed, rebuilt, skills };
      } catch (e) {
        logEvent({ ev: "error", where: `refresh:${trigger}`, message: (e as Error).message });
        throw e;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  /** Make sure there is an index; kick off a background pull if it is old. */
  async ready(): Promise<Searcher> {
    if (!this.searcher) await (this.refreshing ?? this.refresh({ trigger: "first-use" }));
    else if (this.isStale() && !this.refreshing) this.refresh({ trigger: "auto" }).catch((e) => this.log(`refresh failed: ${e.message}`));
    return this.searcher!;
  }
}

// ---------- logged search / load (shared by CLI and MCP) ----------

const recent: { query: string; at: number; ids: string[] }[] = [];

export async function loggedSearch(searcher: Searcher, query: string, opts: SearchOptions, client: string): Promise<Hit[]> {
  const t0 = Date.now();
  const hits = await searcher.search(query, opts);
  recent.unshift({ query, at: Date.now(), ids: hits.flatMap((h) => [h.skill.id, ...h.similar.map((x) => x.id)]) });
  recent.length = Math.min(recent.length, 20);
  logEvent({
    ev: "search",
    client,
    query,
    limit: opts.limit ?? 5,
    source: opts.source,
    mode: searcher.data.model ? "semantic" : "keyword",
    ms: Date.now() - t0,
    pool: searcher.data.skills.length,
    params: PARAMS,
    hits: hits.map((h, i) => ({
      rank: i + 1,
      id: h.skill.id,
      score: round(h.score),
      head: round(h.parts.head),
      chunk: round(h.parts.chunk),
      keyword: round(h.parts.keyword),
      similar: h.similar.map((x) => x.id),
    })),
  });
  return hits;
}

export function loggedGet(searcher: Searcher, id: string, client: string): IndexedSkill | undefined {
  const skill = searcher.get(id);
  // Was this skill offered by a recent search? That pairing (query -> chosen skill) is the tuning signal.
  let fromSearch: { query: string; rank: number; ageSec: number } | undefined;
  if (skill) {
    for (const r of recent) {
      const i = r.ids.indexOf(skill.id);
      if (i >= 0) {
        fromSearch = { query: r.query, rank: i + 1, ageSec: Math.round((Date.now() - r.at) / 1000) };
        break;
      }
    }
  }
  logEvent({ ev: "get_skill", client, id: skill?.id ?? id, found: !!skill, fromSearch });
  return skill;
}

// ---------- formatting shared by CLI and MCP ----------

const day = (iso?: string) => (iso ? iso.slice(0, 10) : "?");

export function formatHits(hits: Hit[], query: string): string {
  if (!hits.length) return `No shared skills matched "${query}".`;
  const lines = [`Shared skills matching "${query}" (best first):`, ""];
  hits.forEach((h, i) => {
    const s = h.skill;
    const sim = h.similarity !== undefined ? ` · match ${(h.similarity * 100).toFixed(0)}%` : "";
    lines.push(`${i + 1}. ${s.name}  [id: ${s.id}]${sim}`);
    lines.push(`   ${truncate(s.description || "(no description)", 300)}`);
    lines.push(`   author: ${s.author ?? "unknown"} · created ${day(s.created)} · updated ${day(s.updated)} · source: ${s.source}`);
    if (s.status) lines.push(`   status: ${s.status}${s.replacedBy ? ` → use ${s.replacedBy}` : ""}`);
    if (h.similar.length) {
      lines.push(`   ${h.similar.length} similar: ` + h.similar.map((o) => `${o.id} (${o.author ?? "?"}, ${day(o.updated)})`).join("; "));
    }
    lines.push("");
  });
  return lines.join("\n").trimEnd();
}

export function formatSkill(s: IndexedSkill): string {
  const meta = [
    `# Shared skill: ${s.name}`,
    `id: ${s.id}`,
    `source: ${s.source} (${s.relDir || "."})`,
    `author: ${s.author ?? "unknown"}${s.authorEmail ? ` <${s.authorEmail}>` : ""}${s.contributors.length > 1 ? ` · contributors: ${s.contributors.join(", ")}` : ""}`,
    `created: ${day(s.created)} · updated: ${day(s.updated)}${s.lastCommit ? ` · commit ${s.lastCommit}` : ""}`,
    s.status ? `status: ${s.status}${s.replacedBy ? ` → use ${s.replacedBy}` : ""}` : "",
    `folder: ${s.dir}`,
    `files: ${s.files.join(", ")}`,
    "",
    `Relative paths in this skill (scripts, references) are relative to the folder above.`,
    `The folder is a read-only cache managed by skillbase: use the files, do not edit them.`,
    "",
    "---- SKILL.md ----",
  ].filter((l, i) => l !== "" || i > 5);
  return meta.join("\n") + "\n" + s.body.trim() + "\n";
}

function truncate(s: string, n: number) {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}
