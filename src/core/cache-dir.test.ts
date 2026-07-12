import * as path from "node:path";
import * as os from "node:os";
import { describe, it, assert } from "../../test/harness.js";
import { cacheDir } from "./cache-dir.js";

describe("cacheDir", () => {
  const savedOverride = process.env["RIGHTSIZE_CACHE_DIR"];
  const savedLocalAppData = process.env["LOCALAPPDATA"];

  function restore(): void {
    if (savedOverride === undefined) {
      delete process.env["RIGHTSIZE_CACHE_DIR"];
    } else {
      process.env["RIGHTSIZE_CACHE_DIR"] = savedOverride;
    }
    if (savedLocalAppData === undefined) {
      delete process.env["LOCALAPPDATA"];
    } else {
      process.env["LOCALAPPDATA"] = savedLocalAppData;
    }
  }

  it("RIGHTSIZE_CACHE_DIR overrides everything, on every platform", () => {
    process.env["RIGHTSIZE_CACHE_DIR"] = "/tmp/custom-rightsize-cache";
    try {
      assert.equal(cacheDir(), "/tmp/custom-rightsize-cache");
    } finally {
      restore();
    }
  });

  it("falls back to ~/.cache/rightsize on non-Windows when unset", () => {
    if (process.platform === "win32") {
      return;
    }
    delete process.env["RIGHTSIZE_CACHE_DIR"];
    try {
      assert.equal(cacheDir(), path.join(os.homedir(), ".cache", "rightsize"));
    } finally {
      restore();
    }
  });

  it("uses %LOCALAPPDATA%\\rightsize on Windows when set", () => {
    if (process.platform !== "win32") {
      return;
    }
    delete process.env["RIGHTSIZE_CACHE_DIR"];
    process.env["LOCALAPPDATA"] = "C:\\Users\\test\\AppData\\Local";
    try {
      assert.equal(cacheDir(), path.join("C:\\Users\\test\\AppData\\Local", "rightsize"));
    } finally {
      restore();
    }
  });

  it("falls back to %USERPROFILE%\\AppData\\Local\\rightsize on Windows when LOCALAPPDATA is unset", () => {
    if (process.platform !== "win32") {
      return;
    }
    delete process.env["RIGHTSIZE_CACHE_DIR"];
    delete process.env["LOCALAPPDATA"];
    try {
      assert.equal(cacheDir(), path.join(os.homedir(), "AppData", "Local", "rightsize"));
    } finally {
      restore();
    }
  });
});
