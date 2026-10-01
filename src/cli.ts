#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import { CHECKOUT, deriveName, loadPersonalSources, loadSources, loadState, loadedSourceFiles, paths, saveSources, setInclude } from "./config.js";

import { MODEL, embeddingsDisabled, embedderError, getEmbedder } from "./embed.js";
import { git } from "./git.js";
import { logEvent } from "./log.js";
import { closePrompt, confirm, setAssumeYes } from "./prompt.js";
import { SkillBase, formatHits, formatSkill, loggedGet, loggedSearch } from "./service.js";
import { AGENTS, AGENT_LABEL, type Agent, isInstalled, isRegistered, setupAgent } from "./setup.js";

const HELP = `skillbase - search shared git skill repos from Claude Code, Codex and OpenCode

  skillbase setup [--yes] [--agent a,b]   connect to your agents (asks one by one), then build the index
  skillbase remove [--yes]                disconnect from your agents (asks one by one)
  skillbase uninstall [--yes]             remove + optionally delete ${paths.home}
  skillbase fresh [--force]               pull all skill repos; rebuild the index only if anything changed
  skillbase search <task words...> [--limit n] [--source name]
  skillbase get <id>                      print one skill as the agent receives it
  skillbase sources                       list sources (default + extra files + yours)
  skillbase sources add <git-url> [--name n] [--branch b] [--path sub/dir]
  skillbase sources remove <name>
  skillbase sources files                 list every yml file being read
  skillbase sources include <file|dir>    also read another yml file (or a folder of ymls)
  skillbase sources uninclude <file|dir>
  skillbase status                        check git access, index, embeddings, agents
  skillbase serve                         the MCP server (your agent starts this)

Default sources: ${paths.teamSources}
Your sources: ${paths.sources}
More ymls:    ${paths.sourcesDir}/*.yml, "include:" in your sources, or SKILLBASE_SOURCES_PATH
Usage logs:   ${paths.logs}`;

const BOOL = new Set(["dry-run", "remove", "no-pull", "json", "yes", "y", "force"]);

function flags(argv: string[]) {
  const pos: string[] = [];
  const opt: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-y") opt.yes = true;
    else if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) opt[k] = v;
      else if (!BOOL.has(k) && argv[i + 1] && !argv[i + 1].startsWith("-")) opt[k] = argv[++i];
      else opt[k] = true;
    } else pos.push(a);
  }
  return { pos, opt };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opt } = flags(rest);
  setAssumeYes(!!opt.yes);

  switch (cmd) {
    case "serve": {
      const { serve } = await import("./server.js");
      return serve();
    }
    case "setup":
      return setup(typeof opt.agent === "string" ? (opt.agent.split(",") as Agent[]) : undefined, !!opt["dry-run"]);
    case "remove":
      return remove();
    case "uninstall":
      return uninstall();
    case "fresh":
    case "sync":
      return fresh({ pull: !opt["no-pull"], force: !!opt.force });
    case "sources":
      return sources(pos, opt);
    case "search": {
      if (!pos.length) throw new Error("usage: skillbase search <task words...>");
      const s = await new SkillBase(true).ready();
      const q = pos.join(" ");
      const hits = await loggedSearch(s, q, { limit: opt.limit ? Number(opt.limit) : 5, source: opt.source as string | undefined }, "cli");
      if (opt.json) console.log(JSON.stringify(hits.map((h) => ({ id: h.skill.id, score: h.score, ...h.parts, similar: h.similar.map((x) => x.id) })), null, 2));
      else console.log(formatHits(hits, q));
      return;
    }
    case "get": {
      const s = await new SkillBase(true).ready();
      const skill = loggedGet(s, pos[0] ?? "", "cli");
      if (!skill) throw new Error(`no skill "${pos[0]}"`);
      return console.log(formatSkill(skill));
    }
    case "status":
    case "doctor":
      return status();
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return console.log(HELP);
    default:
      throw new Error(`unknown command "${cmd}"\n\n${HELP}`);
  }
}

// ---------- setup / remove ----------

