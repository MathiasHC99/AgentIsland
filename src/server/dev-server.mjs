import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { handleAgentRequest } from './api.mjs';
import { createTodoSeed } from '../../scripts/sync-todos.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const todoSeed = await createTodoSeed();
try {
  const localEnv = readFileSync(resolve(projectRoot, '.env'), 'utf8');
  for (const line of localEnv.split(/\r?\n/)) {
    const match = line.match(/^\s*(OPENAI_API_KEY|OPENAI_MODEL|OPENAI_MODELS|OLLAMA_BASE_URL|N8N_WEBHOOK_URL|N8N_WEBHOOK_TOKEN)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    const value = match[2];
    process.env[match[1]] = /^(['"]).*\1$/.test(value) ? value.slice(1, -1) : value;
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
process.env.OLLAMA_BASE_URL ||= 'http://127.0.0.1:11434';

const root = resolve(projectRoot, 'src/client');
const port = Number(process.env.PORT || 4173);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  try {
    const expectedPort = request.socket.localPort;
    const host = request.headers.host;
    if (![new URL(`http://localhost:${expectedPort}`).host, new URL(`http://127.0.0.1:${expectedPort}`).host].includes(host)
        || !request.url.startsWith('/') || request.url.startsWith('//')) {
      response.writeHead(403).end('Use the local island address.');
      return;
    }
    const url = new URL(request.url, `http://${host}`);
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.startsWith('/api/')) {
      const controller = new AbortController();
      response.once('close', () => controller.abort());
      const options = { method: request.method, headers: request.headers, signal: controller.signal };
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        options.body = Readable.toWeb(request);
        options.duplex = 'half';
      }
      const result = await handleAgentRequest(new Request(url.href, options), process.env);
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(await result.text());
      return;
    }
    if (pathname === '/todo-seed.js') {
      response.writeHead(200, { 'Content-Type': types['.js'], 'Cache-Control': 'no-cache' });
      response.end(todoSeed);
      return;
    }
    // Serve only client source assets with supported file types, including nested modules and styles.
    if (pathname !== '/' && (!/^(?:\/[\w.-]+)+$/.test(pathname) || !Object.hasOwn(types, extname(pathname)))) {
      response.writeHead(404).end('Not found');
      return;
    }
    const filename = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!filename.startsWith(root + sep) || !(await stat(filename)).isFile()) {
      response.writeHead(404).end('Not found');
      return;
    }
    const body = await readFile(filename);
    response.writeHead(200, { 'Content-Type': types[extname(filename)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    response.end(body);
  } catch {
    response.writeHead(404).end('Not found');
  }
});
server.listen(port, '127.0.0.1', () => console.log(`AgentIsland is ready at http://localhost:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
