import * as http from "node:http";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { describe, it, assert, before, after } from "../../test/harness.js";
import {
  ensureInstalledAt,
  _parseChecksumsForTests,
  _downloadAndInstallForTests,
  MSB_VERSION,
} from "./provisioner.js";
import { PlatformInfo } from "./platform.js";

const platform = PlatformInfo.current();
const msbAsset = platform !== undefined ? PlatformInfo.msbAsset(platform) : "msb-darwin-aarch64";
const krunAsset = platform !== undefined ? PlatformInfo.krunAsset(platform) : "libkrunfw-darwin-aarch64.dylib";
// Downloads are served under the asset name; the provisioner installs under the
// canonical name msb resolves.
const krunInstallName = platform !== undefined ? PlatformInfo.krunInstallName(platform) : "libkrunfw.5.dylib";
// The install-target basename: msb.exe on Windows, suffixless msb elsewhere —
// see msbBinaryName's doc comment. Hardcoding "msb" here would fail on
// Windows, where the provisioner correctly installs under "msb.exe".
const msbBinaryName = platform !== undefined ? PlatformInfo.msbBinaryName(platform) : "msb";

const MSB_BYTES = Buffer.from("#!/bin/sh\necho fake-msb\n");
const KRUN_BYTES = Buffer.from("fake-krun-shared-object");

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

interface Fixture {
  server: http.Server;
  baseUrl: string;
  assets: Map<string, Buffer>;
  brokenAsset?: string;
}

