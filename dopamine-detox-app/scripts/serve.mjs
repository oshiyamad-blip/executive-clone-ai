// 開発用の静的サーバー。依存を足さないために自前で持つ。
//
//   npm start            → http://localhost:5173
//   npm start -- --host  → LAN 上の端末（実機の Android）からも見られるようにする
//
// 注意: Service Worker と通知は http://localhost では動くが、LAN の IP（http://192.168.x.x）
// では安全なコンテキスト扱いにならず動かない。実機で PWA を試すときは HTTPS で配信すること
// （GitHub Pages に上げるのがいちばん早い）。

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.PORT ?? 5173);
const HOST = process.argv.includes('--host') ? '0.0.0.0' : '127.0.0.1';

const TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
]);

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // ルート外への参照（../ など）を弾く
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    let filePath = join(ROOT, rel);
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    if ((await stat(filePath).catch(() => null))?.isDirectory()) {
      filePath = join(filePath, 'index.html');
    }
    const body = await readFile(filePath);
    res.writeHead(200, {
      'content-type': TYPES.get(extname(filePath)) ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
});
