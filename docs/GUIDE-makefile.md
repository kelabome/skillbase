# Guide: install from a git checkout with make

For contributors and for running a modified copy. Most people should use the
[npm guide](GUIDE-npm.md) instead. Everything the CLI does is the same; `make` is a wrapper around it.

## 1. Requirements

- Node.js 20 or newer, git, `make`, bash
- At least one agent: Claude Code, Codex or OpenCode

## 2. Install

```sh
git clone https://github.com/kelabome/skillbase.git
cd skillbase
make install
```

`make install` does, in order:

1. checks Node and git (`make check`)
2. installs dependencies with `npm ci` (`make deps`)
3. builds TypeScript into `dist/` (`make build`)
4. symlinks `dist/cli.js` as `~/.local/bin/skillbase` (override with `BIN_DIR=...`)
5. runs `skillbase setup`: asks per agent whether to connect, clones the skill repos, builds the index

`YES=1 make install` answers yes to every question. If `~/.local/bin` is not on `PATH`, the `skillbase`
command is not found directly, but every `make` target still works.

Agents are wired to **this checkout's** `dist/cli.js`, so do not move or delete the folder while connected.

## 3. Targets

Run `make` for the list.

| Target | What it does |
|---|---|
| `make install` | build, add the `skillbase` command, connect agents |
| `make setup` | connect / reconnect agents (asks one by one) |
| `make fresh` | pull skill repos; rebuild the index only if something changed |
| `make status` | check git access, index, embeddings, connected agents |
| `make search Q='fill in a PDF form'` | search from the terminal |
| `make update` | `git pull --ff-only`, rebuild, then `fresh` |
| `make remove` | disconnect agents (keeps the tool) |
| `make uninstall` | disconnect agents, remove the symlink, `node_modules` and `dist` |
| `make logs` | tar `~/.skillbase/logs` to attach to a bug report |
| `make test` | build, then run the unit tests |
| `make eval` | retrieval quality check against your current index |
| `make build` | compile only |

Variables: `YES=1`, `BIN_DIR` (default `~/.local/bin`), `SKILLBASE_HOME` (default `~/.skillbase`).

## 4. Check it works

```sh
make status
make search Q='fill in a PDF form'
```

Then restart your agent (it reads the server's instructions at startup) and ask: "check the shared skills
for filling in a PDF form". The agent also searches by itself when you ask what skills exist or start a
task no local skill fits; see [When does the agent search?](GUIDE-npm.md#when-does-the-agent-search).

## 5. Developing

```sh
npm run dev -- search "pdf"     # run from src/ with tsx, no build needed
make test                       # build + unit tests
make eval                       # needs an index: make fresh first
```

Default skill repos are in `sources.yaml` at the repo root (change by PR). Extra yml files work the same as with npm: see "Several yml files" in the [npm guide](GUIDE-npm.md). Use a throwaway data directory
while experimenting so you do not touch your real index:

```sh
export SKILLBASE_HOME=$(mktemp -d)
make fresh && make eval
```

After editing `src/`, run `make build`. Agents run the compiled `dist/`, not `src/`, and read the server's
instructions (the wording in `src/instructions.ts`, chosen by `SKILLBASE_SEARCH`) when they start, so
restart the agent after rebuilding.

`make test` runs `test/core.test.ts`. `test/mcp-smoke.ts` (start the server, call `search_skills`) and
`test/eval.ts` (retrieval quality, `make eval`) are run by hand with `npx tsx`.

## 6. Update

```sh
make update
```

Needs a clean fast-forward `git pull`. Commit or stash local changes first.

## 7. Remove

```sh
make uninstall      # disconnect agents, drop symlink, remove node_modules and dist
```

`make uninstall` also offers to delete `~/.skillbase`. Afterwards you can delete the checkout.
To only disconnect agents and keep everything else: `make remove`.

## Troubleshooting

- **`Node.js >= 20 is required`**: install or switch Node (nvm), then re-run.
- **`skillbase: command not found`**: add `~/.local/bin` to `PATH`, or use `make` targets.
- **Agent stopped working after moving the folder**: run `make setup` from the new location.
- **`make update` fails**: you have local commits or changes; resolve with git, then retry.
- **Anything else**: see the troubleshooting list in the [npm guide](GUIDE-npm.md); the CLI is identical.
