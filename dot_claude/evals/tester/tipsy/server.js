import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
};
const root = new URL('.', import.meta.url).pathname;

createServer(async (req, res) => {
  const path = req.url === '/' ? '/index.html' : req.url;
  try {
    const body = await readFile(join(root, normalize(path)));
    res.writeHead(200, {
      'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}).listen(4173, () => {
  console.log('tipsy running on http://localhost:4173');
});
