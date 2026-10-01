/**
 * Retrieval eval: realistic task phrasings -> the skill name(s) that should come back.
 * Run against whatever index SKILLBASE_HOME points at:  SKILLBASE_HOME=... npm run eval
 * Queries are written the way a person asks, deliberately NOT copying the descriptions.
 */
import { loadIndex, Searcher } from "../src/index.js";

export const CASES: [string, string[]][] = [
  ["make a powerpoint deck", ["pptx"]],
  ["extract form fields from a pdf", ["pdf"]],
  ["build a spreadsheet with formulas", ["xlsx"]],
  ["write a word document with a table of contents", ["docx"]],
  ["create a new skill and test its triggering", ["skill-creator"]],
  ["build an MCP server that wraps a REST API", ["mcp-builder"]],
  ["test my local web app with playwright and take screenshots", ["webapp-testing"]],
  ["design a distinctive, polished landing page UI", ["frontend-design"]],
  ["make an animated gif for slack", ["slack-gif-creator"]],
  ["apply our brand colors and fonts to this document", ["brand-guidelines"]],
  ["help me think through the design before writing any code", ["brainstorming"]],
  ["write the failing test first, then implement", ["test-driven-development"]],
  ["this bug keeps coming back, find the root cause", ["systematic-debugging"]],
  ["turn this spec into a step by step implementation plan", ["writing-plans"]],
  ["isolate my work in a separate git worktree", ["using-git-worktrees"]],
  ["check my work is really done before I claim it passes", ["verification-before-completion"]],
  ["review my diff before I merge", ["requesting-code-review"]],
  ["speed up a slow react component and fix rerenders", ["react-best-practices"]],
  ["audit this UI against web interface guidelines", ["web-design-guidelines"]],
  ["deploy this app to vercel", ["deploy-to-vercel"]],
];

async function main() {
  const data = loadIndex();
  if (!data) throw new Error("no index; run skillbase sync first");
  if (process.argv.includes("--keyword")) data.model = null;
  const s = new Searcher(data);
  let top1 = 0, top3 = 0, top5 = 0;
  const misses: string[] = [];
  for (const [q, want] of CASES) {
    const hits = await s.search(q, { limit: 5 });
    const names = hits.map((h) => (want.includes(h.skill.relDir.split("/").pop()!) ? h.skill.relDir.split("/").pop()! : h.skill.name));
    const rank = names.findIndex((n) => want.includes(n));
    if (rank === 0) top1++;
    if (rank >= 0 && rank < 3) top3++;
    if (rank >= 0) top5++;
    if (rank !== 0) misses.push(`${rank < 0 ? "MISS" : "#" + (rank + 1)}  "${q}" want ${want.join("|")} got ${names.slice(0, 3).join(", ")}`);
  }
  const n = CASES.length;
  const pct = (x: number) => `${((x / n) * 100).toFixed(0)}%`;
  console.log(`mode: ${data.model ?? "keyword only"} · ${data.skills.length} skills · ${n} queries`);
  console.log(`top1 ${pct(top1)}  top3 ${pct(top3)}  top5 ${pct(top5)}`);
  if (process.argv.includes("-v")) for (const m of misses) console.log("  " + m);
}

main();