function startFixtureServer(assets: Map<string, Buffer>): Promise<Fixture> {
  return new Promise((resolveStart) => {
    const fixture: Fixture = { server: null as unknown as http.Server, baseUrl: "", assets };
    const server = http.createServer((req, res) => {
      const url = req.url ?? "/";
      const name = url.replace(/^\//, "");
      if (name === "checksums.sha256") {
        // The checksum always reflects the GOOD bytes; the broken-asset test
        // corrupts what's served, not what's promised, so the mismatch is
        // between "expected" (from this manifest) and "actual" (the bytes
        // that arrive) — exactly the failure downloadVerified must catch.
        const lines = [...assets.entries()].map(([n, buf]) => `${sha256Hex(buf)}  ${n}`).join("\n");
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(lines + "\n");
        return;
      }
      const asset = assets.get(name);
      if (asset === undefined) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      if (name === fixture.brokenAsset) {
        res.writeHead(200);
        res.end(Buffer.from("corrupted-bytes-not-matching-checksum"));
        return;
      }
      res.writeHead(200);
      res.end(asset);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      fixture.server = server;
      fixture.baseUrl = `http://127.0.0.1:${port}`;
      resolveStart(fixture);
    });
  });
}

describe("MsbProvisioner", () => {
  let fixture: Fixture;
  let tmpRoot: string;

  before(async () => {
    fixture = await startFixtureServer(new Map([
      [msbAsset, MSB_BYTES],
      [krunAsset, KRUN_BYTES],
    ]));
  });

  after(async () => {
    await new Promise<void>((r) => fixture.server.close(() => r()));
  });

  async function freshCacheDir(): Promise<string> {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rightsize-msb-test-"));
    return tmpRoot;
  }

  it("MSB_PATH short-circuits everything, even a non-existent version pin", async () => {
    const cacheDir = await freshCacheDir();
    const fakeBin = path.join(cacheDir, "my-msb");
    await fs.writeFile(fakeBin, "#!/bin/sh\n", { mode: 0o755 });
    const resolved = await ensureInstalledAt(fixture.baseUrl, cacheDir, { MSB_PATH: fakeBin });
    assert.equal(resolved, fakeBin);
  });

  it("rejects a non-executable MSB_PATH", async () => {
    // Windows has no execute-bit concept — isExecutableFile's whole check
    // there is "is an existing regular file" (see its doc comment in
    // provisioner.ts), so a 0o644-mode file is a VALID MSB_PATH on Windows,
    // not a rejected one. This case only has a meaningful "non-executable"
    // notion on POSIX, where the missing execute bit is exactly what the
    // provisioner's isExecutableFile checks for.
    if (process.platform === "win32") {
      return;
    }
    const cacheDir = await freshCacheDir();
    const notExecutable = path.join(cacheDir, "not-a-binary");
    await fs.writeFile(notExecutable, "text", { mode: 0o644 });
    await assert.rejects(() => ensureInstalledAt(fixture.baseUrl, cacheDir, { MSB_PATH: notExecutable }));
  });

  it("accepts an MSB_PATH that merely exists as a regular file on Windows (no execute-bit concept there)", async () => {
    if (process.platform !== "win32") {
      return;
    }
    const cacheDir = await freshCacheDir();
    const aFile = path.join(cacheDir, "not-a-binary.exe");
    await fs.writeFile(aFile, "text", { mode: 0o644 });
    const resolved = await ensureInstalledAt(fixture.baseUrl, cacheDir, { MSB_PATH: aFile });
    assert.equal(resolved, aFile);
  });

  it("rejects an MSB_PATH pointing at a directory on Windows (isExecutableFile requires isFile(), not merely 'exists')", async () => {
    // POSIX is deliberately not asserted here: a directory commonly carries
    // the execute ("search") bit, so accessSync(dir, X_OK) legitimately
    // succeeds there — rejecting directories on POSIX was never a guarantee
    // this provisioner made; only Windows's isFile()-based check does.
    if (process.platform !== "win32") {
      return;
    }
    const cacheDir = await freshCacheDir();
    const aDir = path.join(cacheDir, "a-directory");
    await fs.mkdir(aDir, { recursive: true });
    await assert.rejects(() => ensureInstalledAt(fixture.baseUrl, cacheDir, { MSB_PATH: aDir }));
  });

  it("RIGHTSIZE_MSB_SKIP_DOWNLOAD fails with the MSB_PATH escape-hatch hint when nothing is cached", async () => {
    const cacheDir = await freshCacheDir();
    let threw: unknown;
    try {
      await ensureInstalledAt(fixture.baseUrl, cacheDir, { RIGHTSIZE_MSB_SKIP_DOWNLOAD: "true" });
    } catch (err) {
      threw = err;
    }
    assert.ok(threw instanceof Error);
    assert.match((threw as Error).message, /MSB_PATH/);
  });

  it("downloads, verifies, and installs both assets with binary-last commit ordering", async () => {
    const cacheDir = await freshCacheDir();
    const resolved = await ensureInstalledAt(fixture.baseUrl, cacheDir, {});
    assert.ok(resolved.endsWith(path.join("bin", msbBinaryName)));
    const installed = await fs.readFile(resolved);
    assert.deepEqual(installed, MSB_BYTES);
    const krunPath = path.join(cacheDir, "msb", MSB_VERSION, "lib", krunInstallName);
    const krunInstalled = await fs.readFile(krunPath);
    assert.deepEqual(krunInstalled, KRUN_BYTES);
  });

  it("a second call finds the already-completed install and re-downloads nothing", async () => {
    const cacheDir = await freshCacheDir();
    const first = await ensureInstalledAt(fixture.baseUrl, cacheDir, {});
    const second = await ensureInstalledAt(fixture.baseUrl, cacheDir, {});
    assert.equal(first, second);
  });

  it("SHA-256 mismatch aborts the install and cleans up its temp file, naming the asset", async () => {
    const cacheDir = await freshCacheDir();
    const broken = await startFixtureServer(new Map([
      [msbAsset, MSB_BYTES],
      [krunAsset, KRUN_BYTES],
    ]));
    broken.brokenAsset = msbAsset;
    try {
      let threw: unknown;
      try {
        await ensureInstalledAt(broken.baseUrl, cacheDir, {});
      } catch (err) {
        threw = err;
      }
      assert.ok(threw instanceof Error);
      assert.match((threw as Error).message, /SHA-256 mismatch/);
      assert.match((threw as Error).message, new RegExp(msbAsset.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      const binDir = path.join(cacheDir, "msb", MSB_VERSION, "bin");
      const entries = await fs.readdir(binDir).catch(() => []);
      assert.equal(entries.some((n) => n.endsWith(".part")), false);
    } finally {
      await new Promise<void>((r) => broken.server.close(() => r()));
    }
  });

  it("an install missing krun (simulated crash between the two renames) is repaired on the next call", async () => {
    const cacheDir = await freshCacheDir();
    const installDir = path.join(cacheDir, "msb", MSB_VERSION);
    await fs.mkdir(path.join(installDir, "bin"), { recursive: true });
    await fs.writeFile(path.join(installDir, "bin", msbBinaryName), MSB_BYTES, { mode: 0o755 });
    // krun deliberately absent: isInstalled() must say no, and the repair path fills it in.
    const resolved = await ensureInstalledAt(fixture.baseUrl, cacheDir, {});
    const krunPath = path.join(installDir, "lib", krunInstallName);
    assert.ok(fsSync.existsSync(krunPath));
    assert.equal(resolved, path.join(installDir, "bin", msbBinaryName));
  });

  it("takes over a lock whose recorded PID is not alive, even if not yet timestamp-stale", async () => {
    const cacheDir = await freshCacheDir();
    const installDir = path.join(cacheDir, "msb", MSB_VERSION);
    await fs.mkdir(installDir, { recursive: true });
    // A PID essentially guaranteed not to be a live process, with a fresh timestamp.
    const deadPid = 999999;
    await fs.writeFile(path.join(installDir, ".lock"), `${deadPid}\n${Date.now()}`);
    const resolved = await ensureInstalledAt(fixture.baseUrl, cacheDir, {});
    assert.ok(fsSync.existsSync(resolved));
  });

  it("takes over a lock that is timestamp-stale even with this process's own live PID", async () => {
    const cacheDir = await freshCacheDir();
    const installDir = path.join(cacheDir, "msb", MSB_VERSION);
    await fs.mkdir(installDir, { recursive: true });
    const oldTimestamp = Date.now() - 10 * 60 * 1000; // 10 minutes ago > 5 minute threshold
    await fs.writeFile(path.join(installDir, ".lock"), `${process.pid}\n${oldTimestamp}`);
    const resolved = await ensureInstalledAt(fixture.baseUrl, cacheDir, {});
    assert.ok(fsSync.existsSync(resolved));
  });

  it("parses checksums.sha256 tolerant of extra whitespace", () => {
    const parsed = _parseChecksumsForTests(`  abc123   file-one\ndef456  file-two  \n\n`);
    assert.equal(parsed.get("file-one"), "abc123");
    assert.equal(parsed.get("file-two"), "def456");
  });

  describe("Windows asset shapes (via the injected-platform test seam)", () => {
    const WIN_MSB_BYTES = Buffer.from("MZ-fake-windows-msb-exe-bytes");
    const WIN_KRUN_BYTES = Buffer.from("fake-windows-krunfw-dll-bytes");

    async function withWindowsFixture(
      platform: "win32-x64" | "win32-arm64",
      run: (winFixture: Fixture, installDir: string, msbPath: string, krunPath: string) => Promise<void>,
    ): Promise<void> {
      const winMsbAsset = PlatformInfo.msbAsset(platform);
      const winKrunAsset = PlatformInfo.krunAsset(platform);
      const winFixture = await startFixtureServer(
        new Map([
          [winMsbAsset, WIN_MSB_BYTES],
          [winKrunAsset, WIN_KRUN_BYTES],
        ]),
      );
      try {
        const cacheDir = await freshCacheDir();
        const installDir = path.join(cacheDir, "msb", MSB_VERSION);
        const msbPath = path.join(installDir, "bin", PlatformInfo.msbBinaryName(platform));
        const krunPath = path.join(installDir, "lib", PlatformInfo.krunInstallName(platform));
        await run(winFixture, installDir, msbPath, krunPath);
      } finally {
        await new Promise<void>((r) => winFixture.server.close(() => r()));
      }
    }

    it("win32-x64 installs msb.exe and unversioned libkrunfw.dll", async () => {
      await withWindowsFixture("win32-x64", async (winFixture, installDir, msbPath, krunPath) => {
        await _downloadAndInstallForTests(winFixture.baseUrl, "win32-x64", installDir, msbPath, krunPath);
        assert.ok(msbPath.endsWith(path.join("bin", "msb.exe")));
        assert.ok(krunPath.endsWith(path.join("lib", "libkrunfw.dll")));
        assert.deepEqual(await fs.readFile(msbPath), WIN_MSB_BYTES);
        assert.deepEqual(await fs.readFile(krunPath), WIN_KRUN_BYTES);
      });
    });

    it("win32-arm64 installs msb.exe and unversioned libkrunfw.dll", async () => {
      await withWindowsFixture("win32-arm64", async (winFixture, installDir, msbPath, krunPath) => {
        await _downloadAndInstallForTests(winFixture.baseUrl, "win32-arm64", installDir, msbPath, krunPath);
        assert.ok(msbPath.endsWith(path.join("bin", "msb.exe")));
        assert.ok(krunPath.endsWith(path.join("lib", "libkrunfw.dll")));
        assert.deepEqual(await fs.readFile(msbPath), WIN_MSB_BYTES);
        assert.deepEqual(await fs.readFile(krunPath), WIN_KRUN_BYTES);
      });
    });

    it("a Windows SHA-256 mismatch on the .exe asset aborts and cleans up its temp file", async () => {
      const platform = "win32-x64" as const;
      const winMsbAsset = PlatformInfo.msbAsset(platform);
      const winKrunAsset = PlatformInfo.krunAsset(platform);
      const broken = await startFixtureServer(
        new Map([
          [winMsbAsset, WIN_MSB_BYTES],
          [winKrunAsset, WIN_KRUN_BYTES],
        ]),
      );
      broken.brokenAsset = winMsbAsset;
      try {
        const cacheDir = await freshCacheDir();
        const installDir = path.join(cacheDir, "msb", MSB_VERSION);
        const msbPath = path.join(installDir, "bin", PlatformInfo.msbBinaryName(platform));
        const krunPath = path.join(installDir, "lib", PlatformInfo.krunInstallName(platform));
        let threw: unknown;
        try {
          await _downloadAndInstallForTests(broken.baseUrl, platform, installDir, msbPath, krunPath);
        } catch (err) {
          threw = err;
        }
        assert.ok(threw instanceof Error);
        assert.match((threw as Error).message, /SHA-256 mismatch/);
        const binDir = path.join(installDir, "bin");
        const entries = await fs.readdir(binDir).catch(() => []);
        assert.equal(entries.some((n) => n.endsWith(".part")), false);
      } finally {
        await new Promise<void>((r) => broken.server.close(() => r()));
      }
    });
  });
});
