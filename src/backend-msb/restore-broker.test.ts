import { describe, it, assert } from "../../test/harness.js";
import {
  escapePowerShellSingleQuoted,
  buildInnerRestoreScript,
  encodeAsEncodedCommand,
  buildOuterBrokerScript,
  parseBrokerScriptOutput,
  RESTORE_BROKER_ECFILE_WAIT_SECONDS,
} from "./restore-broker.js";

describe("escapePowerShellSingleQuoted", () => {
  it("doubles every embedded single quote", () => {
    assert.equal(escapePowerShellSingleQuoted("it's fine"), "it''s fine");
    assert.equal(escapePowerShellSingleQuoted("'''"), "''''''");
  });

  it("leaves a value with no quote untouched", () => {
    assert.equal(escapePowerShellSingleQuoted("C:\\msb\\bin\\msb.exe"), "C:\\msb\\bin\\msb.exe");
  });

  it("is a no-op on the empty string", () => {
    assert.equal(escapePowerShellSingleQuoted(""), "");
  });
});

describe("buildInnerRestoreScript", () => {
  it("wraps the msb path and every argv token as its own single-quoted literal", () => {
    const script = buildInnerRestoreScript(
      "C:\\msb\\bin\\msb.exe",
      ["restore", "C:\\snaps\\snap_abc", "--name", "rz-run1-1"],
      "C:\\tmp\\out.txt",
      "C:\\tmp\\ec.txt",
    );
    assert.match(script, /& 'C:\\msb\\bin\\msb\.exe' 'restore' 'C:\\snaps\\snap_abc' '--name' 'rz-run1-1' \*> 'C:\\tmp\\out\.txt'/);
    assert.match(script, /Set-Content -LiteralPath 'C:\\tmp\\ec\.txt' -Value \$LASTEXITCODE -NoNewline/);
  });

  it("escapes a literal single quote inside an argv token instead of breaking the script", () => {
    const script = buildInnerRestoreScript("msb", ["restore", "C:\\it's\\a\\path", "--name", "rz-x-1"], "out.txt", "ec.txt");
    assert.match(script, /'C:\\it''s\\a\\path'/);
    // The single-quote count around that token must stay balanced — an
    // unescaped quote would end the literal early and corrupt everything
    // after it.
    const literalMatches = script.match(/'C:\\it''s\\a\\path'/g);
    assert.ok(literalMatches !== null && literalMatches.length === 1, "expected exactly one balanced literal for the escaped token");
  });

  it("escapes a single quote inside the msb path and the out/ec file paths too, not only argv", () => {
    const script = buildInnerRestoreScript("C:\\Program's Files\\msb.exe", ["restore"], "C:\\tmp\\o's.txt", "C:\\tmp\\e's.txt");
    assert.match(script, /'C:\\Program''s Files\\msb\.exe'/);
    assert.match(script, /'C:\\tmp\\o''s\.txt'/);
    assert.match(script, /'C:\\tmp\\e''s\.txt'/);
  });

  it("redirects combined stdout+stderr with '*>' and never emits '--disk-only' or anything beyond the given argv", () => {
    const script = buildInnerRestoreScript("msb", ["restore", "ref", "--name", "n"], "out.txt", "ec.txt");
    assert.match(script, /\*> 'out\.txt'/);
    assert.equal(script.includes("--disk-only"), false);
  });
});

describe("encodeAsEncodedCommand", () => {
  it("round-trips through UTF-16LE base64, matching what 'powershell -EncodedCommand' expects", () => {
    const script = "Write-Output 'hi'";
    const encoded = encodeAsEncodedCommand(script);
    const decoded = Buffer.from(encoded, "base64").toString("utf16le");
    assert.equal(decoded, script);
  });

  it("produces a pure base64 alphabet — safe to embed in a single-quoted string with no escaping of its own", () => {
    const encoded = encodeAsEncodedCommand("some 'quoted' text with $vars and \"double quotes\"");
    assert.match(encoded, /^[A-Za-z0-9+/=]+$/);
  });
});

