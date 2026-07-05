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

  it("resolves win32-x64", () => {
    assert.equal(PlatformInfo._currentFor("win32", "x64"), "win32-x64");
  });

  it("resolves win32-arm64", () => {
    assert.equal(PlatformInfo._currentFor("win32", "arm64"), "win32-arm64");
  });

  it("has no build for unsupported platform/arch combinations", () => {
    assert.equal(PlatformInfo._currentFor("win32", "ia32"), undefined);
    assert.equal(PlatformInfo._currentFor("darwin", "x64"), undefined);
    assert.equal(PlatformInfo._currentFor("linux", "ia32"), undefined);
  });

  it("names the correct msb asset per platform", () => {
    assert.equal(PlatformInfo.msbAsset("darwin-arm64"), "msb-darwin-aarch64");
    assert.equal(PlatformInfo.msbAsset("linux-x64"), "msb-linux-x86_64");
    assert.equal(PlatformInfo.msbAsset("linux-arm64"), "msb-linux-aarch64");
    assert.equal(PlatformInfo.msbAsset("win32-x64"), "msb-windows-x86_64.exe");
    assert.equal(PlatformInfo.msbAsset("win32-arm64"), "msb-windows-aarch64.exe");
  });

  it("names the correct krun asset per platform", () => {
    assert.equal(PlatformInfo.krunAsset("darwin-arm64"), "libkrunfw-darwin-aarch64.dylib");
    assert.equal(PlatformInfo.krunAsset("linux-x64"), "libkrunfw-linux-x86_64.so");
    assert.equal(PlatformInfo.krunAsset("linux-arm64"), "libkrunfw-linux-aarch64.so");
    assert.equal(PlatformInfo.krunAsset("win32-x64"), "libkrunfw-windows-x86_64.dll");
    assert.equal(PlatformInfo.krunAsset("win32-arm64"), "libkrunfw-windows-aarch64.dll");
  });

  it("installs krun under the canonical name msb resolves, versioned on macOS/Linux and unversioned on Windows", () => {
    assert.equal(PlatformInfo.krunInstallName("darwin-arm64"), "libkrunfw.5.dylib");
    assert.equal(PlatformInfo.krunInstallName("linux-x64"), "libkrunfw.so.5.5.0");
    assert.equal(PlatformInfo.krunInstallName("linux-arm64"), "libkrunfw.so.5.5.0");
    assert.equal(PlatformInfo.krunInstallName("win32-x64"), "libkrunfw.dll");
    assert.equal(PlatformInfo.krunInstallName("win32-arm64"), "libkrunfw.dll");
  });

  it("names the msb binary suffixless on macOS/Linux and with .exe on Windows", () => {
    assert.equal(PlatformInfo.msbBinaryName("darwin-arm64"), "msb");
    assert.equal(PlatformInfo.msbBinaryName("linux-x64"), "msb");
    assert.equal(PlatformInfo.msbBinaryName("linux-arm64"), "msb");
    assert.equal(PlatformInfo.msbBinaryName("win32-x64"), "msb.exe");
    assert.equal(PlatformInfo.msbBinaryName("win32-arm64"), "msb.exe");
  });

  it("virtualizationAvailable and current() are synchronous, never Promises", () => {
    const virt: unknown = PlatformInfo.virtualizationAvailable();
    const cur: unknown = PlatformInfo.current();
    assert.equal(virt instanceof Promise, false);
    assert.equal(cur instanceof Promise, false);
    assert.equal(typeof virt, "boolean");
  });

  it("Windows is attempt-and-report: virtualizationAvailable is true for any detected Windows platform", () => {
    assert.equal(PlatformInfo._virtualizationAvailableFor("win32", "x64"), true);
    assert.equal(PlatformInfo._virtualizationAvailableFor("win32", "arm64"), true);
  });

  it("an undetected Windows arch reports no virtualization, same as any other unsupported platform", () => {
    assert.equal(PlatformInfo._virtualizationAvailableFor("win32", "ia32"), false);
  });
});
