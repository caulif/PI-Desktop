import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
await build({entryPoints:[resolve(root,"src/index.ts")],outfile:resolve(root,"dist-bundle/service.mjs"),bundle:true,platform:"node",format:"esm",target:"node22",external:["node-pty","bufferutil","utf-8-validate"],banner:{js:"import { createRequire as __piCreateRequire } from 'node:module'; const require = __piCreateRequire(import.meta.url);"}});
await build({entryPoints:[resolve(root,"src/bot-node-cli.ts")],outfile:resolve(root,"dist-bundle/bot-node.mjs"),bundle:true,platform:"node",format:"esm",target:"node22",external:["node-pty","bufferutil","utf-8-validate"],banner:{js:"import { createRequire as __piCreateRequire } from 'node:module'; const require = __piCreateRequire(import.meta.url);"}});
