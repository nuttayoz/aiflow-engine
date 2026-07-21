const { spawnSync } = require('node:child_process');
const { createReadStream, existsSync } = require('node:fs');
const { createServer } = require('node:http');
const { extname, join, normalize } = require('node:path');

const root = join(__dirname);
const output = spawnSync(
  'bun',
  [
    'build',
    join(root, 'src', 'app.ts'),
    '--outfile',
    join(root, '.dist', 'app.js'),
    '--target',
    'browser',
  ],
  { stdio: 'inherit' },
);
if (output.status !== 0) process.exit(output.status ?? 1);

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

createServer((request, response) => {
  const relative = request.url === '/' ? 'index.html' : request.url.slice(1);
  const path = normalize(join(root, relative));
  if (!path.startsWith(root) || !existsSync(path)) {
    response.writeHead(404).end('Not found');
    return;
  }
  response.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Type': contentTypes[extname(path)] ?? 'application/octet-stream',
  });
  createReadStream(path).pipe(response);
}).listen(4173, '127.0.0.1', () => {
  process.stdout.write('AiFlow Phase 2 demo: http://localhost:4173\n');
});
