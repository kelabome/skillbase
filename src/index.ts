import fs from "node:fs";
import MiniSearch from "minisearch";
import { paths, type Source } from "./config.js";
import { MODEL, cosine, embed, embedderError } from "./embed.js";
import { logEvent } from "./log.js";
import { scanSource, type Skill } from "./scan.js";
import { cacheDir, scanRoot } from "./sources.js";

const INDEX_VERSION = 1;

export interface Vectors {
  /** name + description */
  d: number[];
  /** body chunks */
  c: number[][];
}

export interface IndexedSkill extends Skill {
  vec?: Vectors;
}

export interface IndexData {
  version: number;
  builtAt: string;
  model: string | null;
  embeddingError?: string;
  /** source fingerprint the index was built from; used to skip rebuilds when nothing changed */
  builtFrom?: Record<string, string>;
  skills: IndexedSkill[];
}

// ---------- build ----------

const CHUNK_CHARS = 900;
const MAX_CHUNKS = 8;

function plain(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, (b) => b.slice(0, 300)) // keep a little of code blocks (commands are signal)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`|]+/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

export function chunks(body: string): string[] {
  const text = plain(body);
  const out: string[] = [];
  let cur = "";
  for (const para of text.split("\n")) {
    if (cur && cur.length + para.length > CHUNK_CHARS) {
      out.push(cur);
      cur = "";
      if (out.length >= MAX_CHUNKS) break;
    }
    cur += (cur ? "\n" : "") + para.slice(0, CHUNK_CHARS);
  }
  if (cur && out.length < MAX_CHUNKS) out.push(cur);
  return out;
}

export function headText(s: Pick<Skill, "name" | "description">): string {
  return `${s.name.replace(/[-_]/g, " ")}: ${s.description}`;
}

export async function buildIndex(
  sources: Source[],
  log: (m: string) => void = () => {},
  builtFrom?: Record<string, string>,
): Promise<IndexData> {
  const t0 = Date.now();
  const previous = loadIndex();
  const prevById = new Map((previous?.model === MODEL ? previous.skills : []).map((s) => [s.id, s]));

  const skills: IndexedSkill[] = [];
  for (const s of sources) {
    if (!fs.existsSync(cacheDir(s))) {
      log(`skip ${s.name}: not cloned`);
      continue;
    }
    const found = await scanSource(s.name, cacheDir(s), scanRoot(s));
    log(`${s.name}: ${found.length} skills`);
    skills.push(...found);
  }

  const todo = skills.filter((s) => {
    const p = prevById.get(s.id);
    if (p?.vec && p.hash === s.hash) {
      s.vec = p.vec;
      return false;
    }
    return true;
  });

  let model: string | null = MODEL;
  if (todo.length) {
    log(`embedding ${todo.length} new/changed skills...`);
    const texts: string[] = [];
    const spans: [number, number][] = [];
    for (const s of todo) {
      const c = chunks(s.body);
      spans.push([texts.length, c.length]);
      texts.push(headText(s), ...c);
    }
    const vecs = await embed(texts);
    if (vecs) {
      todo.forEach((s, i) => {
        const [start, n] = spans[i];
        s.vec = { d: vecs[start], c: vecs.slice(start + 1, start + 1 + n) };
      });
    } else {
      model = null;
      log(`embeddings unavailable (${embedderError()}); keyword search only`);
    }
  }
  if (model === null) for (const s of skills) delete s.vec;

  const data: IndexData = {
    version: INDEX_VERSION,
    builtAt: new Date().toISOString(),
    model,
    embeddingError: model ? undefined : embedderError(),
    builtFrom,
    skills,
  };
  fs.mkdirSync(paths.home, { recursive: true });
  const tmp = paths.index + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, paths.index);
  logEvent({ ev: "index", ms: Date.now() - t0, skills: skills.length, embedded: model ? todo.length : 0, model, embeddingError: data.embeddingError });
  return data;
}

export function loadIndex(): IndexData | null {
  try {
    const d = JSON.parse(fs.readFileSync(paths.index, "utf8")) as IndexData;
    return d.version === INDEX_VERSION ? d : null;
  } catch {
    return null;
  }
}

// ---------- search ----------

export interface SearchOptions {
  limit?: number;
  source?: string;
  includeDeprecated?: boolean;
}

export interface Hit {
  skill: IndexedSkill;
  score: number;
  /** cosine similarity to the query, 0..1, when embeddings are available */
  similarity?: number;
  /** ranking components, logged so search parameters can be tuned from real usage */
  parts: { head?: number; chunk?: number; keyword?: number };
  /** near-duplicates folded under this hit */
  similar: IndexedSkill[];
}

