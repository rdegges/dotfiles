import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};
const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT ?? 4174);

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  const path = pathname === '/' ? '/index.html' : pathname;
  if (path.includes('/.')) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  try {
    const body = await readFile(join(root, path));
    res.writeHead(200, {
      'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`statusboard on http://localhost:${port}`);
});
