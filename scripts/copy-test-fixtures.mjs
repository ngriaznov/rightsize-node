// Copies non-TypeScript test fixtures (e.g. src/core/rightsize-fixture.txt,
// test/fixtures/contract-bundled.txt) into their dist-test/ mirror after the
// test build. tsc only emits .ts files, so anything a test resolves
// relative to its own compiled import.meta.url — like
// MountableFile.forResource's fixture file — needs a plain file copy
// alongside the compiled output.
import { cpSync } from "node:fs";

cpSync("src", "dist-test/src", {
  recursive: true,
  filter: (source) => !source.endsWith(".ts"),
});

cpSync("test", "dist-test/test", {
  recursive: true,
  filter: (source) => !source.endsWith(".ts"),
});
