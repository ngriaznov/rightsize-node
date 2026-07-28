import { describe, it, assert } from "../../test/harness.js";
import { isAgentEndpointNotReady } from "./agent-endpoint.js";

describe("isAgentEndpointNotReady", () => {
  it("matches the captured Windows named-pipe failure verbatim", () => {
    // Captured verbatim from a windows-2025 hosted runner: an exec issued
    // against a sandbox immediately after start() returned, before the
    // in-guest agent had created its named pipe.
    assert.ok(
      isAgentEndpointNotReady(
        "error: agent client error: connect \\\\.\\pipe\\msb-agent-e7779577a75cc1f89f66c534458bf8fd: " +
          "The system cannot find the file specified. (os error 2)",
      ),
    );
  });

  it("matches the equivalent unix-socket shape", () => {
    // Same msb framing, unix socket rather than a named pipe — the endpoint
    // is platform-specific but the "couldn't connect at all" classification
    // is not.
    assert.ok(
      isAgentEndpointNotReady(
        "error: agent client error: connect /run/user/1001/msb-agent-abc123.sock: No such file or directory (os error 2)",
      ),
    );
  });

  it("does not match a guest command's own failure", () => {
    // A command that ran and failed inside the guest must return on the
    // first attempt — retrying it would multiply its runtime for no reason.
    assert.ok(!isAgentEndpointNotReady("cat: /srv/missing.txt: No such file or directory"));
    assert.ok(!isAgentEndpointNotReady(""));
  });

  it("does not match a post-connect agent error", () => {
    // Reached the agent, then the agent itself reported a problem — a real
    // error to surface immediately, not a not-yet-listening endpoint to wait out.
    assert.ok(
      !isAgentEndpointNotReady("error: agent client error: request failed: guest process exited before responding"),
    );
  });
});
