import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

// 環境変数を .env.local（優先）→ .env の順で読み込む。
// dotenv は既存の process.env を上書きしないため、先に読んだ .env.local が優先される。
// 各エントリポイントの「最初の import」としてこれを読み込むこと。
// cron等で別のカレントディレクトリから起動されても設定を見失わないよう、リポジトリ直下（src/ と dist/ の親）を先に読む
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
config({ path: resolve(repoRoot, '.env.local'), quiet: true });
config({ path: '.env.local', quiet: true });
config({ path: resolve(repoRoot, '.env'), quiet: true });
config({ quiet: true });
