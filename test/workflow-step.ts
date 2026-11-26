import { spawnSync } from "node:child_process";

/** The `run: |` script of the step named `name` in a workflow's text. */
export const stepScript = (workflow: string, name: string): string => {
  const lines = workflow.split("\n");
  const start = lines.findIndex(line => line.trim() === `- name: ${name}`);
  if (start === -1) throw new Error(`no step named ${name}`);
  const run = lines.findIndex(
    (line, i) => i > start && /^\s+run: \|$/.test(line),
  );
  const indent = /^ */.exec(lines[run + 1] ?? "")?.[0] ?? "";
  const body: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (line !== "" && !line.startsWith(indent)) break;
    body.push(line.slice(indent.length));
  }
  return body.join("\n");
};

/** Runs a step's script with bash the way GitHub Actions does. */
export const runStep = (
  script: string,
  options: { cwd: string; env: Record<string, string> },
): { status: number | null; output: string } => {
  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-eo", "pipefail", "-c", script],
    {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      encoding: "utf8",
    },
  );
  return { status: result.status, output: result.stdout + result.stderr };
};
