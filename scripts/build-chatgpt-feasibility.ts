import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { packageExtension } from "@ableton-extensions/cli";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, "dist", "chatgpt-feasibility");
const stage = join(output, "stage-0.0.2");
const archive = join(output, "ableton-chatgpt-feasibility-0.0.2.ablx");
const manifest = {
  name: "ableton-chatgpt-feasibility",
  author: "Anthony Grimaldi",
  entry: "extension.js",
  version: "0.0.2",
  minimumApiVersion: "1.0.0",
};
// A source-derived, visible identity changes with the fixture inputs. The
// independent archive SHA256 is separately calculated after packaging.
const sourcePaths = [
  "src/extension/feasibility/contracts.ts",
  "src/extension/feasibility/host-probes.ts",
  "src/extension/feasibility/native-compatibility.ts",
  "src/extension/feasibility/index.ts",
  "scripts/build-chatgpt-feasibility.ts",
];
const identity = createHash("sha256");
for (const file of sourcePaths)
  identity.update(file).update(await readFile(join(root, file)));
const buildId = `f2c-${identity.digest("hex").slice(0, 16)}`;
// A separate, static asset with no third-party code or external destinations.
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Temporary ChatGPT compatibility</title><style>body{font:14px system-ui;background:#202020;color:#eee;margin:20px}button{padding:10px;margin:4px;color:#111}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}p{line-height:1.5}</style><h1>Native Fetch compatibility</h1><p>Fixture ${manifest.version} · Build ${buildId}</p><p>No account, credentials, browser launch, storage work, provider requests, or Live Set reads/changes. Tests local constructors first; missing standard constructors may be temporarily supplied from permitted Node builtins, then restored. Restart Live to repeat installed evidence.</p><button id="run">Run compatibility checks</button><button id="cancel" disabled>Cancel</button><pre id="status" role="status">Ready.</pre><script>const run=document.querySelector('#run'),cancel=document.querySelector('#cancel'),statusNode=document.querySelector('#status');let polling=false;async function update(action,method='GET'){try{const r=await fetch(action,{method,cache:'no-store'});if(!r.ok)throw Error();const s=await r.json();run.disabled=s.running||s.report?.restored===false||s.actionFailed;cancel.disabled=!s.running;statusNode.textContent=s.actionFailed?'Compatibility action failed. See sanitized fixture logs; restart before retry.':(s.running?'Checking host…\\n':'')+(s.report?JSON.stringify(s.report,null,2):'Ready.');if(s.running&&!polling){polling=true;setTimeout(()=>{polling=false;void update('status')},400)}}catch{statusNode.textContent='Host IPC unavailable. See sanitized fixture logs.';run.disabled=true;cancel.disabled=true}}run.onclick=()=>{run.disabled=true;void update('compatibility','POST')};cancel.onclick=()=>{cancel.disabled=true;void update('cancel','POST')};void update('status');</script></html>`;

await mkdir(join(stage, "webview"), { recursive: true });
await writeFile(
  join(stage, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n"
);
await writeFile(join(stage, "webview", "index.html"), html + "\n");
const bundled = await build({
  entryPoints: [join(root, "src", "extension", "feasibility", "index.ts")],
  outfile: join(stage, manifest.entry),
  bundle: true,
  platform: "node",
  format: "cjs",
  // Host loads a CJS entry; lazily require builtins so denied modules become
  // evidence at probe time rather than crashing the whole activation.
  supported: { "dynamic-import": false },
  define: {
    __FEASIBILITY_WEBVIEW__: JSON.stringify(html),
    __FEASIBILITY_BUILD_ID__: JSON.stringify(buildId),
  },
  sourcemap: false,
  metafile: true,
});
const unexpected = Object.keys(bundled.metafile.inputs).filter(
  (file) =>
    !file.includes("src/extension/feasibility/") &&
    !file.includes("node_modules/@ableton-extensions/sdk/")
);
if (unexpected.length)
  throw new Error("Unexpected feasibility bundle dependency");
await packageExtension(stage, archive, ["webview/index.html"]);
const hash = createHash("sha256")
  .update(await readFile(archive))
  .digest("hex");
await writeFile(
  `${archive}.sha256`,
  `${hash}  ${manifest.name}-${manifest.version}.ablx\n`
);
console.info(`Build ${buildId} SHA256 ${hash}`);
