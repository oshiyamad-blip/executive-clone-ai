// 自己修復レイヤーと本番実行基盤のオフライン自己検証（npm run ses:heal:check）。外部API呼び出しゼロ。
// 円換算・予算メーター・隔離ラウンドトリップ・エラー分類・PIIマスク・異常終了判定・
// ログ秘匿・SheetsDBのA1表記/ヘッダー移行判定・SA鍵JSONの解釈・担当者メールによる下書き依頼の判定・
// プロパー（スキルシート）管理表の行の組み立てと提案文面、
// 設定値の解釈・実行モード判定・自己メール除外・抽出値の検証・添付の形式判定・突合範囲・Web UIの要求拒否、
// 勤務地の正規化・突合ルール（勤務地不明・単金下限・候補上限・交渉額の丸め・必須スキル空）・名寄せ・返信宛先・紹介文面の開示検査、
// 事前確認（preflight）の書式検査・メール量の測定の集計（集計値だけを表示すること）を検証する。
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { utils as xlsxUtils, write as writeXlsx } from 'xlsx';
import { usageCostJpy, jpyPerUsd } from '../../llm/pricing.js';
import { LlmOutputError, isTruncationError } from '../../llm/errors.js';
import { isRetryableLlmError, healLlmCall, type HealAttempt } from './retry.js';
import { parseNumberSetting, decideRunMode, setDemoOverride } from '../config.js';
import { ownMailReason, type OwnMailPolicy } from '../mail/ownMail.js';
import { sourceNumbers, verifiedRate, validIsoDate, inspectPdf } from '../extract.js';
import { spreadsheetKind, spreadsheetBufferToText } from '../parse.js';
import { primarySelect, matchIdOf } from '../match.js';
import { normalizePrefecture, isFullRemoteLocation } from '../prefecture.js';
import { evaluateOwnMatch } from '../ownMatch.js';
import { dedupeProjects, dedupeEngineers } from '../store.js';
import { planReplyAddresses, removeAddress, disclosureIssues } from '../draft.js';
import { equivalenceKey } from '../skillEquiv.js';
import { sanitizeListItem, joinList, splitList } from '../../database/mapping.js';
import { rejectReason } from '../../web/httpSecurity.js';
import type { IncomingMessage } from 'http';
import { maskPii } from '../pii.js';
import {
  senderDomainOnly,
  isLastChance,
  recordFailure,
  recordSuccess,
  listQuarantined,
  capQuarantine,
  QUARANTINE_MAX_ENTRIES,
  type QuarantineEntry,
} from './quarantine.js';
import { resetHealEvents, recordStat, getStats, recordHealEvent, recordFatal, hasFatal } from './events.js';
import { formatErr, SafeLogError } from '../redact.js';
import { columnLetter, quoteTab, planHeaderMigration, googleTransientKind } from '../../database/sheetBook.js';
import { draftRequestTabs, parseReceivedAt, properEngineerIdOf, properEngineerIdOfCandidate } from '../../database/sheets.js';
import {
  mergeDraftColumns,
  parseDraftData,
  isDraftStateActionable,
  verifyDraftData,
  replyMetaJson,
  parseReplyMeta,
  verifyReplyMeta,
  DRAFT_STATE,
} from '../../database/mapping.js';
import { buildReplyMime } from '../mail/mime.js';
import { isInfraError, itemIdOf } from '../extract.js';
import { withoutResentProjects, reconcileReextractedIds } from '../store.js';
import { orderForRun, pickForRun, followingRunAt, callLimits, startRunClock, stopRunClock, pastExtractDeadline } from '../schedule.js';
import { sanitizeInitials } from '../proper/extractSkillSheet.js';
import { fileRef } from '../proper/master.js';
import { parseServiceAccountJson } from '../../collectors/googleAuth.js';
import {
  normalizeSenderEmail,
  isValidSenderEmail,
  senderDomainAllowed,
  senderRejection,
  jstStamp,
  planDraftRequest,
  type SenderPolicy,
} from '../pendingDrafts.js';
import {
  parseManYen,
  parseAvailableFrom,
  planMasterCells,
  failureOutcome,
  rowToProperEngineer,
  PROPER_MASTER_COLUMNS,
} from '../proper/master.js';
import { skillSheetFormat, type SkillSheetFile } from '../proper/drive.js';
import { buildProperProposalBody, buildProperProposalDraft, MISSING_INITIALS_PLACEHOLDER } from '../proper/proposal.js';
import { properSummaryLines, type ProperRunResult } from '../proper/index.js';
import {
  inspectServiceAccountJson,
  looksLikeHostname,
  looksLikeGoogleId,
  looksLikeDomain,
  invalidAddressCount,
} from '../settingsFormat.js';
import { nextRunAt, aggregateMailStats, formatMailStats } from '../mailStatsReport.js';
import { attachmentKind } from '../../collectors/email.js';
import type {
  SesRawMail,
  DraftRef,
  Project,
  Engineer,
  ProperEngineer,
  ProperCandidate,
  OwnEngineer,
  MatchResult,
} from '../../types/index.js';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failures += 1;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function near(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) < eps;
}

function fakeMail(id: string): SesRawMail {
  return {
    id,
    from: 'test@example.jp',
    to: 'sales@example.jp',
    cc: '',
    subject: 'テスト 090-1234-5678',
    body: '',
    messageIdHeader: '',
    references: '',
    receivedAt: new Date(),
    attachments: [],
    sheetLinks: [],
  };
}

