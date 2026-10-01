# skillbase

Search and use shared agent skills from public (or your own) git repos, from **Claude Code, Codex and OpenCode**.

## Concept

- Shared skills live in git repos (the defaults are listed in [`sources.yaml`](sources.yaml)).
- skillbase clones them to your machine, builds a local search index, and connects to your agent as a
  small local MCP server. It all runs on your machine with your own git access.
- **Your own skills are not touched.** Shared skills are never copied into your agent's skill folders,
  so the two don't mix. Your agent keeps using your local skills as usual.
- **Shared skills are searched on demand, not preloaded.** They do not appear in your agent's own skill
  list. Instead the agent calls skillbase's `search_skills` tool: when you ask what skills exist, or when
  you start a substantial task that no local skill fits. It shows you the matches and loads one only
  after you choose it.

## Install

Requires Node.js 20+ and git (plus access to any private repos you add).

```sh
npm install -g @kelabome/skillbase
skillbase setup          # asks, one agent at a time, whether to connect it
```

Or without installing globally: `npx @kelabome/skillbase setup`. Note that agents are pointed at the installed
copy, so re-run `skillbase setup` after moving Node versions (nvm) or reinstalling.

Update with `npm update -g @kelabome/skillbase` (new default skill repos arrive this way), then `skillbase fresh`.

Restart your agent (it reads the server's instructions at startup), then ask in plain words:

> check the shared skills for filling in a PDF form

or simply "do I have a skill for optimizing queries?". The agent searches local and shared skills and shows
the best matches with author and dates. You pick one, and it's used for this session. Nothing is loaded
until you choose. Prefer the agent to search only when told to? Set `SKILLBASE_SEARCH=ask`; see
[Make the agent search only when asked](docs/GUIDE-npm.md#make-the-agent-search-only-when-asked).

| Command | What it does |
|---|---|
| `skillbase fresh` | pull the skill repos now; rebuild the index only if something changed (also happens hourly on its own) |
| `skillbase search <words>` | search from the terminal |
| `skillbase get <id>` | print one skill as the agent receives it |
| `skillbase sources add <git-url>` | add your own skill repo |
| `skillbase sources include <file\|dir>` | read skill repos from another yml file or folder (also `~/.skillbase/sources.d/*.yml`) |
| `skillbase status` | check git access, index and which agents are connected |
| `skillbase setup` | connect agents again (asks one by one) |
| `skillbase remove` | disconnect agents (asks one by one) |
| `skillbase uninstall` | disconnect agents and delete `~/.skillbase` |
| `skillbase serve` | the MCP server itself; your agent starts it, you normally never run it |

Run `skillbase help` for the full list. Every flag is described in the [npm guide](docs/GUIDE-npm.md#5-everyday-commands).

## What the agent can do

skillbase gives your agent four MCP tools:

| Tool | Purpose |
|---|---|
| `search_skills` | find shared skills for a task (name, id, author, dates, source, match %) |
| `get_skill` | load one skill chosen by the user, by id (e.g. `anthropic-skills:pdf`) |
| `list_sources` | show the skill repos searched, with skill counts and last sync |
| `sync_skills` | pull all repos and rebuild the index now (otherwise hourly) |

Details, including how ranking works, are in the [reference](docs/REFERENCE.md).

## Guides

- **[Install with npm](docs/GUIDE-npm.md)**: the recommended way. Setup, commands, config, update, remove, troubleshooting.
- **[Install from a git checkout with make](docs/GUIDE-makefile.md)**: for contributors and modified copies.
- **[Reference](docs/REFERENCE.md)**: MCP tools, search ranking, skill format, data folder, all settings.
- **[Changelog](CHANGELOG.md)**: what changed in each release.
- **[Sharing a skill](CONTRIBUTING.md)**: how to publish a skill to a shared repo.

## Default skill repos

Out of the box skillbase searches these public repos:

| Name | Repo | What's in it |
|---|---|---|
| `anthropic-skills` | [anthropics/skills](https://github.com/anthropics/skills) | docx, pdf, pptx, xlsx, skill-creator, mcp-builder, ... |
| `openai-skills` | [openai/skills](https://github.com/openai/skills) | curated Codex skills |
| `superpowers` | [obra/superpowers](https://github.com/obra/superpowers) | brainstorming, TDD, debugging, planning, review |
| `vercel-skills` | [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) | React/Next.js best practices, web design, deploy |

Add your own with `skillbase sources add <git-url>`, or keep several yml files (one per project or team) in `~/.skillbase/sources.d/` or via `skillbase sources include`; see the [npm guide](docs/GUIDE-npm.md#several-yml-files). These repos have their own licenses; skillbase only
clones and indexes them locally, it does not redistribute their contents.

## Remove it

```sh
skillbase uninstall       # disconnect agents, delete ~/.skillbase
npm uninstall -g @kelabome/skillbase
```

## Share a skill

Put the skill folder (with its `SKILL.md`) into one of the skill repos and push. See
[CONTRIBUTING.md](CONTRIBUTING.md). To add a new default repo, add it to `sources.yaml` by PR.

## Logs

`~/.skillbase/logs/` records your search queries, the ranking scores, and which skill you picked. It never
contains skill contents or credentials. The logs stay on your machine and include your OS username and
hostname. They are only for tuning search and for bug reports you choose to send; files older than 30 days
are pruned. Turn logging off with `SKILLBASE_LOG=off`.

## License

[MIT](LICENSE)
