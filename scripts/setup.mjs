import { copyFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const src = join(root, '.env.example');
const dest = join(root, '.env.local');

if (existsSync(dest)) {
  console.log('.env.local は既に存在します。スキップします。');
} else {
  copyFileSync(src, dest);
  console.log('.env.local を作成しました。各APIキーを設定してください。');
}
