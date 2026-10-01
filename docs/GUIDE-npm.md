# Guide: install with npm (recommended)

The normal way to use skillbase. No clone, no build step.

## 1. Requirements

- Node.js 20 or newer (`node -v`)
- git (`git --version`)
- At least one agent: Claude Code (`claude`), Codex (`codex`) or OpenCode (`opencode`)
- Access to any private skill repos you add later (SSH key or credential helper)

## 2. Install

```sh
npm install -g @kelabome/skillbase
```

No global install? Use `npx @kelabome/skillbase <command>` (the command is still named `skillbase`) instead of `skillbase <command>` everywhere below.
Agents are wired to the installed path, so a global install is the more stable choice.

## 3. Connect your agents

```sh
skillbase setup
```

It asks one agent at a time whether to connect. It then clones the default skill repos and builds the
search index. The first run downloads a ~25 MB embedding model. Without it, search falls back to keywords.

What `setup` changes:

| Agent | Where |
|---|---|
| Claude Code | `claude mcp add-json --scope user skillbase ...` (in `~/.claude.json`) |
| Codex | `codex mcp add skillbase ...` (in `~/.codex/config.toml`) |
| OpenCode | `mcp.skillbase` in `~/.config/opencode/opencode.json` (a backup is written first) |

Your own skills are not touched. Shared skills are never copied into your agents' skill folders.

Useful flags: `--yes` (answer yes to everything), `--agent claude,codex` (only those), `--dry-run`
(show what would change).

## 4. Check it works

```sh
skillbase status
skillbase search "fill in a PDF form"
```

`status` checks Node, git, each source is reachable, the index, embeddings, and which agents are connected.
Then **restart your agent** and ask in plain words:

> check the shared skills for filling in a PDF form

The agent lists the best matches. You pick one and it is used for that session.

### When does the agent search?

skillbase's server tells the agent to search shared skills, without asking you first, in two cases:

- you ask what skills you have, or whether a skill exists for something. The agent checks your local
  skills and the shared ones, and reports both.
- you start a substantial task and no local skill clearly fits.

It does not search for trivial tasks, or when a local skill already fits. It never loads a shared skill
until you pick one from the results.

The agent reads these instructions when it starts, so **restart it after installing or updating skillbase**.
Shared skills never show up in the agent's own skill list; they are only reachable through the
`search_skills` tool.

### Make the agent search only when asked

Set `SKILLBASE_SEARCH=ask` and re-run setup, so the setting is copied into the agent's MCP entry:

```sh
SKILLBASE_SEARCH=ask skillbase setup
```

Then restart the agent. The server now tells it to search shared skills only when you ask (for example
"also check shared skills"), and to ask before offering a search. `SKILLBASE_SEARCH=proactive` (or unset)
is the default described above. Any other value is treated as `proactive`.

You can also steer it from your agent's own instructions, which take precedence over the server's. Add a
line to `AGENTS.md` (OpenCode, Codex) or `CLAUDE.md` (Claude Code), project or global:

```md
Only call the skillbase tools (search_skills, get_skill) when I explicitly ask for shared skills.
```

To make it search even more eagerly, say so the same way, e.g. "Before starting any non-trivial task, call
skillbase `search_skills` and show me the matches."

## 5. Everyday commands

| Command | What it does |
|---|---|
| `skillbase search <words> [--limit n] [--source name] [--json]` | search from the terminal (default 5 results; `--json` prints ids, scores and ranking parts) |
| `skillbase get <id>` | print one skill the way the agent receives it, e.g. `anthropic-skills:pdf` |
| `skillbase fresh [--force] [--no-pull]` | pull all skill repos; rebuild the index only if something changed. `--force` always rebuilds; `--no-pull` rebuilds from what is already cloned. Alias: `sync` |
| `skillbase sources` | list default and personal sources with their sync state |
| `skillbase sources add <git-url> [--name n] [--branch b] [--path sub/dir]` | add your own skill repo |
| `skillbase sources remove <name>` | remove one of your own repos (alias: `rm`) |
| `skillbase sources files` | list every yml file being read |
| `skillbase sources include <file\|dir>` | also read another yml file or folder (`uninclude` to undo) |
| `skillbase status` | health check (alias: `doctor`) |
| `skillbase setup [--yes] [--agent a,b] [--dry-run]` | connect agents (`claude`, `codex`, `opencode`) |
| `skillbase remove [--yes]` | disconnect agents, keep your data |
| `skillbase uninstall [--yes]` | disconnect agents and optionally delete `~/.skillbase` |
| `skillbase serve` | run the MCP server (agents start this; you rarely need to) |
| `skillbase help` | print the command list and file locations |

`-y` is short for `--yes`.

The MCP server also pulls the repos by itself about once an hour (`SKILLBASE_SYNC_INTERVAL`), or on demand
through its `sync_skills` tool. Failed pulls fall back to the last good clone, so search keeps working offline.

## 6. Add your own skill repos

Any git repo with `*/SKILL.md` folders at any depth works.

```sh
skillbase sources add git@github.com:me/my-skills.git
skillbase sources add https://github.com/me/mono.git --name mono --path agents/skills
```

