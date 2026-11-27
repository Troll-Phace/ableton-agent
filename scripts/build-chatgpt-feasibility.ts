import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { packageExtension } from "@ableton-extensions/cli";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, "dist", "chatgpt-feasibility");
const stage = join(output, "stage");
const archive = join(output, "ableton-chatgpt-feasibility-0.0.1.ablx");
const manifest = {
  name: "ableton-chatgpt-feasibility",
  author: "Anthony Grimaldi",
  entry: "extension.js",
  version: "0.0.1",
  minimumApiVersion: "1.0.0",
};
// A separate, static asset with no third-party code or external destinations.
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Temporary ChatGPT feasibility</title><style>body{font:14px system-ui;background:#202020;color:#eee;margin:20px}button{padding:10px;margin:4px;color:#111}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}p{line-height:1.5}</style><h1>Temporary feasibility fixture</h1><p>No account, credentials, provider requests, or Live Set reads/changes. The probe may open one harmless loopback browser page. Restart Live and repeat for the storage check.</p><button id="run">Run host checks</button><button id="cancel" disabled>Cancel</button><button disabled>Continue with ChatGPT (not available)</button><button disabled>Sign out (not available)</button><pre id="status" role="status">Ready.</pre><script>const run=document.querySelector('#run'),cancel=document.querySelector('#cancel'),statusNode=document.querySelector('#status');let polling=false;async function update(action,method='GET'){try{const r=await fetch(action,{method,cache:'no-store'});if(!r.ok)throw Error();const s=await r.json();run.disabled=s.running||s.browserRequested;cancel.disabled=!s.running;statusNode.textContent=(s.running?'Checking host…\\n':'')+JSON.stringify(s.results,null,2);if(s.running&&!polling){polling=true;setTimeout(()=>{polling=false;void update('status')},400)}}catch{statusNode.textContent='Host IPC unavailable. See sanitized fixture logs.';run.disabled=true;cancel.disabled=true}}run.onclick=()=>{run.disabled=true;void update('run','POST')};cancel.onclick=()=>{cancel.disabled=true;void update('cancel','POST')};void update('status');</script></html>`;

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
  define: { __FEASIBILITY_WEBVIEW__: JSON.stringify(html) },
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
console.info(`SHA256 ${hash}`);