/** share of similarity from the name+description vector vs the best body chunk */
const HEAD_WEIGHT = Number(process.env.SKILLBASE_HEAD_WEIGHT ?? 0.25);
const KEYWORD_WEIGHT = Number(process.env.SKILLBASE_KEYWORD_WEIGHT ?? 0.05);
const BODY_BOOST = 0.3;
const DUP_THRESHOLD = 0.93;

/** Current search parameters, recorded with every logged search. */
export const PARAMS = { headWeight: HEAD_WEIGHT, keywordWeight: KEYWORD_WEIGHT, bodyBoost: BODY_BOOST, dupThreshold: DUP_THRESHOLD };

export class Searcher {
  private mini: MiniSearch;
  private byId: Map<string, IndexedSkill>;

  constructor(public data: IndexData) {
    this.byId = new Map(data.skills.map((s) => [s.id, s]));
    this.mini = new MiniSearch({
      fields: ["name", "description", "body"],
      idField: "id",
      extractField: (doc: any, f) => (f === "name" ? String(doc.name).replace(/[-_]/g, " ") : doc[f]),
      searchOptions: { boost: { name: 3, description: 2, body: BODY_BOOST }, fuzzy: 0.15, prefix: true, combineWith: "OR" },
    });
    this.mini.addAll(data.skills);
  }

  get(id: string): IndexedSkill | undefined {
    return this.byId.get(id) ?? this.data.skills.find((s) => s.name === id || s.id.endsWith(":" + id));
  }

  async search(query: string, opts: SearchOptions = {}): Promise<Hit[]> {
    const limit = opts.limit ?? 5;
    const pool = this.data.skills.filter(
      (s) => (!opts.source || s.source === opts.source) && (opts.includeDeprecated || s.status !== "deprecated"),
    );
    const allowed = new Set(pool.map((s) => s.id));

    const kw = this.mini.search(query).filter((r) => allowed.has(String(r.id)));

    // semantic ranks
    const sim = new Map<string, number>();
    const parts = new Map<string, { head: number; chunk: number }>();
    if (this.data.model) {
      const q = (await embed([query]))?.[0];
      if (q) {
        for (const s of pool) {
          if (!s.vec) continue;
          const d = cosine(q, s.vec.d);
          const c = s.vec.c.length ? Math.max(...s.vec.c.map((v) => cosine(q, v))) : 0;
          sim.set(s.id, HEAD_WEIGHT * d + (1 - HEAD_WEIGHT) * c);
          parts.set(s.id, { head: d, chunk: c });
        }
      }
    }

    // Semantic similarity dominates; keyword score (normalised to the best hit) is a small bonus.
    // Tuned with test/eval.ts: keyword-heavy blends let long catch-all skills win every query.
    const kwMax = kw[0]?.score ?? 1;
    const kwScore = new Map(kw.map((r) => [String(r.id), r.score / kwMax]));
    const scored: { s: IndexedSkill; score: number }[] = [];
    for (const s of pool) {
      const k = kwScore.get(s.id);
      const m = sim.get(s.id);
      if (k === undefined && (m === undefined || m < 0.2)) continue;
      const score = sim.size ? (1 - KEYWORD_WEIGHT) * (m ?? 0) + KEYWORD_WEIGHT * (k ?? 0) : (k ?? 0);
      scored.push({ s, score });
    }
    scored.sort((a, b) => b.score - a.score);

    // Fold near-duplicates into the best-scoring representative.
    const hits: Hit[] = [];
    for (const { s, score } of scored.slice(0, limit * 6)) {
      const g = hits.find((h) => isDuplicate(h.skill, s));
      if (g) g.similar.push(s);
      else if (hits.length < limit) hits.push({ skill: s, score, similarity: sim.get(s.id), parts: { ...parts.get(s.id), keyword: kwScore.get(s.id) }, similar: [] });
    }
    return hits;
  }
}

export function isDuplicate(a: IndexedSkill, b: IndexedSkill): boolean {
  if (a.hash === b.hash) return true;
  if (a.vec && b.vec) {
    const d = cosine(a.vec.d, b.vec.d);
    if (d >= DUP_THRESHOLD) return true;
    if (a.name === b.name && a.vec.c[0] && b.vec.c[0] && cosine(a.vec.c[0], b.vec.c[0]) >= 0.85) return true;
    return false;
  }
  return a.name === b.name;
}
