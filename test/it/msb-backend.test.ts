import { describe, itMsbIntegration as itIntegration, assert } from "../harness.js";
import { MsbCliBackend } from "../../src/backend-msb/backend.js";
import { ensureInstalled } from "../../src/backend-msb/provisioner.js";
import { invoke } from "../../src/backend-msb/invoke.js";
import { MsbCommands } from "../../src/backend-msb/commands.js";
import { runningNames } from "../../src/backend-msb/ls-json.js";
import { UnsupportedByBackendError } from "../../src/core/errors.js";
import { RunId } from "../../src/core/run-id.js";
import type { ContainerSpec } from "../../src/core/model.js";
import type { SandboxHandle } from "../../src/core/backend.js";

/**
 * Live gates against the real `msb 0.6.6` binary at `~/.cache/rightsize`
 * (`RIGHTSIZE_IT=1`). Every sandbox this file creates carries the
 * `rz-<RunId.value>-*` naming convention the reaper filters on, and every
 * test cleans up its own sandbox before returning so `msb ls` is empty both
 * before and after this suite runs, regardless of which assertion fails.
 */

let seq = 0;
function nextName(): string {
  seq += 1;
  return `rz-${RunId.value}-it-msb-${seq}`;
}

function baseSpec(overrides: Partial<ContainerSpec> = {}): ContainerSpec {
  return {
    name: nextName(),
    image: "alpine:3.19",
    env: [],
    command: ["sleep", "60"],
    ports: [],
    mounts: [],
    networkId: undefined,
    aliases: [],
    runId: RunId.value,
    memoryLimitMb: undefined,
    ...overrides,
  };
}

async function withSandbox<T>(
  backend: MsbCliBackend,
  spec: ContainerSpec,
  fn: (handle: SandboxHandle) => Promise<T>,
): Promise<T> {
  const handle = await backend.create(spec);
  try {
    await backend.start(handle);
    return await fn(handle);
  } finally {
    await backend.stop(handle).catch(() => {});
    await backend.remove(handle).catch(() => {});
  }
}

describe("MsbCliBackend integration (real msb 0.6.6 binary)", () => {
  itIntegration("attached-mode boot reaches Running; exec and logs work against it", async () => {
    const backend = new MsbCliBackend(ensureInstalled());
    const spec = baseSpec({ env: [["FOO", "bar"]] });
    await withSandbox(backend, spec, async (handle) => {
      const exec = await backend.exec(handle, ["sh", "-c", "echo $FOO"]);
      assert.equal(exec.exitCode, 0);
      assert.equal(exec.stdout.trim(), "bar");

      const nonZero = await backend.exec(handle, ["sh", "-c", "exit 7"]);
      assert.equal(nonZero.exitCode, 7);

      const logs = await backend.logs(handle);
      assert.equal(typeof logs, "string");
    });
  });

  itIntegration("runningNames against a real `msb ls` shows this sandbox as Running while it's up", async () => {
    const msbPath = await ensureInstalled();
    const backend = new MsbCliBackend(Promise.resolve(msbPath));
    const spec = baseSpec();
    const handle = await backend.create(spec);
    try {
      await backend.start(handle);
      const ls = await invoke(msbPath, MsbCommands.ls(), 30_000);
      const names = runningNames(ls.stdout);
      assert.ok(names.has(handle.id), `expected 'msb ls' to report ${handle.id} as Running`);
    } finally {
      await backend.stop(handle).catch(() => {});
      await backend.remove(handle).catch(() => {});
    }
  });

  itIntegration(
    "installNetworkLinks on a consumer image with no nc/busybox fails fast with the docker remedy and self-cleans",
    async () => {
      const backend = new MsbCliBackend(ensureInstalled());
      // debian:12-slim has neither nc nor busybox (verified: `command -v nc`
      // and `command -v busybox` both exit 127 in the image), unlike alpine
      // which ships busybox (and therefore nc) by default.
      const spec = baseSpec({ image: "debian:12-slim", command: ["sleep", "60"] });
      await withSandbox(backend, spec, async (handle) => {
        let thrown: unknown;
        try {
          await backend.installNetworkLinks(handle, [{ alias: "sibling", guestPort: 8080, targetHostPort: 9999 }]);
        } catch (err) {
          thrown = err;
        }
        assert.ok(thrown instanceof UnsupportedByBackendError, `expected UnsupportedByBackendError, got ${String(thrown)}`);
        const asError = thrown as UnsupportedByBackendError;
        assert.ok(asError.message.includes("nc/busybox"), `expected the nc/busybox reason, got: ${asError.message}`);
        assert.ok(
          asError.message.includes("RIGHTSIZE_BACKEND=docker"),
          `expected the docker remedy, got: ${asError.message}`,
        );
      });
    },
  );

  itIntegration("installNetworkLinks rejects a duplicate guest port before touching the sandbox, and self-cleans", async () => {
    const backend = new MsbCliBackend(ensureInstalled());
    const spec = baseSpec();
    await withSandbox(backend, spec, async (handle) => {
      let thrown: unknown;
      try {
        await backend.installNetworkLinks(handle, [
          { alias: "a", guestPort: 8080, targetHostPort: 9001 },
          { alias: "b", guestPort: 8080, targetHostPort: 9002 },
        ]);
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown instanceof UnsupportedByBackendError, `expected UnsupportedByBackendError, got ${String(thrown)}`);
      assert.ok(
        (thrown as Error).message.includes("8080"),
        `expected the duplicate port named in the message, got: ${(thrown as Error).message}`,
      );
    });
  });

  itIntegration(
    "installNetworkLinks rejects a shell-quoting-breaking alias before the /etc/hosts shell-out",
    async () => {
      const backend = new MsbCliBackend(ensureInstalled());
      const spec = baseSpec();
      await withSandbox(backend, spec, async (handle) => {
        let thrown: unknown;
        try {
          await backend.installNetworkLinks(handle, [
            { alias: "sib'; rm -rf /; echo '", guestPort: 8080, targetHostPort: 9001 },
          ]);
        } catch (err) {
          thrown = err;
        }
        assert.ok(thrown instanceof UnsupportedByBackendError, `expected UnsupportedByBackendError, got ${String(thrown)}`);
        assert.ok(
          (thrown as Error).message.includes("DNS label"),
          `expected the DNS-label remedy, got: ${(thrown as Error).message}`,
        );

        // Prove the rejection happened BEFORE any /etc/hosts mutation: the
        // sandbox's own hosts file must be untouched by the rejected alias.
        const hosts = await backend.exec(handle, ["cat", "/etc/hosts"]);
        assert.ok(!hosts.stdout.includes("rm -rf"), "the invalid alias must never reach the shell-out");
      });
    },
  );

  itIntegration("close() stops and removes every sandbox this backend started, leaving msb ls clean", async () => {
    const backend = new MsbCliBackend(ensureInstalled());
    const spec = baseSpec();
    const handle = await backend.create(spec);
    await backend.start(handle);

    await backend.close();

    const msbPath = await ensureInstalled();
    const ls = await invoke(msbPath, MsbCommands.ls(), 30_000);
    const names = runningNames(ls.stdout);
    assert.ok(!names.has(handle.id), "close() must have stopped+removed this run's sandbox");
  });
});
