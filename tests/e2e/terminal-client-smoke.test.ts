import { describe, expect, test } from "vitest";
import { spawn } from "node:child_process";

function runTerminalClientSmoke(): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      "bun",
      ["x", "tsx", "clients/terminal/client.ts", "--smoke"],
      {
        cwd: "/workspace",
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
  test("runs --smoke mode successfully", { timeout: 20000 }, async () => {
    const result = await runTerminalClientSmoke();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("terminal-client-smoke-ok");
  });
});
