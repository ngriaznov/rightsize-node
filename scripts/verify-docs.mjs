#!/usr/bin/env node
// docs:verify — extracts every fenced ts/typescript code block from
// README.md and docs/**, wraps each in a compilable harness, and typechecks
// the whole batch with one `tsc --noEmit` invocation. Blocks whose info
// string carries the `runnable` tag (```ts runnable) are additionally
// executed end-to-end, under both Node and Bun when RIGHTSIZE_DOCS_RUN=1 is
// set — those samples boot real containers, so they're opt-in rather than
// part of the default fast typecheck-only pass. It also typechecks
// examples/**/*.ts (via tsconfig.examples.json) as a second, separate `tsc`
// pass — those are samples too, just ones with their own dedicated build
// (`npm run examples:build`) rather than markdown fences.
//
// Usage:
//   node scripts/verify-docs.mjs                        # extract + typecheck only
//   RIGHTSIZE_DOCS_RUN=1 node scripts/verify-docs.mjs    # + execute runnable samples (current runtime)
//
// The harness resolves `rightsize`/`rightsize/modules`/etc. exactly the way
// a real consumer would: a `node_modules/rightsize` symlink into the repo
// root, so both tsc's module resolution and Node/Bun's runtime resolution
// go through the package's own `exports` map — no custom path mapping to
// keep in sync with it.

import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, symlinkSync, existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const outDir = join(repoRoot, ".docs-verify");
const isBun = typeof globalThis.Bun !== "undefined";

function listMarkdownFiles() {
  const readmePath = join(repoRoot, "README.md");
  const files = existsSync(readmePath) ? [readmePath] : [];
  const docsDir = join(repoRoot, "docs");

  // Process/implementation records, not doc-site content — same exclusion
  // list as docs/.vitepress/config.ts's srcExclude.
  const skipDirs = new Set([".vitepress", "plans", ".typedoc", "node_modules"]);
  const skipFiles = new Set(["verification.md", "coverage.md", "runtime-baseline.md"]);

  function walk(dir) {
    for (const entry of readdirSync(dir)) {
      if (skipDirs.has(entry)) {
        continue;
      }
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".md") && !skipFiles.has(entry)) {
        files.push(full);
      }
    }
  }
  walk(docsDir);
  return files;
}

// Matches ```ts / ```typescript fences, capturing the info string (for the
// `runnable` tag) and the body. Global regex re-used per file with
// lastIndex reset, so back-to-back fences in the same file are extracted
// individually rather than one greedy match spanning both.
const FENCE_RE = /```(ts|typescript)([^\n]*)\n([\s\S]*?)```/g;

function extractSamples(files) {
  const samples = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    let match;
    let index = 0;
    FENCE_RE.lastIndex = 0;
    while ((match = FENCE_RE.exec(text)) !== null) {
      const [, , infoRest, body] = match;
      const runnable = /\brunnable\b/.test(infoRest ?? "");
      samples.push({
        file: relative(repoRoot, file),
        index: index++,
        runnable,
        body,
      });
    }
  }
  return samples;
}

function sampleBasename(sample) {
  const safeFile = sample.file.replace(/[\\/.]/g, "_");
  return `${safeFile}__${sample.index}`;
}

// `import`/`export` statements must stay at the top level of the module —
// wrapping the WHOLE sample body in an async IIFE (so top-level `await`
// and `await using` typecheck without each sample declaring its own async
// function) would otherwise nest those imports inside a function body,
// which TypeScript rejects (TS1232). Splitting the leading import block out
// keeps imports at module scope and only wraps the executable statements
// that follow them.
function splitImports(body) {
  const lines = body.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line === "" || line.startsWith("import ") || line.startsWith("import{")) {
      i++;
      continue;
    }
    break;
  }
  return { imports: lines.slice(0, i).join("\n"), rest: lines.slice(i).join("\n") };
}

function writeHarness(sample) {
  const name = sampleBasename(sample);
  const filePath = join(outDir, `${name}.ts`);
  const { imports, rest } = splitImports(sample.body);
  const wrapped =
    `// Auto-generated from ${sample.file} (block #${sample.index}) by scripts/verify-docs.mjs — do not edit.\n` +
    `${imports}\n(async () => {\n${rest}\n})();\n`;
  writeFileSync(filePath, wrapped, "utf8");
  return filePath;
}

