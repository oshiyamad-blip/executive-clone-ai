import '../env.js';
// 本番実行前の設定の事前確認（npm run ses:preflight）。外部には一切接続しない（オフライン）。
// GitHub Actions の定時バッチで本番の直前に実行し、Secrets / Variables の渡し漏れ・貼り付け誤りを
// メール・スプレッドシート・LLMに触れる前に検出する。公開ログで実行するため、鍵・パスワード・ID・アドレス等の
// 値そのものは表示しない（件数と「形式OKか」だけ）。❌ が1つでもあれば終了コード1。⚠️ は任意項目・推奨設定。
// 接続まで確かめる診断は npm run doctor（手元での実行向け）。
import {
  settingValue,
  requireLive,
  demoModeExplicit,
  logRedact,
  llmProviderName,
  llmKeyConfigured,
  extractModel,
  matchModel,
  dbProvider,
  sheetsDbSpreadsheetId,
  sheetsDbImpersonate,
  mailProvider,
  xserverImapHost,
  xserverImapPort,
  xserverSmtpHost,
  xserverSmtpPort,
  xserverSharedUser,
  xserverSharedPass,
  xserverDraftsMailbox,
  sesTargetGmail,
  sesNotifyTo,
  ownDomains,
  allowedSenderDomains,
  allowedSenders,
  draftSigningKey,
  runDeadlineMinutes,
  properFolderId,
  properMasterSpreadsheetId,
  properImpersonate,
  properServiceAccountEnvPrefix,
  notionProjectDbId,
  notionEngineerDbId,
  notionMatchDbId,
  minGrossMarginJpy,
  maxCandidatesPerItem,
  skillMatchThreshold,
  skillMatchStrongThreshold,
  hourlyToMonthlyHours,
  matchMinLlmScore,
  matchTimingGraceDays,
  maxNegotiationRaiseMan,
  maxNegotiationCutMan,
  matchLookbackDays,
  matchPoolLimit,
  collectDays,
  maxMailsPerRun,
  healBudgetJpy,
  healMaxAttempts,
  repairEnabled,
  repairBudgetJpy,
  properMaxExtractPerRun,
  properProjectLookbackDays,
  statsDays,
} from './config.js';
import {
  isPlainEmailAddress,
  looksLikeDomain,
  looksLikeHostname,
  looksLikeGoogleId,
  looksLikeNotionId,
  invalidAddressCount,
  inspectServiceAccountJson,
} from './settingsFormat.js';

let errors = 0;
let warnings = 0;
const ok = (msg: string) => console.log(`  ✅ ${msg}`);
const warn = (msg: string) => {
  warnings += 1;
  console.log(`  ⚠️  ${msg}`);
};
const bad = (msg: string) => {
  errors += 1;
  console.log(`  ❌ ${msg}`);
};
const info = (msg: string) => console.log(`  ・${msg}`);
const section = (title: string) => console.log(`\n■ ${title}`);

function onGithubActions(): boolean {
  return settingValue('GITHUB_ACTIONS') === 'true' || settingValue('CI') === 'true';
}

// 数値の設定は各ゲッターが解釈できない値を既定値に戻して1回だけ警告する。その警告を集めて ⚠️ として出す
// （範囲の定義を config.ts の1か所に保つため、ここでは範囲を持たない）
function collectNumberWarnings(): string[] {
  const captured: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    const message = args.map(String).join(' ');
    if (message.startsWith('設定: ')) captured.push(message.slice('設定: '.length));
    else original(...args);
  };
  try {
    for (const read of [
      minGrossMarginJpy,
      maxCandidatesPerItem,
      skillMatchThreshold,
      skillMatchStrongThreshold,
      hourlyToMonthlyHours,
      matchMinLlmScore,
      matchTimingGraceDays,
      maxNegotiationRaiseMan,
      maxNegotiationCutMan,
      matchLookbackDays,
      matchPoolLimit,
      collectDays,
      maxMailsPerRun,
      healBudgetJpy,
      healMaxAttempts,
      repairBudgetJpy,
      properMaxExtractPerRun,
      properProjectLookbackDays,
      statsDays,
      runDeadlineMinutes,
      xserverImapPort,
      xserverSmtpPort,
    ]) {
      read();
    }
  } finally {
    console.warn = original;
  }
  return captured;
}