async function main(): Promise<void> {
  console.log('=== SES自己修復レイヤー 自己検証 ===');

  // 1. 円換算（Haiku: $1/$5 per MTok）
  const rate = jpyPerUsd();
  const haikuCost = usageCostJpy({ model: 'claude-haiku-4-5', inputTokens: 10000, outputTokens: 2000 });
  check(
    '円換算: Haiku 10K入力+2K出力',
    near(haikuCost, ((10000 * 1 + 2000 * 5) / 1_000_000) * rate),
    `got ${haikuCost}`,
  );
  const sonnetCost = usageCostJpy({ model: 'claude-sonnet-5', inputTokens: 1_000_000, outputTokens: 0 });
  check('円換算: Sonnet 5 1MTok入力 = 2USD相当', near(sonnetCost, 2 * rate), `got ${sonnetCost}`);

  // 2. エラー分類（400/401/403/404は再試行しない、429/529/その他は再試行）
  check('分類: 400は再試行しない', !isRetryableLlmError({ status: 400 }));
  check('分類: 401は再試行しない', !isRetryableLlmError({ status: 401 }));
  check('分類: 429は再試行する', isRetryableLlmError({ status: 429 }));
  check('分類: 529は再試行する', isRetryableLlmError({ status: 529 }));
  check('分類: ネットワーク例外は再試行する', isRetryableLlmError(new Error('ECONNRESET')));

  // 3. PIIマスク
  const masked = maskPii('連絡先: taro.suzuki+ses@example.co.jp / 090-1234-5678');
  check('PIIマスク: メールアドレス', !masked.includes('@example.co.jp') && masked.includes('<メールアドレス>'));
  check('PIIマスク: 電話番号', !masked.includes('090-1234-5678') && masked.includes('<電話番号>'));

  // 4. 隔離ラウンドトリップ（SES_HEAL_DATA_DIR は呼び出し側でscratchに向ける）
  const mail = fakeMail(`selftest_${process.pid}`);
  await recordFailure(mail, new Error('test1'));
  await recordFailure(mail, new Error('test2'));
  const third = await recordFailure(mail, new Error('test3 to quarantine taro@example.jp'));
  check('隔離: 3回目の失敗で隔離される（既定 SES_HEAL_MAX_ATTEMPTS=3）', third.quarantined && third.attempts === 3);
  const q = (await listQuarantined()).find((e) => e.mailId === mail.id);
  check('隔離: エラー文中のメールアドレスがマスクされる', Boolean(q) && !q!.lastError.includes('taro@example.jp'));
  check('隔離: 件名の電話番号がマスクされる', Boolean(q) && !q!.subject.includes('090-1234-5678'));
  await recordSuccess(mail.id);
  check('隔離: 成功で履歴が消える', !(await listQuarantined()).some((e) => e.mailId === mail.id));

  // 5. 過半数失敗ガード（countTowardQuarantine=false ならカウントが増えない）
  const mail2 = fakeMail(`selftest2_${process.pid}`);
  const r = await recordFailure(mail2, new Error('mass'), { countTowardQuarantine: false });
  check('過半数失敗ガード: カウント保留', r.attempts === 0 && !r.quarantined);
  await recordSuccess(mail2.id);

  // 6. 統計カウンタ
  resetHealEvents();
  recordStat('collected', 5);
  recordStat('extractFailures', 2);
  check('統計: 加算が反映される', getStats().collected === 5 && getStats().extractFailures === 2);

  // 7. 異常終了判定（warnでは立たず、critical・recordFatalで立つ。resetで消える）
  resetHealEvents();
  recordHealEvent('warn', 'selftest warn');
  check('異常終了: warnでは立たない', !hasFatal());
  recordHealEvent('critical', 'selftest critical');
  check('異常終了: criticalで立つ', hasFatal());
  resetHealEvents();
  recordFatal('selftest fatal');
  const fatalRaised = hasFatal();
  resetHealEvents();
  check('異常終了: recordFatalで立ち、resetで消える', fatalRaised && !hasFatal());

  // 8. ログ秘匿（秘匿時はエラー本文を出さず種別・ステータスのみ。固定文言のエラーはそのまま）
  const apiErr = Object.assign(new Error('本文 山田太郎 taro@example.jp'), { status: 403 });
  const redacted = formatErr(apiErr, true);
  check('ログ秘匿: 生エラー文を出さない', !redacted.includes('山田') && !redacted.includes('@') && redacted.includes('403'));
  check('ログ秘匿: 非秘匿時は全文', formatErr(apiErr, false).includes('山田太郎'));
  check('ログ秘匿: SafeLogErrorは秘匿時も文言を出す', formatErr(new SafeLogError('固定文言'), true) === '固定文言');

  // 9. SheetsDB: A1表記・ヘッダー移行判定
  check('A1列文字: 0→A / 25→Z / 26→AA / 701→ZZ', [0, 25, 26, 701].map(columnLetter).join(',') === 'A,Z,AA,ZZ');
  check('タブ名の引用', quoteTab("_状態") === "'_状態'" && quoteTab("a'b") === "'a''b'");
  const def = ['ID', '名前', '日時'];
  check('ヘッダー: 一致はok', planHeaderMigration(['ID', '名前', '日時'], def).kind === 'ok');
  check('ヘッダー: 人が末尾に足した列はok', planHeaderMigration(['ID', '名前', '日時', 'メモ'], def).kind === 'ok');
  const appendPlan = planHeaderMigration(['ID'], def);
  check(
    'ヘッダー: 先頭部分なら不足列を末尾に追記',
    appendPlan.kind === 'append' && appendPlan.fromIndex === 1 && appendPlan.cells.join(',') === '名前,日時',
  );
  check('ヘッダー: 空タブは全列を追記', planHeaderMigration([], def).kind === 'append');
  const conflict = planHeaderMigration(['ID', '日時'], def);
  check('ヘッダー: 途中の列の見出しが無ければ上書きしない', conflict.kind === 'conflict' && conflict.index === 1);
  const moved = planHeaderMigration(['名前', 'メモ', 'ID', '日時'], def);
  check(
    'ヘッダー: 並べ替え・途中のメモ列は見出しの名前で対応付ける',
    moved.kind === 'ok' && moved.defToLive.join(',') === '2,0,3',
  );
  const grown = planHeaderMigration(['ID', '名前', 'メモ'], def);
  check(
    'ヘッダー: 人の列が右端にあっても、増えた定義の列はその後ろに追記する',
    grown.kind === 'append' && grown.fromIndex === 3 && grown.cells.join(',') === '日時' && grown.defToLive.join(',') === '0,1,3',
  );
  const dup = planHeaderMigration(['ID', '名前', '名前', '日時'], def);
  check('ヘッダー: 同じ見出しが2つあれば上書きしない', dup.kind === 'conflict' && dup.reason === 'duplicate');
  check(
    'Google API: 429・Driveの403レート制限は再送可、5xx・通信断は要確認、権限不足は再試行しない',
    googleTransientKind({ response: { status: 429 } }) === 'rate' &&
      googleTransientKind({ response: { status: 403, data: { error: { errors: [{ reason: 'userRateLimitExceeded' }] } } } }) === 'rate' &&
      googleTransientKind({ response: { status: 503 } }) === 'ambiguous' &&
      googleTransientKind({ code: 'ETIMEDOUT' }) === 'ambiguous' &&
      googleTransientKind({ response: { status: 403, data: { error: { errors: [{ reason: 'forbidden' }] } } } }) === null,
  );

  // 10. 隔離リストの切り詰め（件数上限・1セル文字数上限）
  const many: QuarantineEntry[] = Array.from({ length: QUARANTINE_MAX_ENTRIES + 50 }, (_, i) => ({
    mailId: `m${i}`,
    subject: 'x'.repeat(120),
    from: 'y'.repeat(80),
    attempts: 1,
    lastError: 'z'.repeat(300),
    firstFailedAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
    lastFailedAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
    quarantinedAt: null,
  }));
  const capped = capQuarantine(many);
  check(
    '隔離リスト: 件数・文字数の上限内に収まり、新しいものが残る',
    capped.length <= QUARANTINE_MAX_ENTRIES && JSON.stringify(capped).length <= 45_000 && capped[0].mailId === `m${many.length - 1}`,
    `len=${capped.length}`,
  );

  // 11. サービスアカウント鍵JSON（GOOGLE_SA_KEY_JSON）の解釈
  const sa = parseServiceAccountJson(JSON.stringify({ client_email: 'sa@p.iam.gserviceaccount.com', private_key: 'A\\nB' }));
  check('SA鍵JSON: client_email/private_keyを取り出し、\\n を改行に戻す', sa?.clientEmail === 'sa@p.iam.gserviceaccount.com' && sa.privateKey === 'A\nB');
  check('SA鍵JSON: 不正なJSONは null', parseServiceAccountJson('{not json') === null && parseServiceAccountJson('{}') === null);

  // 12. 担当者メールによる下書き依頼（列の保存方針・状態判定・送信元アドレス検証）
  const draft = (body: string): DraftRef => ({
    draftId: 'd1', url: '/tmp/x', to: 'a@partner.jp', cc: 'sales@example.jp', from: 'placeholder',
    subject: 'Re: 件名', inReplyTo: '<m@p>', references: '<m@p>', body,
  });
  const created = mergeDraftColumns(null, draft('v1'), undefined);
  const stored = parseDraftData(created.data);
  check(
    '下書き列: 新規は文面ありの側=未作成・無い側=不要、保存データに draftId/url/from を持たない',
    created.projectState === '未作成' && created.engineerState === '不要' && Boolean(stored.project) &&
      !stored.engineer && !('draftId' in stored.project!) && !('url' in stored.project!) && !('from' in stored.project!),
  );
  check('下書き列: 文面は宛先・件名つき', created.projectText.startsWith('To: a@partner.jp\nCc: sales@example.jp\nSubject: Re: 件名\n\nv1'));
  const locked = mergeDraftColumns({ ...created, projectState: '作成済 2026-09-01 10:00' }, draft('v2'), undefined);
  check(
    '下書き列: 作成済の側は状態・文面・データを固定',
    locked.projectState === '作成済 2026-09-01 10:00' && locked.projectText === created.projectText && parseDraftData(locked.data).project?.body === 'v1',
  );
  const refreshed = mergeDraftColumns({ ...created, engineerState: '不要', projectState: 'エラー: x' }, draft('v2'), draft('e2'));
  check(
    '下書き列: 依頼前の側は最新文面に差し替え、人が書いた状態（不要・エラー）は保持',
    refreshed.projectState === 'エラー: x' && refreshed.engineerState === '不要' && parseDraftData(refreshed.data).project?.body === 'v2',
  );
  check('下書き列: 壊れたJSONは空扱い', Object.keys(parseDraftData('{broken')).length === 0);
  const injected = parseDraftData(
    JSON.stringify({ project: { to: 'x@own.jp', subject: 's', body: { path: '/proc/self/environ' } }, engineer: { to: 'y@own.jp', subject: 's', body: 'ok', extra: { href: 'http://x' } } }),
  );
  check(
    '下書き列: 文字列以外の項目（{path}/{href}）を含む側は捨て、決まった項目だけを取り出す',
    !injected.project && injected.engineer?.body === 'ok' && !('extra' in (injected.engineer ?? {})),
  );
  const secretDir = mkdtempSync(join(tmpdir(), 'ses-mime-'));
  const secretFile = join(secretDir, 'secret.txt');
  writeFileSync(secretFile, 'SES_SELFTEST_SECRET_MARKER');
  try {
    const mime = (
      await buildReplyMime({ draftId: '', url: '', to: 'a@b.jp', subject: 's', body: { path: secretFile } as unknown as string })
    ).toString('utf-8');
    check('MIME: 本文がファイル指定（{path}）でもファイルを読み込まない', !mime.includes('SES_SELFTEST_SECRET_MARKER'));
  } finally {
    rmSync(secretDir, { recursive: true, force: true });
  }
  const signed = mergeDraftColumns(null, draft('v1'), undefined, { signingKey: 'k'.repeat(32) });
  const tamperedJson = signed.data.replace('a@partner.jp', 'evil@attacker.example');
  check(
    '下書き列: 署名鍵があれば署名し、書き換え・署名なしを検知する',
    verifyDraftData(signed.data, 'k'.repeat(32)) &&
      !verifyDraftData(tamperedJson, 'k'.repeat(32)) &&
      !verifyDraftData(created.data, 'k'.repeat(32)) &&
      verifyDraftData(tamperedJson, ''),
  );
  const relaundered = mergeDraftColumns(
    { ...signed, data: tamperedJson, projectState: '作成済 2026-09-01 10:00' },
    undefined,
    undefined,
    { signingKey: 'k'.repeat(32) },
  );
  check('下書き列: 署名の合わない既存データは再保存で引き継がない（署名し直して正規化しない）', !relaundered.data.includes('attacker'));
  const genFailed = mergeDraftColumns(null, undefined, undefined, { failed: true });
  check(
    '下書き列: 成立候補の文面を用意できなかった側は「不要」でなく作り直し待ち（依頼は受けない）',
    genFailed.projectState === DRAFT_STATE.genFailed && !isDraftStateActionable(genFailed.projectState) &&
      mergeDraftColumns(genFailed, draft('v2'), draft('e2')).projectState === '未作成',
  );
  const regenToTentative = mergeDraftColumns(genFailed, undefined, undefined);
  check(
    '下書き列: 作り直し待ちの側は、判定し直しで下書きを作らない区分になれば「不要」に戻す（判定済みに含める）',
    regenToTentative.projectState === DRAFT_STATE.notNeeded && regenToTentative.engineerState === DRAFT_STATE.notNeeded,
  );
  check(
    '下書き状態: 空欄・未作成・エラーのみ作成対象',
    ['', '未作成', 'エラー: x'].every(isDraftStateActionable) &&
      !['作成済 2026-09-01 10:00', '送信済', '不要', '作成中', '作成中 2026-09-01 10:00'].some(isDraftStateActionable),
  );
  check('送信元: 全角・前後空白・ドメイン大文字を正規化', normalizeSenderEmail(' ｔａｒｏ＠Example.CO.jp ') === 'taro@example.co.jp');
  check(
    '送信元: 表示名付き・複数・改行入りは不正',
    isValidSenderEmail('taro@example.co.jp') &&
      !['山田 <y@example.co.jp>', 'a@example.co.jp, b@example.co.jp', 'a@example.co.jp\nBcc: x@evil.jp', 'taro', 'a@b'].some(isValidSenderEmail),
  );
  check(
    '送信元: 許可ドメインは完全一致（一覧が空なら許可しない）',
    senderDomainAllowed('a@example.co.jp', ['example.co.jp']) && !senderDomainAllowed('a@sub.example.co.jp', ['example.co.jp']) &&
      !senderDomainAllowed('a@evil.jp', ['example.co.jp']) && !senderDomainAllowed('a@evil.jp', []),
  );
  const domainPolicy: SenderPolicy = { domains: ['example.co.jp'], addresses: [], requireAddress: false };
  setDemoOverride(false);
  try {
    check(
      '送信元: 設定が無ければ作らない・Gmailはアドレスの一覧が必須・一覧があればそのアドレスだけ',
      senderRejection('a@example.co.jp', { domains: [], addresses: [], requireAddress: false }) !== '' &&
        senderRejection('boss@example.co.jp', { domains: ['example.co.jp'], addresses: [], requireAddress: true }) !== '' &&
        senderRejection('taro@example.co.jp', { domains: [], addresses: ['taro@example.co.jp'], requireAddress: true }) === '' &&
        senderRejection('boss@example.co.jp', { domains: ['example.co.jp'], addresses: ['taro@example.co.jp'], requireAddress: false }) !== '' &&
        senderRejection('taro@example.co.jp', domainPolicy) === '',
    );
  } finally {
    setDemoOverride(null);
  }
  check('状態の日時はJST表記', jstStamp(new Date('2026-09-23T01:05:00Z')) === '2026-09-23 10:05');
  setDemoOverride(false);
  const plan = planDraftRequest(
    { tab: 'マッチ', id: 'm1', rowNumber: 2, senderEmail: 'y@evil.jp', projectState: '', engineerState: '不要', draftData: created.data },
    domainPolicy,
  );
  check('依頼判定: 許可外ドメインは作成せずエラー（不要の側は触らない）', plan.create.length === 0 && plan.errors.project === 'エラー: 送信元ドメインが許可されていません' && plan.errors.engineer === undefined);
  const plan2 = planDraftRequest(
    { tab: 'マッチ', id: 'm1', rowNumber: 2, senderEmail: 'taro@example.co.jp', projectState: '未作成', engineerState: '', draftData: created.data },
    domainPolicy,
  );
  check('依頼判定: 文面のある側は作成、無い側はエラー', plan2.create.join(',') === 'project' && Boolean(plan2.errors.engineer?.startsWith('エラー: 下書きの文面データ')));
  const plan3 = planDraftRequest(
    { tab: 'マッチ', id: 'm1', rowNumber: 2, senderEmail: 'taro@example.co.jp', projectState: '', engineerState: '不要', draftData: tamperedJson },
    domainPolicy,
    'k'.repeat(32),
  );
  check('依頼判定: 署名の合わない下書きデータからは作らない', plan3.create.length === 0 && Boolean(plan3.errors.project?.includes('書き換え')));
  check('依頼対象タブ: マッチ・プロパー候補を含む', draftRequestTabs().includes('マッチ') && draftRequestTabs().includes('プロパー候補'));
  const properId = `ownmatch_${properEngineerIdOf('fileX')}_proj_0123456789ab`;
  const properRow = { tab: 'プロパー候補', id: properId, rowNumber: 2, senderEmail: 'taro@example.co.jp', projectState: '', engineerState: '不要', draftData: created.data };
  const properPlan = planDraftRequest(properRow, domainPolicy, '', new Set([properEngineerIdOf('fileX')]));
  const retiredPlan = planDraftRequest(properRow, domainPolicy, '', new Set());
  const unknownPlan = planDraftRequest(properRow, domainPolicy, '', null);
  check('依頼判定: 案件側だけのタブは要員側に触らない', properPlan.create.join(',') === 'project' && Object.keys(properPlan.errors).length === 0);
  check(
    '依頼判定: 稼働可でなくなった社員・管理表を確かめられないときのプロパー候補は作らない',
    retiredPlan.create.length === 0 && Boolean(retiredPlan.errors.project?.includes('稼働可ではない')) &&
      unknownPlan.create.length === 0 && Boolean(unknownPlan.errors.project?.includes('確認できない')),
  );
  check(
    'プロパー候補ID: DriveのファイルIDを含めず、社員IDを取り出せる',
    !properId.includes('fileX') && properEngineerIdOfCandidate(properId) === properEngineerIdOf('fileX') &&
      properEngineerIdOfCandidate('ownmatch_proper_fileA_proj_flow_1') === 'proper_fileA',
  );
  const boundKey = 'k'.repeat(32);
  const bound = mergeDraftColumns(null, draft('v1'), draft('e1'), { signingKey: boundKey, bind: ['マッチ', 'm1'] });
  const copied = planDraftRequest(
    { tab: 'マッチ', id: 'm2', rowNumber: 3, senderEmail: 'taro@example.co.jp', projectState: '', engineerState: '', draftData: bound.data },
    domainPolicy,
    boundKey,
  );
  check(
    '下書き列: 署名は行（タブ・ID）に結び付け、別の行へ写した下書きデータからは作らない',
    verifyDraftData(bound.data, boundKey, ['マッチ', 'm1']) && !verifyDraftData(bound.data, boundKey, ['マッチ', 'm2']) &&
      copied.create.length === 0 && Boolean(copied.errors.project?.includes('書き換え')),
  );
  const noTo = mergeDraftColumns(null, { ...draft('v1'), to: '' }, draft('e1'), { signingKey: boundKey, bind: ['マッチ', 'm1'] });
  const noToPlan = planDraftRequest(
    { tab: 'マッチ', id: 'm1', rowNumber: 2, senderEmail: 'taro@example.co.jp', projectState: noTo.projectState, engineerState: noTo.engineerState, draftData: noTo.data },
    domainPolicy,
    boundKey,
  );
  check(
    '下書き列: 宛先の無い側は依頼を受けない状態にし、もう片側は署名どおり作れる',
    noTo.projectState === DRAFT_STATE.noRecipient && !isDraftStateActionable(noTo.projectState) &&
      noToPlan.create.join(',') === 'engineer' && Object.keys(noToPlan.errors).length === 0,
    JSON.stringify(noToPlan),
  );
  setDemoOverride(null);

  // 13. プロパー（スキルシート）: 人が入力する列の解釈
  check(
    'プロパー: 必要案件単価の表記ゆれ（65/６５万円/650,000円/空欄）',
    parseManYen('65') === 65 && parseManYen('６５万円') === 65 && parseManYen('650,000円') === 65 && parseManYen('') === null,
  );
  check(
    'プロパー: 稼働可能日（ISO・スラッシュ・年月のみ→1日・即日は不明）',
    parseAvailableFrom('2026-10-01') === '2026-10-01' && parseAvailableFrom('2026/9/5') === '2026-09-05' &&
      parseAvailableFrom('2026年11月〜') === '2026-11-01' && parseAvailableFrom('即日') === null,
  );
  check(
    'プロパー: ファイル形式（拡張子でも判定・ショートカットは未対応）',
    skillSheetFormat({ name: 'a.xlsx', mimeType: 'application/octet-stream' }) === 'excel' &&
      skillSheetFormat({ name: 'b', mimeType: 'application/vnd.google-apps.document' }) === 'gdoc' &&
      skillSheetFormat({ name: 'c.pdf', mimeType: 'application/vnd.google-apps.shortcut' }) === null &&
      skillSheetFormat({ name: 'd.doc', mimeType: 'application/msword' }) === null,
  );

  // 14. プロパー: 管理表の行（人の列は入力済みなら決して書き換えない）
  const col = (name: string) => PROPER_MASTER_COLUMNS.indexOf(name);
  const sheetFile: SkillSheetFile = {
    id: 'f1', name: '山田太郎_スキルシート.xlsx', mimeType: 'application/octet-stream',
    modifiedTime: '2026-09-20T01:00:00.000Z', webViewLink: 'https://drive.example/f1', size: 1000,
  };
  const profile = {
    displayName: '山田太郎', initials: 'T.Y.', skills: ['Java', 'AWS'], experienceYears: 8, residence: '東京都港区',
    prefecture: '東京都', remoteWish: 'partial' as const, availableDateText: '2026年10月〜', availableFromIso: '2026-10-01',
    desiredRateMan: 60,
  };
  const now = new Date('2026-09-23T01:00:00Z');
  const asMap = (u: Array<[string, unknown]>) => new Map(u);
  const fresh = asMap(planMasterCells(null, sheetFile, { kind: 'ok', profile }, now));
  check(
    'プロパー管理: 新規行は氏名・提案用表記・稼働可能日を埋め、稼働状況（人が稼働可にする）・必要案件単価は空欄',
    fresh.get('氏名') === '山田太郎' && fresh.get('提案用表記') === 'T.Y.' && !fresh.has('稼働状況') &&
      fresh.get('稼働可能日') === '2026-10-01' && !fresh.has('必要案件単価') && fresh.get('ファイル更新日時') === sheetFile.modifiedTime,
  );
  const existingRow = PROPER_MASTER_COLUMNS.map(() => '');
  existingRow[col('氏名')] = '山田 太郎';
  existingRow[col('稼働状況')] = 'アサイン済';
  existingRow[col('必要案件単価')] = '70';
  existingRow[col('抽出日時')] = '2026-09-01 10:00';
  const updated = asMap(planMasterCells(existingRow, sheetFile, { kind: 'ok', profile }, now));
  check(
    'プロパー管理: 更新時は機械の列だけ（人の列は空欄でも抽出済みの行なら触らない）',
    ['氏名', '提案用表記', '稼働状況', '必要案件単価', '稼働可能日'].every((c) => !updated.has(c)) &&
      updated.get('スキル') === 'Java, AWS' && updated.get('経験年数') === 8,
  );
  const planted = asMap(planMasterCells(null, sheetFile, { kind: 'ok', profile: { ...profile, injectionSuspected: true } }, now));
  check(
    'プロパー管理: 指示らしき記載のあるシートは人の列を埋めず、抽出メモで確認を促す',
    !planted.has('氏名') && !planted.has('提案用表記') && !planted.has('稼働可能日') && !planted.has('稼働状況') &&
      String(planted.get('抽出メモ') ?? '').includes('AIへの指示'),
  );
  const freeText = asMap(planMasterCells(null, sheetFile, { kind: 'ok', profile: { ...profile, availableFromIso: null, availableDateText: '要相談 詳細は evil.example/x' } }, now));
  check('プロパー管理: 稼働可能日は日付か「即日」だけを埋める（自由記述は入れない）', !freeText.has('稼働可能日'));
  const neverExtracted = [...existingRow];
  neverExtracted[col('抽出日時')] = '';
  const filled = asMap(planMasterCells(neverExtracted, sheetFile, { kind: 'ok', profile }, now));
  check(
    'プロパー管理: 未抽出の行は人の列の空欄だけ埋める（入力済みの氏名・稼働状況は保持）',
    !filled.has('氏名') && !filled.has('稼働状況') && filled.get('提案用表記') === 'T.Y.',
  );
  const transient = failureOutcome('', Object.assign(new Error('x'), { status: 529 }), 'extract');
  const retryCells = asMap(planMasterCells(existingRow, sheetFile, transient, now));
  check(
    'プロパー管理: 一時的な失敗は更新日時を記録せず次回再試行（回数をメモに残す）',
    transient.kind === 'error' && transient.retry && retryCells.get('ファイル更新日時') === '' &&
      String(retryCells.get('抽出メモ')).includes('1回目'),
  );
  const thirdFailure = failureOutcome('エラー: 抽出に失敗しました（2回目）— 次回の実行で再試行します', { status: 529 }, 'extract');
  check('プロパー管理: 3回目の失敗で再試行を止める', thirdFailure.kind === 'error' && !thirdFailure.retry);

  const masterRow = PROPER_MASTER_COLUMNS.map(() => '');
  masterRow[col('氏名')] = '山田太郎';
  masterRow[col('提案用表記')] = 'T.Y.';
  masterRow[col('稼働状況')] = '稼働可';
  masterRow[col('必要案件単価')] = '65万';
  masterRow[col('スキル')] = 'Java, AWS';
  masterRow[col('ファイルID')] = 'f1';
  const eng = rowToProperEngineer(masterRow);
  check(
    'プロパー管理: 稼働可の行 → 突合用の社員（IDはファイルIDのハッシュ・必要案件単価を数値化）',
    eng?.id === properEngineerIdOf('f1') && !eng.id.includes('f1') && eng.fileId === 'f1' && eng.requiredProjectRate === 65 && eng.skills.length === 2,
  );
  const assigned = [...masterRow];
  assigned[col('稼働状況')] = 'アサイン済';
  check('プロパー管理: 稼働可以外は突合しない', rowToProperEngineer(assigned) === null);

  // 15. プロパー: 提案文面（社外向け。氏名・必要案件単価を書かない）
  const project: Project = {
    id: 'proj_x', title: 'Java案件', requiredSkills: ['Java'], preferredSkills: [], rateMin: 70, rateMax: 80,
    location: '東京都', prefecture: '東京都', remote: 'partial', startPeriod: '10月', startDate: '2026-10-01', duration: '',
    businessFlow: '', agentCompany: 'パートナー', agentContact: '佐藤', agentEmail: 'sato@partner.jp', sourceMailId: 'm1',
    replyTarget: { from: 'sato@partner.jp', to: 'sales@example.co.jp', cc: '', subject: '案件のご紹介', messageId: '<a@b>', references: '' },
    receivedAt: new Date(), status: 'open',
  };
  const body = buildProperProposalBody(eng as ProperEngineer, project);
  check(
    'プロパー提案文面: イニシャルのみ・氏名と必要案件単価を含まない',
    body.includes('T.Y.') && !body.includes('山田') && !body.includes('65万') && body.startsWith('佐藤様'),
  );
  const noInitials = buildProperProposalBody({ ...(eng as ProperEngineer), proposalLabel: '' }, project);
  check('プロパー提案文面: 提案用表記が空なら氏名で代用せず差し込み表記', noInitials.includes(MISSING_INITIALS_PLACEHOLDER) && !noInitials.includes('山田'));
  const proposal = buildProperProposalDraft(eng as ProperEngineer, project);
  check('プロパー提案文面: 元メールへの全員に返信', proposal?.to === 'sato@partner.jp' && proposal.subject === 'Re: 案件のご紹介' && proposal.inReplyTo === '<a@b>');

  const candidate = { properLabel: '山田太郎（T.Y.）', projectTitle: 'Java案件' } as ProperCandidate;
  const run: ProperRunResult = { demo: false, sync: null, engineers: 1, projects: 1, candidates: [candidate], saved: 1, retired: 0 };
  const consoleLines = properSummaryLines(run, false).join('\n');
  check('プロパー: コンソール用のサマリは件数のみ（氏名・案件名なし）', consoleLines.includes('1件') && !consoleLines.includes('山田') && !consoleLines.includes('Java案件'));

  await reviewFindingChecks(project);
  matchingAndDraftChecks(project);
  robustnessChecks(project);

  console.log('');
  if (failures > 0) {
    console.log(`❌ ${failures}件の検証に失敗しました`);
    process.exitCode = 1;
  } else {
    console.log('✅ すべての自己検証を通過しました');
  }
}

