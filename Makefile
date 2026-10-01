# skillbase: shared skill search for Claude Code, Codex and OpenCode.
# Run `make` to see the commands.

SHELL      := /bin/bash
BIN_DIR    ?= $(HOME)/.local/bin
DATA_DIR   ?= $(or $(SKILLBASE_HOME),$(HOME)/.skillbase)
CLI        := node $(CURDIR)/dist/cli.js
YESFLAG    := $(if $(YES),--yes,)
STAMP      := $(shell date +%Y%m%d-%H%M%S)

.DEFAULT_GOAL := help
.PHONY: help install setup fresh status search remove uninstall update logs test eval build deps check

help:
	@echo "skillbase: search shared skills from Claude Code, Codex and OpenCode"
	@echo ""
	@echo "  make install     build, add the 'skillbase' command, connect your agents (asks one by one)"
	@echo "  make setup       connect / reconnect your agents (asks one by one)"
	@echo "  make fresh       pull the skill repos; rebuild the index only if something changed"
	@echo "  make status      check everything: git access, index, agents"
	@echo "  make search Q='fill in a PDF form'"
	@echo "  make update      update skillbase itself (git pull) and the skills"
	@echo "  make logs        pack usage logs into a .tar.gz (e.g. for a bug report)"
	@echo "  make remove      disconnect your agents (asks one by one)"
	@echo "  make uninstall   remove everything skillbase added (asks one by one)"
	@echo ""
	@echo "  YES=1 answers yes to every question, e.g. make install YES=1"

check:
	@command -v node >/dev/null || { echo "Node.js >= 20 is required (https://nodejs.org or nvm)"; exit 1; }
	@node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' || { echo "Node.js >= 20 is required, found $$(node -v)"; exit 1; }
	@command -v git >/dev/null || { echo "git is required"; exit 1; }

deps: check
	@echo "==> installing dependencies"
	@if [ -f package-lock.json ]; then npm ci --no-audit --no-fund --no-progress --loglevel=error --no-update-notifier; else npm install --no-audit --no-fund --no-progress --loglevel=error --no-update-notifier; fi

build: deps
	@echo "==> building"
	@npm run --silent build

install: build
	@echo "==> adding the skillbase command to $(BIN_DIR)"
	@mkdir -p "$(BIN_DIR)"
	@ln -sfn "$(CURDIR)/dist/cli.js" "$(BIN_DIR)/skillbase"
	@case ":$$PATH:" in *":$(BIN_DIR):"*) ;; *) echo "    note: $(BIN_DIR) is not on your PATH; add it to use 'skillbase' directly (make targets work regardless)";; esac
	@echo "==> connecting your agents"
	@$(CLI) setup $(YESFLAG)

setup:
	@$(CLI) setup $(YESFLAG)

fresh:
	@$(CLI) fresh

status:
	@$(CLI) status

search:
	@test -n "$(Q)" || { echo "usage: make search Q='what you want to do'"; exit 1; }
	@$(CLI) search $(Q)

update:
	@echo "==> updating skillbase"
	@git pull --ff-only
	@$(MAKE) --no-print-directory build
	@$(CLI) fresh

remove:
	@$(CLI) remove $(YESFLAG)

uninstall:
	@if [ -f dist/cli.js ]; then $(CLI) uninstall $(YESFLAG); else echo "not built; skipping agent removal"; fi
	@if [ -L "$(BIN_DIR)/skillbase" ]; then rm -f "$(BIN_DIR)/skillbase" && echo "    removed $(BIN_DIR)/skillbase"; fi
	@rm -rf node_modules dist && echo "    removed node_modules and dist from this checkout"
	@echo "skillbase is uninstalled. You can delete this folder (usage logs live in $(DATA_DIR)/logs)."

logs:
	@if [ ! -d "$(DATA_DIR)/logs" ] || [ -z "$$(ls -A "$(DATA_DIR)/logs" 2>/dev/null)" ]; then echo "no logs yet"; exit 0; fi
	@tar -czf "skillbase-logs-$(USER)-$(STAMP).tar.gz" -C "$(DATA_DIR)" logs
	@echo "created $(CURDIR)/skillbase-logs-$(USER)-$(STAMP).tar.gz"
	@echo "It has your search queries and which skills you opened (no skill contents, no credentials)."
	@echo "Attach it to a bug report if it helps."

test: build
	@npm test --silent

eval:
	@npx tsx test/eval.ts -v