function linkRightsizeIntoNodeModules() {
  const nodeModulesDir = join(outDir, "node_modules");
  mkdirSync(nodeModulesDir, { recursive: true });
  const linkPath = join(nodeModulesDir, "rightsize");
  if (!existsSync(linkPath)) {
    symlinkSync(repoRoot, linkPath, "dir");
  }
}

function writeTsconfig() {
  const tsconfigPath = join(outDir, "tsconfig.json");
  const config = {
    compilerOptions: {
      strict: true,
      exactOptionalPropertyTypes: true,
      module: "nodenext",
      moduleResolution: "nodenext",
      target: "es2022",
      lib: ["es2022", "esnext.disposable"],
      verbatimModuleSyntax: true,
      skipLibCheck: true,
      types: ["node"],
      rootDir: outDir,
      outDir: join(outDir, "dist"),
    },
    include: ["*.ts"],
  };
  writeFileSync(tsconfigPath, JSON.stringify(config, null, 2), "utf8");
  return tsconfigPath;
}

function main() {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  linkRightsizeIntoNodeModules();

  const files = listMarkdownFiles();
  const samples = extractSamples(files);

  if (samples.length === 0) {
    console.error(
      "docs:verify found zero fenced ts/typescript samples — that's almost certainly a bug in the extractor, not a clean bill of health.",
    );
    process.exit(1);
  }

  for (const sample of samples) {
    writeHarness(sample);
  }
  const tsconfigPath = writeTsconfig();

  console.log(`docs:verify: extracted ${samples.length} sample(s) from ${files.length} file(s).`);

  const runnable = samples.filter((s) => s.runnable);
  const wantsExecution = process.env.RIGHTSIZE_DOCS_RUN === "1";
  // --noEmit for the typecheck-only pass; a real emit is needed when Node
  // will execute the compiled output (Bun runs the .ts sources directly and
  // never needs this).
  const tscArgs = ["-p", tsconfigPath];
  if (!wantsExecution || isBun || runnable.length === 0) {
    tscArgs.push("--noEmit");
  }

  const tsc = spawnSync(process.execPath, [join(repoRoot, "node_modules/typescript/bin/tsc"), ...tscArgs], {
    stdio: "inherit",
    cwd: repoRoot,
  });
  if (tsc.status !== 0) {
    console.error("docs:verify: FAILED — one or more documentation samples do not typecheck.");
    process.exit(tsc.status ?? 1);
  }
  console.log(`docs:verify: all ${samples.length} sample(s) typecheck clean.`);

  const examplesTsc = spawnSync(
    process.execPath,
    [join(repoRoot, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.examples.json", "--noEmit"],
    { stdio: "inherit", cwd: repoRoot },
  );
  if (examplesTsc.status !== 0) {
    console.error("docs:verify: FAILED — one or more examples/**/*.ts files do not typecheck.");
    process.exit(examplesTsc.status ?? 1);
  }
  console.log("docs:verify: examples/**/*.ts typecheck clean.");

  if (wantsExecution) {
    console.log(`docs:verify: executing ${runnable.length} runnable sample(s) under ${isBun ? "Bun" : "Node"}...`);
    for (const sample of runnable) {
      const name = sampleBasename(sample);
      const runPath = isBun ? join(outDir, `${name}.ts`) : join(outDir, "dist", `${name}.js`);
      console.log(`  running ${sample.file} block #${sample.index} (${name})`);
      const run = isBun
        ? spawnSync("bun", ["run", runPath], { stdio: "inherit", cwd: repoRoot })
        : spawnSync(process.execPath, [runPath], { stdio: "inherit", cwd: repoRoot });
      if (run.status !== 0) {
        console.error(`docs:verify: FAILED — runnable sample ${sample.file}#${sample.index} exited non-zero.`);
        process.exit(run.status ?? 1);
      }
    }
    console.log(`docs:verify: all ${runnable.length} runnable sample(s) executed cleanly under ${isBun ? "Bun" : "Node"}.`);
  } else if (runnable.length > 0) {
    console.log(
      `docs:verify: ${runnable.length} runnable sample(s) found but not executed (set RIGHTSIZE_DOCS_RUN=1 to boot real containers and run them).`,
    );
  }
}

main();