// 全体レビューの確定指摘への修正の回帰確認
async function reviewFindingChecks(project: Project): Promise<void> {
  // 16. 設定値: 空文字は未設定・桁区切り/全角を許す・数値でない/範囲外は既定値
  check(
    '設定値: 空文字は既定値・カンマ区切り/全角を解釈・NaNや範囲外は既定値',
    parseNumberSetting('', 5, { min: 1 }).value === 5 &&
      parseNumberSetting('100,000', 1).value === 100000 &&
      parseNumberSetting('１０', 1).value === 10 &&
      !parseNumberSetting('50円', 50).valid &&
      parseNumberSetting('50円', 50).value === 50 &&
      parseNumberSetting('0', 3, { min: 1 }).value === 3 &&
      parseNumberSetting('1.5', 3, { int: true }).value === 3,
  );
  check(
    '実行モード: CIで鍵が無ければdemoにせず停止・明示DEMO_MODEはdemo・鍵があれば本番',
    decideRunMode({ demoExplicit: false, keyConfigured: false, requireLive: true }) === 'error' &&
      decideRunMode({ demoExplicit: false, keyConfigured: false, requireLive: false }) === 'demo' &&
      decideRunMode({ demoExplicit: true, keyConfigured: false, requireLive: true }) === 'demo' &&
      decideRunMode({ demoExplicit: false, keyConfigured: true, requireLive: true }) === 'live',
  );

  // 17. 自己メール除外（自分の送信元・サマリ件名・自社ドメイン）
  const policy: OwnMailPolicy = { selfAddresses: ['sales@example.co.jp'], ownDomains: ['example.co.jp'], collectOwnDomain: false };
  check(
    '自己メール除外: 自分の送信元・自社からのサマリ/修復レポート（転送含む）・自社ドメインを除外し、社外は件名が似ていても通す',
    ownMailReason('"営業" <Sales@Example.co.jp>', '案件', policy) === 'self' &&
      ownMailReason('taro@example.co.jp', 'Fwd: SES案件・要員マッチング バッチ実行結果（10:00）', { ...policy, collectOwnDomain: true }) === 'report' &&
      ownMailReason('x@partner.jp', 'Fwd: SES案件・要員マッチング バッチ実行結果（10:00）', policy) === null &&
      ownMailReason('taro@example.co.jp', 'Re: 【ご提案】', policy) === 'ownDomain' &&
      // 自社ドメインも収集する運用でも、社内の人の返信（バッチの下書きを送った控え）は取り込まない。転送・新規の共有は取り込む
      ownMailReason('taro@example.co.jp', 'Re: 【ご提案】', { ...policy, collectOwnDomain: true }) === 'ownReply' &&
      ownMailReason('taro@example.co.jp', 'Fwd: 【案件】Java', { ...policy, collectOwnDomain: true }) === null &&
      ownMailReason('partner@agent.jp', '【案件】Java', policy) === null,
  );

  // 18. PIIマスクの拡張と送信者のドメイン化
  const pii = maskPii('TEL:０３（１２３４）５６７８ / 09012345678 / +81-90-1234-5678 / 2026-09-23');
  check(
    'PIIマスク: 全角・括弧・区切りなし・+81の電話番号を伏せ、日付は残す',
    !/1234|5678|9012345678/.test(pii) && pii.includes('2026-09-23'),
    pii,
  );
  check('隔離リスト: 送信者はドメインのみ', senderDomainOnly('山田 太郎 <taro@Partner.co.jp>') === '@partner.co.jp');
  // 水曜10:00 JST（次回は同日11:00）と金曜19:00 JST（次回は月曜9:00）。平日9〜19時の毎時
  const now = new Date('2026-09-23T01:00:00Z');
  const friday = new Date('2026-09-25T10:00:00Z');
  check('次回の実行: 水曜10時の次は同日11時・金曜19時の次は月曜9時', followingRunAt(now) === Date.parse('2026-09-23T02:00:00Z') && followingRunAt(friday) === Date.parse('2026-09-28T00:00:00Z'));
  check(
    '隔離: 次回の実行時に収集期間を外れるメールだけを最後の機会と判定（半日前のメールは平日なら最後の機会ではない）',
    isLastChance(new Date('2026-09-19T01:00:00Z'), 4, now) &&
      !isLastChance(new Date('2026-09-22T12:00:00Z'), 4, now) &&
      !isLastChance(new Date('2026-09-20T12:00:00Z'), 4, now) &&
      isLastChance(new Date('2026-09-22T03:00:00Z'), 4, friday) &&
      !isLastChance(new Date('2026-09-24T12:00:00Z'), 4, friday) &&
      !isLastChance(new Date('2026-09-19T01:00:00Z'), 7, now),
  );
  const lastFirst = orderForRun(
    [
      { id: 'new', receivedAt: new Date('2026-09-23T00:00:00Z') },
      { id: 'old', receivedAt: new Date('2026-09-19T02:00:00Z') },
      { id: 'mid', receivedAt: new Date('2026-09-22T00:00:00Z') },
    ],
    4,
    now,
  ).map((x) => x.id);
  const picked = pickForRun([{ receivedAt: new Date('2026-09-23T00:00:00Z') }, { receivedAt: new Date('2026-09-22T00:00:00Z') }], 1, 4, now);
  check(
    '収集: 次回に窓を外れるメールを先に、残りは新しい順に処理し、上限を超えた分は次回へ',
    lastFirst.join(',') === 'old,new,mid' && picked.picked.length === 1 && picked.deferred.length === 1,
    lastFirst.join(','),
  );
  check(
    '抽出: 残高不足・請求の400は基盤起因（メールの問題として隔離しない）',
    isInfraError({ status: 400, message: 'Your credit balance is too low to access the Anthropic API' }) &&
      !isInfraError({ status: 400, message: 'invalid pdf document' }) &&
      isInfraError({ status: 529 }),
  );
  check('抽出: 案件・要員のIDはメールIDと出現順で決まる（言い回しが変わっても同じ）', itemIdOf('proj', 'sesmail_a', 0) === itemIdOf('proj', 'sesmail_a', 0) && itemIdOf('proj', 'sesmail_a', 0) !== itemIdOf('proj', 'sesmail_a', 1));
  check(
    '受信日: ISO・スラッシュ・年月日・年なしを読み、空欄と読めない値は不明',
    parseReceivedAt('2026-09-01T00:00:00.000Z')?.toISOString() === '2026-09-01T00:00:00.000Z' &&
      parseReceivedAt('2026/9/1')?.toISOString() === '2026-08-31T15:00:00.000Z' &&
      parseReceivedAt('2026年9月1日')?.toISOString() === '2026-08-31T15:00:00.000Z' &&
      parseReceivedAt('9/1', now)?.toISOString() === '2026-08-31T15:00:00.000Z' &&
      parseReceivedAt('12/30', now)?.toISOString() === '2025-12-29T15:00:00.000Z' &&
      parseReceivedAt('') === null && parseReceivedAt('来週') === null && parseReceivedAt('2026/2/30') === null,
  );
  check(
    'プロパー: 提案用表記はイニシャルの形だけ（氏名・ローマ字の氏名は捨てる）',
    sanitizeInitials('T.Y.', '山田太郎') === 'T.Y.' && sanitizeInitials('ＴＹ', '山田太郎') === 'TY' &&
      sanitizeInitials('Taro Yamada', 'Taro Yamada') === '' && sanitizeInitials('山田太郎', '山田太郎') === '' &&
      sanitizeInitials('LI', 'Li Wei') === '' && sanitizeInitials('', 'x') === '',
  );
  check('プロパー: ログのファイル参照はIDを含まない短いハッシュ', fileRef('1AbCdEfGhIjKlMn') .length === 8 && !fileRef('1AbCdEfGhIjKlMn').includes('AbC'));

  // 19. 抽出値の検証（単金は原文にある数値・妥当な範囲のみ、日付は実在する YYYY-MM-DD のみ）
  const nums = sourceNumbers('単価：７０～８０万円（税別）/ 時給4,500円 / 月額800,000円');
  check(
    '抽出検証: 原文にある単金だけを採用し、原文に無い値・範囲外は null',
    verifiedRate(80, 'manYenPerMonth', nums) === 80 &&
      verifiedRate(800000, 'yenPerMonth', nums) === 80 &&
      verifiedRate(4500, 'yenPerHour', nums) === 72 &&
      verifiedRate(150, 'manYenPerMonth', nums) === null &&
      verifiedRate(900, 'manYenPerMonth', null) === null &&
      verifiedRate(65, 'manYenPerMonth', null) === 65,
  );
  check(
    '抽出検証: 日付は実在する YYYY-MM-DD のみ',
    validIsoDate('2026-10-01') === '2026-10-01' && validIsoDate('2026-10') === null && validIsoDate('2026/11/01') === null && validIsoDate('2026-02-30') === null,
  );
  check(
    'スキル名: 区切り文字を除き、保存→読み戻しで要素が割れない',
    sanitizeListItem('Java(Spring, MyBatis)') === 'Java(Spring/MyBatis)' &&
      splitList(joinList(['Java(Spring, MyBatis)', 'AWS'])).join('|') === 'Java(Spring/MyBatis)|AWS',
  );

  // 20. 添付の形式判定（先頭バイト）と表計算の安全な解析
  const wb = xlsxUtils.book_new();
  xlsxUtils.book_append_sheet(wb, xlsxUtils.aoa_to_sheet([['案件名', '単価'], ['Java開発', 80]]), '案件');
  const xlsxBuf = writeXlsx(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  check('添付: xlsx(ZIP)・xls(OLE)は先頭バイトで判定し、それ以外は拒否', spreadsheetKind(xlsxBuf) === 'xlsx' &&
    spreadsheetKind(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0])) === 'xls' &&
    spreadsheetKind(Buffer.from('<html>')) === null);
  check('添付: xlsxをCSVテキスト化できる', spreadsheetBufferToText(xlsxBuf).includes('Java開発,80'));
  let rejected = false;
  try {
    spreadsheetBufferToText(Buffer.from('not a spreadsheet'));
  } catch (err) {
    rejected = err instanceof SafeLogError;
  }
  check('添付: Excel形式でないバイト列は解析しない', rejected);
  const b64 = (t: string) => Buffer.from(t, 'latin1').toString('base64');
  check(
    '添付PDF: パスワード保護・PDFでないものは送らない',
    inspectPdf(b64('%PDF-1.7\n1 0 obj << /Type /Page >>\ntrailer << /Encrypt 5 0 R >>')) === 'encrypted' &&
      inspectPdf(b64('hello')) === 'not_pdf' &&
      inspectPdf(b64('%PDF-1.4\n1 0 obj << /Type /Pages /Kids [2 0 R] >>\n2 0 obj << /Type /Page >>')) === 'ok',
  );

  // 21. LLM応答の打ち切りと自動修復（出力上限を拡大し、SDKの自動再試行は0にする。予算超過の見積もりなら試行しない）
  check('LLM: 打ち切りは型付きエラー・413は再試行しない', isTruncationError(new LlmOutputError('max_tokens', 'm')) && !isRetryableLlmError({ status: 413 }));
  setDemoOverride(false);
  try {
    let seen: HealAttempt | null = null;
    const healed = await healLlmCall('selftest', new LlmOutputError('max_tokens', 'm'), async (a) => {
      seen = a;
      return 'ok';
    });
    const s = seen as HealAttempt | null;
    check('自動修復: 打ち切りからの再試行は出力上限2倍・SDK再試行0', healed === 'ok' && s?.maxTokensFactor === 2 && s.sdkRetries === 0);
    let called = false;
    const skipped = await healLlmCall(
      'selftest',
      new Error('ECONNRESET'),
      async () => {
        called = true;
        return 'x';
      },
      () => 1_000_000,
    );
    check('自動修復: 見積もりが残り予算を超える試行はしない', skipped === null && !called);
  } finally {
    setDemoOverride(null);
    resetHealEvents();
  }

  // 22. 通常バッチの突合範囲（新着を含み未判定のペアだけ。既存×既存・判定済みは除外）
  const eng = (id: string): Engineer => ({
    id, displayName: 'A.B.', age: null, skills: ['Java'], experienceYears: 5, desiredRate: 60, residence: '東京都',
    prefecture: '東京都', nearestStation: '', availableDate: '', availableFrom: null, utilization: '', remoteWish: 'partial',
    agentCompany: '', agentContact: '', agentEmail: '', sourceMailId: 'm', receivedAt: new Date(), status: 'available',
  });
  const proj = (id: string): Project => ({ ...project, id, rateMax: 80, startDate: null });
  const pairs = primarySelect([proj('pNew'), proj('pOld')], [eng('eNew'), eng('eOld'), eng('eJudged')], {
    newProjectIds: new Set(['pNew']),
    newEngineerIds: new Set(['eNew']),
    judgedMatchIds: new Set([matchIdOf('pNew', 'eJudged')]),
  });
  const ids = pairs.map((p) => `${p.project.id}×${p.engineer.id}`).sort().join(',');
  check('突合範囲: 新着を含む未判定のペアのみ（既存×既存・判定済みは除外）', ids === 'pNew×eNew,pNew×eOld,pOld×eNew', ids);

  // 23. Web UI: トークン無しではループバック以外のHostを拒否、他サイトからのPOSTを拒否
  const req = (host: string, method = 'GET', origin?: string) =>
    ({ method, headers: { host, ...(origin ? { origin } : {}) } }) as unknown as IncomingMessage;
  check(
    'Web UI: DNSリバインディング・他サイトからの送信を拒否',
    rejectReason(req('evil.example:8788'), { tokenRequired: false })?.status === 403 &&
      rejectReason(req('127.0.0.1:8788'), { tokenRequired: false }) === null &&
      rejectReason(req('127.0.0.1:8788', 'POST', 'http://evil.example'), { tokenRequired: false })?.status === 403 &&
      rejectReason(req('127.0.0.1:8788', 'POST', 'http://127.0.0.1:8788'), { tokenRequired: false }) === null &&
      rejectReason(req('10.0.0.5:8788'), { tokenRequired: true }) === null,
  );
}

