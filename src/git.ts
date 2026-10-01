import { execFile } from "node:child_process";

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Run git non-interactively: never prompt for credentials, never hang on ssh. */
export function git(args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<GitResult> {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes -o ConnectTimeout=15",
  };
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd: opts.cwd, env, timeout: opts.timeoutMs ?? 120_000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr || err?.message || "") }),
    );
  });
}