function shareTargetNote(clientEmail: string): void {
  if (!clientEmail) return;
  info(`共有先（サービスアカウントのメール）: ${logRedact() ? 'ログ秘匿のため非表示（JSON鍵の client_email）' : clientEmail}`);
}

// サービスアカウント鍵（<prefix>KEY_JSON か <prefix>CLIENT_EMAIL / PRIVATE_KEY）。
// 設定されていて使えるなら true。required=false のときは未設定を問題にしない
function checkServiceAccount(prefix: string, label: string, required: boolean): boolean {
  const json = settingValue(`${prefix}KEY_JSON`);
  const splitSet = Boolean(settingValue(`${prefix}CLIENT_EMAIL`) && settingValue(`${prefix}PRIVATE_KEY`));
  if (json) {
    const r = inspectServiceAccountJson(json);
    if (r.problems.length === 0) {
      ok(`${label}（${prefix}KEY_JSON）: JSON鍵として読め、client_email と private_key を含みます`);
      r.notes.forEach(warn);
      shareTargetNote(r.clientEmail);
      return true;
    }
    if (!splitSet) {
      bad(`${label}（${prefix}KEY_JSON）: ${r.problems.join(' / ')}`);
      return false;
    }
    warn(`${prefix}KEY_JSON を使えないため ${prefix}CLIENT_EMAIL / ${prefix}PRIVATE_KEY を使います（${r.problems.join(' / ')}）`);
  }
  if (splitSet) {
    const email = settingValue(`${prefix}CLIENT_EMAIL`);
    const key = settingValue(`${prefix}PRIVATE_KEY`);
    if (!isPlainEmailAddress(email)) {
      bad(`${prefix}CLIENT_EMAIL がメールアドレスの形式ではありません`);
      return false;
    }
    if (!key.includes('BEGIN PRIVATE KEY')) {
      bad(`${prefix}PRIVATE_KEY の形式が正しくありません（-----BEGIN PRIVATE KEY----- から始まる鍵全体が必要です）`);
      return false;
    }
    ok(`${label}（${prefix}CLIENT_EMAIL / PRIVATE_KEY）: 設定済み`);
    shareTargetNote(email);
    return true;
  }
  if (required) bad(`${label}が未設定です（${prefix}KEY_JSON に、JSON鍵ファイルの中身を丸ごと登録してください）`);
  return false;
}

function checkEmailSetting(name: string, value: string, required: boolean, purpose: string): void {
  if (!value) {
    if (required) bad(`${name} が未設定です（${purpose}）`);
    return;
  }
  if (isPlainEmailAddress(value)) ok(`${name}: 設定済み（形式OK）`);
  else bad(`${name} がメールアドレスの形式ではありません（表示名や空白を含めず、アドレスだけを入れてください）`);
}

function checkHost(name: string, value: string, required: boolean, purpose: string): void {
  if (!value) {
    (required ? bad : warn)(`${name} が未設定です（${purpose}）`);
    return;
  }
  if (looksLikeHostname(value)) ok(`${name}: 設定済み（ホスト名の形式OK）`);
  else bad(`${name} の形式が正しくありません（https:// やポート番号を付けず、svXXXX.xserver.jp のようなホスト名だけを入れてください）`);
}

function checkDomainList(name: string, domains: string[], purpose: string): void {
  if (domains.length === 0) {
    warn(`${name} が未設定です — ${purpose}`);
    return;
  }
  const invalid = domains.filter((d) => !looksLikeDomain(d)).length;
  if (invalid > 0) warn(`${name} にドメイン名として解釈できない値が${invalid}件あります（example.co.jp の形でカンマ区切り）`);
  else ok(`${name}: ${domains.length}件`);
}

