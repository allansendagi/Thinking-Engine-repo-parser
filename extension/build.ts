import { rmSync, mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";

const outdir = join(import.meta.dir, "dist");
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

async function build(entrypoints: string[], format: "esm" | "iife") {
  const result = await Bun.build({
    entrypoints: entrypoints.map((e) => join(import.meta.dir, e)),
    outdir,
    target: "browser",
    format,
    naming: "[name].js",
    // Every output file must be fully self-contained: content scripts run as classic (non-module)
    // scripts, so an import pointing at a separate chunk file would fail outright, not degrade.
    splitting: false,
  });
  if (!result.success) {
    for (const message of result.logs) console.error(message);
    throw new Error(`Build failed for: ${entrypoints.join(", ")}`);
  }
  return result;
}

// Content scripts: IIFE, no module system needed or declared in the manifest.
const contentResult = await build(
  ["src/content-chatgpt.ts", "src/content-claude.ts", "src/content-gemini.ts"],
  "iife",
);

// Background (declared type:"module" in the manifest) and popup/sidepanel (loaded via
// <script type="module">) can use ESM.
const moduleResult = await build(["src/background.ts", "src/popup/popup.ts", "src/sidepanel/sidepanel.ts"], "esm");

for (const file of ["src/popup/popup.html", "src/sidepanel/sidepanel.html", "src/shared.css"]) {
  copyFileSync(join(import.meta.dir, file), join(outdir, file.split("/").pop() as string));
}

console.log(`Built ${contentResult.outputs.length + moduleResult.outputs.length} bundles to ${outdir}`);
