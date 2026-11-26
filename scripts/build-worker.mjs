import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { createTodoSeed } from './sync-todos.mjs';

const root = new URL('../', import.meta.url);
const client = new URL('src/client/', root);
const types = new Map([
  ['.html', 'text/html'], ['.js', 'text/javascript'], ['.css', 'text/css'], ['.svg', 'image/svg+xml'],
]);

// Embed the same browser assets served by the local development server.
const assets = [];
async function collect(directory, prefix = '') {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix + entry.name;
    const file = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    if (entry.isDirectory()) {
      await collect(file, relative + '/');
      continue;
    }
    const type = types.get(extname(entry.name));
    if (type) assets.push(['/' + relative, { body: await readFile(file, 'utf8'), type: type + '; charset=utf-8' }]);
  }
}
await collect(client);
assets.push(['/todo-seed.js', { body: await createTodoSeed(), type: 'text/javascript; charset=utf-8' }]);

const api = await readFile(new URL('src/server/api.mjs', root), 'utf8');
const router = await readFile(new URL('src/server/worker.mjs', root), 'utf8');
const main = 'export default createIslandWorker(handleAgentRequest, new Map(' + JSON.stringify(assets) + '));';
await mkdir(new URL('dist/server/', root), { recursive: true });
await writeFile(new URL('dist/server/index.js', root), [api, router, main].join('\n'));