function checkRuntime(): void {
  section('実行環境');
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 20) ok(`Node.js v${process.versions.node}`);
  else bad(`Node.js v${process.versions.node} — v20 以上が必要です`);
  if (settingValue('TZ') === 'Asia/Tokyo') ok('タイムゾーン: Asia/Tokyo');
  else warn('TZ が Asia/Tokyo ではありません（記録する日時は日本時間に固定しているため動作は続きます）');

  if (onGithubActions()) {
    info('GitHub Actions 上の実行として確認します（LLMの鍵が無い場合はdemoにせず停止します）');
    if (!logRedact()) bad('SES_LOG_REDACT=false です — 公開リポジトリのActionsログに氏名・アドレスが出るため true にしてください');
    else ok('ログ秘匿: 有効（氏名・メールアドレス・件名・本文はログに出ません）');
    if (!requireLive()) warn('SES_REQUIRE_LIVE=false です — LLMの鍵の渡し忘れがあると fixture のデモ結果で「成功」してしまいます');
    if (settingValue('SES_SENSITIVE_VARS_PRESENT') === 'true') {
      bad(
        '公開ログに表示される Variables に、Secrets へ移した設定（SES_OWN_DOMAINS・SES_ALLOWED_SENDER_DOMAINS・SHEETS_DB_IMPERSONATE・' +
          'PROPER_GOOGLE_IMPERSONATE・MIN_GROSS_MARGIN_*・NEGOTIATION_MAX_*）が残っています。同じ名前で Secrets に登録し、Variables からは削除してください（Variables の値は使いません）',
      );
    }
  } else if (logRedact()) {
    ok('ログ秘匿: 有効');
  } else {
    info('ログ秘匿: 無効（手元での実行なら問題ありません。GitHub Actions では自動で有効になります）');
  }
  if (demoModeExplicit()) {
    bad('DEMO_MODE=true です — 本番の実行が fixture（デモ用のメール）で動きます。デモは Run workflow の「デモ」を選んでください');
  }
}

function checkLlm(): void {
  section('LLM（生成AI）— 必須');
  const provider = llmProviderName();
  if (provider === 'anthropic') {
    const key = settingValue('ANTHROPIC_API_KEY');
    if (!key) bad('ANTHROPIC_API_KEY が未設定です（Secrets に登録してください）');
    else if (/\s/.test(key)) bad('ANTHROPIC_API_KEY に空白・改行が含まれています（キーだけを貼り付けてください）');
    else if (!key.startsWith('sk-ant-')) warn('ANTHROPIC_API_KEY の形式が想定と異なります（sk-ant- で始まるキーをそのまま貼り付けてください）');
    else ok('ANTHROPIC_API_KEY: 設定済み（形式OK）');
  } else if (provider === 'gemini') {
    if (llmKeyConfigured()) ok('Gemini の鍵（GEMINI_API_KEY または Vertex AI の GOOGLE_CLOUD_PROJECT）: 設定済み');
    else bad('LLM_PROVIDER=gemini ですが GEMINI_API_KEY（Vertex AI の場合は GOOGLE_CLOUD_PROJECT）が未設定です');
  } else {
    bad('LLM_PROVIDER の値が正しくありません（anthropic または gemini）');
  }
  info(`モデル: 抽出 ${extractModel()} / 最終判定・紹介文面 ${matchModel()}`);
}

