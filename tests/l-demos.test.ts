import { spawn } from "node:child_process";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeTestPool,
  MOCK_BASE,
  resetAll,
  TEST_DB,
  TSX,
  workerTestEnv,
} from "./helpers.js";

beforeEach(async () => {
  await resetAll();
});

afterAll(async () => {
  await closeTestPool();
});

function runDemo(scenario: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, ["src/scripts/demo.ts", scenario], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...workerTestEnv,
        DATABASE_URL: TEST_DB,
        DOCUSIGN_BASE_URL: MOCK_BASE,
        DOCUSIGN_CREATE_TIMEOUT_MS: "800",
        MOCK_TIMEOUT_MS: "2000",
        // Crash demo uses 10s stale in script; keep as-is for realism.
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout?.on("data", (b) => {
      out += b.toString();
    });
    child.stderr?.on("data", (b) => {
      out += b.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, out }));
  });
}

describe("L. Demo scripts", () => {
  it('29. demo:normal|crash|timeout|concurrent exit 0 and print DUPLICATES: 0', async () => {
    for (const scenario of ["normal", "crash", "timeout", "concurrent"]) {
      await resetAll();
      const { code, out } = await runDemo(scenario);
      expect(code, `${scenario} exit`).toBe(0);
      expect(out, scenario).toMatch(/DUPLICATES:\s*0/);
    }
  }, 300_000);
});