describe("buildOuterBrokerScript", () => {
  const encoded = encodeAsEncodedCommand("Write-Output 'inner'");

  it("embeds the encoded inner command in a powershell.exe -EncodedCommand invocation", () => {
    const script = buildOuterBrokerScript({ encodedInner: encoded, outFile: "C:\\tmp\\o.txt", ecFile: "C:\\tmp\\e.txt" });
    assert.match(script, /powershell\.exe -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand/);
    assert.ok(script.includes(encoded), "expected the outer script to embed the exact encoded payload");
  });

  it("calls Win32_Process Create via Invoke-CimMethod and prints its ReturnValue/ProcessId", () => {
    const script = buildOuterBrokerScript({ encodedInner: encoded, outFile: "o.txt", ecFile: "e.txt" });
    assert.match(script, /Invoke-CimMethod -ClassName Win32_Process -MethodName Create/);
    assert.match(script, /ReturnValue/);
    assert.match(script, /ProcessId/);
  });

  it("defaults its ecFile wait bound to RESTORE_BROKER_ECFILE_WAIT_SECONDS and honors an override", () => {
    const defaulted = buildOuterBrokerScript({ encodedInner: encoded, outFile: "o.txt", ecFile: "e.txt" });
    assert.match(defaulted, new RegExp(`AddSeconds\\(${RESTORE_BROKER_ECFILE_WAIT_SECONDS}\\)`));

    const overridden = buildOuterBrokerScript({ encodedInner: encoded, outFile: "o.txt", ecFile: "e.txt", waitSeconds: 5 });
    assert.match(overridden, /AddSeconds\(5\)/);
  });

  it("escapes a single quote in the out/ec file paths", () => {
    const script = buildOuterBrokerScript({ encodedInner: encoded, outFile: "C:\\tmp\\o's.txt", ecFile: "C:\\tmp\\e's.txt" });
    assert.match(script, /'C:\\tmp\\o''s\.txt'/);
    assert.match(script, /'C:\\tmp\\e''s\.txt'/);
  });
});

describe("parseBrokerScriptOutput", () => {
  it("parses a full successful broker script transcript", () => {
    const stdout = [
      "RIGHTSIZE-BROKER-RETURNVALUE=0",
      "RIGHTSIZE-BROKER-PROCESSID=4242",
      "RIGHTSIZE-BROKER-OUT-BEGIN",
      "some restore output",
      "more output",
      "RIGHTSIZE-BROKER-OUT-END",
      "RIGHTSIZE-BROKER-EC-BEGIN",
      "0",
      "RIGHTSIZE-BROKER-EC-END",
    ].join("\n");
    const parsed = parseBrokerScriptOutput(stdout);
    assert.equal(parsed.returnValue, 0);
    assert.equal(parsed.processId, 4242);
    assert.equal(parsed.outText, "some restore output\nmore output");
    assert.equal(parsed.ecText, "0");
  });

  it("tolerates CRLF line endings (PowerShell's own native ending)", () => {
    const stdout = ["RIGHTSIZE-BROKER-RETURNVALUE=0", "RIGHTSIZE-BROKER-EC-BEGIN", "1", "RIGHTSIZE-BROKER-EC-END"].join("\r\n");
    const parsed = parseBrokerScriptOutput(stdout);
    assert.equal(parsed.returnValue, 0);
    assert.equal(parsed.ecText, "1");
  });

  it("leaves ecText/outText undefined when their markers never appear — the ecFile-missing case", () => {
    const stdout = ["RIGHTSIZE-BROKER-RETURNVALUE=0", "RIGHTSIZE-BROKER-PROCESSID=1"].join("\n");
    const parsed = parseBrokerScriptOutput(stdout);
    assert.equal(parsed.returnValue, 0);
    assert.equal(parsed.ecText, undefined);
    assert.equal(parsed.outText, undefined);
  });

  it("reports a non-zero ReturnValue (WMI itself refused to create the process)", () => {
    const parsed = parseBrokerScriptOutput("RIGHTSIZE-BROKER-RETURNVALUE=2\nRIGHTSIZE-BROKER-PROCESSID=");
    assert.equal(parsed.returnValue, 2);
  });

  it("returns returnValue undefined when the outer script died before printing anything at all", () => {
    const parsed = parseBrokerScriptOutput("");
    assert.equal(parsed.returnValue, undefined);
    assert.equal(parsed.processId, undefined);
    assert.equal(parsed.ecText, undefined);
    assert.equal(parsed.outText, undefined);
  });

  it("trims whitespace around the parsed exit code text", () => {
    const stdout = ["RIGHTSIZE-BROKER-RETURNVALUE=0", "RIGHTSIZE-BROKER-EC-BEGIN", "  7  ", "RIGHTSIZE-BROKER-EC-END"].join("\n");
    assert.equal(parseBrokerScriptOutput(stdout).ecText, "7");
  });
});