function checkDatabase(): void {
  const provider = dbProvider();
  section(`データ保存先（DB_PROVIDER=${provider === 'sheets' || provider === 'notion' ? provider : '不正な値'}）— 必須`);
  if (provider === 'sheets') {
    if (!settingValue('SHEETS_DB_SPREADSHEET_ID')) bad('SHEETS_DB_SPREADSHEET_ID が未設定です（空のスプレッドシートを作り、そのIDかURLを登録）');
    else if (!looksLikeGoogleId(sheetsDbSpreadsheetId())) {
      bad('SHEETS_DB_SPREADSHEET_ID の形式が正しくありません（スプレッドシートのURL、またはURLの /d/ と /edit の間の文字列）');
    } else ok('SHEETS_DB_SPREADSHEET_ID: 設定済み（IDの形式OK）');
    checkServiceAccount('GOOGLE_SA_', 'サービスアカウント鍵', true);
    const impersonate = sheetsDbImpersonate();
    if (impersonate) {
      checkEmailSetting('SHEETS_DB_IMPERSONATE', impersonate, false, '');
      info('スプレッドシートはDWD（ドメイン全体の委任）でこのユーザーとして読み書きします（spreadsheets スコープの登録が必要）');
    } else {
      info('スプレッドシートはサービスアカウント自身で読み書きします（上のメールに「編集者」で共有しておく）');
    }
    return;
  }
  if (provider === 'notion') {
    if (onGithubActions()) warn('GitHub Actions の定時実行は DB_PROVIDER=sheets を前提にしています（Notionでも動きますが手順書はスプレッドシート運用です）');
    if (settingValue('NOTION_TOKEN')) ok('NOTION_TOKEN: 設定済み');
    else bad('NOTION_TOKEN が未設定です');
    for (const [name, value] of [
      ['NOTION_PROJECT_DB_ID', notionProjectDbId()],
      ['NOTION_ENGINEER_DB_ID', notionEngineerDbId()],
      ['NOTION_MATCH_DB_ID', notionMatchDbId()],
    ] as const) {
      if (!value) bad(`${name} が未設定です`);
      else if (!looksLikeNotionId(value)) bad(`${name} の形式が正しくありません（DBのURLに含まれる32桁の英数字）`);
      else ok(`${name}: 設定済み（形式OK）`);
    }
    return;
  }
  bad('DB_PROVIDER の値が正しくありません（sheets または notion）');
}

function checkMail(): void {
  const provider = mailProvider();
  section(`メール（MAIL_PROVIDER=${provider === 'xserver' || provider === 'gmail' ? provider : '不正な値'}）— 必須`);
  const notifySet = Boolean(sesNotifyTo());
  if (provider === 'xserver') {
    checkHost('XSERVER_IMAP_HOST', xserverImapHost(), true, '共有メールボックスの収集・下書き作成に必要');
    checkHost(
      'XSERVER_SMTP_HOST',
      xserverSmtpHost(),
      notifySet,
      notifySet ? 'SES_NOTIFY_TO へのサマリ送信に必要' : 'サマリメールを送る場合に必要',
    );
    if (xserverImapPort() !== 993) warn(`XSERVER_IMAP_PORT が ${xserverImapPort()} です（本システムはSSL接続のみ。Xserverは 993）`);
    const smtpPort = xserverSmtpPort();
    if (smtpPort !== 465 && smtpPort !== 587) warn(`XSERVER_SMTP_PORT が ${smtpPort} です（Xserverは 465/SSL。587/STARTTLS も可）`);
    const user = xserverSharedUser();
    if (!user) bad('XSERVER_SHARED_USER が未設定です（共有メールボックスのアドレス）');
    else if (!isPlainEmailAddress(user)) warn('XSERVER_SHARED_USER がメールアドレスの形式ではありません（Xserverのログイン名はメールアドレス全体です）');
    else ok('XSERVER_SHARED_USER: 設定済み（形式OK）');
    const pass = xserverSharedPass();
    if (!pass) bad('XSERVER_SHARED_PASS が未設定です（共有メールボックスのパスワード）');
    else if (pass !== pass.trim()) warn('XSERVER_SHARED_PASS の前後に空白・改行があります（貼り付け時に混入していないか確認）');
    else ok('XSERVER_SHARED_PASS: 設定済み');
    info(`下書きフォルダ: 「${xserverDraftsMailbox()}」（実在するかは「SESメール量の測定」ワークフローか npm run doctor で確認）`);
    return;
  }
  if (provider === 'gmail') {
    checkEmailSetting('SES_TARGET_GMAIL', sesTargetGmail(), true, 'SES専用メールボックスの実ユーザーのアドレス');
    checkServiceAccount('GOOGLE_SA_', 'サービスアカウント鍵・DWD用', true);
    info('Workspace管理コンソールのドメイン全体の委任に gmail.readonly / gmail.compose / gmail.send の登録が必要です');
    return;
  }
  bad('MAIL_PROVIDER の値が正しくありません（xserver または gmail）');
}

