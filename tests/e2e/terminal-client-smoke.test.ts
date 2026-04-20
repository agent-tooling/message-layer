import { describe, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { resolve as resolvePath } from "node:path";

const PROJECT_ROOT = resolvePath(import.meta.dirname, "../..");
const CLIENT_ENTRY = resolvePath(PROJECT_ROOT, "clients/terminal/client.ts");

function runTerminalClientSmoke(): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", CLIENT_ENTRY, "--smoke"],
      {
        cwd: PROJECT_ROOT,
        env: process.env,
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += String(data);
    });
    child.stderr.on("data", (data) => {
      stderr += String(data);
    });
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

describe("terminal client smoke", () => {
  test("runs --smoke mode successfully", { timeout: 30000 }, async () => {
    const result = await runTerminalClientSmoke();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("terminal-client-smoke-ok");
  });
});
