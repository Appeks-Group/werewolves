// scripts/dev-server.mjs — Servidor local sin Netlify: sirve public/ y la API
// con almacenamiento en memoria. Uso: node scripts/dev-server.mjs [puerto]
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApi } from '../lib/api.mjs';
import { createMemoryStore } from '../lib/memory-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

export function startServer({ port = 8888, store = createMemoryStore(), quiet = false, now } = {}) {
  const api = createApi({ store, ...(now ? { now } : {}) });
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (url.pathname.startsWith('/api/')) {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = chunks.length ? Buffer.concat(chunks) : undefined;
        const headers = {};
        for (const h of ['content-type', 'x-token', 'x-public']) if (req.headers[h]) headers[h] = req.headers[h];
        const request = new Request(url, { method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body });
        const response = await api.handle(request);
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
        return;
      }
      let file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
      if (!file.startsWith(ROOT)) {
        res.writeHead(403).end();
        return;
      }
      if ((await stat(file).catch(() => null))?.isDirectory()) file = path.join(file, 'index.html');
      const data = await readFile(file).catch(() => null);
      if (!data) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('No encontrado');
        return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(data);
    } catch (e) {
      console.error(e);
      res.writeHead(500).end('Error interno');
    }
  });
  return new Promise((resolve) => {
    server.listen(port, () => {
      const p = server.address().port;
      if (!quiet) console.log(`Lobos en el parque · servidor local en http://localhost:${p}`);
      resolve({ server, port: p, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer({ port: Number(process.argv[2] || process.env.PORT || 8888) });
}
