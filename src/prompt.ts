import readline from "node:readline";

/** Global --yes: answer every question with its default. */
let assumeYes = false;
export function setAssumeYes(v: boolean) {
  assumeYes = v;
}

export const interactive = () => !!process.stdin.isTTY && !assumeYes;

// One readline for the whole process: a new interface per question drops type-ahead / piped answers.
let rl: readline.Interface | undefined;
const lines: string[] = [];
const waiting: ((l: string | undefined) => void)[] = [];
let ended = false;

function nextLine(): Promise<string | undefined> {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on("line", (l) => (waiting.length ? waiting.shift()!(l) : lines.push(l)));
    rl.on("close", () => {
      ended = true;
      while (waiting.length) waiting.shift()!(undefined);
    });
  }
  if (lines.length) return Promise.resolve(lines.shift());
  if (ended) return Promise.resolve(undefined);
  return new Promise((r) => waiting.push(r));
}

export function closePrompt() {
  rl?.close();
}

/** Ask a yes/no question. With --yes, or no terminal, the default is taken. */
export async function confirm(question: string, def: boolean): Promise<boolean> {
  const hint = def ? "[Y/n]" : "[y/N]";
  if (!interactive()) {
    console.log(`${question} ${hint} ${def ? "y" : "n"} (default)`);
    return def;
  }
  for (;;) {
    process.stdout.write(`${question} ${hint} `);
    const raw = await nextLine();
    if (raw === undefined) {
      console.log("");
      return def;
    }
    const a = raw.trim().toLowerCase();
    if (!a) return def;
    if (a === "y" || a === "yes") return true;
    if (a === "n" || a === "no") return false;
  }
}
