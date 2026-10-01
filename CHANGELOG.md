# Changelog

All notable changes to skillbase. The format follows [Keep a Changelog](https://keepachangelog.com/),
and the project uses [semantic versioning](https://semver.org/).

## [0.1.0] - 2026-10-01

First release.

### Added

- MCP server (`skillbase serve`) with four tools: `search_skills`, `get_skill`, `list_sources`,
  `sync_skills`.
- Local search over skills in git repos: keyword search plus optional semantic search with a local
  embedding model (`Xenova/all-MiniLM-L6-v2`, ~25 MB, downloaded once), with near-duplicate folding.
- Default skill repos: `anthropic-skills`, `openai-skills`, `superpowers`, `vercel-skills`.
- Your own repos: `skillbase sources add`, plus several yml files via `~/.skillbase/sources.d/`,
  `include:` and `SKILLBASE_SOURCES_PATH`.
- `skillbase setup` / `remove` / `uninstall` for Claude Code, Codex and OpenCode, with `--yes`, `--agent`
  and `--dry-run`. OpenCode's config is backed up before it is edited.
- CLI: `search`, `get`, `fresh` (alias `sync`), `sources`, `status` (alias `doctor`), `help`.
- Hourly background sync with fallback to the last good clone when a pull fails.
- Skill metadata from frontmatter and git history: author, created/updated dates, `deprecated` status and
  `replaced_by`.
- Usage logs (local, 30-day retention, `SKILLBASE_LOG=off` to disable) for tuning search and bug reports.
- Install by npm (`@kelabome/skillbase`) or from a checkout with `make`.
- Documentation: README, npm guide, make guide, reference, contributing guide.

### Behavior

- The server's instructions tell the agent to search shared skills **without asking first** when the user
  asks what skills exist or starts a substantial task no local skill fits. Loading a shared skill still
  requires the user to pick it from the results. Set `SKILLBASE_SEARCH=ask` (then re-run
  `skillbase setup`) to make the agent search only when asked
  ([how](docs/GUIDE-npm.md#make-the-agent-search-only-when-asked)). Agents read the instructions at
  startup, so restart them after installing or updating.
- `skillbase setup` copies `SKILLBASE_SEARCH`, `SKILLBASE_HEAD_WEIGHT` and `SKILLBASE_KEYWORD_WEIGHT`
  into the agent entry along with the other `SKILLBASE_*` variables.

### Known limitations

- Shared skills are not listed in the agent's own skill list; they are reachable only through
  `search_skills`.
- `report_skill` (reporting a broken skill from the agent) is planned, not implemented.
