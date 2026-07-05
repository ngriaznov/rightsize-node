import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as http from "node:http";
import * as https from "node:https";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { ProvisionError } from "../core/errors.js";
import { PlatformInfo } from "./platform.js";
import type { Platform } from "./platform.js";

export const MSB_VERSION = "0.6.3";

const DEFAULT_BASE = `https://github.com/superradcompany/microsandbox/releases/download/v${MSB_VERSION}`;
const CONNECT_READ_TIMEOUT_MS = 300_000;
const STALE_LOCK_AGE_MS = 5 * 60 * 1000;
const LOCK_POLL_MS = 200;
const LOCK_WAIT_MAX_MS = 30_000;

function defaultCacheDir(): string {
  return process.env["RIGHTSIZE_CACHE_DIR"] ?? path.join(os.homedir(), ".cache", "rightsize");
}

function isInstalled(msbPath: string, krunPath: string): boolean {
  try {
    fs.accessSync(msbPath, fs.constants.X_OK);
  } catch {
    return false;
  }
  return fs.existsSync(krunPath);
}

/** Follows a bounded chain of 30x redirects — the release CDN issues one hop to the actual asset host. */
function fetchBuffer(url: string, maxRedirects = 5): Promise<Buffer> {
  const transport = url.startsWith("https:") ? https : http;
  return new Promise((resolveFetch, rejectFetch) => {
    const req = transport.get(url, { timeout: CONNECT_READ_TIMEOUT_MS }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location !== undefined) {
        res.resume();
        if (maxRedirects <= 0) {
          rejectFetch(new ProvisionError(`too many redirects fetching ${url}`));
          return;
        }
        const nextUrl = new URL(res.headers.location, url).toString();
        fetchBuffer(nextUrl, maxRedirects - 1).then(resolveFetch, rejectFetch);
        return;
      }
      if (status !== 200) {
        res.resume();
        rejectFetch(new ProvisionError(`HTTP ${status} fetching ${url}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolveFetch(Buffer.concat(chunks)));
      res.on("error", (err) => rejectFetch(err));
    });
    req.on("timeout", () => req.destroy(new ProvisionError(`timed out fetching ${url}`)));
    req.on("error", (err) => rejectFetch(err));
  });
}

/** Tolerant of extra whitespace and either column order — `sha256sum` output vs a hand-authored manifest can vary. */
function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    const parts = line.split(/\s+/);
    if (parts.length < 2) {
      throw new ProvisionError(`malformed line in checksums.sha256: '${line}'`);
    }
    const [hex, filename] = parts;
    if (hex !== undefined && filename !== undefined) {
      sums.set(filename, hex.toLowerCase());
    }
  }
  return sums;
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

interface LockInfo {
  readonly pid: number;
  readonly timestamp: number;
}

function parseLockInfo(text: string): LockInfo | undefined {
  const [pidStr, tsStr] = text.trim().split("\n");
  const pid = Number(pidStr);
  const timestamp = Number(tsStr);
  if (!Number.isFinite(pid) || !Number.isFinite(timestamp)) {
    return undefined;
  }
  return { pid, timestamp };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: no such process. EPERM: a live process we don't own — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isLockStale(info: LockInfo | undefined): boolean {
  if (info === undefined) {
    // An unparseable lock file cannot be trusted as "held" — treat it as stale.
    return true;
  }
  if (!isProcessAlive(info.pid)) {
    return true;
  }
  return Date.now() - info.timestamp > STALE_LOCK_AGE_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Cross-process install-dir lock via `fs.open(path, "wx")` (O_EXCL create) —
 * the closest Node stdlib equivalent to a kernel-held advisory lock, except
 * that unlike an OS advisory lock it is NOT released automatically
 * when the holding process dies. The lock file therefore records
 * `${pid}\n${timestamp}` so a waiter can positively detect a dead holder
 * (`process.kill(pid, 0)` throwing `ESRCH`) rather than only ever guessing
 * from file age. Staleness is thus two independent conditions, either one
 * sufficient to take over: the recorded PID is provably dead, OR the lock
 * predates the staleness threshold (a live-but-wedged holder).
 */
async function withInstallLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + LOCK_WAIT_MAX_MS;
  for (;;) {
    let handle: fsp.FileHandle | undefined;
    try {
      handle = await fsp.open(lockPath, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
      // Someone else holds the lock file (or a stale one is sitting there).
      let existing: string;
      try {
        existing = await fsp.readFile(lockPath, "utf8");
      } catch {
        existing = "";
      }
      const info = parseLockInfo(existing);
      if (isLockStale(info)) {
        // Stale takeover: remove and retry immediately. A second racer may
        // beat us to the same removal+recreate — that's fine, they'll just
        // loop again on the next EEXIST.
        try {
          await fsp.unlink(lockPath);
        } catch {
          // Already removed by a concurrent racer — fall through to retry.
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new ProvisionError(`timed out waiting for the msb install lock at ${lockPath}`);
      }
      await sleep(LOCK_POLL_MS);
      continue;
    }
    try {
      await handle.writeFile(`${process.pid}\n${Date.now()}`);
      return await fn();
    } finally {
      await handle.close();
      await fsp.unlink(lockPath).catch(() => {
        // Best-effort: if it's already gone (a stale-takeover racer beat us
        // to cleanup) there's nothing left to do.
      });
    }
  }
}

async function downloadVerified(
  baseUrl: string,
  asset: string,
  destDir: string,
  sums: Map<string, string>,
  executable: boolean,
): Promise<string> {
  const expected = sums.get(asset);
  if (expected === undefined) {
    throw new ProvisionError(`No SHA-256 for '${asset}' in ${baseUrl}/checksums.sha256`);
  }
  await fsp.mkdir(destDir, { recursive: true });
  const tmp = path.join(destDir, `.dl-${process.pid}-${Date.now()}-${asset}.part`);
  let ok = false;
  try {
    const buf = await fetchBuffer(`${baseUrl}/${asset}`);
    const actual = sha256Hex(buf);
    if (actual !== expected) {
      throw new ProvisionError(
        `SHA-256 mismatch for ${asset} from ${baseUrl} (expected ${expected}, got ${actual}) ` +
          `— delete ${destDir} and retry, or set MSB_PATH to a trusted msb binary`,
      );
    }
    await fsp.writeFile(tmp, buf, { mode: executable ? 0o755 : 0o644 });
    ok = true;
    return tmp;
  } finally {
    if (!ok) {
      await fsp.unlink(tmp).catch(() => {});
    }
  }
}

/**
 * Downloads and SHA-256-verifies BOTH assets to temp files before moving
 * either into place, then renames krun into `lib/` FIRST and the `msb`
 * binary into `bin/` LAST. `msb`'s presence is therefore the commit marker
 * for a genuinely complete install — a crash between the two renames can
 * never leave a present-msb/missing-krun state, because `isInstalled`
 * requires both files and whichever half is missing gets re-downloaded on
 * the next call.
 */
async function downloadAndInstall(
  baseUrl: string,
  platform: Platform,
  installDir: string,
  msbPath: string,
  krunPath: string,
): Promise<void> {
  const checksumsText = (await fetchBuffer(`${baseUrl}/checksums.sha256`)).toString("utf8");
  const sums = parseChecksums(checksumsText);
  const msbAsset = PlatformInfo.msbAsset(platform);
  const krunAsset = PlatformInfo.krunAsset(platform);

  const msbTmp = await downloadVerified(baseUrl, msbAsset, path.join(installDir, "bin"), sums, true);
  const krunTmp = await downloadVerified(baseUrl, krunAsset, path.join(installDir, "lib"), sums, false);
  try {
    await fsp.rename(krunTmp, krunPath);
    await fsp.rename(msbTmp, msbPath);
  } finally {
    await fsp.unlink(msbTmp).catch(() => {});
    await fsp.unlink(krunTmp).catch(() => {});
  }
}

/** Test seam: the full resolution logic parameterized over the release base URL, cache dir, and environment. */
export async function ensureInstalledAt(
  baseUrl: string,
  cacheDir: string,
  env: Record<string, string | undefined>,
): Promise<string> {
  const override = env["MSB_PATH"];
  if (override !== undefined) {
    try {
      fs.accessSync(override, fs.constants.X_OK);
    } catch {
      throw new ProvisionError(`MSB_PATH='${override}' is not an executable file`);
    }
    return override;
  }

  const platform = PlatformInfo.current();
  if (platform === undefined) {
    throw new ProvisionError(
      `microsandbox has no build for ${process.platform}/${process.arch} — ` +
        `use the docker backend (RIGHTSIZE_BACKEND=docker) or set MSB_PATH to a binary you provide`,
    );
  }

  const installDir = path.join(cacheDir, "msb", MSB_VERSION);
  const msbPath = path.join(installDir, "bin", "msb");
  // Installed under the canonical name msb resolves (`../lib/` next to its binary),
  // not the release-asset name it is downloaded as — msb never probes the asset name.
  const krunPath = path.join(installDir, "lib", PlatformInfo.krunInstallName(platform));

  if (isInstalled(msbPath, krunPath)) {
    return msbPath;
  }

  if (env["RIGHTSIZE_MSB_SKIP_DOWNLOAD"] === "true") {
    throw new ProvisionError(
      `msb ${MSB_VERSION} not found at ${msbPath} and RIGHTSIZE_MSB_SKIP_DOWNLOAD=true — ` +
        `pre-install it there or point MSB_PATH at an msb binary`,
    );
  }

  await fsp.mkdir(installDir, { recursive: true });
  await withInstallLock(path.join(installDir, ".lock"), async () => {
    // Another process may have finished the install while we waited for the lock.
    if (isInstalled(msbPath, krunPath)) {
      return;
    }
    await downloadAndInstall(baseUrl, platform, installDir, msbPath, krunPath);
  });
  return msbPath;
}

/** Resolves (downloading and verifying if needed) a runnable `msb` binary path, using the real GitHub release base, `RIGHTSIZE_CACHE_DIR`, and `process.env`. */
export function ensureInstalled(): Promise<string> {
  return ensureInstalledAt(DEFAULT_BASE, defaultCacheDir(), process.env);
}

/** Test-only access to the pure checksum-line parser, exercised against real-shape and malformed input. */
export function _parseChecksumsForTests(text: string): Map<string, string> {
  return parseChecksums(text);
}
