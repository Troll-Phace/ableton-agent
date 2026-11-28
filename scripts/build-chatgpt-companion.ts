import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Metafile } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, "dist", "chatgpt-companion");
const version = "0.0.4";
const entry = "companion.cjs";
const requiredNode = ">=24.14.1";

const approvedPackages = [
  { name: "jsonwebtoken", version: "9.0.3", license: "MIT", file: "LICENSE" },
  { name: "jws", version: "4.0.1", license: "MIT", file: "LICENSE" },
  { name: "jwa", version: "2.0.1", license: "MIT", file: "LICENSE" },
  {
    name: "lodash.includes",
    version: "4.3.0",
    license: "MIT",
    file: "LICENSE",
  },
  {
    name: "lodash.isboolean",
    version: "3.0.3",
    license: "MIT",
    file: "LICENSE",
  },
  {
    name: "lodash.isinteger",
    version: "4.0.4",
    license: "MIT",
    file: "LICENSE",
  },
  {
    name: "lodash.isnumber",
    version: "3.0.3",
    license: "MIT",
    file: "LICENSE",
  },
  {
    name: "lodash.isplainobject",
    version: "4.0.6",
    license: "MIT",
    file: "LICENSE",
  },
  {
    name: "lodash.isstring",
    version: "4.0.1",
    license: "MIT",
    file: "LICENSE",
  },
  { name: "lodash.once", version: "4.1.1", license: "MIT", file: "LICENSE" },
  { name: "ms", version: "2.1.3", license: "MIT", file: "license.md" },
  { name: "semver", version: "7.8.1", license: "ISC", file: "LICENSE" },
  { name: "safe-buffer", version: "5.2.1", license: "MIT", file: "LICENSE" },
  {
    name: "buffer-equal-constant-time",
    version: "1.0.1",
    license: "BSD-3-Clause",
    file: "LICENSE.txt",
  },
  {
    name: "ecdsa-sig-formatter",
    version: "1.0.11",
    license: "Apache-2.0",
    file: "LICENSE",
  },
] as const;
const typeOnly = { name: "@types/jsonwebtoken", version: "9.0.10" };
const allowedBuiltins = new Set([
  "node:http",
  "node:crypto",
  "node:fs",
  "node:path",
  "node:util",
  "node:url",
  "node:os",
  "node:stream/web",
  "node:child_process",
  "buffer",
  "crypto",
  "stream",
  "util",
]);
const fixtureSources = [
  ...[
    "contracts.ts",
    "signin-contracts.ts",
    "official-http.ts",
    "response-diagnostics.ts",
    "credential-store.ts",
    "oauth.ts",
    "id-token.ts",
    "responses.ts",
    "signin-session.ts",
  ].map((name) => `src/extension/feasibility/${name}`),
  ...[
    "main.ts",
    "runtime.ts",
    "storage.ts",
    "preflight.ts",
    "contracts.ts",
    "control-server.ts",
    "diagnostic-budget.ts",
    "response-diagnostic.ts",
  ].map((name) => `src/companion-feasibility/${name}`),
];
const viewSource = "src/companion-feasibility/control-view.html";
const runbookSource = "docs/active/phase-15.3-companion-runbook.md";
const virtualEntry = "chatgpt-companion-entry.ts";
// The packaged entry is inert when imported. Test seams are invocation-only;
// native CLI accepts no destination, command, directory, credential or model.
const adapterEntry = `import { startForegroundCompanion, nativeForegroundDependencies, type ForegroundDependencies } from "./src/companion-feasibility/main.ts";
import { createCompanionRuntime, type CompanionRuntimeDependencies } from "./src/companion-feasibility/runtime.ts";
export { nativeCompanionRuntimeDependencies } from "./src/companion-feasibility/runtime.ts";
import { createCompanionControl, type CompanionControlDependencies } from "./src/companion-feasibility/control-server.ts";
export const version = __COMPANION_VERSION__;
export const buildId = __COMPANION_BUILD_ID__;
export const requiredNode = __COMPANION_NODE__;
export function launchCompanion(options: {foreground?: ForegroundDependencies; control?: CompanionControlDependencies; runtime?: CompanionRuntimeDependencies} = {}) {
  const foreground = options.runtime ? { ...(options.foreground ?? nativeForegroundDependencies()), createRuntime: () => createCompanionRuntime({ ...options.runtime, diagnosticMode: true }) } : options.foreground;
  return startForegroundCompanion(context => createCompanionControl(context, {view: __COMPANION_VIEW__, dependencies: options.control}), foreground);
}
async function main() {
  console.log("Ableton Agent Companion " + version + " · " + buildId + " · Node " + requiredNode);
  if (process.argv.length === 3 && process.argv[2] === "--version") return;
  if (process.argv.length !== 2) { console.error("Only the optional --version argument is supported."); process.exitCode = 1; return; }
  const [major, minor, patch] = process.versions.node.split(".").map(Number);
  if (major < 24 || (major === 24 && (minor < 14 || (minor === 14 && patch < 1)))) { console.error("Unsupported Node version."); process.exitCode = 1; return; }
  try {
    const running = await launchCompanion();
    const result = await running.stopped;
    console.log(JSON.stringify(result));
    // Pending cleanup retains the singleton until process termination.
    process.exit(result.cleanup === "complete" ? 0 : 1);
  } catch (error) {
    const allowed = new Set(["interactive_required","port_occupied","permission_denied","listener_unavailable","storage_blocked","startup_failed"]);
    const storage = new Set(["storage_unsafe","storage_unavailable","storage_failed","permission_denied","directory_sync_unsupported","directory_sync_failed","uncertain_commit"]);
    const code = error && typeof error.code === "string" && allowed.has(error.code) ? error.code : "startup_failed";
    const issue = error && typeof error.storageIssue === "string" && storage.has(error.storageIssue) ? error.storageIssue : undefined;
    console.error(JSON.stringify({code, ...(issue ? {storageIssue: issue} : {})}));
    process.exit(1);
  }
}
if (require.main === module) void main();
`;

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid fixture dependency metadata");
  return value as Record<string, unknown>;
}
async function json(path: string): Promise<Record<string, unknown>> {
  return object(JSON.parse(await readFile(path, "utf8")) as unknown);
}
function sha(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
function inputPath(path: string): string {
  return relative(root, resolve(root, path)).split(sep).join("/");
}

const packageManifest = await json(join(root, "package.json"));
const lockBytes = await readFile(join(root, "package-lock.json"));
const lock = object(JSON.parse(lockBytes.toString("utf8")) as unknown);
const packages = object(lock.packages);
const dev = object(packageManifest.devDependencies);
const runtime = object(packageManifest.dependencies);
if (
  dev.jsonwebtoken !== "9.0.3" ||
  dev[typeOnly.name] !== typeOnly.version ||
  "jsonwebtoken" in runtime ||
  typeOnly.name in runtime
)
  throw new Error(
    "JWT verifier/type pins must be reviewed dev-only dependencies"
  );
const typeLock = object(packages[`node_modules/${typeOnly.name}`]);
const typeInstalled = await json(
  join(root, "node_modules", typeOnly.name, "package.json")
);
if (
  typeLock.version !== typeOnly.version ||
  typeLock.dev !== true ||
  typeInstalled.version !== typeOnly.version ||
  typeInstalled.name !== typeOnly.name
)
  throw new Error("Type declaration pin mismatch");

const notices: string[] = [
  "THIRD-PARTY NOTICES — standalone Ableton Agent ChatGPT companion feasibility",
  "Runtime packages are bundled into the companion application only. No Ableton SDK is included. Type declarations are build-only.",
];
const inventory: {
  name: string;
  version: string;
  license: string;
  integrity: string;
  licenseSha256: string;
}[] = [];
for (const approved of approvedPackages) {
  const lockEntry = object(packages[`node_modules/${approved.name}`]);
  const installed = await json(
    join(root, "node_modules", approved.name, "package.json")
  );
  if (
    installed.name !== approved.name ||
    installed.version !== approved.version ||
    installed.license !== approved.license ||
    lockEntry.version !== approved.version ||
    lockEntry.license !== approved.license ||
    typeof lockEntry.integrity !== "string" ||
    lockEntry.dev !== true
  )
    throw new Error(`Unreviewed dependency metadata: ${approved.name}`);
  const license = await readFile(
    join(root, "node_modules", approved.name, approved.file),
    "utf8"
  );
  if (!license.trim())
    throw new Error(`Missing dependency license: ${approved.name}`);
  inventory.push({
    name: approved.name,
    version: approved.version,
    license: approved.license,
    integrity: lockEntry.integrity,
    licenseSha256: sha(license),
  });
  notices.push(
    `------------------------------------------------------------\n${approved.name} ${approved.version} (${approved.license})\n------------------------------------------------------------\n${license.trimEnd()}\n`
  );
}
const noticeText = notices.join("\n\n") + "\n";
const projectLicense = await readFile(join(root, "LICENSE"), "utf8");
const template = await readFile(join(root, viewSource), "utf8");
const runbook = await readFile(join(root, runbookSource), "utf8");
function renderView(id: string): string {
  if (
    !template.includes("{{COMPANION_VERSION}}") ||
    !template.includes("{{BUILD_ID}}") ||
    !template.includes("{{CSP_NONCE}}")
  )
    throw new Error("Missing companion identity or nonce placeholders");
  return template
    .replaceAll("{{COMPANION_VERSION}}", version)
    .replaceAll("{{BUILD_ID}}", id);
}
async function compile(id: string) {
  return await build({
    absWorkingDir: root,
    stdin: {
      contents: adapterEntry,
      resolveDir: root,
      sourcefile: virtualEntry,
      loader: "ts",
    },
    outfile: entry,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    supported: { "dynamic-import": false },
    define: {
      __COMPANION_VERSION__: JSON.stringify(version),
      __COMPANION_BUILD_ID__: JSON.stringify(id),
      __COMPANION_NODE__: JSON.stringify(requiredNode),
      __COMPANION_VIEW__: JSON.stringify(renderView(id)),
    },
    sourcemap: false,
    legalComments: "eof",
    metafile: true,
    write: false,
  });
}
function inspectGraph(graph: Metafile): {
  inputs: string[];
  externals: string[];
  runtimePackages: string[];
} {
  const inputs = Object.keys(graph.inputs).map(inputPath).sort();
  const used = new Set<string>();
  const fixture = new Set(fixtureSources);
  for (const input of inputs) {
    if (input === virtualEntry || fixture.has(input)) continue;
    const approved = approvedPackages.find(
      (pkg) =>
        input.startsWith(`node_modules/${pkg.name}/`) &&
        !input
          .slice(`node_modules/${pkg.name}/`.length)
          .includes("node_modules/")
    );
    if (!approved)
      throw new Error(`Unexpected feasibility bundle input: ${input}`);
    used.add(approved.name);
  }
  if (
    used.size !== approvedPackages.length ||
    approvedPackages.some((pkg) => !used.has(pkg.name))
  )
    throw new Error("Reviewed package closure does not match bundled packages");
  for (const required of fixtureSources)
    if (!inputs.includes(required))
      throw new Error(`Missing fixture source: ${required}`);
  const externals = new Set<string>();
  for (const element of [
    ...Object.values(graph.inputs),
    ...Object.values(graph.outputs),
  ]) {
    for (const item of element.imports)
      if (item.external) {
        if (!allowedBuiltins.has(item.path))
          throw new Error(`Unexpected external runtime import: ${item.path}`);
        externals.add(item.path);
      }
  }
  return {
    inputs,
    externals: [...externals].sort(),
    runtimePackages: [...used].sort(),
  };
}

// First inspect the actual graph, then derive identity from source/view/script,
// lock, package versions/licenses and all bundled input bytes. The final pass
// must produce the identical reviewed graph with that visible identity.
const preliminary = inspectGraph(
  (await compile("f3c-0000000000000000")).metafile
);
const identity = createHash("sha256");
identity
  .update(JSON.stringify({ version, entry, requiredNode }))
  .update(adapterEntry)
  .update(JSON.stringify(inventory))
  .update(noticeText);
const sourcePaths = [
  ...fixtureSources,
  viewSource,
  runbookSource,
  "scripts/build-chatgpt-companion.ts",
  "package.json",
  "package-lock.json",
  "LICENSE",
];
const sourceHashes: Record<string, string> = {};
for (const path of sourcePaths) {
  const bytes = await readFile(join(root, path));
  sourceHashes[path] = sha(bytes);
  identity.update(path).update(bytes);
}
if (
  sourceHashes[viewSource] !== sha(template) ||
  sourceHashes[runbookSource] !== sha(runbook) ||
  sourceHashes["LICENSE"] !== sha(projectLicense) ||
  sourceHashes["package-lock.json"] !== sha(lockBytes)
)
  throw new Error(
    "Companion package inputs changed during identity generation"
  );
const inputHashes: Record<string, string> = {};
for (const path of preliminary.inputs) {
  const bytes =
    path === virtualEntry ? adapterEntry : await readFile(join(root, path));
  inputHashes[path] = sha(bytes);
  if (sourceHashes[path] && sourceHashes[path] !== inputHashes[path])
    throw new Error("Companion source changed during identity generation");
  identity.update(path).update(bytes);
}
const buildId = `f3c-${identity.digest("hex").slice(0, 16)}`;
const finalBundle = await compile(buildId);
const finalGraph = inspectGraph(finalBundle.metafile);
if (JSON.stringify(finalGraph) !== JSON.stringify(preliminary))
  throw new Error("Fixture graph changed between identity and package build");
for (const [path, digest] of Object.entries({
  ...sourceHashes,
  ...inputHashes,
})) {
  const bytes =
    path === virtualEntry ? adapterEntry : await readFile(join(root, path));
  if (sha(bytes) !== digest)
    throw new Error("Fixture input changed during package build");
}
const companion = finalBundle.outputFiles.find((file) =>
  file.path.endsWith(`/${entry}`)
);
if (!companion || finalBundle.outputFiles.length !== 1)
  throw new Error("Unexpected fixture build outputs");

const inventoryText =
  JSON.stringify(
    {
      version,
      buildId,
      requiredNode,
      packageLockSha256: sha(lockBytes),
      embeddedViewSha256: sha(renderView(buildId)),
      runtimePackages: inventory,
      typeOnly,
      sourceHashes,
      inputHashes,
      graph: finalGraph,
    },
    null,
    2
  ) + "\n";
const assets: Record<string, string | Uint8Array> = {
  [entry]: companion.contents,
  "RUNBOOK.md": runbook,
  "LICENSE.txt": projectLicense,
  "THIRD_PARTY_NOTICES.txt": noticeText,
  "bundle-inventory.json": inventoryText,
};
const manifestText =
  Object.entries(assets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${sha(value)}  ${name}`)
    .join("\n") + "\n";
assets["SHA256SUMS"] = manifestText;
await mkdir(output, { recursive: true });
const stage = await mkdtemp(join(output, `stage-${version}-`));
for (const [name, bytes] of Object.entries(assets))
  await writeFile(join(stage, name), bytes, { flag: "wx" });
const target = join(output, version);
let previous = false;
try {
  const stat = await lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Unsafe prior companion artifact");
  previous = true;
} catch (error) {
  if (
    !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    )
  )
    throw error;
}
if (previous) {
  const names = (await readdir(target)).sort();
  const expected = Object.keys(assets).sort();
  if (JSON.stringify(names) !== JSON.stringify(expected))
    throw new Error("Unexpected prior companion artifact contents");
  let identical = true;
  for (const [name, bytes] of Object.entries(assets)) {
    const info = await lstat(join(target, name));
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Unsafe prior companion asset");
    if (sha(await readFile(join(target, name))) !== sha(bytes))
      identical = false;
  }
  if (identical) {
    console.log(
      `Existing identical artifact: ${target} · ${buildId} · ${sha(companion.contents)}`
    );
    console.log(`Fresh verified stage retained at ${stage}`);
  } else {
    // Preserve earlier local candidate, never overwrite historical package bytes.
    const previousDir = await mkdtemp(join(output, `previous-${version}-`));
    await rename(target, join(previousDir, version));
    await rename(stage, target);
    console.log(`Preserved earlier candidate at ${previousDir}`);
  }
} else await rename(stage, target);
console.log(`Companion ${version} · ${buildId} · ${target}`);
console.log(`Entry SHA256: ${sha(companion.contents)}`);
console.log(`SHA256SUMS SHA256: ${sha(manifestText)}`);
