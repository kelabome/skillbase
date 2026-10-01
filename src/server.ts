import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadSources, loadState } from "./config.js";
import { getEmbedder } from "./embed.js";
import { instructions, searchMode, searchToolDescription } from "./instructions.js";
import { logEvent } from "./log.js";
import { SkillBase, formatHits, formatSkill, loggedGet, loggedSearch } from "./service.js";

const VERSION = "0.1.0";

export async function serve(): Promise<void> {
  const sb = new SkillBase();
  const mode = searchMode();
  const server = new McpServer({ name: "skillbase", version: VERSION }, { instructions: instructions(mode) });
  const client = () => {
    const c = server.server.getClientVersion();
    return c ? `${c.name}/${c.version}` : "unknown";
  };
  server.server.oninitialized = () => logEvent({ ev: "server_start", client: client(), version: VERSION });

  server.registerTool(
    "search_skills",
    {
      title: "Search shared skills",
      description: searchToolDescription(mode),
      inputSchema: {
        query: z.string().min(2).describe("The task in plain words, e.g. 'fill in a PDF form and merge it with another PDF'"),
        limit: z.number().int().min(1).max(20).optional().describe("Max results (default 5)"),
        source: z.string().optional().describe("Only search this source (see list_sources)"),
        include_deprecated: z.boolean().optional(),
      },
    },
    async ({ query, limit, source, include_deprecated }) => {
      const s = await sb.ready();
      const hits = await loggedSearch(s, query, { limit, source, includeDeprecated: include_deprecated }, client());
      return { content: [{ type: "text", text: formatHits(hits, query) }] };
    },
  );

  server.registerTool(
    "get_skill",
    {
      title: "Load a shared skill",
      description:
        "Load the full instructions of one shared skill chosen by the user, by the id returned from search_skills. " +
        "Follow the returned instructions for the current task only. Scripts and reference files live in the folder shown.",
      inputSchema: { id: z.string().describe("Skill id from search_skills, e.g. 'anthropic-skills:pdf'") },
    },
    async ({ id }) => {
      const s = await sb.ready();
      const skill = loggedGet(s, id, client());
      if (!skill) return { isError: true, content: [{ type: "text", text: `No shared skill with id "${id}". Use search_skills first.` }] };
      return { content: [{ type: "text", text: formatSkill(skill) }] };
    },
  );

  server.registerTool(
    "list_sources",
    {
      title: "List shared skill sources",
      description: "List the shared git repos skillbase searches, with skill counts and last sync status.",
      inputSchema: {},
    },
    async () => {
      const data = (await sb.ready()).data;
      const state = loadState();
      const lines = loadSources().map((src) => {
        const st = state.sources?.[src.name];
        const n = data.skills.filter((k) => k.source === src.name).length;
        return `- ${src.name}: ${src.url}${src.branch ? ` (${src.branch})` : ""} · ${n} skills · last sync ${st?.at?.slice(0, 16) ?? "never"} ${st ? (st.ok ? "ok" : "FAILED: " + st.error) : ""}`;
      });
      const mode = data.model ? `semantic + keyword (${data.model})` : "keyword only";
      return { content: [{ type: "text", text: (lines.length ? lines.join("\n") : "No sources configured. Run: skillbase sources add <git-url>") + `\nsearch mode: ${mode}` }] };
    },
  );

  server.registerTool(
    "sync_skills",
    {
      title: "Update shared skills now",
      description: "git pull every shared skill source and rebuild the index. Normally automatic (hourly); use when the user says a skill was just published or updated.",
      inputSchema: {},
    },
    async () => {
      const r = await sb.refresh({ trigger: "mcp" });
      const lines = r.results.map((x) => `- ${x.name}: ${x.ok ? `ok @ ${x.commit}` : `FAILED ${x.error}${x.stale ? " (using cached copy)" : ""}`}`);
      const what = r.rebuilt ? "changes found, index rebuilt" : "no changes";
      return { content: [{ type: "text", text: `${lines.join("\n")}\n${what} · ${r.skills} shared skills` }] };
    },
  );

  await server.connect(new StdioServerTransport());
  // Warm up without blocking the handshake.
  sb.ready()
    .then((s) => (s.data.model ? getEmbedder() : null))
    .catch((e) => process.stderr.write(`[skillbase] ${e.message}\n`));
}
