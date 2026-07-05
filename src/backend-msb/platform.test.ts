import { describe, it, assert } from "../../test/harness.js";
import { PlatformInfo } from "./platform.js";

describe("PlatformInfo", () => {
  it("resolves darwin-arm64", () => {
    assert.equal(PlatformInfo._currentFor("darwin", "arm64"), "darwin-arm64");
  });

  it("resolves linux-x64", () => {
    assert.equal(PlatformInfo._currentFor("linux", "x64"), "linux-x64");
  });

  it("resolves linux-arm64", () => {
    assert.equal(PlatformInfo._currentFor("linux", "arm64"), "linux-arm64");
  });

  it("has no build for unsupported platform/arch combinations", () => {
    assert.equal(PlatformInfo._currentFor("win32", "x64"), undefined);
    assert.equal(PlatformInfo._currentFor("darwin", "x64"), undefined);
    assert.equal(PlatformInfo._currentFor("linux", "ia32"), undefined);
  });

  it("names the correct msb asset per platform", () => {
    assert.equal(PlatformInfo.msbAsset("darwin-arm64"), "msb-darwin-aarch64");
    assert.equal(PlatformInfo.msbAsset("linux-x64"), "msb-linux-x86_64");
    assert.equal(PlatformInfo.msbAsset("linux-arm64"), "msb-linux-aarch64");
  });

  it("names the correct krun asset per platform", () => {
    assert.equal(PlatformInfo.krunAsset("darwin-arm64"), "libkrunfw-darwin-aarch64.dylib");
    assert.equal(PlatformInfo.krunAsset("linux-x64"), "libkrunfw-linux-x86_64.so");
    assert.equal(PlatformInfo.krunAsset("linux-arm64"), "libkrunfw-linux-aarch64.so");
  });

  it("virtualizationAvailable and current() are synchronous, never Promises", () => {
    const virt: unknown = PlatformInfo.virtualizationAvailable();
    const cur: unknown = PlatformInfo.current();
    assert.equal(virt instanceof Promise, false);
    assert.equal(cur instanceof Promise, false);
    assert.equal(typeof virt, "boolean");
  });
});