function checkNotifyAndDomains(): void {
  section('通知・自社ドメイン（推奨）');
  const notify = sesNotifyTo();
  if (!notify) {
    warn('SES_NOTIFY_TO が未設定です — サマリ・診断レポートが届きません（Actionsのログは秘匿されるため、詳細はメールとスプレッドシートでしか確認できません）');
  } else {
    const { total, invalid } = invalidAddressCount(notify);
    if (invalid > 0) bad(`SES_NOTIFY_TO にメールアドレスとして解釈できない値が${invalid}件あります（カンマ区切りで複数可）`);
    else ok(`SES_NOTIFY_TO: ${total}件`);
  }
  checkDomainList('SES_OWN_DOMAINS', ownDomains(), '自社から共有メールボックスに届いたメール（紹介メールのCc等）も案件・要員として取り込みます');
  if (dbProvider() === 'sheets') {
    checkSenders();
    checkDraftSigning();
  }
}

// 「担当者メール」で下書きの送信元にできるアドレス。未設定なら作らない（シートの編集者が任意の送信元で下書きを作れないように）
function checkSenders(): void {
  const addresses = allowedSenders();
  const invalid = addresses.filter((a) => !isPlainEmailAddress(a)).length;
  if (invalid > 0) bad(`SES_ALLOWED_SENDERS にメールアドレスとして解釈できない値が${invalid}件あります（カンマ区切り）`);
  else if (addresses.length > 0) ok(`SES_ALLOWED_SENDERS: ${addresses.length}件（このアドレスだけを下書きの送信元にします）`);
  if (mailProvider() === 'gmail') {
    if (addresses.length === 0) {
      bad('MAIL_PROVIDER=gmail では SES_ALLOWED_SENDERS（下書きの送信元にしてよい社員のアドレス）が必須です（DWDでその人のGmailに下書きを作るため）');
    }
    return;
  }
  if (addresses.length > 0) return;
  const explicit = allowedSenderDomains();
  if (explicit.length > 0) {
    checkDomainList('SES_ALLOWED_SENDER_DOMAINS', explicit, '');
    return;
  }
  const shared = xserverSharedUser();
  const fallback = [...ownDomains(), shared.includes('@') ? shared.slice(shared.lastIndexOf('@') + 1) : ''].filter(Boolean);
  if (fallback.length === 0) {
    bad('下書きの送信元にできるドメインがありません（SES_ALLOWED_SENDER_DOMAINS か SES_OWN_DOMAINS を登録してください。未設定のままでは担当者メールの依頼はすべてエラーになります）');
  } else {
    info('SES_ALLOWED_SENDER_DOMAINS が未設定のため、SES_OWN_DOMAINS と共有メールボックスのドメインだけを下書きの送信元として許可します');
  }
}

function checkDraftSigning(): void {
  const key = draftSigningKey();
  if (!key) {
    warn('SES_DRAFT_SIGNING_KEY が未設定です — スプレッドシートの「下書きデータ」列を書き換えられても、その内容で下書きを作ります（ランダムな32文字以上を Secrets に登録すると、書き換えを検知して作成しません）');
  } else if (key.length < 32) {
    warn('SES_DRAFT_SIGNING_KEY が短すぎます（ランダムな32文字以上を推奨）');
  } else {
    ok('SES_DRAFT_SIGNING_KEY: 設定済み（下書きデータの書き換えを検知します）');
  }
}

