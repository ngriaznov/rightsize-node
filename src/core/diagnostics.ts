import type { SandboxBackend, SandboxHandle } from "./backend.js";
import { liveContainers } from "./cleanup.js";

/** Bounded log tail: matches the cross-language contract (Kotlin/Rust `diagnostics` report the same tail length). */
const LOG_TAIL_LINES = 50;

function formatPorts(spec: SandboxHandle["spec"]): string {
  if (spec.ports.length === 0) {
    return "(none)";
  }
  return spec.ports.map((p) => `${p.guestPort}->${p.hostPort}`).join(", ");
}

/** The last `n` lines of `raw`, dropping one trailing empty element from a final newline (never a real blank log line otherwise). */
function tailLines(raw: string, n: number): string[] {
  const lines = raw.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.slice(-n);
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Every entry in the live-container registry is, by construction, currently
 * running (see `cleanup.ts`'s doc) — `state:` is therefore always
 * `running`, never queried from the backend. `host` is always `127.0.0.1`
 * per `GenericContainer.host`'s own invariant.
 */
async function renderContainer(handle: SandboxHandle, backend: SandboxBackend): Promise<string> {
  const lines = [`-- ${handle.spec.name} (${handle.spec.image}) --`, `state: running   host: 127.0.0.1   ports: ${formatPorts(handle.spec)}`];
  try {
    const raw = await backend.logs(handle);
    lines.push(`last ${LOG_TAIL_LINES} log lines:`);
    for (const line of tailLines(raw, LOG_TAIL_LINES)) {
      lines.push(`  ${line}`);
    }
  } catch (err) {
    lines.push(`logs: unavailable (${reasonOf(err)})`);
  }
  return lines.join("\n");
}

/**
 * The failure-diagnostics report: every container this process currently has
 * running (`cleanup.ts`'s live-container registry — populated on a
 * successful `start()`, cleared on `stop()`), in start order — its image,
 * state, host, mapped ports, and a bounded tail of its logs. Identical
 * FORMAT to the Kotlin and Rust implementations (contract-tested against a
 * golden fixture). A failing `logs()` call degrades to a one-line
 * `logs: unavailable (<reason>)` instead of throwing, so one broken
 * container's log fetch never hides the rest of the report. Every
 * container's `logs()` call runs concurrently.
 *
 * A `keepAlive` (reuse) container is never in this registry — see
 * `cleanup.ts`'s `registerSyncCleanup` call site — so it never appears in
 * this report; it isn't torn down by this process anyway.
 */
export async function diagnostics(): Promise<string> {
  const entries = liveContainers();
  if (entries.length === 0) {
    return "== rightsize diagnostics: no running containers ==";
  }
  const blocks = await Promise.all(entries.map(({ handle, backend }) => renderContainer(handle, backend)));
  return `== rightsize diagnostics: ${entries.length} running container(s) ==\n${blocks.join("\n")}`;
}

/**
 * The shape of a test framework's own failure-registration function —
 * matches vitest's `onTestFailed` closely enough that passing the real
 * thing typechecks (a callback accepting fewer parameters than the
 * framework's own handler type is always assignable to it). No dependency
 * on any particular test framework.
 */
export type FailureHook = (callback: () => void | Promise<void>) => void;

/**
 * Framework-neutral wiring for "print the full diagnostics report, once, to
 * stderr, when a test fails." Pass a test framework's own failure-
 * registration function — e.g. vitest's `onTestFailed` — and this registers
 * a callback with it that runs `diagnostics()` and writes the result. See
 * the [diagnostics guide](/guide/diagnostics) for the vitest wiring example.
 */
export function registerDiagnostics(
  onTestFailed: FailureHook,
  write: (text: string) => void = (text: string) => {
    process.stderr.write(text);
  },
): void {
  onTestFailed(() => diagnostics().then((text) => write(`${text}\n`)));
}