async function setup(only?: Agent[], dryRun = false) {
  for (const a of only ?? []) if (!AGENTS.includes(a)) throw new Error(`unknown agent ${a}; use ${AGENTS.join(",")}`);
  console.log("Connect skillbase to your coding agents. Your own local skills are not touched.\n");
  let connected = 0;
  for (const a of only ?? AGENTS) {
    const label = AGENT_LABEL[a];
    if (!isInstalled(a)) {
      console.log(`- ${label}: not installed, skipped`);
      continue;
    }
    const reg = isRegistered(a);
    const yes = await confirm(reg ? `- ${label}: already connected. Update it?` : `- ${label}: connect skillbase?`, true);
    if (!yes) {
      if (reg) connected++;
      continue;
    }
    const r = setupAgent(a, { dryRun });
    logEvent({ ev: "setup", action: "add", agent: a, status: r.status });
    console.log(`    ${r.status}: ${r.detail}`);
    if (r.status === "added") connected++;
  }
  if (dryRun) return;

  console.log("");
  if (!loadSources().length) {
    console.log(`No skill repos configured yet. Add one with:\n  skillbase sources add <git-url>\nor edit the default list in ${paths.teamSources}`);
  } else {
    const firstRun = !fs.existsSync(paths.models);
    console.log(`Fetching skill repos and building the search index${firstRun ? " (first run downloads a ~25 MB model)" : ""}...`);
    await fresh({ pull: true, force: false });
  }
  if (connected) console.log(`\nDone. Restart your agent, then ask e.g.: "check the shared skills for <your task>"`);
}

async function remove(): Promise<number> {
  const registered = AGENTS.filter((a) => isRegistered(a));
  if (!registered.length) {
    console.log("skillbase is not connected to any agent.");
    return 0;
  }
  let removed = 0;
  for (const a of registered) {
    if (!(await confirm(`- ${AGENT_LABEL[a]}: disconnect skillbase?`, true))) continue;
    const r = setupAgent(a, { remove: true });
    logEvent({ ev: "setup", action: "remove", agent: a, status: r.status });
    console.log(`    ${r.status}: ${r.detail}`);
    if (r.status === "removed") removed++;
  }
  return removed;
}

async function uninstall() {
  await remove();
  if (fs.existsSync(paths.home)) {
    const personal = loadPersonalSources().length;
    const note = personal ? ` (includes your ${personal} personal source entr${personal === 1 ? "y" : "ies"})` : "";
    if (await confirm(`Delete ${paths.home}: cloned repos, index, model${note}?`, true)) {
      fs.rmSync(paths.home, { recursive: true, force: true });
      console.log(`    deleted ${paths.home}`);
    }
  }
  console.log(`\nskillbase is disconnected. If you installed it with npm, remove the command with: npm uninstall -g @kelabome/skillbase`);
}

// ---------- fresh ----------

async function fresh(o: { pull: boolean; force: boolean }) {
  const sb = new SkillBase(false);
  const r = await sb.refresh({ pull: o.pull, force: o.force, trigger: "cli" });
  for (const x of r.results) console.log(`  ${x.name.padEnd(22)} ${x.ok ? `ok @ ${x.commit}` : `FAILED: ${x.error}${x.stale ? " (using cached copy)" : ""}`}`);
  const d = sb.data;
  const mode = d?.model ? "semantic + keyword" : `keyword only${d?.embeddingError ? ` (${d.embeddingError})` : ""}`;
  console.log(r.rebuilt ? `Index rebuilt: ${r.skills} skills · ${mode}` : `No changes. Index is up to date: ${r.skills} skills · ${mode}`);
}

// ---------- sources ----------

