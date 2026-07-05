// Symlinks node_modules/rightsize -> the repo root, idempotently, so
// examples/ (and scripts/verify-docs.mjs's own harness) can import
// "rightsize" / "rightsize/modules" / etc. exactly the way a real consumer
// would — through the package's own `exports` map — without publishing to
// npm or building a separate mapping to keep in sync with it.
import { existsSync, mkdirSync, symlinkSync, lstatSync, rmSync } from "node:fs";
import { join } from "node:path";

const nodeModulesDir = "node_modules";
const linkPath = join(nodeModulesDir, "rightsize");

mkdirSync(nodeModulesDir, { recursive: true });

if (existsSync(linkPath) || lstatSync(linkPath, { throwIfNoEntry: false }) !== undefined) {
  const stat = lstatSync(linkPath, { throwIfNoEntry: false });
  if (stat !== undefined && !stat.isSymbolicLink()) {
    rmSync(linkPath, { recursive: true, force: true });
  }
}
if (!existsSync(linkPath)) {
  symlinkSync(process.cwd(), linkPath, "dir");
}
