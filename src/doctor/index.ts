import '../env.js';
import { existsSync } from 'fs';
import { generateText } from '../llm/index.js';
import { fetchRecentSignals, fetchRecentStories } from '../database/index.js';
import { INBOX_DIR as LIFELOG_INBOX } from '../collectors/lifelog.js';
import { INBOX_DIR as MESSENGER_INBOX } from '../collectors/messenger.js';

// 環境診断（セットアップ確認用）
// 使い方: npm run doctor
// 新しい端末への導入時に、動作に必要な設定が揃っているかを一括チェックする。
// ❌ が1つでもあれば exit 1（セットアップ未完了）。⚠️ は任意項目の未設定。

let hasError = false;
const ok = (msg: string) => console.log(`  ✅ ${msg}`);
const warn = (msg: string) => console.log(`  ⚠️  ${msg}`);
const bad = (msg: string) => {
  hasError = true;
  console.log(`  ❌ ${msg}`);
};
const section = (title: string) => console.log(`\n■ ${title}`);

function envSet(...names: string[]): boolean {
  return names.every((n) => Boolean(process.env[n]?.trim()));
}

async function main(): Promise<void> {
  console.log('経営者クローンAI — 環境診断を開始します...');

  // 1. 実行環境
  section('実行環境');
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 20) ok(`Node.js v${process.versions.node}`);
  else bad(`Node.js v${process.versions.node} — v20 以上が必要です（https://nodejs.org からLTSを導入）`);

  if (existsSync('.env.local')) ok('.env.local あり');
  else warn('.env.local がありません — `npm run setup` で生成し、APIキーを記入してください');

  // 2. LLM（必須）
  section('LLM（生成AI）— 必須');
  const provider = (process.env.LLM_PROVIDER ?? 'anthropic').toLowerCase();
  const isVertex = process.env.GOOGLE_GENAI_USE_VERTEXAI === 'true';
  const keyOk =
    provider === 'gemini'
      ? isVertex
        ? envSet('GOOGLE_CLOUD_PROJECT')
        : envSet('GEMINI_API_KEY')
      : envSet('ANTHROPIC_API_KEY');
  if (!keyOk) {
    bad(
      provider === 'gemini'
        ? isVertex
          ? 'Vertex AI 設定が不足（GOOGLE_CLOUD_PROJECT）'
          : 'GEMINI_API_KEY が未設定（Google AI Studio → Get API key で無料発行）'
        : 'ANTHROPIC_API_KEY が未設定（LLM_PROVIDER=gemini にして Gemini 無料枠を使う手もあります）',
    );
  } else {
    ok(`プロバイダ: ${provider}${provider === 'gemini' ? (isVertex ? '（Vertex AI）' : '（AI Studio）') : ''}`);
    try {
      const answer = await generateText('診断用の疎通確認です。', [
        { role: 'user', content: '「OK」とだけ返してください。' },
      ], { maxTokens: 1000 });
      ok(`疎通OK — 応答: ${answer.trim().slice(0, 40)}`);
    } catch (err) {
      bad(`疎通に失敗しました: ${String(err).slice(0, 200)}`);
    }
  }

  // 3. Notion（本番運用に必須 / デモは不要）
  section('Notion（データベース）— 本番運用に必須');
  if (envSet('NOTION_TOKEN', 'NOTION_SIGNAL_DB_ID', 'NOTION_STORY_DB_ID')) {
    try {
      const [signals, stories] = await Promise.all([fetchRecentSignals(1), fetchRecentStories(1)]);
      ok(`接続OK — シグナルDB（${signals.length ? 'データあり' : '空'}）/ ストーリーDB（${stories.length ? 'データあり' : '空'}）`);
    } catch (err) {
      bad(
        `接続に失敗: ${String(err).slice(0, 160)}\n     → DBの Connections でインテグレーションを共有したか、IDが正しいか確認してください`,
      );
    }
  } else {
    warn('未設定 — 本番運用には必要です。お試しは DEMO_MODE=true（npm run demo:web 等）で動きます');
  }

  // 4. データソース（任意 — 未設定のソースは収集時にスキップされる）
  section('データソース（任意）');
  // 受け皿パスはコレクタ本体の定義を参照する（診断と実際の取り込み先がずれないように）
  console.log(`  ・ライフログ受け皿: ${LIFELOG_INBOX} ${existsSync(LIFELOG_INBOX) ? '（あり）' : '（未作成 — 初回収集時に用意）'}`);
  console.log(`  ・LINE受け皿:      ${MESSENGER_INBOX} ${existsSync(MESSENGER_INBOX) ? '（あり）' : '（未作成 — 初回収集時に用意）'}`);
  console.log(`  ・Slack:           ${envSet('SLACK_USER_TOKEN', 'SLACK_TARGET_USER_ID') ? '設定済み' : '未設定（スキップされます）'}`);
  console.log(`  ・Google Workspace: ${envSet('GOOGLE_SA_CLIENT_EMAIL', 'GOOGLE_SA_PRIVATE_KEY', 'GOOGLE_TARGET_EMAIL') ? '設定済み' : '未設定（スキップされます）'}`);

  // 5. プロファイル・セキュリティ
  section('プロファイル・セキュリティ');
  if (envSet('EXECUTIVE_NAME')) ok(`経営者名: ${process.env.EXECUTIVE_NAME}`);
  else warn('EXECUTIVE_NAME が未設定 — src/data/executiveProfile.ts のサンプル値の差し替えも忘れずに');
  if (envSet('WEB_ACCESS_TOKEN')) ok('WEB_ACCESS_TOKEN 設定済み（Web UIに認証あり）');
  else warn('WEB_ACCESS_TOKEN 未設定 — Web UIはローカル(127.0.0.1)でのみ使ってください');

  // まとめ
  console.log('');
  if (hasError) {
    console.log('❌ 未完了の必須項目があります。上記の ❌ を解消してから再度 npm run doctor を実行してください。');
    process.exitCode = 1;
  } else {
    console.log('✅ 診断完了。必須項目はすべてOKです。（⚠️ は任意項目・後から設定可）');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