`sources add` writes to `~/.skillbase/sources.yaml`.

### Several yml files

You can split sources across as many yml files as you like (per project, per team, a shared company
file in a synced folder, ...). Each file has the same format as `sources.yaml`:

```yaml
sources:
  - name: team-skills
    url: git@github.com:acme/skills.git
    path: skills
```

There are three ways to bring files in. Use any mix:

| Way | How |
|---|---|
| Drop-in folder | put `*.yml` / `*.yaml` into `~/.skillbase/sources.d/`. All are loaded, in alphabetical order (name them `10-x.yml`, `20-y.yml` to control order). |
| Include | `skillbase sources include ~/work/skills.yml` (a file, or a folder of ymls). `skillbase sources uninclude <path>` undoes it. It is stored as `include:` in `sources.yaml`; you can also write `include: [a.yml, ./dir]` yourself. Relative paths in an `include:` are relative to the file that contains it, and `~` works. |
| Environment | `SKILLBASE_SOURCES_PATH=/a/one.yml:/b/dir` (separated like `PATH`) |

Files can include other files. Cycles and repeats are read once. A missing file is skipped with a warning.

**Which wins on a name clash?** Later beats earlier, in this order (lowest to highest): the default list
shipped with the package, `sources.d/`, `SKILLBASE_SOURCES_PATH`, then `~/.skillbase/sources.yaml` (and the
files it includes, with the file itself winning over what it includes). So you can override or replace a
default source by giving yours the same `name`.

See what is being read:

```sh
skillbase sources          # every source and the file it came from
skillbase sources files    # every yml file, in load order
```

`skillbase sources remove <name>` only edits `sources.yaml`; for a source from another file it tells you
which file to edit.

## 7. Update

```sh
npm update -g @kelabome/skillbase    # new version, including any new default skill repos
skillbase fresh            # pull the latest skills
skillbase setup            # only needed if the install path changed
```

## 8. Remove

```sh
skillbase uninstall        # disconnect agents, optionally delete ~/.skillbase
npm uninstall -g @kelabome/skillbase
```

`skillbase remove` only disconnects agents and keeps your data.

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `SKILLBASE_HOME` | `~/.skillbase` | cloned repos, index, model, personal sources, logs |
| `SKILLBASE_SOURCES_PATH` | empty | extra yml files or folders, separated like `PATH` |
| `SKILLBASE_TEAM_SOURCES` | `sources.yaml` in the package | replace the default skill-repo list with your own file |
| `SKILLBASE_SYNC_INTERVAL` | `60` | minutes between automatic pulls by the MCP server |
| `SKILLBASE_SEARCH` | `proactive` | `ask` = the agent searches shared skills only when you ask ([details](#make-the-agent-search-only-when-asked)) |
| `SKILLBASE_EMBEDDINGS` | on | `off` = keyword search only, no model download |
| `SKILLBASE_MODEL` | `Xenova/all-MiniLM-L6-v2` | embedding model |
| `SKILLBASE_LOG` | on | `off` = no usage logging |
| `SKILLBASE_LOG_DIR` | `~/.skillbase/logs` | where logs go |

Set these when you run `skillbase setup`; they are copied into the agent's MCP entry. Changing them
later in your shell does not affect an already-connected agent: re-run `skillbase setup`.

Two search-tuning variables (`SKILLBASE_HEAD_WEIGHT`, `SKILLBASE_KEYWORD_WEIGHT`) are described in the
[reference](REFERENCE.md#tuning); `setup` copies them too.

## Troubleshooting

- **`skillbase: command not found`**: the npm global bin folder is not on `PATH`. Check `npm prefix -g`,
  and add its `bin` directory to `PATH`.
- **Agent says no skillbase tools**: restart the agent, then `skillbase status` to see if it is connected.
  Re-run `skillbase setup` after changing Node version (nvm) or reinstalling.
- **Tools work but the agent never searches on its own**: it only reads the server's instructions when it
  starts, so restart it. Check that `SKILLBASE_SEARCH` is not set to `ask` (look at the skillbase entry in
  your agent's config). If it still waits to be asked, say "also check shared skills" once, or add a rule
  to `AGENTS.md` / `CLAUDE.md` (see [When does the agent search?](#when-does-the-agent-search)).
- **My own skills don't list shared skills**: by design. Shared skills are never copied into your agent's
  skill folders; ask the agent to search them.
- **A source shows FAILED / unreachable**: `git ls-remote <url>` shows the real git error. Fix your
  credentials, or `skillbase sources remove <name>` (own repos) / pick another branch.
- **Search is keyword-only**: the model failed to download. `skillbase status` shows why. Check network or
  proxy, then `skillbase fresh --force`.
- **OpenCode config has comments**: setup refuses to edit it and prints the snippet to paste under `"mcp"`.
  When setup does edit `opencode.json`, it first writes an `opencode.json.skillbase-backup-<timestamp>` copy next to it.
- **Config files and secrets**: `skillbase setup` copies only `SKILLBASE_*` variables into the agent's MCP
  entry. It never writes tokens. Use a git credential helper or SSH key for private repos, not URLs with
  embedded passwords.
- **Stale results**: `skillbase fresh --force` rebuilds the index.
