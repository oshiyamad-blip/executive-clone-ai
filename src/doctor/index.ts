import '../env.js';
import { existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { EXECUTIVE_PROFILE_SOURCE } from '../data/executiveProfile.js';
import { generateText } from '../llm/index.js';
import { google } from 'googleapis';
import { fetchRecentSignals, fetchRecentStories } from '../database/index.js';
import {
  logRedact,
  isDemo,
  demoModeExplicit,
  liveConfigError,
  requireLive,
  mailProvider as sesMailProvider,
  dbProvider as sesDbProvider,
  sheetsDbSpreadsheetId,
  sheetsDbImpersonate,
  ownDomains,
  collectDays,
  properMasterSpreadsheetId,
  extractModel,
  matchModel,
  llmProviderName,
  draftSigningKey,
  DRAFT_SIGNING_KEY_MIN_CHARS,
} from '../ses/config.js';
import { retirementNotice } from '../llm/modelLifecycle.js';
import { sesMainConfigured, sesMainAccountEmail, sheetsDbAuth, sheetsDbAuthProblem, gmailAuthProblem, unneededDelegationProblems } from '../ses/googleCreds.js';
import { inspectServiceAccountJson } from '../ses/settingsFormat.js';
import { SafeLogError } from '../ses/redact.js';
import { listSkillSheetFiles } from '../ses/proper/drive.js';
import { properMasterAuth, properAccessHint, properUsesDedicatedAccount } from '../ses/proper/auth.js';
import { probeImap, probeSmtp } from '../ses/mail/xserver.js';
import { probeGmail } from '../ses/mail/gmail.js';
import { WEB_TOKEN_MIN_CHARS } from '../web/httpSecurity.js';

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

// サービスアカウント鍵は JSON丸ごと（GOOGLE_SA_KEY_JSON）か、client_email/private_key の個別指定のどちらでもよい（経営者クローンの収集用）
function serviceAccountSet(): boolean {
  return envSet('GOOGLE_SA_KEY_JSON') || envSet('GOOGLE_SA_CLIENT_EMAIL', 'GOOGLE_SA_PRIVATE_KEY');
}

// SES のスプレッドシート・スキルシートのフォルダを共有する相手（メインのサービスアカウントのメール）。公開ログでは表示しない
function serviceAccountEmail(): string {
  const email = sesMainAccountEmail();
  if (!email) return '';
  return logRedact() ? 'ログ秘匿のため非表示（JSON鍵の client_email）' : email;
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
      ], { maxTokens: 2000, strict: true }); // 空応答・打ち切りを「疎通OK」と扱わない
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
  const lifelogDir = process.env.LIFELOG_INBOX_DIR ?? './lifelog-inbox';
  const messengerDir = process.env.MESSENGER_INBOX_DIR ?? './messenger-inbox';
  console.log(`  ・ライフログ受け皿: ${lifelogDir} ${existsSync(lifelogDir) ? '（あり）' : '（未作成 — 初回収集時に用意）'}`);
  console.log(`  ・LINE受け皿:      ${messengerDir} ${existsSync(messengerDir) ? '（あり）' : '（未作成 — 初回収集時に用意）'}`);
  console.log(`  ・Slack:           ${envSet('SLACK_USER_TOKEN', 'SLACK_TARGET_USER_ID') ? '設定済み' : '未設定（スキップされます）'}`);
  console.log(`  ・Google Workspace: ${serviceAccountSet() && envSet('GOOGLE_TARGET_EMAIL') ? '設定済み' : '未設定（スキップされます）'}`);

  // 5. SESマッチング（任意 — 使う場合のみ。関連の設定が1つでもあれば「使う」とみなし、不足は ❌）
  section('SESマッチング（任意）');
  const sesInUse = ['MAIL_PROVIDER', 'DB_PROVIDER', 'XSERVER_IMAP_HOST', 'SES_TARGET_GMAIL', 'SHEETS_DB_SPREADSHEET_ID', 'SES_NOTIFY_TO'].some(
    (n) => envSet(n),
  );
  const need = (msg: string) => (sesInUse ? bad(msg) : warn(msg));
  console.log('  ・接続なしで設定の渡し漏れ・書式だけを確かめる場合は npm run ses:preflight（GitHub Actions では本番の直前に自動実行）');
  for (const name of ['SES_GOOGLE_SA_KEY_JSON', 'GOOGLE_SA_KEY_JSON', 'SHEETS_DB_SA_KEY_JSON', 'SES_GMAIL_SA_KEY_JSON', 'PROPER_GOOGLE_SA_KEY_JSON']) {
    const json = process.env[name]?.trim();
    if (!json) continue;
    const problems = inspectServiceAccountJson(json).problems;
    if (problems.length > 0) bad(`${name}: ${problems.join(' / ')}`);
  }
  const saEmail = serviceAccountEmail();
  if (saEmail && sesInUse) console.log(`  ・サービスアカウント: ${saEmail} — 案件スプレッドシート・「プロパー管理」・スキルシートのフォルダをこのアドレスに共有します`);
  // バッチが実際に使う判定（isDemo）で実行モードを示す。本番のつもりで demo（fixture）が動く状態を見逃さない
  const liveError = liveConfigError();
  if (liveError) bad(`実行モード: 停止（${liveError}）`);
  else if (isDemo()) {
    const why = demoModeExplicit() ? 'DEMO_MODE=true' : 'LLM_PROVIDER に応じたLLMの鍵が未設定';
    if (sesInUse || requireLive()) bad(`実行モード: DEMO（${why}）— npm run ses は実メールを収集せず fixture で動きます`);
    else console.log(`  ・実行モード:      DEMO（${why}）`);
  } else ok('実行モード: 本番（npm run ses は実メールを収集します）');

  if (llmProviderName() === 'anthropic') {
    console.log(`  ・モデル:          抽出 ${extractModel()} / 最終判定・紹介文面 ${matchModel()}`);
    const retire = retirementNotice(extractModel());
    if (retire) {
      (retire.soon ? warn : (m: string) => console.log(`  ・${m}`))(
        `抽出モデル ${extractModel()} は ${retire.notBefore} より後に退役予定（公表）です。退役後は判定用モデルで代替して費用が増えます。` +
          '後継のモデルに切り替えるときは ANTHROPIC_MODEL_EXTRACT を変更してください',
      );
    }
  }
  const mailProvider = sesMailProvider();
  console.log(`  ・メールプロバイダ: ${mailProvider}（収集期間 ${collectDays()}日）`);
  if (mailProvider === 'gmail') {
    if (!envSet('SES_TARGET_GMAIL') || gmailAuthProblem()) {
      need(`Gmail設定が不足（SES_TARGET_GMAIL=SES専用メールボックスの実ユーザー / ${gmailAuthProblem() ?? 'SES_GMAIL_SA_KEY_JSON'}）`);
    } else {
      const problem = await probeGmail();
      if (problem) bad(`Gmail: ${problem}`);
      else ok('Gmail: SES専用メールボックスとして収集・送信のトークンを取得できました');
    }
  } else {
    if (!envSet('XSERVER_IMAP_HOST', 'XSERVER_SHARED_USER', 'XSERVER_SHARED_PASS')) {
      need('Xserver設定が不足（XSERVER_IMAP_HOST/SHARED_USER/SHARED_PASS）');
    } else {
      const imap = await probeImap();
      if (imap) bad(`Xserver IMAP: ${imap}`);
      else ok('Xserver IMAP: ログインと下書きフォルダを確認しました');
    }
    if (!envSet('XSERVER_SMTP_HOST')) {
      (envSet('SES_NOTIFY_TO') ? bad : warn)('XSERVER_SMTP_HOST 未設定 — サマリメールを送信できません');
    } else if (envSet('XSERVER_SHARED_USER', 'XSERVER_SHARED_PASS')) {
      const smtp = await probeSmtp();
      if (smtp) bad(`Xserver SMTP: ${smtp}`);
      else ok('Xserver SMTP: 接続と認証を確認しました');
    }
  }
  if (ownDomains().length === 0) {
    warn('SES_OWN_DOMAINS 未設定 — 自社ドメインから共有メーリスに届いた紹介メール等も案件・要員として取り込みます（自社ドメインの設定を推奨）');
  }
  const dbProvider = sesDbProvider();
  if (dbProvider === 'sheets') {
    if (!envSet('SHEETS_DB_SPREADSHEET_ID') || !sesMainConfigured()) {
      need('SheetsDB設定が不足（SHEETS_DB_SPREADSHEET_ID / SES_GOOGLE_SA_KEY_JSON（または GOOGLE_SA_KEY_JSON）等）');
    } else if (sheetsDbAuthProblem()) {
      bad(`データ保存先: sheets — ${sheetsDbAuthProblem()}`);
    } else {
      try {
        const auth = sheetsDbAuth(['https://www.googleapis.com/auth/spreadsheets']);
        await google.sheets({ version: 'v4', auth: auth! }).spreadsheets.get({
          spreadsheetId: sheetsDbSpreadsheetId(),
          fields: 'properties.title',
        });
        ok('データ保存先: sheets（スプレッドシートに接続できました）');
      } catch {
        bad(
          sheetsDbImpersonate()
            ? 'データ保存先: sheets — スプレッドシートを開けません（ID、SHEETS_DB_IMPERSONATE のユーザーの編集権限、SHEETS_DB_SA_KEY_JSON のクライアントIDへの spreadsheets の委任を確認）'
            : 'データ保存先: sheets — スプレッドシートを開けません（IDと、サービスアカウントのメールへの「編集者」共有を確認。' +
                '組織外への共有が禁止されている場合は、管理コンソールで許可するか SHEETS_DB_IMPERSONATE を使います）',
        );
      }
    }
    if (!envSet('SES_ALLOWED_SENDER_DOMAINS')) {
      warn('SES_ALLOWED_SENDER_DOMAINS 未設定 — 「担当者メール」列で任意の送信元の下書きを作れます（自社ドメインの設定を推奨）');
    }
    if (draftSigningKey().length < DRAFT_SIGNING_KEY_MIN_CHARS) {
      warn(`SES_DRAFT_SIGNING_KEY が未設定か${DRAFT_SIGNING_KEY_MIN_CHARS}文字未満 — 「担当者メール」の依頼はすべてエラーにして下書きを作りません（ランダムな${DRAFT_SIGNING_KEY_MIN_CHARS}文字以上を設定）`);
    }
  } else {
    const dbs = envSet('NOTION_TOKEN', 'NOTION_PROJECT_DB_ID', 'NOTION_ENGINEER_DB_ID', 'NOTION_MATCH_DB_ID');
    if (dbs) console.log('  ・データ保存先:    notion（案件/要員/マッチDB 設定済み）');
    else need('データ保存先: notion のDB設定が不足（NOTION_TOKEN / NOTION_PROJECT_DB_ID / NOTION_ENGINEER_DB_ID / NOTION_MATCH_DB_ID）');
  }
  // 鍵に使わないスコープのドメイン全体の委任が付いていないか（トークンを要求して確かめる。バッチも同じ確認で止める）
  if (sesInUse) {
    const delegation = await unneededDelegationProblems();
    if (delegation.length === 0) ok('ドメイン全体の委任: 使わないスコープ（Gmail・ドライブ等）のトークンは発行されませんでした（確かめられた範囲）');
    for (const p of delegation) bad(p);
  }
  // プロパー（自社社員のスキルシート）連携。既定はメインのサービスアカウントで読む（同じWorkspace内で共有）
  if (envSet('PROPER_SKILLSHEET_FOLDER_ID', 'PROPER_MASTER_SPREADSHEET_ID')) {
    const dedicated = properUsesDedicatedAccount();
    const account = dedicated ? 'プロパー用SA（PROPER_GOOGLE_SA_*）' : 'メインのSA';
    console.log(
      `  ・プロパー候補:    有効（${account}${envSet('PROPER_GOOGLE_IMPERSONATE') ? '・なりすましあり' : ''}。フォルダと「プロパー管理」をそのアカウントに共有してください）`,
    );
    if (!dedicated && !sesMainConfigured()) warn('プロパー候補: Google認証（SES_GOOGLE_SA_KEY_JSON / GOOGLE_SA_KEY_JSON 等）が未設定のためスキップされます');
    else {
      // 読み取りだけの疎通確認（ファイル名・氏名は表示しない）
      try {
        const files = await listSkillSheetFiles();
        ok(`プロパー候補: スキルシートのフォルダを読めました（ファイル${files.length}件）`);
      } catch (err) {
        bad(err instanceof SafeLogError ? err.message : `プロパー: スキルシートのフォルダを読めません（${properAccessHint()}）`);
      }
      try {
        const auth = properMasterAuth(['https://www.googleapis.com/auth/spreadsheets']);
        await google.sheets({ version: 'v4', auth: auth! }).spreadsheets.get({
          spreadsheetId: properMasterSpreadsheetId(),
          fields: 'properties.title',
        });
        ok('プロパー候補: 管理表（「プロパー管理」を置くスプレッドシート）を開けました');
      } catch {
        bad(`プロパー候補: 管理表のスプレッドシートを開けません（IDと「編集者」での共有を確認。${properAccessHint()}）`);
      }
    }
    if (dbProvider !== 'sheets') warn('プロパー候補: 候補の保存先「プロパー候補」タブは DB_PROVIDER=sheets の案件スプレッドシートです');
  } else {
    console.log('  ・プロパー候補:    無効（PROPER_SKILLSHEET_FOLDER_ID / PROPER_MASTER_SPREADSHEET_ID 未設定）');
  }
  // 公開CIのログに宛先アドレスを出さない
  const notifyTo = process.env.SES_NOTIFY_TO?.trim();
  console.log(`  ・通知先:          ${notifyTo ? (logRedact() ? '設定済み' : notifyTo) : '未設定（サマリはコンソールのみ）'}`);
  const healOn = (process.env.SES_HEAL_ENABLED ?? 'true') !== 'false';
  console.log(
    `  ・自己修復:        ${healOn ? `有効（予算 ${process.env.SES_HEAL_BUDGET_JPY ?? '50'}円/バッチ・${process.env.SES_HEAL_MAX_ATTEMPTS ?? '3'}回失敗で隔離）` : '無効'}`,
  );
  try {
    const { quarantineCount } = await import('../ses/heal/quarantine.js');
    const qc = await quarantineCount();
    if (qc > 0) warn(`隔離中のメールが${qc}件あります — npm run ses:repair で原因分析・修正パッチ案を生成できます`);
    else ok('隔離中のメールなし');
  } catch {
    /* 参照失敗は診断継続 */
  }

  // 6. プロファイル・セキュリティ
  section('プロファイル・セキュリティ');
  if (envSet('EXECUTIVE_NAME')) ok(`経営者名: ${logRedact() ? '設定済み' : process.env.EXECUTIVE_NAME}`);
  else warn('EXECUTIVE_NAME が未設定です');
  checkExecutiveProfilePlacement();
  for (const name of ['WEB_ACCESS_TOKEN', 'SES_WEB_ACCESS_TOKEN']) {
    const v = process.env[name]?.trim() ?? '';
    if (!v) warn(`${name} 未設定 — そのUIはこのPCのブラウザから直接（プロキシを通さず）だけ使えます`);
    else if (v.length < WEB_TOKEN_MIN_CHARS) warn(`${name} が${WEB_TOKEN_MIN_CHARS}文字未満です（UIは起動を中止します）`);
    else ok(`${name} 設定済み（Web UIに認証あり）`);
  }
  if (envSet('WEB_ACCESS_TOKEN') && process.env.WEB_ACCESS_TOKEN?.trim() === process.env.SES_WEB_ACCESS_TOKEN?.trim()) {
    warn('WEB_ACCESS_TOKEN と SES_WEB_ACCESS_TOKEN が同じ値です（UIは起動を中止します。別の値にしてください）');
  }

  // まとめ
  console.log('');
  if (hasError) {
    console.log('❌ 未完了の必須項目があります。上記の ❌ を解消してから再度 npm run doctor を実行してください。');
    console.log('   GitHub Actions での定時実行の設定は docs/ses-deploy-github-actions.md を参照してください。');
    process.exitCode = 1;
  } else {
    console.log('✅ 診断完了。必須項目はすべてOKです。（⚠️ は任意項目・後から設定可）');
  }
}

// 経営者の実際の方針（権限委譲の上限・採用基準等）を、公開リポジトリで管理するソースファイルに書いていないか
function checkExecutiveProfilePlacement(): void {
  const source = EXECUTIVE_PROFILE_SOURCE;
  if (source === 'sample') warn('経営者プロファイルはサンプル値です — 実際の内容は data/executive-profile.json（コミットされません）か EXECUTIVE_PROFILE_JSON に置いてください');
  else ok(`経営者プロファイル: ${source === 'env' ? 'EXECUTIVE_PROFILE_JSON' : 'data/executive-profile.json'} から読み込み`);
  try {
    const changed = execFileSync('git', ['status', '--porcelain', '--', 'src/data/'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (changed) {
      warn(
        'src/data/ のサンプルのプロファイルが書き換えられています — 公開リポジトリにコミットすると経営者の方針が誰でも読めます。' +
          '内容を data/executive-profile.json に移し、git checkout -- src/data/ で元に戻してください',
      );
    }
  } catch {
    /* git が無い環境では確かめない */
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
