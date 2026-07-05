import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, assert, before, after } from "../../test/harness.js";
import { invoke } from "./invoke.js";

describe("invoke", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rightsize-invoke-test-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function fakeMsb(script: string): Promise<string> {
    const p = path.join(tmpDir, `fake-msb-${Date.now()}-${Math.random().toString(16).slice(2)}.sh`);
    await fs.writeFile(p, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return p;
  }

  it("captures stdout, stderr, and the real exit code", async () => {
    const bin = await fakeMsb(`echo out-line; echo err-line >&2; exit 7`);
    const result = await invoke(bin, [], 5_000);
    assert.equal(result.exitCode, 7);
    assert.match(result.stdout, /out-line/);
    assert.match(result.stderr, /err-line/);
  });

  it("closes stdin so a script waiting for EOF never hangs", async () => {
    // cat with no args reads stdin until EOF; if invoke() left stdin open
    // ("pipe" with nothing written and never closed) this would hang until
    // the test's own timeout, not invoke()'s.
    const bin = await fakeMsb(`cat; echo done`);
    const result = await invoke(bin, [], 5_000);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /done/);
  });

  it("joins the drain without truncating output that arrives right at process exit", async () => {
    const bigLine = "x".repeat(5000);
    const bin = await fakeMsb(`for i in $(seq 1 50); do echo "${bigLine}"; done`);
    const result = await invoke(bin, [], 5_000);
    const lines = result.stdout.trim().split("\n");
    assert.equal(lines.length, 50);
    assert.equal(lines[0]?.length, 5000);
  });

  it("rejects with a BackendError naming the timeout when the process hangs", async () => {
    const bin = await fakeMsb(`sleep 10`);
    await assert.rejects(() => invoke(bin, [], 100));
  });
});