async function sources(pos: string[], opt: Record<string, string | boolean>) {
  const all = loadSources();
  const sub = pos[0] ?? "list";
  if (sub === "list") {
    const st = loadState().sources ?? {};
    if (!all.length) return console.log(`No sources yet. Add one:  skillbase sources add <git-url>`);
    for (const s of all) {
      const x = st[s.name];
      const sync = x ? (x.ok ? `ok ${x.commit} @ ${x.at.slice(0, 16)}` : `FAILED: ${x.error}`) : "not synced";
      const where = s.origin === "extra" && s.file ? `extra:${path.basename(s.file)}` : (s.origin ?? "personal");
      console.log(`${where.padEnd(20)}  ${s.name.padEnd(22)} ${s.url}${s.branch ? `#${s.branch}` : ""}${s.path ? ` (${s.path})` : ""}  ${sync}`);
    }
    return;
  }
  if (sub === "files") {
    for (const f of loadedSourceFiles()) console.log(`${f.origin.padEnd(8)}  ${String(f.count).padStart(3)} source${f.count === 1 ? " " : "s"}  ${f.file}`);
    return;
  }
  if (sub === "include" || sub === "uninclude") {
    const target = pos[1];
    if (!target) throw new Error(`usage: skillbase sources ${sub} <file-or-dir>`);
    // Store ~ paths as written; make relative paths absolute so they do not depend on the current directory.
    const entry = target.startsWith("~") ? target : path.resolve(target);
    if (sub === "include" && !fs.existsSync(entry.startsWith("~") ? entry.replace(/^~/, process.env.HOME ?? "~") : entry)) {
      throw new Error(`${target} does not exist`);
    }
    const changed = setInclude(entry, sub === "include" ? "add" : "remove");
    console.log(changed ? `${sub === "include" ? "Now reading" : "No longer reading"} ${entry}` : `${entry} was ${sub === "include" ? "already included" : "not included"}`);
    if (changed) return fresh({ pull: sub === "include", force: false });
    return;
  }
  const personal = loadPersonalSources();
  if (sub === "add") {
    const url = pos[1];
    if (!url) throw new Error("usage: skillbase sources add <git-url> [--name n] [--branch b] [--path p]");
    const name = typeof opt.name === "string" ? opt.name : deriveName(url);
    if (all.some((s) => s.name === name)) throw new Error(`source "${name}" already exists (use --name)`);
    personal.push({ name, url, branch: opt.branch as string | undefined, path: opt.path as string | undefined });
    saveSources(personal);
    console.log(`Added ${name} to ${paths.sources}`);
    return fresh({ pull: true, force: false });
  }
  if (sub === "remove" || sub === "rm") {
    const name = pos[1];
    if (!personal.some((s) => s.name === name)) {
      const other = all.find((s) => s.name === name);
      if (other) throw new Error(`"${name}" comes from ${other.file ?? paths.teamSources}; edit that file instead`);
      throw new Error(`no source named "${name}"`);
    }
    saveSources(personal.filter((s) => s.name !== name));
    console.log(`Removed ${name}`);
    return fresh({ pull: false, force: false });
  }
  throw new Error(`unknown: sources ${sub}`);
}

// ---------- status ----------

async function status() {
  const ok = (b: boolean | undefined) => (b ? "ok  " : b === false ? "FAIL" : "--  ");
  const v = process.versions.node;
  console.log(`${ok(Number(v.split(".")[0]) >= 20)} node ${v}`);
  const g = await git(["--version"]);
  console.log(`${ok(g.ok)} ${g.ok ? g.stdout.trim() : "git not found"}`);
  console.log(`     checkout ${CHECKOUT}`);
  console.log(`     data     ${paths.home}`);
  console.log(`     logs     ${paths.logs}`);

  const all = loadSources();
  if (!all.length) console.log(`FAIL no sources (skillbase sources add <git-url>)`);
  for (const s of all) {
    const r = await git(["ls-remote", "--heads", s.url], { timeoutMs: 30_000 });
    console.log(`${ok(r.ok)} ${s.origin} source ${s.name}: ${r.ok ? "reachable" : r.stderr.split("\n").find((l) => /fatal|denied|error/i.test(l)) ?? "unreachable"}`);
  }

  const d = fs.existsSync(paths.index) ? new SkillBase(true).data : null;
  const st = loadState();
  console.log(`${ok(!!d)} index ${d ? `${d.skills.length} skills, built ${d.builtAt.slice(0, 16)}, last pull ${st.lastSync?.slice(0, 16) ?? "never"}` : "missing (skillbase fresh)"}`);

  if (embeddingsDisabled()) console.log(`--   embeddings disabled (SKILLBASE_EMBEDDINGS)`);
  else {
    const e = await getEmbedder();
    console.log(`${ok(!!e)} embeddings ${e ? MODEL : `unavailable: ${embedderError()} (keyword search still works)`}`);
  }

  for (const a of AGENTS) {
    if (!isInstalled(a)) {
      console.log(`--   ${AGENT_LABEL[a]}: not installed`);
      continue;
    }
    const r = isRegistered(a);
    console.log(`${ok(r)} ${AGENT_LABEL[a]}: ${r ? "connected" : "not connected (skillbase setup)"}`);
  }
}

main()
  .then(() => {
    if (process.argv[2] !== "serve") closePrompt();
  })
  .catch((e) => {
  closePrompt();
  logEvent({ ev: "error", where: `cli:${process.argv[2] ?? ""}`, message: e.message });
  console.error(`skillbase: ${e.message}`);
  process.exit(1);
});
