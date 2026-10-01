# Reference

How skillbase behaves in detail. For setup and everyday use see the [npm guide](GUIDE-npm.md).

## MCP server

`skillbase serve` runs an MCP server over stdio. Agents start it from the entry that `skillbase setup`
writes. On startup it sends the agent **instructions** and four tools.

### Instructions

The instructions tell the agent that shared skills are separate from the user's local ones, and when to
search them. `SKILLBASE_SEARCH` chooses the wording:

| `SKILLBASE_SEARCH` | Behavior |
|---|---|
| `proactive` (default, also any unrecognised value) | search, without asking first, when the user asks what skills exist or whether one exists for something, or starts a substantial task no local skill clearly fits; skip trivial tasks and tasks a local skill already fits |
| `ask` | search only when the user asks for shared skills (or agrees after being offered a search) |

In both modes the agent shows the matches (name, author, dates, source), lets the user pick, then calls
`get_skill`, and never loads a shared skill the user has not chosen. The `search_skills` tool description
changes with the mode too.

The text lives in `src/instructions.ts`. Agents read it once at startup, so restart the agent after
changing the setting or updating skillbase. `skillbase setup` copies `SKILLBASE_SEARCH` into the agent's
entry. You can also steer behavior from your agent's `AGENTS.md` or `CLAUDE.md`, which take precedence
([how](GUIDE-npm.md#make-the-agent-search-only-when-asked)).

### Tools

| Tool | Arguments | Returns |
|---|---|---|
| `search_skills` | `query` (required, min 2 chars, the task in plain words), `limit` (1-20, default 5), `source` (only this source), `include_deprecated` (default false) | ranked matches: name, `id`, match %, description (max 300 chars), author, created/updated dates, source, status, and any near-duplicates folded under the hit |
| `get_skill` | `id` (e.g. `anthropic-skills:pdf`) | the skill as the agent should use it: metadata header, folder path, file list, then the `SKILL.md` body. Error if the id is unknown |
| `list_sources` | none | each source with URL, branch, skill count, last sync time and result, plus the search mode (semantic + keyword, or keyword only) |
| `sync_skills` | none | pulls every source and rebuilds the index if anything changed. Normally unnecessary: the server pulls about hourly |

`get_skill` also accepts a bare skill name or the part of an id after the colon; if several skills match,
the first one found is returned, so prefer the full id.

The server also checks for staleness on every `search_skills` / `get_skill` call and refreshes in the
background when the last pull is older than `SKILLBASE_SYNC_INTERVAL` minutes. The first call after a fresh
install builds the index if it does not exist yet, which can take a while on the first run.

## Skill ids

An id is `<source>:<folder>`, where `<folder>` is the path to the skill folder relative to the source's
`path` (or to the repo root). Example: source `vercel-skills`, folder `skills/react-best-practices`, with
`path: skills` in `sources.yaml`, gives `vercel-skills:react-best-practices`.

## Skill format

Each skill is a folder containing `SKILL.md`, found at any depth up to 6 levels (folders such as `.git`,
`node_modules`, `dist`, `build`, `venv` are skipped). The file starts with YAML frontmatter:

```yaml
---
name: my-skill
description: What it does and when to use it.
metadata:
  owner: Jane Doe
  status: deprecated
  replaced_by: better-skill
---
```

| Field | Used for |
|---|---|
| `name` | display name; defaults to the folder name |
| `description` | the main thing search matches on |
| `metadata.owner` / `metadata.author` / top-level `author` | displayed author, in that order; otherwise the first committer in git |
| `metadata.status` | `deprecated` hides the skill from search (still loadable by id) |
| `metadata.replaced_by` | shown next to a deprecated skill |

Sloppy frontmatter (for example an unquoted colon in a description) does not break indexing: the parser
falls back to reading simple `key: value` lines.

Created/updated dates, author and contributors come from `git log` for the skill's folder. Files outside
git history fall back to filesystem times.

## How search works

1. **Keyword score**: MiniSearch over name (boost 3), description (boost 2) and body (0.3), with prefix
   and fuzzy matching.
2. **Semantic score** (when embeddings are available): the query is embedded locally with
   `Xenova/all-MiniLM-L6-v2`. Similarity is `0.25 x name+description + 0.75 x best body chunk`. Bodies are
   split into up to 8 chunks of about 900 characters.
3. **Blend**: `0.95 x semantic + 0.05 x keyword`. Without embeddings the keyword score is used alone.
   Candidates with no keyword match and semantic similarity below 0.2 are dropped.
4. **De-duplication**: hits with identical content, or name+description similarity of 0.93 or more, are
   folded under the best-scoring one and listed as "similar".

Deprecated skills are excluded unless `include_deprecated` is set.

### Tuning

| Variable | Default | Meaning |
|---|---|---|
| `SKILLBASE_HEAD_WEIGHT` | `0.25` | share of similarity from name+description vs body chunks |
| `SKILLBASE_KEYWORD_WEIGHT` | `0.05` | share of the keyword score in the blend |

`setup` copies these into the agent's entry when they are set in the shell that runs it. Use `make eval` to
check the effect on retrieval quality before keeping a change. Each logged search records the parameters in
effect.

## Indexing and sync

- Each source is cloned into `~/.skillbase/cache/<name>` (`--no-tags`, no shallow clone, so history is
  available for authorship). Later syncs `fetch` and `reset --hard` to the remote branch: the cache is
  read-only by contract, so never edit files there.
- The index is rebuilt only when a source's URL, branch, path or checked-out commit changed, or when forced
  (`skillbase fresh --force`). Unchanged skills reuse their stored vectors, so only new or edited skills are
  embedded.
- A failed pull keeps the previous clone and reports `FAILED ... (using cached copy)`; search still works.
- Clones of sources you removed from the yml files are deleted on the next sync.
- If the embedding model cannot load, the index is built without vectors and search is keyword-only. The
  reason is shown by `skillbase status`.

## Data folder

Everything lives under `SKILLBASE_HOME` (default `~/.skillbase`):

| Path | Contents |
|---|---|
| `sources.yaml` | your own sources and `include:` entries |
| `sources.d/` | optional extra `*.yml` files |
| `cache/` | one git clone per source |
| `index.json` | the search index (skills and vectors) |
| `state.json` | last sync time and per-source result |
| `models/` | the downloaded embedding model (~25 MB) |
| `logs/` | usage logs |

`skillbase uninstall` offers to delete the whole folder.

## Usage logs

One JSON object per line in `logs/skillbase-YYYY-MM-DD.jsonl`, pruned after 30 days. Event types:

| `ev` | Recorded |
|---|---|
| `search` | query, limit, source, mode, duration, search parameters, and for each hit its rank, score and components |
| `get_skill` | the id, whether it was found, and which recent search offered it (query, rank, age) |
| `sync` | trigger (`cli`, `mcp`, `auto`, `first-use`), duration, whether anything changed, per-source result |
| `index` | duration, skill count, number embedded, model |
| `server_start` | client name and skillbase version |
| `setup` | agent connected or disconnected |
| `error` | where and the message |

Every line also carries a timestamp, your OS username, hostname, process id and a random session id. Logs
never contain skill bodies, file contents or credentials. Turn them off with `SKILLBASE_LOG=off`; move them
with `SKILLBASE_LOG_DIR`. `make logs` packs them into a `.tar.gz` for a bug report.

## All settings

| Variable | Default | Meaning |
|---|---|---|
| `SKILLBASE_HOME` | `~/.skillbase` | data folder |
| `SKILLBASE_SOURCES_PATH` | empty | extra yml files or folders, separated like `PATH` |
| `SKILLBASE_TEAM_SOURCES` | `sources.yaml` in the package | the default skill-repo list |
| `SKILLBASE_SYNC_INTERVAL` | `60` | minutes between automatic pulls by the MCP server |
| `SKILLBASE_SEARCH` | `proactive` | `ask` = the agent searches shared skills only when asked; see [Instructions](#instructions) |
| `SKILLBASE_EMBEDDINGS` | on | `0`, `off`, `false` or `no` = keyword search only |
| `SKILLBASE_MODEL` | `Xenova/all-MiniLM-L6-v2` | embedding model |
| `SKILLBASE_LOG` | on | `0`, `off`, `false` or `no` = no logging |
| `SKILLBASE_LOG_DIR` | `$SKILLBASE_HOME/logs` | log folder |
| `SKILLBASE_HEAD_WEIGHT` | `0.25` | see [Tuning](#tuning) |
| `SKILLBASE_KEYWORD_WEIGHT` | `0.05` | see [Tuning](#tuning) |

`setup` copies every variable above into the agent's MCP entry, when they are set in the shell that runs it.

## Source file format

```yaml
include: [~/work/skills.yml, ./team-skills/]   # optional: more files or folders of ymls
sources:
  - name: my-skills        # default: repo name; letters, digits, . _ -
    url: git@github.com:me/my-skills.git   # anything `git clone` accepts
    branch: main           # optional; default = the remote's default branch
    path: skills           # optional; only look under this sub-directory
```

Load order, lowest to highest precedence: the default list, `sources.d/`, `SKILLBASE_SOURCES_PATH`, then
`~/.skillbase/sources.yaml`. A later entry with the same `name` replaces the earlier one. Names must be
unique within one file. See the [npm guide](GUIDE-npm.md#several-yml-files) for examples.
