import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { randomUUID } from 'crypto';

// 環境変数を .env.local（優先）→ .env の順で読み込む。
// dotenv は既存の process.env を上書きしないため、先に読んだ .env.local が優先される。
// 各エントリポイントの「最初の import」としてこれを読み込むこと。
// cron等で別のカレントディレクトリから起動されても設定を見失わないよう、リポジトリ直下（src/ と dist/ の親）を先に読む
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
config({ path: resolve(repoRoot, '.env.local'), quiet: true });
config({ path: '.env.local', quiet: true });
config({ path: resolve(repoRoot, '.env'), quiet: true });
config({ quiet: true });

// GitHub Actions では、以後の出力の「::command::」（ワークフローコマンド）を解釈させない。
// 公開ログのジョブで、メール・添付に由来する文字列（ライブラリが直接出す警告を含む）が行頭に来ても、
// 偽のエラー注釈・add-mask・環境変数の書き換え等として実行されないようにする。再開の合図は乱数で、出力しない限り外から分からない
if (process.env.GITHUB_ACTIONS === 'true') {
  process.stdout.write(`::stop-commands::${randomUUID()}\n`);
}
