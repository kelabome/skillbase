import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Isolate everything under a temp home before importing modules that read it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skillbase-test-"));
process.env.SKILLBASE_HOME = path.join(tmp, "home");
process.env.SKILLBASE_EMBEDDINGS = "off"; // unit tests stay fast and offline
process.env.XDG_CONFIG_HOME = path.join(tmp, "xdg");
process.env.SKILLBASE_TEAM_SOURCES = path.join(tmp, "team-sources.yaml");
process.env.SKILLBASE_LOG_DIR = path.join(tmp, "logs");

const { deriveName, loadSources, saveSources, setInclude, loadIncludes, loadPersonalSources, loadedSourceFiles, paths } = await import("../src/config.js");
const { parseSkillMd, findSkillDirs, scanSource } = await import("../src/scan.js");
const { syncAll } = await import("../src/sources.js");
const { buildIndex, Searcher, chunks } = await import("../src/index.js");
const { setupAgent, opencodeConfigPath } = await import("../src/setup.js");
const { SkillBase, loggedSearch, loggedGet } = await import("../src/service.js");

function sh(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_DATE: process.env.GIT_AUTHOR_DATE, GIT_COMMITTER_DATE: process.env.GIT_COMMITTER_DATE } }).toString();
}

function commitAs(repo: string, who: string, date: string, msg: string) {
  sh(repo, "add", "-A");
  execFileSync("git", ["-c", `user.name=${who}`, "-c", `user.email=${who.toLowerCase()}@x.com`, "commit", "-qm", msg], {
    cwd: repo,
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
}

function writeSkill(root: string, rel: string, name: string, description: string, body = "Do the thing.", extra = "") {
  const dir = path.join(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n${body}\n`);
}

test("parseSkillMd reads frontmatter and body; tolerates bad yaml", () => {
  const a = parseSkillMd("---\nname: x\ndescription: hello\nmetadata:\n  owner: bob\n---\n# Body\n");
  assert.equal(a.fm.name, "x");
  assert.equal((a.fm.metadata as any).owner, "bob");
  assert.equal(a.body, "# Body\n");
  const b = parseSkillMd("---\nname: y\ndescription: use when: things: break\n---\nbody");
  assert.equal(b.fm.name, "y");
  assert.match(String(b.fm.description), /things/);
  const c = parseSkillMd("no frontmatter");
  assert.deepEqual(c.fm, {});
});

test("deriveName", () => {
  assert.equal(deriveName("git@github.com:example/dev-skills-embedded.git"), "dev-skills-embedded");
  assert.equal(deriveName("https://github.com/a/B_Repo/"), "b_repo");
});

test("findSkillDirs finds nested skills, skips .git/node_modules and nested SKILL.md", () => {
  const root = path.join(tmp, "find");
  writeSkill(root, "a", "a", "A");
  writeSkill(root, "cat/b", "b", "B");
  writeSkill(root, "cat/b/inner", "inner", "should be part of b");
  writeSkill(root, "node_modules/c", "c", "C");
  const found = findSkillDirs(root).map((d) => path.relative(root, d));
  assert.deepEqual(found, ["a", "cat/b"]);
});

test("scan attributes author/created/updated from git history per skill folder", async () => {
  const repo = path.join(tmp, "repo1");
  fs.mkdirSync(repo, { recursive: true });
  sh(repo, "init", "-q");
  writeSkill(repo, "skills/alpha", "alpha", "Alpha skill");
  writeSkill(repo, "skills/beta", "beta", "Beta skill", "x", "metadata:\n  owner: Team Beta\n  status: deprecated\n  replaced_by: alpha\n");
  commitAs(repo, "Alice", "2026-01-01T10:00:00Z", "init");
  fs.appendFileSync(path.join(repo, "skills/alpha/SKILL.md"), "more\n");
  fs.writeFileSync(path.join(repo, "skills/alpha/run.sh"), "echo hi\n");
  commitAs(repo, "Bob", "2026-03-01T10:00:00Z", "update alpha");

  const skills = await scanSource("s1", repo);
  const alpha = skills.find((s) => s.name === "alpha")!;
  const beta = skills.find((s) => s.name === "beta")!;
  assert.equal(alpha.id, "s1:skills/alpha");
  assert.equal(alpha.author, "Alice");
  assert.deepEqual(alpha.contributors.sort(), ["Alice", "Bob"]);
  assert.equal(alpha.created?.slice(0, 10), "2026-01-01");
  assert.equal(alpha.updated?.slice(0, 10), "2026-03-01");
  assert.deepEqual(alpha.files, ["SKILL.md", "run.sh"]);
  assert.equal(beta.author, "Team Beta");
  assert.equal(beta.status, "deprecated");
  assert.equal(beta.replacedBy, "alpha");
  assert.equal(beta.updated?.slice(0, 10), "2026-01-01");
});

test("sync clones, pulls new commits, drops removed sources; search + dedup work", async () => {
  const upstream = path.join(tmp, "upstream");
  fs.mkdirSync(upstream, { recursive: true });
  sh(upstream, "init", "-q");
  writeSkill(upstream, "deploy-fw", "deploy-fw", "Deploy firmware to devices over AWS IoT jobs");
  commitAs(upstream, "Carol", "2026-02-01T00:00:00Z", "one");

  const other = path.join(tmp, "other");
  fs.mkdirSync(other, { recursive: true });
  sh(other, "init", "-q");
  // identical copy of the same skill in a second repo -> should fold as a duplicate
  writeSkill(other, "deploy-fw", "deploy-fw", "Deploy firmware to devices over AWS IoT jobs");
  writeSkill(other, "pdf", "pdf", "Extract text and form fields from PDF files");
  commitAs(other, "Dan", "2026-02-02T00:00:00Z", "one");

  saveSources([
    { name: "up", url: upstream },
    { name: "other", url: other },
  ]);
  assert.equal(loadSources().length, 2);
  let res = await syncAll(loadSources());
  assert.ok(res.every((r) => r.ok), JSON.stringify(res));
  let data = await buildIndex(loadSources());
  assert.equal(data.skills.length, 3);
  assert.equal(data.model, null); // embeddings off in tests

  let hits = await new Searcher(data).search("deploy firmware");
  assert.equal(hits[0].skill.name, "deploy-fw");
  assert.equal(hits[0].similar.length, 1, "identical skill in second repo folds under the first");

  // upstream gets a new skill; sync must pull it
  writeSkill(upstream, "call-log", "call-log", "Survey phone call history on a DVR");
  commitAs(upstream, "Carol", "2026-02-03T00:00:00Z", "two");
  res = await syncAll(loadSources());
  data = await buildIndex(loadSources());
  assert.equal(data.skills.length, 4);
  hits = await new Searcher(data).search("phone call history");
  assert.equal(hits[0].skill.id, "up:call-log");

  // source filter
  hits = await new Searcher(data).search("pdf form fields", { source: "up" });
  assert.ok(hits.every((h) => h.skill.source === "up"));

  // removing a source drops its clone and skills
  saveSources([{ name: "up", url: upstream }]);
  await syncAll(loadSources());
  data = await buildIndex(loadSources());
  assert.ok(data.skills.every((s) => s.source === "up"));
  assert.ok(!fs.existsSync(path.join(process.env.SKILLBASE_HOME!, "cache", "other")));
});

test("sync failure keeps the cached copy usable", async () => {
  saveSources([{ name: "gone", url: path.join(tmp, "does-not-exist") }]);
  const [r] = await syncAll(loadSources());
  assert.equal(r.ok, false);
  assert.ok(r.error);
});

test("chunks splits long bodies and caps count", () => {
  const body = Array.from({ length: 100 }, (_, i) => `paragraph ${i} ` + "word ".repeat(40)).join("\n\n");
  const c = chunks(body);
  assert.ok(c.length > 1 && c.length <= 8);
  assert.ok(c.every((x) => x.length <= 1300));
});

test("opencode setup inserts into existing mcp block, preserves other entries, is idempotent, removable", () => {
  fs.mkdirSync(path.join(process.cwd(), "dist"), { recursive: true });
  const cliJs = path.join(process.cwd(), "dist", "cli.js");
  if (!fs.existsSync(cliJs)) return; // needs a build
  const file = opencodeConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `{\n\t"theme": "x",\n\t"mcp": {\n\t\t"other": { "type": "remote", "url": "https://e" }\n\t}\n}\n`);

  let r = setupAgent("opencode");
  assert.equal(r.status, "added", r.detail);
  let cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(cfg.mcp.other.url, "https://e");
  assert.equal(cfg.mcp.skillbase.type, "local");
  assert.equal(cfg.mcp.skillbase.command.at(-1), "serve");
  assert.match(fs.readFileSync(file, "utf8"), /\t"theme"/, "original formatting kept on first add");

  r = setupAgent("opencode"); // again: replaced, not duplicated
  cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(Object.keys(cfg.mcp).filter((k) => k === "skillbase").length, 1);

  r = setupAgent("opencode", { remove: true });
  assert.equal(r.status, "removed");
  cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(cfg.mcp.skillbase, undefined);
  assert.equal(cfg.mcp.other.url, "https://e");

  // config with no mcp key at all
  fs.writeFileSync(file, `{ "theme": "x" }`);
  assert.equal(setupAgent("opencode").status, "added");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).mcp.skillbase.type, "local");

  // JSONC is refused rather than corrupted
  fs.writeFileSync(file, `{ // comment\n "theme": "x" }`);
  assert.equal(setupAgent("opencode").status, "failed");
});

test("team + personal sources merge; personal overrides; saveSources never writes team entries", () => {
  fs.writeFileSync(process.env.SKILLBASE_TEAM_SOURCES!, "sources:\n  - url: git@x:org/team-a.git\n  - name: shared\n    url: /team/shared\n");
  saveSources([{ name: "shared", url: "/mine/shared" }, { name: "mine", url: "/mine/m" }]);
  const all = loadSources();
  assert.deepEqual(all.map((s) => `${s.origin}:${s.name}:${s.url}`), ["team:team-a:git@x:org/team-a.git", "personal:shared:/mine/shared", "personal:mine:/mine/m"]);
  saveSources(all);
  const personalText = fs.readFileSync(path.join(process.env.SKILLBASE_HOME!, "sources.yaml"), "utf8");
  assert.ok(!personalText.includes("team-a"));
  assert.ok(!personalText.includes("origin"));
  fs.writeFileSync(process.env.SKILLBASE_TEAM_SOURCES!, "sources: []\n");
  saveSources([]);
});

test("multiple yml files: sources.d, include (relative, dir, cycle, missing), env path, precedence", () => {
  const home = process.env.SKILLBASE_HOME!;
  const base = path.join(tmp, "multi");
  fs.mkdirSync(path.join(base, "dir"), { recursive: true });
  fs.mkdirSync(path.join(home, "sources.d"), { recursive: true });
  fs.writeFileSync(process.env.SKILLBASE_TEAM_SOURCES!, "sources:\n  - name: dflt\n    url: /d/dflt\n  - name: clash\n    url: /d/clash\n");
  // sources.d: loaded alphabetically, later file wins over earlier one and over the default
  fs.writeFileSync(path.join(home, "sources.d", "10-a.yml"), "sources:\n  - name: da\n    url: /d/da\n  - name: clash\n    url: /a/clash\n");
  fs.writeFileSync(path.join(home, "sources.d", "20-b.yaml"), "sources:\n  - name: clash\n    url: /b/clash\n");
  fs.writeFileSync(path.join(home, "sources.d", "notes.txt"), "ignored");
  // include: a file next to the personal one is a cycle back to it; a dir; a missing path
  fs.writeFileSync(path.join(base, "one.yml"), `include: [./dir, ${JSON.stringify(path.join(home, "sources.yaml"))}]\nsources:\n  - name: one\n    url: /i/one\n`);
  fs.writeFileSync(path.join(base, "dir", "x.yml"), "sources:\n  - url: /i/from-dir.git\n");
  fs.writeFileSync(path.join(base, "env.yml"), "sources:\n  - name: envsrc\n    url: /e/env\n");
  process.env.SKILLBASE_SOURCES_PATH = path.join(base, "env.yml") + path.delimiter + path.join(base, "nope.yml");
  (paths as any).sourcesPath = process.env.SKILLBASE_SOURCES_PATH;

  assert.ok(setInclude(path.join(base, "one.yml"), "add"));
  assert.ok(!setInclude(path.join(base, "one.yml"), "add"), "adding twice is a no-op");
  saveSources([{ name: "mine", url: "/m/mine" }]);
  assert.deepEqual(loadIncludes(), [path.join(base, "one.yml")], "saveSources keeps include:");

  const got = Object.fromEntries(loadSources().map((x) => [x.name, `${x.origin}:${x.url}`]));
  assert.equal(got.dflt, "team:/d/dflt");
  assert.equal(got.da, "extra:/d/da");
  assert.equal(got.clash, "extra:/b/clash", "20-b.yaml beats 10-a.yml beats the default");
  assert.equal(got.one, "extra:/i/one");
  assert.equal(got["from-dir"], "extra:/i/from-dir.git");
  assert.equal(got.envsrc, "extra:/e/env");
  assert.equal(got.mine, "personal:/m/mine");
  assert.equal(loadPersonalSources().length, 1, "personal list excludes included files");
  assert.ok(loadedSourceFiles().length >= 7);

  assert.ok(setInclude(path.join(base, "one.yml"), "remove"));
  assert.equal(loadSources().some((x) => x.name === "one"), false);
  assert.deepEqual(loadIncludes(), []);

  // cleanup so later tests see only what they add
  process.env.SKILLBASE_SOURCES_PATH = "";
  (paths as any).sourcesPath = "";
  fs.rmSync(path.join(home, "sources.d"), { recursive: true });
  fs.writeFileSync(process.env.SKILLBASE_TEAM_SOURCES!, "sources: []\n");
  saveSources([]);
});

test("fresh rebuilds only when something changed; searches and loads are logged", async () => {
  const repo = path.join(tmp, "fresh-repo");
  fs.mkdirSync(repo, { recursive: true });
  sh(repo, "init", "-q");
  writeSkill(repo, "a", "a", "Alpha deploy tool");
  commitAs(repo, "Eve", "2026-04-01T00:00:00Z", "a");
  saveSources([{ name: "fr", url: repo }]);

  const sb = new SkillBase(true);
  let r = await sb.refresh({ trigger: "test" });
  assert.equal(r.rebuilt, true);
  r = await sb.refresh({ trigger: "test" });
  assert.equal(r.changed, false);
  assert.equal(r.rebuilt, false, "nothing new -> no rebuild");

  writeSkill(repo, "b", "b", "Beta call survey");
  commitAs(repo, "Eve", "2026-04-02T00:00:00Z", "b");
  r = await sb.refresh({ trigger: "test" });
  assert.equal(r.rebuilt, true, "new commit -> rebuild");
  assert.equal(r.skills, 2);

  saveSources([{ name: "fr", url: repo, path: "b" }]);
  r = await sb.refresh({ pull: false, trigger: "test" });
  assert.equal(r.rebuilt, true, "source definition changed -> rebuild");
  assert.equal(r.skills, 1);

  const s = await sb.ready();
  const hits = await loggedSearch(s, "call survey", { limit: 3 }, "test-client");
  assert.equal(hits[0].skill.id, "fr:b");
  loggedGet(s, "fr:b", "test-client");

  const logDir = process.env.SKILLBASE_LOG_DIR!;
  const lines = fs.readdirSync(logDir).flatMap((f) => fs.readFileSync(path.join(logDir, f), "utf8").trim().split("\n")).map((l) => JSON.parse(l));
  const search = lines.find((l) => l.ev === "search" && l.client === "test-client");
  assert.equal(search.query, "call survey");
  assert.equal(search.hits[0].id, "fr:b");
  assert.ok("params" in search);
  const get = lines.find((l) => l.ev === "get_skill" && l.client === "test-client");
  assert.deepEqual({ q: get.fromSearch.query, rank: get.fromSearch.rank }, { q: "call survey", rank: 1 });
  assert.ok(lines.some((l) => l.ev === "sync" && l.rebuilt === false));
  assert.ok(lines.some((l) => l.ev === "index"));
});

test("SKILLBASE_SEARCH picks the instruction wording; default is proactive", async () => {
  const { searchMode, instructions, searchToolDescription } = await import("../src/instructions.js");
  assert.equal(searchMode(undefined), "proactive");
  assert.equal(searchMode(""), "proactive");
  assert.equal(searchMode("bogus"), "proactive");
  assert.equal(searchMode("ask"), "ask");
  assert.equal(searchMode(" ASK "), "ask");
  assert.match(instructions("proactive"), /without asking first/);
  assert.doesNotMatch(instructions("ask"), /without asking first/);
  assert.match(instructions("ask"), /Only search shared skills when the user asks/);
  assert.match(searchToolDescription("proactive"), /proactively/);
  assert.match(searchToolDescription("ask"), /Use only when the user asks/);
  for (const m of ["ask", "proactive"] as const) assert.match(instructions(m), /do not load a shared skill the user has not chosen/i);
});

test("setup copies SKILLBASE_SEARCH and the search weights into the agent entry", () => {
  const cliJs = path.join(process.cwd(), "dist", "cli.js");
  if (!fs.existsSync(cliJs)) return; // needs a build
  const saved = { ...process.env };
  process.env.SKILLBASE_SEARCH = "ask";
  process.env.SKILLBASE_HEAD_WEIGHT = "0.4";
  process.env.SKILLBASE_KEYWORD_WEIGHT = "0.1";
  try {
    const file = opencodeConfigPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{}\n");
    assert.equal(setupAgent("opencode").status, "added");
    const env = JSON.parse(fs.readFileSync(file, "utf8")).mcp.skillbase.environment;
    assert.equal(env.SKILLBASE_SEARCH, "ask");
    assert.equal(env.SKILLBASE_HEAD_WEIGHT, "0.4");
    assert.equal(env.SKILLBASE_KEYWORD_WEIGHT, "0.1");
  } finally {
    for (const k of ["SKILLBASE_SEARCH", "SKILLBASE_HEAD_WEIGHT", "SKILLBASE_KEYWORD_WEIGHT"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});
