import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { handleAgentRequest } from './agent-api.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), 'dist');
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
    // Only the public top-level assets belong to the local static site.
    if (pathname !== '/' && (!/^\/[\w.-]+$/.test(pathname) || !Object.hasOwn(types, extname(pathname)))) {
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
