import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { packageExtension } from "@ableton-extensions/cli";
import { build, type Metafile } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, "dist", "chatgpt-feasibility");
const archive = join(
  output,
  "ableton-chatgpt-feasibility-0.0.3-storage-diagnostic.ablx"
);
const manifest = {
  name: "ableton-chatgpt-feasibility",
  author: "Anthony Grimaldi",
  entry: "extension.js",
  version: "0.0.3",
  minimumApiVersion: "1.0.0",
};

// The reviewed exact runtime closure. Type-only declarations are checked
// separately and not bundled. A newly resolved package/version is a build stop.
const approvedPackages = [
  {
    name: "@ableton-extensions/sdk",
    version: "1.0.0-beta.0",
    license: "SEE LICENSE IN LICENSE.md",
    file: "LICENSE.md",
  },
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
  "node:stream/web",
  "node:child_process",
  "buffer",
  "crypto",
  "stream",
  "util",
]);
const fixtureSources = [
  "contracts.ts",
  "host-probes.ts",
  "native-compatibility.ts",
  "signin-contracts.ts",
  "official-http.ts",
  "credential-store.ts",
  "oauth.ts",
  "id-token.ts",
  "responses.ts",
  "signin-session.ts",
  "index.ts",
].map((name) => `src/extension/feasibility/${name}`);
const viewSource = "src/extension/feasibility/signin-view.html";
const virtualEntry = "signin-feasibility-entry.ts";
// The maintained verifier is a dependency of the actual reviewed package entry,
// not the earlier source-only fixture graphs. Load it lazily so a denied native
// capability becomes preflight evidence instead of an activation-time crash.
const adapterEntry = `import { activate as activateFixture } from "./src/extension/feasibility/index.ts";
export function activate(activation: unknown) {
  activateFixture(activation as Parameters<typeof activateFixture>[0], async () => {
    const jwt = await import("jsonwebtoken");
    return jwt.default;
  }, true);
}`;

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
  "THIRD-PARTY NOTICES — temporary Ableton Agent ChatGPT feasibility fixture",
  "Runtime packages are bundled into the application only; no standalone Ableton SDK archive is included. Type declarations are build-only.",
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
    (approved.name !== "@ableton-extensions/sdk" && lockEntry.dev !== true)
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
function renderView(id: string): string {
  if (
    !template.includes("{{FIXTURE_VERSION}}") ||
    !template.includes("{{BUILD_ID}}")
  )
    throw new Error("Missing fixture identity placeholders");
  return template
    .replaceAll("{{FIXTURE_VERSION}}", manifest.version)
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
    outfile: manifest.entry,
    bundle: true,
    platform: "node",
    format: "cjs",
    supported: { "dynamic-import": false },
    define: {
      __FEASIBILITY_WEBVIEW__: JSON.stringify(renderView(id)),
      __FEASIBILITY_BUILD_ID__: JSON.stringify(id),
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
  (await compile("f3-0000000000000000")).metafile
);
const identity = createHash("sha256");
identity
  .update(JSON.stringify(manifest))
  .update(adapterEntry)
  .update(JSON.stringify(inventory))
  .update(noticeText);
const sourcePaths = [
  ...fixtureSources,
  viewSource,
  "scripts/build-chatgpt-feasibility.ts",
  "package.json",
  "package-lock.json",
  "LICENSE",
];
for (const path of sourcePaths)
  identity.update(path).update(await readFile(join(root, path)));
const inputHashes: Record<string, string> = {};
for (const path of preliminary.inputs) {
  const bytes =
    path === virtualEntry ? adapterEntry : await readFile(join(root, path));
  inputHashes[path] = sha(bytes);
  identity.update(path).update(bytes);
}
const buildId = `f3-${identity.digest("hex").slice(0, 16)}`;
const finalBundle = await compile(buildId);
const finalGraph = inspectGraph(finalBundle.metafile);
if (JSON.stringify(finalGraph) !== JSON.stringify(preliminary))
  throw new Error("Fixture graph changed between identity and package build");
for (const [path, digest] of Object.entries(inputHashes)) {
  const bytes =
    path === virtualEntry ? adapterEntry : await readFile(join(root, path));
  if (sha(bytes) !== digest)
    throw new Error("Fixture input changed during package build");
}
const extension = finalBundle.outputFiles.find((file) =>
  file.path.endsWith(`/${manifest.entry}`)
);
if (!extension || finalBundle.outputFiles.length !== 1)
  throw new Error("Unexpected fixture build outputs");
const html = renderView(buildId);

// Unique, clean staging and explicit package assets. Never touch older stages,
// prior 0.0.1/0.0.2 archives, production bundles, storage or vendor archives.
await mkdir(output, { recursive: true });
const stage = await mkdtemp(join(output, "stage-0.0.3-"));
await mkdir(join(stage, "webview"));
await writeFile(
  join(stage, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n"
);
await writeFile(join(stage, manifest.entry), extension.contents);
await writeFile(join(stage, "webview", "index.html"), html);
await writeFile(join(stage, "LICENSE.txt"), projectLicense);
await writeFile(join(stage, "THIRD_PARTY_NOTICES.txt"), noticeText);
await writeFile(
  join(stage, "bundle-inventory.json"),
  JSON.stringify(
    {
      version: manifest.version,
      buildId,
      packageLockSha256: sha(lockBytes),
      extensionSha256: sha(extension.contents),
      webviewSha256: sha(html),
      noticesSha256: sha(noticeText),
      runtimePackages: inventory,
      typeOnly,
      externalBuiltins: finalGraph.externals,
      inputSha256: inputHashes,
    },
    null,
    2
  ) + "\n"
);
await packageExtension(stage, archive, [
  "webview/index.html",
  "LICENSE.txt",
  "THIRD_PARTY_NOTICES.txt",
  "bundle-inventory.json",
]);
const hash = sha(await readFile(archive));
await writeFile(`${archive}.sha256`, `${hash}  ${basename(archive)}\n`);
console.info(`Fixture ${manifest.version} Build ${buildId} SHA256 ${hash}`);
console.info(
  `Reviewed runtime packages: ${inventory.length}; isolated stage: ${stage}`
);
