/**
 * The text the MCP server gives agents: server-level instructions and the search_skills tool description.
 * SKILLBASE_SEARCH picks how eagerly the agent should search:
 *   proactive (default)  search without asking first when the user asks what skills exist, or starts a
 *                        substantial task no local skill fits
 *   ask                  search only when the user asks for shared skills, or agrees after being offered
 * Agents read this once at startup.
 */
export type SearchMode = "proactive" | "ask";

export function searchMode(value: string | undefined = process.env.SKILLBASE_SEARCH): SearchMode {
  return /^ask$/i.test((value ?? "").trim()) ? "ask" : "proactive";
}

const INTRO = `skillbase searches the SHARED skill library: SKILL.md skills published in shared git repos.
These are separate from the user's own local skills, which the agent already loads natively.`;

const WORKFLOW = `Workflow: search_skills -> show the user the options (name, author, dates, source) -> let the user pick -> get_skill -> follow it for this task.`;

export function instructions(mode: SearchMode = searchMode()): string {
  if (mode === "ask") {
    return `${INTRO}

Only search shared skills when the user asks for it (e.g. "also check shared skills", "is there a shared skill for this").
You may offer a search when no local skill fits a substantial task, but ask first.

${WORKFLOW}
Do not load a shared skill the user has not chosen.`;
  }
  return `${INTRO}

Search shared skills proactively, without asking first, whenever:
- the user asks what skills they have or whether a skill exists for something (search shared skills as well as checking local ones, and report both), or
- the user starts a substantial task and no local skill clearly fits it.
Skip the search for trivial tasks and when a local skill already fits.

${WORKFLOW}
Searching needs no permission, but do not load a shared skill the user has not chosen.`;
}

export function searchToolDescription(mode: SearchMode = searchMode()): string {
  const when =
    mode === "ask"
      ? "Use only when the user asks to check shared skills, or agrees after you offer. "
      : "Call this proactively, without asking first, when the user asks what skills exist or when a substantial task has no clearly fitting local skill. ";
  return (
    "Search the SHARED skill library (git repos, not the user's local skills) for skills that fit a task. " +
    when +
    "Returns the best matches with name, id, author, created/updated dates and source. Present them to the user to choose; then call get_skill with the chosen id."
  );
}
