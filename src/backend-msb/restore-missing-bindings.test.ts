import { describe, it, assert } from "../../test/harness.js";
import { isRestoreMissingBindingsFailure } from "./restore-missing-bindings.js";

// Verbatim from msb 0.7.8 (a snapshot whose source sandbox had a file copied in
// at /etc/app/b.conf, restored without --volume for it).
const MSB_078_REFUSAL =
  "error: invalid config: restore requires destination bindings for: mount /etc/app/b.conf; provide a destination mount for each path or explicitly allow missing resources\n" +
  "  \u2192 map each path with -v SOURCE:GUEST or --mount-disk SOURCE:GUEST\n" +
  "  \u2192 or pass --allow-missing-resources to start without them\n";

describe("isRestoreMissingBindingsFailure", () => {
  it("matches msb 0.7.8's refusal verbatim", () => {
    assert.ok(isRestoreMissingBindingsFailure(MSB_078_REFUSAL));
  });

  it("matches the 0.7.6 binary's variant: no 'invalid config:' prefix and a different tail", () => {
    assert.ok(
      isRestoreMissingBindingsFailure(
        "error: restore requires destination bindings for: disk /data; provide --volume mappings, select captured disks with --volume GUEST, or explicitly use --allow-missing-resources",
      ),
    );
  });

  it("matches the first line alone: the hint lines, the arrows and the 'invalid config:' prefix do not matter", () => {
    assert.ok(isRestoreMissingBindingsFailure("restore requires destination bindings for: mount /a"));
    assert.ok(isRestoreMissingBindingsFailure("restore requires destination bindings for"));
  });

  it("matches a disk entry and several entries as well as a single mount", () => {
    assert.ok(
      isRestoreMissingBindingsFailure(
        "error: invalid config: restore requires destination bindings for: mount /a, disk /b; provide a destination mount or select a captured disk for each path, or explicitly allow missing resources",
      ),
    );
  });

  it("matches a PowerShell-decorated capture: 'msb.exe : ' in front, the console's own record lines, the arrows mangled", () => {
    const decorated =
      "msb.exe : error: invalid config: restore requires destination bindings for: mount /etc/app/b.conf; provide a destination mount for each path or explicitly allow missing resources\n" +
      "At line:1 char:1\n" +
      "+ & 'C:\\Users\\runner\\msb.exe' 'restore' 'C:\\snaps\\snap_1' '--name' 'rz-1-2' ...\n" +
      "+ ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~\n" +
      "    + CategoryInfo          : NotSpecified: (error: invalid ...ng resources:String) [], RemoteException\n" +
      "    + FullyQualifiedErrorId : NativeCommandError\n" +
      " \n" +
      "  \u0393\u00e5\u00c6 map each path with -v SOURCE:GUEST or --mount-disk SOURCE:GUEST\n" +
      "  \u0393\u00e5\u00c6 or pass --allow-missing-resources to start without them\n";
    assert.ok(isRestoreMissingBindingsFailure(decorated));
  });

  it("matches when the capture wrapped the sentence at a space, so a line break or indent sits between its words", () => {
    assert.ok(isRestoreMissingBindingsFailure("msb.exe : error: invalid config: restore requires\n    destination bindings for: mount /a"));
    assert.ok(isRestoreMissingBindingsFailure("restore  requires\r\ndestination   bindings\tfor: mount /a"));
  });

  it("matches inside a longer tail of merged output", () => {
    assert.ok(isRestoreMissingBindingsFailure(`restoring rz-1-2 from /snaps/snap_1\n${MSB_078_REFUSAL}`));
  });

  it("does not match an unrelated restore failure", () => {
    assert.equal(isRestoreMissingBindingsFailure("error: failed to restore snapshot 'rz-ckpt-x': destination disk is full"), false);
    assert.equal(isRestoreMissingBindingsFailure("error: snapshot not found: rz-ckpt-never-existed"), false);
    assert.equal(isRestoreMissingBindingsFailure("error: invalid config: disk_only requires a full snapshot with checkpoint state"), false);
    assert.equal(isRestoreMissingBindingsFailure(""), false);
  });

  it("does not match the agent-relay failure, the access-denied failure or a name collision", () => {
    assert.equal(
      isRestoreMissingBindingsFailure(
        'error: failed to start "rz-1-2"\n  \u2192 other: sandbox process exited (exit code: 0) before agent relay became available\n',
      ),
      false,
    );
    assert.equal(isRestoreMissingBindingsFailure("error: io error: Access is denied. (os error 5)"), false);
    assert.equal(isRestoreMissingBindingsFailure("error: sandbox 'rz-abc-1' already exists"), false);
  });

  it("does not match msb's other mount-related refusals, which are not this one", () => {
    assert.equal(isRestoreMissingBindingsFailure("error: invalid config: external mount /etc/app/b.conf must retain captured mount flags"), false);
    assert.equal(isRestoreMissingBindingsFailure("error: invalid config: restore cannot add uncaptured file transports"), false);
  });
});
