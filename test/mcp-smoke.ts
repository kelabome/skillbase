/** Starts `skillbase serve` over stdio as an agent would and exercises every tool. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/cli.js", "serve"],
  env: { ...process.env } as Record<string, string>,
  stderr: "inherit",
});
const client = new Client({ name: "smoke", version: "0" });
const t0 = Date.now();
await client.connect(transport);
console.log(`connected in ${Date.now() - t0} ms; instructions: ${client.getInstructions()?.split("\n")[0]}`);
console.log("tools:", (await client.listTools()).tools.map((t) => t.name).join(", "));

const text = (r: any) => r.content.map((c: any) => c.text).join("\n");
const q = process.argv[2] ?? "fill in a PDF form and merge it with another PDF";
let t = Date.now();
const search = await client.callTool({ name: "search_skills", arguments: { query: q, limit: 3 } });
console.log(`\n--- search_skills (${Date.now() - t} ms)\n` + text(search));
const id = /\[id: ([^\]]+)\]/.exec(text(search))?.[1];
if (id) {
  const got = await client.callTool({ name: "get_skill", arguments: { id } });
  console.log(`\n--- get_skill ${id}\n` + text(got).split("\n").slice(0, 12).join("\n") + "\n...");
}
const bad = await client.callTool({ name: "get_skill", arguments: { id: "nope:nope" } });
console.log(`\n--- get_skill bad id -> isError=${bad.isError}`);
console.log("\n--- list_sources\n" + text(await client.callTool({ name: "list_sources", arguments: {} })));
await client.close();
