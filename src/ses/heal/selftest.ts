// 自己修復レイヤーと本番実行基盤のオフライン自己検証（npm run ses:heal:check）。外部API呼び出しゼロ。
// 円換算・予算メーター・隔離ラウンドトリップ・エラー分類・PIIマスク・異常終了判定・
// ログ秘匿・SheetsDBのA1表記/ヘッダー移行判定・SA鍵JSONの解釈・担当者メールによる下書き依頼の判定・
// プロパー（スキルシート）管理表の行の組み立てと提案文面、
// 設定値の解釈・実行モード判定・自己メール除外・抽出値の検証・添付の形式判定・突合範囲・Web UIの要求拒否を検証する。
import { utils as xlsxUtils, write as writeXlsx } from 'xlsx';
import { usageCostJpy, jpyPerUsd } from '../../llm/pricing.js';
import { LlmOutputError, isTruncationError } from '../../llm/errors.js';
import { isRetryableLlmError, healLlmCall, type HealAttempt } from './retry.js';
import { parseNumberSetting, decideRunMode, setDemoOverride } from '../config.js';
import { ownMailReason, type OwnMailPolicy } from '../mail/ownMail.js';
import { sourceNumbers, verifiedRate, validIsoDate, inspectPdf } from '../extract.js';
import { spreadsheetKind, spreadsheetBufferToText } from '../parse.js';
import { primarySelect, matchIdOf } from '../match.js';
import { sanitizeListItem, joinList, splitList } from '../../database/mapping.js';
import { rejectReason } from '../../web/httpSecurity.js';
import type { IncomingMessage } from 'http';
import {
  maskPii,
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
import { columnLetter, quoteTab, planHeaderMigration } from '../../database/sheetBook.js';
import { draftRequestTabs } from '../../database/sheets.js';
import { mergeDraftColumns, parseDraftData, isDraftStateActionable } from '../../database/mapping.js';
import { parseServiceAccountJson } from '../../collectors/googleAuth.js';
import {
  normalizeSenderEmail,
  isValidSenderEmail,
  senderDomainAllowed,
  jstStamp,
  planDraftRequest,
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
import type { SesRawMail, DraftRef, Project, Engineer, ProperEngineer, ProperCandidate } from '../../types/index.js';

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
  check('円換算: Sonnet 1MTok入力 = 3USD相当', near(sonnetCost, 3 * rate), `got ${sonnetCost}`);

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
  check('ヘッダー: 並びが違えば上書きしない', conflict.kind === 'conflict' && conflict.index === 1);

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
  check(
    '下書き状態: 空欄・未作成・エラーのみ作成対象',
    ['', '未作成', 'エラー: x'].every(isDraftStateActionable) &&
      !['作成済 2026-09-01 10:00', '送信済', '不要', '作成中'].some(isDraftStateActionable),
  );
  check('送信元: 全角・前後空白・ドメイン大文字を正規化', normalizeSenderEmail(' ｔａｒｏ＠Example.CO.jp ') === 'taro@example.co.jp');
  check(
    '送信元: 表示名付き・複数・改行入りは不正',
    isValidSenderEmail('taro@example.co.jp') &&
      !['山田 <y@example.co.jp>', 'a@example.co.jp, b@example.co.jp', 'a@example.co.jp\nBcc: x@evil.jp', 'taro', 'a@b'].some(isValidSenderEmail),
  );
  check(
    '送信元: 許可ドメインは完全一致（未設定なら全許可）',
    senderDomainAllowed('a@example.co.jp', ['example.co.jp']) && !senderDomainAllowed('a@sub.example.co.jp', ['example.co.jp']) &&
      !senderDomainAllowed('a@evil.jp', ['example.co.jp']) && senderDomainAllowed('a@evil.jp', []),
  );
  check('状態の日時はJST表記', jstStamp(new Date('2026-09-23T01:05:00Z')) === '2026-09-23 10:05');
  const plan = planDraftRequest(
    { tab: 'マッチ', id: 'm1', senderEmail: 'y@evil.jp', projectState: '', engineerState: '不要', draftData: created.data },
    ['example.co.jp'],
  );
  check('依頼判定: 許可外ドメインは作成せずエラー（不要の側は触らない）', plan.create.length === 0 && plan.errors.project === 'エラー: 送信元ドメインが許可されていません' && plan.errors.engineer === undefined);
  const plan2 = planDraftRequest(
    { tab: 'マッチ', id: 'm1', senderEmail: 'taro@example.co.jp', projectState: '未作成', engineerState: '', draftData: created.data },
    ['example.co.jp'],
  );
  check('依頼判定: 文面のある側は作成、無い側はエラー', plan2.create.join(',') === 'project' && Boolean(plan2.errors.engineer?.startsWith('エラー: 下書きの文面データ')));
  check('依頼対象タブ: マッチ・プロパー候補を含む', draftRequestTabs().includes('マッチ') && draftRequestTabs().includes('プロパー候補'));
  const properPlan = planDraftRequest(
    { tab: 'プロパー候補', id: 'p1', senderEmail: 'taro@example.co.jp', projectState: '', engineerState: '不要', draftData: created.data },
    ['example.co.jp'],
  );
  check('依頼判定: 案件側だけのタブは要員側に触らない', properPlan.create.join(',') === 'project' && Object.keys(properPlan.errors).length === 0);

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
    'プロパー管理: 新規行は氏名・提案用表記・稼働可能日を埋め、稼働状況=稼働可・必要案件単価は空欄',
    fresh.get('氏名') === '山田太郎' && fresh.get('提案用表記') === 'T.Y.' && fresh.get('稼働状況') === '稼働可' &&
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
    'プロパー管理: 稼働可の行 → 突合用の社員（IDはファイルIDから・必要案件単価を数値化）',
    eng?.id === 'proper_f1' && eng.requiredProjectRate === 65 && eng.skills.length === 2,
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
  const run: ProperRunResult = { demo: false, sync: null, engineers: 1, projects: 1, candidates: [candidate], saved: 1 };
  const consoleLines = properSummaryLines(run, false).join('\n');
  check('プロパー: コンソール用のサマリは件数のみ（氏名・案件名なし）', consoleLines.includes('1件') && !consoleLines.includes('山田') && !consoleLines.includes('Java案件'));

  await reviewFindingChecks(project);

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
    '自己メール除外: 自分の送信元・サマリ/修復レポート（転送含む）・自社ドメインを除外し、社外は通す',
    ownMailReason('"営業" <Sales@Example.co.jp>', '案件', policy) === 'self' &&
      ownMailReason('x@partner.jp', 'Fwd: SES案件・要員マッチング バッチ実行結果（10:00）', policy) === 'report' &&
      ownMailReason('taro@example.co.jp', 'Re: 【ご提案】', policy) === 'ownDomain' &&
      ownMailReason('taro@example.co.jp', 'Re: 【ご提案】', { ...policy, collectOwnDomain: true }) === null &&
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
  const now = new Date('2026-09-23T01:00:00Z');
  check(
    '隔離: 次回の実行時に収集期間を外れるメールは最後の機会と判定',
    isLastChance(new Date('2026-09-19T01:00:00Z'), 7, now) && !isLastChance(new Date('2026-09-22T01:00:00Z'), 7, now),
  );

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

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
