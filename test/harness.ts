// Uniform test surface shared by every test file in this repository so the
// same source runs unchanged under `node --test` and `bun test`. Import
// `describe`/`it`/`test`/lifecycle hooks/`assert` from here, never directly
// from `node:test`, `node:assert`, or `bun:test`.
//
// Node and Bun ship incompatible test-runner modules (`node:test` has
// `before`/`after`; `bun:test` has `beforeAll`/`afterAll` and no `assert`
// export at all — assertions go through `expect()`). This module detects the
// engine at import time and re-exports a single shape that papers over both.
import { PlatformInfo } from "../src/backend-msb/platform.js";
//
// Deliberately does NOT statically `import` from `"bun:test"`: the
// `bun-types` ambient declarations for that module drag in global overrides
// that collide with `@types/node` (both declare incompatible globals such as
// `setTimeout`/`ConnectionOptions`/`KeyObject`). Loading `bun:test` via a
// dynamic import keeps the project on `@types/node` only, matching
// `tsconfig.json`'s `types: ["node"]`, while still resolving and running
// correctly at runtime under Bun (proven by `harness.test.ts`).

export type TestFn = (t?: unknown) => unknown | Promise<unknown>;
export type HookFn = () => unknown | Promise<unknown>;

export interface AssertApi {
  equal(actual: unknown, expected: unknown, message?: string): void;
  deepEqual(actual: unknown, expected: unknown, message?: string): void;
  ok(value: unknown, message?: string): void;
  throws(fn: () => unknown, message?: string): void;
  rejects(fn: (() => Promise<unknown>) | Promise<unknown>, message?: string): Promise<void>;
  match(value: string, pattern: RegExp, message?: string): void;
}

export interface HarnessApi {
  readonly engine: "node" | "bun";
  describe(name: string, fn: () => void): void;
  it(name: string, fn: TestFn): void;
  test(name: string, fn: TestFn): void;
  before(fn: HookFn): void;
  after(fn: HookFn): void;
  beforeEach(fn: HookFn): void;
  afterEach(fn: HookFn): void;
  assert: AssertApi;
}

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

async function loadNode(): Promise<HarnessApi> {
  const nodeTest = await import("node:test");
  const nodeAssert = await import("node:assert/strict");
  const assert: AssertApi = {
    equal: (a, e, m) => nodeAssert.equal(a, e, m),
    deepEqual: (a, e, m) => nodeAssert.deepEqual(a, e, m),
    ok: (v, m) => nodeAssert.ok(v, m),
    throws: (fn, m) => nodeAssert.throws(fn, m),
    rejects: (fn, m) => nodeAssert.rejects(fn as never, m),
    match: (v, p, m) => nodeAssert.match(v, p, m),
  };
  return {
    engine: "node",
    describe: (name, fn) => nodeTest.describe(name, fn),
    it: (name, fn) => nodeTest.it(name, fn as never),
    test: (name, fn) => nodeTest.test(name, fn as never),
    before: (fn) => nodeTest.before(fn as never),
    after: (fn) => nodeTest.after(fn as never),
    beforeEach: (fn) => nodeTest.beforeEach(fn as never),
    afterEach: (fn) => nodeTest.afterEach(fn as never),
    assert,
  };
}

// Structural shape of the subset of `bun:test` this harness relies on.
// Kept local (not `bun-types`) so the main project typecheck never has to
// load Bun's global overrides. Verified against the real module at runtime.
interface BunTestModule {
  describe(name: string, fn: () => void): void;
  it(name: string, fn: TestFn): void;
  test(name: string, fn: TestFn): void;
  beforeAll(fn: HookFn): void;
  afterAll(fn: HookFn): void;
  beforeEach(fn: HookFn): void;
  afterEach(fn: HookFn): void;
  expect(actual: unknown): {
    toEqual(expected: unknown): void;
    toBeTruthy(): void;
    toThrow(message?: string): void;
  };
}

function withMessage(m: string | undefined, run: () => void): void {
  try {
    run();
  } catch (err) {
    if (m === undefined) {
      throw err;
    }
    throw new Error(m, { cause: err });
  }
}