function checkProper(): void {
  section('プロパー（自社社員のスキルシート）— 任意');
  const folderSet = Boolean(settingValue('PROPER_SKILLSHEET_FOLDER_ID'));
  const masterSet = Boolean(settingValue('PROPER_MASTER_SPREADSHEET_ID'));
  if (!folderSet && !masterSet) {
    warn('未設定のため無効です（使う場合は PROPER_SKILLSHEET_FOLDER_ID と PROPER_MASTER_SPREADSHEET_ID を設定）');
    return;
  }
  if (!folderSet || !masterSet) {
    warn(`${folderSet ? 'PROPER_MASTER_SPREADSHEET_ID' : 'PROPER_SKILLSHEET_FOLDER_ID'} が未設定のため無効です（両方そろうと有効になります）`);
    return;
  }
  if (looksLikeGoogleId(properFolderId())) ok('PROPER_SKILLSHEET_FOLDER_ID: 設定済み（IDの形式OK）');
  else bad('PROPER_SKILLSHEET_FOLDER_ID の形式が正しくありません（フォルダのURL、またはURLの /folders/ の後ろの文字列）');
  if (looksLikeGoogleId(properMasterSpreadsheetId())) ok('PROPER_MASTER_SPREADSHEET_ID: 設定済み（IDの形式OK）');
  else bad('PROPER_MASTER_SPREADSHEET_ID の形式が正しくありません（スプレッドシートのURL、またはURLの /d/ と /edit の間の文字列）');

  const prefix = properServiceAccountEnvPrefix();
  const dedicated = checkServiceAccount(prefix, 'プロパー用サービスアカウント鍵', false);
  if (!dedicated && !settingValue(`${prefix}KEY_JSON`)) {
    info('メインのサービスアカウントで接続します（フォルダを「閲覧者」、管理表を「編集者」で同じメールに共有）');
  }
  const impersonate = properImpersonate();
  if (impersonate) {
    checkEmailSetting('PROPER_GOOGLE_IMPERSONATE', impersonate, false, '');
    if (!dedicated) {
      bad(
        'PROPER_GOOGLE_IMPERSONATE はプロパー専用のサービスアカウント（PROPER_GOOGLE_SA_KEY_JSON。そのテナントが発行したもの）と組み合わせてください' +
          '（メインの鍵で別テナントをなりすますと、その鍵で別テナントの全ユーザーのDriveを読めてしまうため使いません）',
      );
    } else {
      info('フォルダ・管理表はDWDでこのユーザーとして読みます（そのテナントで drive.readonly と spreadsheets の委任が必要）');
    }
  }
  if (dbProvider() !== 'sheets') warn('候補の保存先「プロパー候補」タブは DB_PROVIDER=sheets の案件スプレッドシートです（notion では保存されません）');
}

function checkNumbers(numberWarnings: string[]): void {
  section('数値・切替の設定');
  info(
    `粗利下限 ${minGrossMarginJpy().toLocaleString('ja-JP')}円/月・スキル一致率 ${skillMatchThreshold()}（強マッチ ${skillMatchStrongThreshold()}）・` +
      `収集 直近${collectDays()}日（1回${maxMailsPerRun()}件まで）`,
  );
  if (numberWarnings.length === 0) ok('数値の設定はすべて解釈できました（未設定の項目は既定値）');
  for (const w of numberWarnings) warn(w);
  if (skillMatchThreshold() > skillMatchStrongThreshold()) {
    warn('SKILL_MATCH_THRESHOLD が SKILL_MATCH_STRONG_THRESHOLD より大きいため「参考提案」の帯がなくなります');
  }
  if (collectDays() < 4) {
    warn('SES_COLLECT_DAYS が4日未満です — 金曜14:00〜月曜10:00（約3日）をまたぐ月曜の回で取りこぼしたり、失敗したメールを再試行できずに隔離したりする恐れがあります（既定 7）');
  }
  info(`1回の実行で新しい抽出・判定を始める期限: 開始から${runDeadlineMinutes()}分（残りは次回の実行で続きから処理します。ワークフローの制限時間より短くしてください）`);
  if (repairEnabled()) info('修正パッチ案の自動生成: 有効（隔離が増えた回にソースコードの一部をAPIへ送ります）');
}

function main(): void {
  console.log('SESマッチング — 本番設定の事前確認（オフライン。外部には接続せず、設定値そのものは表示しません）');
  // 数値の警告は各ゲッターの初回呼び出しでしか出ないため、他の確認より先に集める
  const numberWarnings = collectNumberWarnings();

  checkRuntime();
  checkLlm();
  checkDatabase();
  checkMail();
  checkNotifyAndDomains();
  checkProper();
  checkNumbers(numberWarnings);

  console.log('');
  if (errors > 0) {
    console.log(
      `❌ 必須の設定に不足・誤りが${errors}件あります。GitHub の Settings → Secrets and variables → Actions で名前と値を確認してください（⚠️ ${warnings}件）`,
    );
    process.exitCode = 1;
  } else {
    console.log(`✅ 事前確認OK（⚠️ ${warnings}件は任意・推奨の項目です）。接続の確認は初回実行のサマリか npm run doctor で行います`);
  }
}

main();
