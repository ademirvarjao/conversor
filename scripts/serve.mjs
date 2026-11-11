#!/usr/bin/env node
/**
 * Servidor estático mínimo (sem dependências) para desenvolvimento local.
 *
 * Uso:
 *   npm run dev            # http://localhost:3000
 *   PORT=8080 npm run dev
 *
 * O app é 100% client-side; este servidor existe apenas porque ES Modules e
 * Web Workers do PDF.js não funcionam via file://.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function resolvePath(requestUrl) {
  const { pathname } = new URL(requestUrl, 'http://localhost');
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const candidate = path.normalize(path.join(ROOT, decoded));
  if (candidate !== ROOT && !candidate.startsWith(ROOT + path.sep)) return null;
  return candidate;
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  response.end(body);
}

const server = createServer(async (request, response) => {
  if (!['GET', 'HEAD'].includes(request.method)) {
    send(response, 405, 'Método não permitido', { Allow: 'GET, HEAD' });
    return;
  }

  const filePath = resolvePath(request.url || '/');
  if (!filePath) {
    send(response, 400, 'Caminho inválido');
    return;
  }

  let target = filePath;
  try {
    const info = await stat(target);
    if (info.isDirectory()) target = path.join(target, 'index.html');
  } catch {
    send(response, 404, 'Arquivo não encontrado');
    return;
  }

  try {
    const info = await stat(target);
    if (!info.isFile()) {
      send(response, 404, 'Arquivo não encontrado');
      return;
    }

    const extension = path.extname(target).toLowerCase();
    response.writeHead(200, {
      'Content-Type': MIME_TYPES[extension] || 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-store',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
    });

    if (request.method === 'HEAD') {
      response.end();
      return;
    }

    createReadStream(target)
      .on('error', () => {
        response.destroy();
      })
      .pipe(response);
  } catch {
    send(response, 404, 'Arquivo não encontrado');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Conversor disponível em http://localhost:${PORT}`);
  console.log(`Raiz: ${ROOT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
