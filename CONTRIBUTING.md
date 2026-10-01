# Sharing a skill

Sharing costs one commit: copy your skill folder into a shared skills repo and push. There's no
registration and no duplicate check. Search handles finding skills and folding duplicates, and git records
who shared it and when.

```sh
cp -r ~/.claude/skills/my-skill  <shared-repo>/my-skill     # or ~/.config/opencode/skills, ~/.codex/skills
cd <shared-repo> && git add my-skill && git commit -m "add my-skill" && git push
```

The layout is flexible: `my-skill/SKILL.md`, `skills/my-skill/SKILL.md` or `skills/<category>/my-skill/SKILL.md`
all work (skills nested deeper than 6 folders are not found, and a `SKILL.md` inside another skill's
folder is treated as part of that skill). Everyone picks it up on their next sync: hourly, or
`skillbase fresh` (`make fresh` in a checkout).

## Before you push

Reviewers and users will check these.

1. **No secrets.** Tokens, passwords, keys and account-specific ARNs don't go in the skill. Point to where
   they come from instead (env var, SSM path, `aws sso login`). Anything you push is readable by everyone
   with repo access, permanently, through git history.
2. **Say what it needs.** If it relies on a CLI, a local checkout of another repo, a VPN, an AWS profile or
   another skill, list it under a `## Prerequisites` heading. Avoid paths that only exist on your machine,
   or mark them clearly as "your checkout of X".
3. **Write a real description.** It's the main thing search matches on. Say what it does *and when to use it*,
   in the words someone would type. `"context hub"` is almost unfindable. `"Look up current API/CLI docs
   (AWS, etc.) with the chub CLI when unsure of the exact or latest spec"` is findable.
4. **Scripts are code.** Anything under the folder may be run by someone else's agent. Keep scripts
   readable, avoid destructive defaults, and ask for confirmation before writes to prod.
5. **Keep the `name` valid.** Lowercase with hyphens, matching the folder name. OpenCode rejects mismatches.

## Optional frontmatter

All three agents ignore unknown fields, and OpenCode keeps them under `metadata`. skillbase reads
`owner` (or `author`) as the displayed author; without one it uses the first committer. More in the
[reference](docs/REFERENCE.md#skill-format):

```yaml
---
name: my-skill
description: What it does and when to use it.
metadata:
  owner: Jane Doe            # who to contact; defaults to whoever added the folder in git
  status: deprecated         # hides it from search (still loadable by id)
  replaced_by: better-skill  # shown next to a deprecated skill
---
```

## Updating, replacing and retiring

- Update: edit and push. The updated date and search index follow.
- Replaced by a better one: set `status: deprecated` and `replaced_by`. Don't delete it straight away,
  because people may be loading it by id.
- Broken and nobody owns it: delete the folder.

If you find a problem with someone else's skill, tell the author shown in search results (or open a PR).
A `report_skill` tool to do this from the agent is planned.

# Working on skillbase itself

Code changes: see the [make guide](docs/GUIDE-makefile.md#5-developing). Before opening a PR run
`make test`, and `make eval` if you touched search. If you change the server's instructions or tool
descriptions (`src/instructions.ts`), mention it in [CHANGELOG.md](CHANGELOG.md): it changes how agents behave.
Adding a default skill repo is a PR to `sources.yaml` (name, url, branch, and `path` if the skills are in a sub-folder).
