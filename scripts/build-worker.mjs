import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';

const root = new URL('../', import.meta.url);
const dist = new URL('dist/', root);
const types = new Map([
  ['.html', 'text/html'], ['.js', 'text/javascript'], ['.css', 'text/css'], ['.svg', 'image/svg+xml'],
]);
// The island has a small set of text assets. Embed them for the standalone Sites Worker.
const assets = [];
for (const entry of (await readdir(dist, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
  const type = types.get(extname(entry.name));
  if (entry.isFile() && type) {
    const body = await readFile(new URL(entry.name, dist), 'utf8');
    assets.push(['/' + entry.name, { body, type: type + '; charset=utf-8' }]);
  }
}
const api = await readFile(new URL('agent-api.mjs', root), 'utf8');
const router = await readFile(new URL('worker.mjs', root), 'utf8');
const main = 'export default createIslandWorker(handleAgentRequest, new Map(' + JSON.stringify(assets) + '));';
await mkdir(new URL('server/', dist), { recursive: true });
await writeFile(new URL('server/index.js', dist), [api, router, main].join('\n'));
