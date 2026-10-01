import { paths } from "./config.js";

/**
 * Local sentence embeddings via transformers.js (optional dependency).
 * Everything runs on this machine; the model (~25 MB) is downloaded once into ~/.skillbase/models.
 * If the package or model is unavailable, callers fall back to keyword-only search.
 */
export const MODEL = process.env.SKILLBASE_MODEL ?? "Xenova/all-MiniLM-L6-v2";

type Extractor = (texts: string[], opts: Record<string, unknown>) => Promise<{ tolist(): number[][] }>;

let loading: Promise<Extractor | null> | undefined;
let loadError: string | undefined;

export function embeddingsDisabled(): boolean {
  return /^(0|off|false|no)$/i.test(process.env.SKILLBASE_EMBEDDINGS ?? "");
}

export function embedderError(): string | undefined {
  return loadError;
}

async function load(): Promise<Extractor | null> {
  if (embeddingsDisabled()) {
    loadError = "disabled by SKILLBASE_EMBEDDINGS";
    return null;
  }
  try {
    const t: any = await import("@huggingface/transformers");
    t.env.cacheDir = paths.models;
    t.env.allowLocalModels = true;
    const pipe = await t.pipeline("feature-extraction", MODEL, { dtype: "q8" });
    return pipe as Extractor;
  } catch (e) {
    loadError = (e as Error).message?.split("\n")[0] ?? String(e);
    return null;
  }
}

export function getEmbedder(): Promise<Extractor | null> {
  loading ??= load();
  return loading;
}

/** Embed texts into L2-normalised vectors, or null if embeddings are unavailable. */
export async function embed(texts: string[]): Promise<number[][] | null> {
  const ex = await getEmbedder();
  if (!ex) return null;
  const out: number[][] = [];
  const BATCH = 16;
  for (let i = 0; i < texts.length; i += BATCH) {
    const t = await ex(texts.slice(i, i + BATCH), { pooling: "mean", normalize: true });
    for (const v of t.tolist()) out.push(v.map((x) => Math.round(x * 1e5) / 1e5));
  }
  return out;
}

export function cosine(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s; // vectors are normalised
}
