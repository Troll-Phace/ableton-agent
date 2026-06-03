import * as fs from "node:fs";

import * as esbuild from "esbuild";

/** Minimal shape of `manifest.json` consumed by this build driver. */
interface Manifest {
  entry: string;
}

/**
 * Reads and validates `manifest.json`, narrowing the `unknown` JSON payload to
 * the {@link Manifest} fields the esbuild driver depends on.
 */
function readManifest(path: string): Manifest {
  const parsed: unknown = JSON.parse(fs.readFileSync(path, "utf8"));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("entry" in parsed) ||
    typeof parsed.entry !== "string"
  ) {
    throw new Error(`Invalid manifest at ${path}: missing string "entry".`);
  }
  return { entry: parsed.entry };
}

const manifest = readManifest("manifest.json");
const production = process.argv.includes("--production");

await esbuild.build({
  entryPoints: ["src/extension/index.ts"],
  outfile: manifest.entry,
  bundle: true,
  format: "cjs",
  platform: "node",
  sourcesContent: false,
  logLevel: "info",
  minify: production,
  sourcemap: !production,
  loader: { ".html": "text" },
});