async function loadBun(): Promise<HarnessApi> {
  const spec = "bun:test";
  const bunTest = (await import(/* @vite-ignore */ spec)) as unknown as BunTestModule;
  const assert: AssertApi = {
    equal: (a, e, m) => withMessage(m, () => bunTest.expect(a).toEqual(e)),
    deepEqual: (a, e, m) => withMessage(m, () => bunTest.expect(a).toEqual(e)),
    ok: (v, m) => withMessage(m, () => bunTest.expect(v).toBeTruthy()),
    throws: (fn, m) => withMessage(m, () => bunTest.expect(fn).toThrow()),
    rejects: async (fn, m) => {
      const promise = typeof fn === "function" ? (async () => fn())() : fn;
      let threw = false;
      try {
        await promise;
      } catch {
        threw = true;
      }
      if (!threw) {
        throw new Error(m ?? "expected promise to reject");
      }
    },
    match: (v, p, m) => {
      if (!p.test(v)) {
        throw new Error(m ?? `expected ${JSON.stringify(v)} to match ${String(p)}`);
      }
    },
  };
  return {
    engine: "bun",
    describe: (name, fn) => bunTest.describe(name, fn),
    it: (name, fn) => bunTest.it(name, fn),
    test: (name, fn) => bunTest.test(name, fn),
    before: (fn) => bunTest.beforeAll(fn),
    after: (fn) => bunTest.afterAll(fn),
    beforeEach: (fn) => bunTest.beforeEach(fn),
    afterEach: (fn) => bunTest.afterEach(fn),
    assert,
  };
}

const api: HarnessApi = isBun ? await loadBun() : await loadNode();

export const engine = api.engine;
export const describe = api.describe;
export const it = api.it;
export const test = api.test;
export const before = api.before;
export const after = api.after;
export const beforeEach = api.beforeEach;
export const afterEach = api.afterEach;
export const assert = api.assert;

/**
 * Integration-test gate, the analog of a `@Tag("sandbox-it")` marker: a
 * no-op (skipped) test unless `RIGHTSIZE_IT=1` is set in the environment.
 * Plain `npm test` never runs these, so it passes on any machine with no
 * container runtime installed.
 *
 * Integration-test FILES must also run serially, never in parallel, across
 * processes: `node --test` and `bun test` each start one process per test
 * file, and each process computes its own `RunId` and runs its own orphan
 * reaper (see `src/backend-msb`'s `sweepOrphans`). Two concurrent IT
 * processes would each treat the other's live containers as orphans of a
 * crashed run and reap them.
 *
 * The two runners need different fixes because they parallelize at
 * different granularities: `node --test` spawns one child process per test
 * file (verified: two files report two different `process.pid` values), so
 * `test:node:it` passes `--test-concurrency=1` to keep those file-processes
 * from overlapping. `bun test`, run with no `--parallel` flag, keeps the
 * entire run — every file — in a single process (verified: two files report
 * the same `process.pid`); `--parallel=N` is what turns on the
 * multi-process/worker mode, so `test:bun:it` simply never passes it. (Bun's
 * `--isolate`/`--parallel` worker mode was also found to break this
 * harness's top-level-await + namespace-import shape with a
 * "Cannot access 'describe' before initialization" TDZ error — one more
 * reason to leave it off, independent of the concurrency question.)
 */
export function itIntegration(name: string, fn: TestFn): void {
  if (process.env["RIGHTSIZE_IT"] !== "1") {
    return;
  }
  it(name, fn);
}

/**
 * Like {@link itIntegration}, but only when this machine can actually run
 * microsandbox: the msb backend suites drive the real binary directly, which
 * needs working hardware virtualization (KVM access on Linux) and makes no
 * sense when the run is pinned to the docker backend.
 */
export function itMsbIntegration(name: string, fn: TestFn): void {
  if (process.env["RIGHTSIZE_IT"] !== "1") {
    return;
  }
  if (process.env["RIGHTSIZE_BACKEND"] === "docker") {
    return;
  }
  if (PlatformInfo.current() === undefined || !PlatformInfo.virtualizationAvailable()) {
    return;
  }
  it(name, fn);
}