// 全体レビューの確定指摘（マッチ精度・下書き）への修正の回帰確認
function matchingAndDraftChecks(base: Project): void {
  // 24. 勤務地の正規化（語幹・市区・駅名・地域名。「東京都」の中の「京都」を拾わない）
  const prefCases: Array<[string, string | null]> = [
    ['東京（品川）', '東京都'], ['都内', '東京都'], ['東京23区', '東京都'], ['神奈川', '神奈川県'], ['横浜', '神奈川県'],
    ['大阪市内', '大阪府'], ['名古屋', '愛知県'], ['渋谷駅', '東京都'], ['リモート（月1出社：東京）', '東京都'],
    ['東京/大阪', '東京都'], ['京都市', '京都府'], ['東京都港区', '東京都'], ['梅田', '大阪府'], ['博多', '福岡県'],
    ['首都圏', '東京都'], ['最寄駅: 町田駅', '東京都'], ['フルリモート', null], ['', null],
  ];
  const prefNg = prefCases.filter(([input, want]) => normalizePrefecture(input) !== want).map(([input]) => input);
  check('勤務地: 語幹・市区・駅名・地域名から都道府県を推定', prefNg.length === 0, prefNg.join(','));
  check(
    '勤務地: 「フルリモート」「リモート」だけの記載はフルリモート扱い、出社・地名ありは対象外',
    isFullRemoteLocation('フルリモート') && isFullRemoteLocation('リモート') && !isFullRemoteLocation('リモート（月1出社：東京）') && !isFullRemoteLocation('東京都港区'),
  );

  const eng = (id: string, over: Partial<Engineer> = {}): Engineer => ({
    id, displayName: 'K.S.', age: 30, skills: ['Java'], experienceYears: 5, desiredRate: 60, residence: '東京都',
    prefecture: '東京都', nearestStation: '', availableDate: '', availableFrom: null, utilization: '', remoteWish: 'partial',
    agentCompany: 'B社', agentContact: '鈴木', agentEmail: 'suzuki@b.example', sourceMailId: `m_${id}`, receivedAt: new Date(),
    status: 'available', ...over,
  });
  const proj = (id: string, over: Partial<Project> = {}): Project => ({ ...base, id, rateMin: null, rateMax: 80, startDate: null, sourceMailId: `m_${id}`, ...over });
  const one = (p: Project, e: Engineer) => primarySelect([p], [e])[0];

  // 25. 片側だけ勤務地不明のペアは落とさず要員確認へ（フルリモートなら不問、両方わかって隣接外なら除外）
  const unknownLoc = one(proj('p1'), eng('e1', { residence: '', prefecture: null }));
  check('突合: 片側の勤務地不明は除外せず要確認', Boolean(unknownLoc?.needsReview) && unknownLoc!.reviewReasons.includes('勤務地不明'));
  check('突合: 両方わかって隣接外は除外', one(proj('p2'), eng('e2', { prefecture: '福岡県' })) === undefined);
  const remote = one(proj('p3', { remote: 'unknown', location: 'フルリモート', prefecture: null }), eng('e3', { prefecture: null }));
  check('突合: 勤務地の記載がフルリモートなら都道府県不明でも要確認にしない', Boolean(remote) && !remote!.needsReview);

  // 26. 案件単金が下限だけでも粗利を計算する（注意書き付き）
  const lower = one(proj('p4', { rateMin: 75, rateMax: null }), eng('e4', { desiredRate: 60 }));
  check('粗利: 上限が無ければ下限で計算し注意を付ける', lower?.grossMarginJpy === 150000 && !lower.needsReview && lower.cautions.length === 1);
  check('粗利: 下限で交渉幅を超える組は除外', one(proj('p5', { rateMin: 50, rateMax: null }), eng('e5', { desiredRate: 80 })) === undefined);

  // 27. 候補の上限は区分優先（粗利の大きい参考提案が成立候補を押し出さない）
  const many = [
    ...['t1', 't2', 't3', 't4', 't5', 't6'].map((id) => eng(id, { skills: ['Java', 'SQL'], desiredRate: 55 })),
    eng('strong', { skills: ['Java', 'Spring', 'SQL'], desiredRate: 64 }),
  ];
  const capped = primarySelect([proj('p6', { requiredSkills: ['Java', 'Spring', 'SQL'], rateMax: 75 })], many);
  check('候補上限: 強マッチの成立候補が残る', capped.some((p) => p.engineer.id === 'strong'), capped.map((p) => p.engineer.id).join(','));

  // 28. 交渉後の単金は0.5万円刻み、粗利下限と交渉上限を守る
  const hourly = one(proj('p7', { rateMax: 60.48 }), eng('e7', { desiredRate: 57.6 }));
  const n = hourly?.negotiation;
  check(
    '交渉: 端数を0.5万円刻みにし粗利下限を満たす',
    Boolean(n) && Number.isInteger(n!.targetProjectRateMan * 2) && Number.isInteger(n!.targetEngineerRateMan * 2) &&
      n!.resultingGrossMarginJpy >= 100000 && n!.projectRaiseMan <= 5 && n!.engineerCutMan <= 5,
    JSON.stringify(n),
  );
  const own: OwnEngineer = {
    id: 'own1', displayName: 'A', skills: ['Java'], experienceYears: 5, requiredProjectRate: 64.8, residence: '東京都',
    prefecture: '東京都', availableDate: '', availableFrom: null, remoteWish: 'partial', status: 'available',
  };
  const ownMatch = evaluateOwnMatch(own, proj('p8', { rateMax: 70 }));
  check('自社社員: 単価差は0.5万円刻み（端数を表示しない）', ownMatch?.rateGapMan === 5 && !ownMatch.reason.includes('000000'), ownMatch?.reason);

  // 29. 必須スキルが空の案件を「誰にでも100%一致」にしない
  const noSkill = proj('p9', { title: '【Java】金融系開発', requiredSkills: [], preferredSkills: [] });
  check('スキル不明: 案件名に要員のスキルが無ければ候補にしない', one(noSkill, eng('e9', { skills: ['COBOL'] })) === undefined);
  const noSkillJava = one(noSkill, eng('e10'));
  check('スキル不明: 案件名に要員のスキルがあれば要確認（強マッチにしない）', Boolean(noSkillJava?.needsReview) && noSkillJava!.band === 'tentative');
  const prefOnly = one(proj('p11', { requiredSkills: [], preferredSkills: ['Java'] }), eng('e11'));
  check('スキル不明: 必須が空なら尚可スキルで判定し参考提案止まり', prefOnly?.band === 'tentative' && !prefOnly.needsReview);
  check('同義辞書: 正規化後の表記で照合（vue→Vue.js・JS→JavaScript）', equivalenceKey('vue') === equivalenceKey('Vue.js') && equivalenceKey('JS') === 'javascript');

  // 30. 名寄せは単金・人物属性・同一メールの別項目を統合しない
  const ks = eng('ks', { displayName: 'K.S.', skills: ['PHP', 'MySQL', 'AWS'] });
  const ys = eng('ys', { displayName: 'Y.S.', skills: ['PHP', 'MySQL', 'AWS'] });
  const resent = eng('ks2', { displayName: 'K.S.', skills: ['PHP', 'MySQL', 'AWS'] });
  const sameMail = eng('ks3', { displayName: 'K.S.', skills: ['PHP', 'MySQL', 'AWS'], sourceMailId: 'm_ks' });
  const dedupedEngineers = dedupeEngineers([ks, ys, resent, sameMail]).map((e) => e.id).join(',');
  check('名寄せ: 別イニシャル・同一メールの別項目は残し、同一人物の再送だけ統合', dedupedEngineers === 'ks,ys,ks3', dedupedEngineers);
  const pg = proj('pg', { title: '【Java】金融系開発（PG）', rateMax: 60 });
  const pl = proj('pl', { title: '【Java】金融系開発（PL）', rateMax: 75 });
  check('名寄せ: 単金の違う案件は統合しない', dedupeProjects([pg, pl]).length === 2);
  const stored = proj('stored', { title: '【Java】金融系開発（PG）', rateMax: 60, sourceMailId: 'm_monday' });
  const resentProject = proj('resent', { title: '【Java】金融系開発（PG）', rateMax: 60, sourceMailId: 'm_wednesday' });
  const reExtracted = proj('stored', { title: '金融系Java開発（PG）', rateMax: 60, sourceMailId: 'm_monday' });
  const kept = withoutResentProjects([stored], [resentProject, reExtracted, pl]).map((p) => p.id).join(',');
  check('名寄せ: 保存済みと同じ案件の再送は除き、同じメールの抽出し直し・別案件は残す', kept === 'stored,pl', kept);

  // 31. 全員に返信: Reply-To を宛先に、他社・配信用アドレスは Cc に引き継がない、自社は重複なく1回
  const policy = { ourDomains: ['ours.example'] };
  const viaHaishin = planReplyAddresses(
    { from: 'noreply@haishin.example', replyTo: '田中 <tanaka@partner.example>', to: 'bp-all@partner.example', cc: 'sales@ours.example, x@competitor.example', subject: 's', messageId: '', references: '' },
    '',
    policy,
  );
  check(
    '返信宛先: Reply-To を To にし、配信リスト・他社は Cc から外して件数を注記',
    viaHaishin.to === '田中 <tanaka@partner.example>' && viaHaishin.cc === 'sales@ours.example' && viaHaishin.note.includes('1件') && !viaHaishin.note.includes('@'),
    JSON.stringify(viaHaishin),
  );
  const normal = planReplyAddresses(
    { from: 'tanaka@partner.example', to: 'sales@ours.example', cc: 'boss@partner.example, "営業" <SALES@ours.example>, taro@ours.example', subject: 's', messageId: '', references: '' },
    '',
    policy,
  );
  check('返信宛先: 自社・返信先と同じ会社の宛先は重複なく引き継ぐ', normal.cc === 'sales@ours.example, boss@partner.example, taro@ours.example' && normal.note === '', normal.cc);
  const bcc = planReplyAddresses({ from: 'tanaka@partner.example', to: 'tanaka-team@partner.example', cc: '', subject: 's', messageId: '', references: '' }, '', policy);
  check('返信宛先: Bccで受け取った一斉配信は宛先一同を Cc にしない', bcc.cc === '' && bcc.note !== '');
  check('返信宛先: 下書き作成時は送信者本人を Cc から外す', removeAddress(normal.cc, 'Taro <TARO@ours.example>') === 'sales@ours.example, boss@partner.example');
  const harvester = planReplyAddresses(
    { from: 'eigyo@real-partner.example', replyTo: 'collect@evil.example', to: 'sales@ours.example', cc: '', subject: 's', messageId: '', references: '' },
    '',
    policy,
  );
  check(
    '返信宛先: Reply-To が差出人と別のドメインなら注意書きを付ける（アドレスは書かない）',
    harvester.note.includes('Reply-To') && !harvester.note.includes('@') && normal.note === '',
    harvester.note,
  );

  // 32. 紹介文面: 相手方の社名・担当者名・単金・粗利・URL が混ざったら検出する
  const dp = proj('dp', { rateMin: 70, rateMax: 78, agentCompany: '株式会社アルファ', agentContact: '田中' });
  const de = eng('de', { desiredRate: 70, agentCompany: '株式会社ベータ', agentContact: '鈴木花子' });
  const match = { id: 'match_dp_de', grossMarginJpy: 80000, negotiation: undefined } as unknown as MatchResult;
  check('紹介文面: 問題のない文面は通す', disclosureIssues('田中様\nK.S.をご提案します。単金はご相談させてください。', 'project', dp, de, match).length === 0);
  const leaked = disclosureIssues('田中様\nベータ所属の鈴木 花子様の要員（希望７０万円）です。粗利8万円。https://evil.example', 'project', dp, de, match);
  check('紹介文面: 相手方の社名・単金・粗利・URLを検出', ['相手方の社名・担当者名', '相手方の単金', '粗利', 'URL'].every((x) => leaked.includes(x)), leaked.join(','));
  check('紹介文面: 要員側宛に案件の単金（上限）を書いたら検出', disclosureIssues('鈴木花子様\n単価780,000円の案件です', 'engineer', dp, de, match).includes('相手方の単金'));

  // 33. 事前確認（preflight）の書式検査: 値を表示せずに貼り付け誤りを見分ける
  const saOk = inspectServiceAccountJson(
    JSON.stringify({ type: 'service_account', client_email: 'bot@proj.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n' }),
  );
  check('事前確認: 正しいJSON鍵は問題なし', saOk.problems.length === 0 && saOk.notes.length === 0 && saOk.clientEmail.endsWith('gserviceaccount.com'));
  const saB64 = inspectServiceAccountJson(Buffer.from('{"client_email":"a"}').toString('base64'));
  check('事前確認: base64にしたJSON鍵を見分ける', saB64.problems.length === 1 && saB64.problems[0].includes('base64'));
  const saNoKey = inspectServiceAccountJson('{"type":"service_account","client_email":"bot@proj.iam.gserviceaccount.com"}');
  check('事前確認: private_key の欠けたJSON鍵は問題あり', saNoKey.problems.some((p) => p.includes('private_key')));
  check('事前確認: 問題の文言に鍵の中身を含めない', !JSON.stringify([saOk, saB64, saNoKey].map((r) => r.problems)).includes('BEGIN'));
  check(
    '事前確認: ホスト名はスキーム・ポートなしだけを通す',
    looksLikeHostname('imap.example.jp') && !looksLikeHostname('https://imap.example.jp') && !looksLikeHostname('imap.example.jp:993'),
  );
  check('事前確認: ドメイン名の判定', looksLikeDomain('example.co.jp') && !looksLikeDomain('@example.co.jp') && !looksLikeDomain('example'));
  check('事前確認: ドライブIDの判定（共有ドライブの短いIDも可）', looksLikeGoogleId('0AFxyz123456789ABCDE') && !looksLikeGoogleId('short') && !looksLikeGoogleId('https://x/y'));
  const addr = invalidAddressCount('a@example.co.jp, 営業 <b@example.co.jp>, foo');
  check('事前確認: 通知先のうち不正なアドレスの件数', addr.total === 3 && addr.invalid === 1, JSON.stringify(addr));

  // 34. メール量の測定: 添付の種類・定時バッチへの割り当て・集計（件名・アドレス・ドメイン名を出さない）
  check(
    '測定: 添付の種類（拡張子を優先し、拡張子で決まらないときはMIMEタイプで判定）',
    attachmentKind('スキル.PDF', 'application/octet-stream') === 'pdf' &&
      attachmentKind('noext', 'application/pdf') === 'pdf' &&
      attachmentKind('a.xlsx', 'application/octet-stream') === 'xlsx' &&
      attachmentKind('a.doc', 'application/msword') === 'other',
  );
  const jst = (iso: string) => new Date(`${iso}+09:00`).getTime();
  check('測定: 金曜19時半の受信は月曜9時の回', nextRunAt(jst('2026-09-18T19:30:00')) === jst('2026-09-21T09:00:00'));
  check('測定: 火曜12時半の受信は同日13時の回', nextRunAt(jst('2026-09-22T12:30:00')) === jst('2026-09-22T13:00:00'));
  check('測定: 実行時刻ちょうどの受信はその回', nextRunAt(jst('2026-09-22T10:00:00')) === jst('2026-09-22T10:00:00'));
  check('測定: 土曜の受信は月曜9時の回', nextRunAt(jst('2026-09-19T09:00:00')) === jst('2026-09-21T09:00:00'));
  const metas = [
    { receivedAt: new Date(jst('2026-09-21T09:00:00')), subject: '【案件】Java 田中太郎', fromAddress: 'tanaka@partner-secret.example', sizeBytes: 2048, attachmentKinds: ['pdf' as const, 'pdf' as const] },
    { receivedAt: new Date(jst('2026-09-20T11:00:00')), subject: '要員のご紹介', fromAddress: 'suzuki@other-secret.example', sizeBytes: 1024, attachmentKinds: ['xlsx' as const] },
    { receivedAt: new Date(jst('2026-09-22T09:30:00')), subject: 'SES案件・要員マッチング バッチ実行結果', fromAddress: 'sales@ours.example', sizeBytes: 1024, attachmentKinds: [] },
    { receivedAt: new Date(jst('2026-08-01T09:00:00')), subject: '期間外', fromAddress: 'x@old.example', sizeBytes: 1, attachmentKinds: [] },
  ];
  const statsResult = aggregateMailStats(metas, {
    since: new Date(jst('2026-09-15T00:00:00')),
    until: new Date(jst('2026-09-23T00:00:00')),
    policy: { selfAddresses: ['sales@ours.example'], ownDomains: ['ours.example'], collectOwnDomain: false },
    cap: 1,
  });
  check(
    '測定: 期間外を除き、自分たちのメールを収集対象外に数える',
    statsResult.total === 3 && statsResult.ownExcluded === 1 && statsResult.target === 2,
    JSON.stringify({ t: statsResult.total, o: statsResult.ownExcluded, g: statsResult.target }),
  );
  check(
    '測定: 添付はメール数とファイル数を分けて数える',
    statsResult.kindMails.pdf === 1 && statsResult.kindFiles.pdf === 2 && statsResult.kindMails.xlsx === 1 && statsResult.withAttachment === 2,
  );
  check('測定: 送信元ドメインは種類数だけ', statsResult.senderDomains === 2);
  check('測定: 月曜10時の回に2通がまとまり、上限超過として数える', statsResult.runMax === 2 && statsResult.runsOverCap === 1, JSON.stringify(statsResult.runSlots));
  const statsText = formatMailStats(statsResult, 8, 1).join('\n');
  check(
    '測定: 表示に件名・アドレス・ドメイン名・氏名を含めない',
    !['田中', 'tanaka', 'partner-secret', 'other-secret', 'ours.example', '要員のご紹介'].some((x) => statsText.includes(x)),
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

// 返信メタの署名・LLM呼び出しの待ち時間・抽出の持ち時間・抽出し直したときのID
function robustnessChecks(project: Project): void {
  const key = 'k'.repeat(32);
  const rt = { from: 'a@partner.jp', to: 'sales@own.jp', cc: '', subject: 's', messageId: '<m@p>', references: '' };
  const bind = { key, tab: '案件', id: 'proj_1', agentEmail: 'a@partner.jp' };
  const json = replyMetaJson(rt, bind);
  const edited = json.replace('a@partner.jp', 'evil@attacker.example');
  check(
    '返信メタ: 署名つきで保存し、宛先の書き換え・別の行への写し・営業元メールの書き換え・署名なしを検知する',
    verifyReplyMeta(json, bind) && parseReplyMeta(json)?.from === 'a@partner.jp' && !('sig' in (parseReplyMeta(json) ?? {})) &&
      !verifyReplyMeta(edited, bind) && !verifyReplyMeta(json, { ...bind, id: 'proj_2' }) &&
      !verifyReplyMeta(json, { ...bind, agentEmail: 'evil@attacker.example' }) && !verifyReplyMeta(JSON.stringify(rt), bind) &&
      verifyReplyMeta(JSON.stringify(rt), { ...bind, key: '' }),
  );
  const t0 = Date.now();
  startRunClock(t0);
  try {
    const early = callLimits(300_000, 1, t0);
    const late = callLimits(300_000, 1, t0 + 25 * 60_000);
    check(
      '実行時間: 期限前は再試行ありで残り時間に収め、期限後は再試行なし・短い待ち時間にする',
      early.maxRetries === 1 && early.timeoutMs === 300_000 && late.maxRetries === 0 && late.timeoutMs <= 3 * 60_000,
      JSON.stringify({ early, late }),
    );
    check(
      '実行時間: 抽出は持ち時間の約半分で打ち切り、残りを突合・通知に回す',
      !pastExtractDeadline(t0 + 5 * 60_000) && pastExtractDeadline(t0 + 12 * 60_000),
    );
  } finally {
    stopRunClock();
  }
  const mk = (id: string, title: string, skills: string[]): Project => ({ ...project, id, title, requiredSkills: skills, sourceMailId: 'mailR' });
  const saved = [mk(itemIdOf('proj', 'mailR', 0), 'Java基幹システム開発', ['Java']), mk(itemIdOf('proj', 'mailR', 1), 'Pythonデータ分析基盤', ['Python'])];
  const reordered = [mk(itemIdOf('proj', 'mailR', 0), 'Pythonデータ分析基盤', ['Python']), mk(itemIdOf('proj', 'mailR', 1), 'Java基幹システム開発', ['Java']), mk(itemIdOf('proj', 'mailR', 2), 'Go API開発', ['Go'])];
  const ids = reconcileReextractedIds('project', reordered, saved, (m, i) => itemIdOf('proj', m, i)).map((p) => p.id);
  check(
    '抽出し直し: 順番が変わっても内容の同じ行のIDを使い、増えた項目は保存済みの行と重ならないIDにする',
    ids[0] === saved[1].id && ids[1] === saved[0].id && !saved.some((x) => x.id === ids[2]) && new Set(ids).size === 3,
    ids.join(','),
  );
}
