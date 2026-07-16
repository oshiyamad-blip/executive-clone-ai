import { config } from 'dotenv';

// 環境変数を .env.local（優先）→ .env の順で読み込む。
// dotenv は既存の process.env を上書きしないため、先に読んだ .env.local が優先される。
// 各エントリポイントの「最初の import」としてこれを読み込むこと。
config({ path: '.env.local' });
config();
