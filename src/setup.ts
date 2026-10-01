import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const AGENTS = ["claude", "codex", "opencode"] as const;
export type Agent = (typeof AGENTS)[number];

export const AGENT_LABEL: Record<Agent, string> = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode" };

const NAME = "skillbase";

/** Absolute `node dist/cli.js serve`, so agents started outside a login shell (nvm etc.) still find it. */
export function serverCommand(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let cli = path.join(here, "cli.js");
  if (!fs.existsSync(cli)) cli = path.join(here, "..", "dist", "cli.js"); // running from src via tsx
  if (!fs.existsSync(cli)) throw new Error("dist/cli.js not found - run `npm run build` first");
  return [process.execPath, cli, "serve"];
}

function extraEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ["SKILLBASE_HOME", "SKILLBASE_EMBEDDINGS", "SKILLBASE_MODEL", "SKILLBASE_SYNC_INTERVAL", "SKILLBASE_LOG", "SKILLBASE_LOG_DIR", "SKILLBASE_TEAM_SOURCES", "SKILLBASE_SOURCES_PATH", "SKILLBASE_SEARCH", "SKILLBASE_HEAD_WEIGHT", "SKILLBASE_KEYWORD_WEIGHT"]) {
    if (process.env[k]) env[k] = process.env[k]!;
  }
  return env;
}

function onPath(bin: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" }).status === 0;
}

export function opencodeConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  const dir = path.join(base, "opencode");
  for (const f of ["opencode.json", "opencode.jsonc"]) if (fs.existsSync(path.join(dir, f))) return path.join(dir, f);
  return path.join(dir, "opencode.json");
}

export interface SetupResult {
  agent: Agent;
  status: "added" | "removed" | "skipped" | "failed" | "dry-run";
  detail: string;
}

export function isInstalled(a: Agent): boolean {
  return onPath(a) || (a === "opencode" && fs.existsSync(opencodeConfigPath()));
}

export function detectAgents(): Agent[] {
  return AGENTS.filter((a) => onPath(a) || (a === "opencode" && fs.existsSync(opencodeConfigPath())));
}

export function setupAgent(agent: Agent, opts: { remove?: boolean; dryRun?: boolean } = {}): SetupResult {
  const cmd = serverCommand();
  const env = extraEnv();
  try {
    if (agent === "claude") {
      const json = JSON.stringify({ type: "stdio", command: cmd[0], args: cmd.slice(1), env });
      const add = ["mcp", "add-json", "--scope", "user", NAME, json];
      if (opts.dryRun) return { agent, status: "dry-run", detail: `claude ${add.join(" ")}` };
      spawnSync("claude", ["mcp", "remove", "--scope", "user", NAME], { stdio: "ignore" });
      if (opts.remove) return { agent, status: "removed", detail: "claude mcp remove --scope user skillbase" };
      execFileSync("claude", add, { stdio: "pipe" });
      return { agent, status: "added", detail: "user scope (~/.claude.json)" };
    }
    if (agent === "codex") {
      const envArgs = Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
      const add = ["mcp", "add", ...envArgs, NAME, "--", ...cmd];
      if (opts.dryRun) return { agent, status: "dry-run", detail: `codex ${add.join(" ")}` };
      spawnSync("codex", ["mcp", "remove", NAME], { stdio: "ignore" });
      if (opts.remove) return { agent, status: "removed", detail: "codex mcp remove skillbase" };
      execFileSync("codex", add, { stdio: "pipe" });
      return { agent, status: "added", detail: "~/.codex/config.toml" };
    }
    return setupOpencode(cmd, env, opts);
  } catch (e) {
    const err = e as { stderr?: Buffer; message: string };
    return { agent, status: "failed", detail: (err.stderr?.toString() || err.message).trim().split("\n")[0] };
  }
}

/**
 * OpenCode has no `mcp add` command, so edit opencode.json. We insert text rather than
 * re-serialising, to keep the user's formatting, and back the file up first.
 */
function setupOpencode(cmd: string[], env: Record<string, string>, opts: { remove?: boolean; dryRun?: boolean }): SetupResult {
  const agent = "opencode" as const;
  const file = opencodeConfigPath();
  const entry: Record<string, unknown> = { type: "local", command: cmd, enabled: true };
  if (Object.keys(env).length) entry.environment = env;
  const snippet = `"${NAME}": ${JSON.stringify(entry)}`;

  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "{}\n";
  let cfg: any;
  try {
    cfg = JSON.parse(text);
  } catch {
    return { agent, status: "failed", detail: `${file} is not plain JSON (comments?). Add manually under "mcp": { ${snippet} }` };
  }
  const has = !!cfg.mcp?.[NAME];
  if (opts.dryRun) return { agent, status: "dry-run", detail: `${has ? "replace" : "add"} mcp.${NAME} in ${file}: ${snippet}` };

  let next = text;
  if (has) {
    // Removing needs a structural edit; re-serialise (a backup is kept).
    delete cfg.mcp[NAME];
    next = JSON.stringify(cfg, null, 2) + "\n";
  }
  if (opts.remove) {
    if (!has) return { agent, status: "skipped", detail: "not configured" };
    backup(file, text);
    fs.writeFileSync(file, next);
    return { agent, status: "removed", detail: file };
  }
  const mcpMatch = /"mcp"\s*:\s*\{/.exec(next);
  if (mcpMatch) {
    const at = mcpMatch.index + mcpMatch[0].length;
    const empty = /^\s*\}/.test(next.slice(at));
    next = next.slice(0, at) + `\n    ${snippet}${empty ? "\n  " : ","}` + next.slice(at);
  } else {
    // Append as the last top-level key, before the closing brace.
    const at = next.lastIndexOf("}");
    const before = next.slice(0, at).trimEnd();
    const empty = before.endsWith("{");
    next = before + `${empty ? "" : ","}\n  "mcp": {\n    ${snippet}\n  }\n` + next.slice(at);
  }
  JSON.parse(next); // never write a broken config
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) backup(file, text);
  fs.writeFileSync(file, next);
  return { agent, status: "added", detail: file };
}

function backup(file: string, text: string) {
  fs.writeFileSync(`${file}.skillbase-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`, text);
}

/** Is skillbase registered in this agent? */
export function isRegistered(agent: Agent): boolean | undefined {
  try {
    if (agent === "claude") return spawnSync("claude", ["mcp", "get", NAME], { stdio: "ignore", timeout: 20_000 }).status === 0;
    if (agent === "codex") return spawnSync("codex", ["mcp", "get", NAME], { stdio: "ignore", timeout: 20_000 }).status === 0;
    const f = opencodeConfigPath();
    return fs.existsSync(f) && !!JSON.parse(fs.readFileSync(f, "utf8")).mcp?.[NAME];
  } catch {
    return undefined;
  }
}
