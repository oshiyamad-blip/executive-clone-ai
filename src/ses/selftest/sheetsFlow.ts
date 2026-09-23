// スプレッドシート運用（DB_PROVIDER=sheets）の結合自己検証（npm run ses:flow:check）。
// Google Sheets / Drive・メール送受信・スキルシートのLLM抽出をインメモリの偽物（fakeGoogle.ts）に差し替え、
// 外部には一切接続しない（fetch も遮断し、呼ばれたら失敗にする）。毎回まっさらな環境で動く定時実行を
// 「行キャッシュを捨てて同じ処理をもう一度」で再現し、タブの自動生成・ヘッダー移行、upsert の冪等性、
// 人が編集する列の保持、処理済みメールID・隔離リストの持ち越し、担当者メールによる下書き作成、
// プロパー管理表の同期とプロパー候補の保存、ログ秘匿を検証する。
// テストデータの氏名・会社・アドレスはすべて架空（example ドメイン）。
import { rmSync } from 'fs';
import { join } from 'path';
import { __setSheetsApiForTest } from '../../database/sheetBook.js';
import {
  resetSheetsCache,
  listDraftRequestRowsSheets,
  saveProperCandidatesSheets,
  saveProjectsSheets,
  markItemsMatchedSheets,
  markItemsInjectionSuspectedSheets,
  updateMatchStatusSheets,
  pruneProcessedMailSheets,
  checkSheetsTabs,
  PROPER_CANDIDATE_TAB,
  DRAFT_REQUEST_COLUMNS,
  MATCHED_COLUMN,
  JUDGE_COLUMN,
  INJECTION_COLUMN,
  LAST_SEEN_COLUMN,
  METRICS_TAB,
  METRICS_COLUMNS,
  RETIRED_PROPER_VERDICT,
  properEngineerIdOf,
  acquireBatchLeaseSheets,
  releaseBatchLeaseSheets,
  readStateJson,
} from '../../database/sheets.js';
import {
  saveProject,
  saveEngineer,
  saveMatch,
  saveSkillEquivalence,
  fetchOpenProjects,
  fetchAvailableEngineers,
  fetchJudgedMatchIds,
  fetchMatchLedger,
  fetchItemsByIds,
} from '../../database/index.js';
import { setDemoOverride } from '../config.js';
import { startRunClock, stopRunClock } from '../schedule.js';
import { matchIncrementally } from '../matchRun.js';
import { DRAFT_STATE } from '../../database/mapping.js';
import { __setMailTransportForTest } from '../mail/index.js';
import { __setDriveForTest, listSkillSheetFiles, type SkillSheetContent } from '../proper/drive.js';
import {
  __setSkillSheetExtractorForTest,
  syncProperMaster,
  resetProperMasterCache,
  loadProperEngineers,
  PROPER_MASTER_TAB,
  MISSING_FILE_MEMO,
} from '../proper/master.js';
import type { SkillSheetProfile } from '../proper/extractSkillSheet.js';
import { runProperFlow, activeProperEngineerIds } from '../proper/index.js';
import { collectSesMail } from '../collect.js';
import { markMailProcessed, loadFingerprintRecords, touchLastSeen } from '../store.js';
import { splitResends, serializeFingerprint } from '../resend.js';
import { recordFailure, recordSuccess, listQuarantined } from '../heal/quarantine.js';
import { resetHealEvents, hasFatal } from '../heal/events.js';
import { materializePendingDrafts } from '../pendingDrafts.js';
import { persistAndNotify, notifyResults, loadUnnotifiedMatches, rememberUnnotified, clearUnnotified } from '../notify.js';
import { buildReplyRef } from '../draft.js';
import { matchIdOf, __setMatchJudgeForTest } from '../match.js';
import { loadSuppressionIndex } from '../suppress.js';
import { INJECTION_REVIEW_REASON } from '../injection.js';
import { recordFeedback } from '../feedback.js';
import { recordLlmUsage } from '../../llm/usage.js';
import { SafeLogError } from '../redact.js';
import { parseAttachments } from '../parse.js';
import { FakeSheets, FakeDrive, FakeMailTransport, type FakeDriveFile } from './fakeGoogle.js';
import type { Project, Engineer, MatchResult, MatchCategory, ReplyTarget, SesRawMail } from '../../types/index.js';

// ===== 実行環境の隔離（外部の設定・鍵を一切拾わない） =====

const WORK_DIR = 'data/ses-flow-selftest';
const SES_BOOK = 'fakeSesBook';
const PROPER_BOOK = 'fakeProperBook';
const CONFLICT_BOOK = 'fakeConflictBook';
const OWN_DOMAIN = 'ourco.example.jp';
const SALES = `sales@${OWN_DOMAIN}`;
const FLOW_SIGNING_KEY = 's'.repeat(40);

const ENV_PREFIXES = [
  'SES_', 'PROPER_', 'XSERVER_', 'SHEETS_', 'NOTION_', 'GOOGLE_', 'ANTHROPIC_', 'GEMINI_', 'SKILL_', 'MATCH_',
  'MIN_GROSS_', 'MAX_CANDIDATES', 'NEGOTIATION_', 'ENABLE_NEGOTIATION', 'HOURLY_', 'MAIL_PROVIDER', 'DB_PROVIDER',
  'LLM_PROVIDER', 'DEMO_MODE', 'CI', 'GITHUB_ACTIONS', 'WEB_',
];

function isolateEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (ENV_PREFIXES.some((p) => key === p || key.startsWith(p))) delete process.env[key];
  }
  Object.assign(process.env, {
    DB_PROVIDER: 'sheets',
    MAIL_PROVIDER: 'xserver',
    SHEETS_DB_SPREADSHEET_ID: SES_BOOK,
    PROPER_MASTER_SPREADSHEET_ID: PROPER_BOOK,
    PROPER_SKILLSHEET_FOLDER_ID: 'folderRoot',
    PROPER_MAX_EXTRACT_PER_RUN: '2',
    PROPER_PROJECT_LOOKBACK_DAYS: '14',
    XSERVER_SHARED_USER: SALES,
    SES_OWN_DOMAINS: OWN_DOMAIN,
    SES_ALLOWED_SENDER_DOMAINS: OWN_DOMAIN,
    // 本番は署名鍵が無ければ担当者メールの依頼を受けない（pendingDrafts）。鍵の無い場合は個別の検証で外す
    SES_DRAFT_SIGNING_KEY: FLOW_SIGNING_KEY,
    SES_HEAL_ENABLED: 'false', // 抽出失敗の再試行の待ち時間を入れない
    SES_HEAL_MAX_ATTEMPTS: '2',
    SES_HEAL_DATA_DIR: `${WORK_DIR}/heal`,
    SES_REVIEW_DATA_DIR: `${WORK_DIR}/review`,
    SES_LOG_REDACT: 'false',
    SES_REQUIRE_LIVE: 'false',
  });
  setDemoOverride(false); // LLMの鍵が無くても本番経路を通す（LLMは呼ばない）
}

let networkAttempts = 0;

function blockNetwork(): void {
  globalThis.fetch = (async () => {
    networkAttempts += 1;
    throw new Error('ses:flow:check はオフラインで動作します（ネットワーク呼び出しを遮断）');
  }) as typeof fetch;
}

// ===== 判定・出力 =====

let failures = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failures += 1;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n■ ${title}`);
}

// 定時実行の1回分の開始（毎回クリーンな環境で動くため、プロセス内の行キャッシュ・イベントを捨てる）
function newRun(): void {
  resetSheetsCache();
  resetProperMasterCache();
  resetHealEvents();
}

// ===== 偽物 =====

const sheets = new FakeSheets();
const drive = new FakeDrive();
const mail = new FakeMailTransport();
let extractCalls: string[] = [];

interface ProfileSeed extends SkillSheetProfile {
  tag: string;
}

// スキルシートの「中身」はプロフィールのJSON（偽の抽出器がそのまま読む。JSONでなければ抽出失敗）
async function fakeExtract(content: SkillSheetContent): Promise<SkillSheetProfile> {
  const text = content.kind === 'pdf' ? Buffer.from(content.base64, 'base64').toString('utf-8') : content.text;
  const o = JSON.parse(text) as ProfileSeed;
  extractCalls.push(o.tag);
  const { tag: _tag, ...extracted } = o;
  return extracted;
}

function profileJson(p: ProfileSeed): string {
  return JSON.stringify(p);
}

// ===== テストデータ（架空） =====

const NOW = new Date();

function rt(name: string, from: string, subject: string, tag: string): ReplyTarget {
  return {
    from: `${name} <${from}>`,
    to: SALES,
    cc: '',
    subject,
    messageId: `<${tag}@flow.example.jp>`,
    references: '',
  };
}

function project(id: string, over: Partial<Project>): Project {
  return {
    id,
    title: '',
    requiredSkills: [],
    preferredSkills: [],
    rateMin: null,
    rateMax: null,
    location: '',
    prefecture: null,
    remote: 'unknown',
    startPeriod: '即日',
    startDate: null,
    duration: '6ヶ月',
    businessFlow: '',
    agentCompany: '',
    agentContact: '',
    agentEmail: '',
    sourceMailId: `sesmail_${id}`,
    receivedAt: NOW,
    status: 'open',
    ...over,
  };
}

function engineer(id: string, over: Partial<Engineer>): Engineer {
  return {
    id,
    displayName: '',
    age: null,
    skills: [],
    experienceYears: 5,
    desiredRate: null,
    residence: '',
    prefecture: null,
    nearestStation: '',
    availableDate: '即日',
    availableFrom: null,
    utilization: '',
    remoteWish: 'unknown',
    agentCompany: '',
    agentContact: '',
    agentEmail: '',
    sourceMailId: `sesmail_${id}`,
    receivedAt: NOW,
    status: 'available',
    ...over,
  };
}

const p1 = project('proj_flow_1', {
  title: '【検証】ECバックエンド刷新案件',
  requiredSkills: ['PHP', 'MySQL'],
  preferredSkills: ['AWS'],
  rateMin: 60,
  rateMax: 75,
  location: '東京都港区',
  prefecture: '東京都',
  remote: 'partial',
  agentCompany: '株式会社アルファ検証',
  agentContact: '検証花子',
  agentEmail: 'hanako@alpha.example.jp',
  replyTarget: rt('検証花子', 'hanako@alpha.example.jp', '【案件】ECバックエンド刷新（検証）', 'p1'),
});
const p2 = project('proj_flow_2', {
  title: '【検証】Python分析基盤構築案件',
  requiredSkills: ['Python', 'GCP'],
  rateMin: 70,
  rateMax: 80,
  location: 'フルリモート',
  remote: 'full',
  agentCompany: 'ベータ検証株式会社',
  agentContact: '検証次郎',
  agentEmail: 'jiro@beta.example.jp',
  replyTarget: rt('検証次郎', 'jiro@beta.example.jp', '【案件】Python分析基盤（検証）', 'p2'),
});
const p3 = project('proj_flow_3', {
  title: '【検証】Go決済API開発案件',
  requiredSkills: ['Go'],
  rateMin: 70,
  rateMax: 85,
  location: '東京都千代田区',
  prefecture: '東京都',
  agentCompany: 'ガンマ検証',
  agentContact: '検証三子',
  agentEmail: 'miko@gamma.example.jp',
  replyTarget: rt('検証三子', 'miko@gamma.example.jp', '【案件】Go決済API（検証）', 'p3'),
});
const e1 = engineer('eng_flow_1', {
  displayName: 'Z.Q.',
  skills: ['PHP', 'MySQL', 'AWS'],
  desiredRate: 58,
  residence: '東京都新宿区',
  prefecture: '東京都',
  agentCompany: 'デルタ検証',
  agentContact: '検証四郎',
  agentEmail: 'shiro@delta.example.jp',
  replyTarget: rt('検証四郎', 'shiro@delta.example.jp', '【要員】Z.Q. PHP（検証）', 'e1'),
});
const e2 = engineer('eng_flow_2', {
  displayName: 'W.X.',
  skills: ['Python', 'GCP'],
  desiredRate: 62,
  residence: '千葉県千葉市',
  prefecture: '千葉県',
  agentCompany: 'イプシロン検証',
  agentContact: '検証五郎',
  agentEmail: 'goro@epsilon.example.jp',
  replyTarget: rt('検証五郎', 'goro@epsilon.example.jp', '【要員】W.X. Python（検証）', 'e2'),
});
const e3 = engineer('eng_flow_3', {
  displayName: 'V.U.',
  skills: ['PHP', 'MySQL'],
  desiredRate: 55,
  residence: '神奈川県横浜市',
  prefecture: '神奈川県',
  agentCompany: 'ゼータ検証',
  agentContact: '検証六郎',
  agentEmail: 'rokuro@zeta.example.jp',
  replyTarget: rt('検証六郎', 'rokuro@zeta.example.jp', '【要員】V.U. PHP（検証）', 'e3'),
});
const PROJECTS = [p1, p2, p3];
const ENGINEERS = [e1, e2, e3];

function makeMatch(p: Project, e: Engineer, category: MatchCategory, reason = '検証用の判定根拠'): MatchResult {
  const drafts = category === 'confirmed' || category === 'negotiable';
  return {
    id: matchIdOf(p.id, e.id),
    projectId: p.id,
    engineerId: e.id,
    title: `${p.title} × ${e.displayName}`,
    grossMarginJpy: 150000,
    score: 90,
    reason,
    needsReview: category === 'review',
    band: 'strong',
    category,
    status: 'unconfirmed',
    detectedAt: NOW,
    ...(drafts
      ? {
          draftToProject: buildReplyRef(p.replyTarget, p.agentEmail, `【ご提案】${e.displayName}`, `${p.agentContact}様\n要員${e.displayName}をご提案します。`),
          draftToEngineer: buildReplyRef(e.replyTarget, e.agentEmail, `【ご紹介】${p.title}`, `${e.agentContact}様\n案件${p.title}をご紹介します。`),
        }
      : {}),
  };
}

const m11 = () => makeMatch(p1, e1, 'confirmed');
const m22 = () => makeMatch(p2, e2, 'confirmed');
const m12 = () => makeMatch(p1, e2, 'confirmed');
const m21 = () => ({
  ...makeMatch(p2, e1, 'negotiable'),
  negotiation: { projectRaiseMan: 2, engineerCutMan: 2, targetProjectRateMan: 82, targetEngineerRateMan: 56, resultingGrossMarginJpy: 260000 },
});
const m13 = () => makeMatch(p1, e3, 'confirmed');
const mR = () => makeMatch(p2, e3, 'review');
const allMatches = () => [m11(), m22(), m12(), m21(), m13(), mR()];

// 秘匿モードのログに出てはならない文字列（氏名・担当者名・メールアドレス・件名・案件名・要員の表示名）
const SENSITIVE: string[] = [
  ...PROJECTS.flatMap((p) => [p.title, p.agentContact, p.agentEmail, p.agentCompany, p.replyTarget!.subject]),
  ...ENGINEERS.flatMap((e) => [e.displayName, e.agentContact, e.agentEmail, e.agentCompany, e.replyTarget!.subject]),
  '山田太郎', '佐藤花子', '鈴木一郎', '高橋五月', '伊藤八郎', 'T.Y.', 'H.S.', 'G.T.',
  `taro@${OWN_DOMAIN}`, `fail@${OWN_DOMAIN}`, `boss@${OWN_DOMAIN}`, 'mallory@evil.example.com',
  '【要員】秘匿検証メール', 'nana@eta.example.jp', '090-1111-2222',
];

// 列定義（新規作成するタブの見出しの並び。意図しない並び替えをここで検出する）
const OLD_PROJECT_HEADER = [
  'ID', '案件名', '必須スキル', '尚可スキル', '単金下限', '単金上限', '勤務地', 'リモート',
  '開始時期', '開始日', '期間', '商流メモ', '営業元会社', '営業元担当', '営業元メール',
  '元メールID', '返信メタ', '受信日', 'ステータス',
];
const PROJECT_HEADER = [...OLD_PROJECT_HEADER, MATCHED_COLUMN, INJECTION_COLUMN, LAST_SEEN_COLUMN];
const ENGINEER_HEADER = [
  'ID', '表示名', 'スキル', '経験年数', '希望単金', '居住地', 'リモート希望', '稼働開始可能日',
  '営業元会社', '営業元担当', '営業元メール', '元メールID', '返信メタ', '受信日', 'ステータス',
];
const OLD_MATCH_HEADER = [
  'ID', 'マッチ名', '粗利額', '適合スコア', '判定根拠', '案件ID', '要員ID',
  '案件側下書きURL', '要員側下書きURL', 'ステータス', '検出日時',
];
const ALL_TABS = ['案件', '要員', 'マッチ', '自社社員', '評価', 'スキル同義', '処理済みメール', '_状態', METRICS_TAB, PROPER_CANDIDATE_TAB];

const STAMP = /^作成済 \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

// ===== 1. タブの自動生成とヘッダー移行 =====

async function testTabsAndHeaders(): Promise<void> {
  section('タブの自動生成・ヘッダー移行');
  sheets.createBook(SES_BOOK);
  // 旧バージョンのマッチタブ（担当者メール等の列が無い）と、その既存データ1行
  sheets.seedTab(SES_BOOK, 'マッチ', [
    OLD_MATCH_HEADER,
    ['match_legacy_1', '旧マッチ', 100000, 80, '旧根拠', 'proj_legacy', 'eng_legacy', '', '', '紹介済', '2026-01-01T00:00:00.000Z'],
  ]);
  // 旧バージョンの定義の後ろに人が列を足した要員タブ（増えた「突合済」列は人の列の後ろに追記する）
  sheets.seedTab(SES_BOOK, '要員', [[...ENGINEER_HEADER, '社内メモ']]);

  newRun();
  await fetchOpenProjects(10);
  const missing = ALL_TABS.filter((t) => !sheets.hasTab(SES_BOOK, t));
  check('不足していたタブを自動生成する', missing.length === 0, `未生成: ${missing.join(', ')}`);
  check('案件タブのヘッダー行が定義どおり', JSON.stringify(sheets.header(SES_BOOK, '案件')) === JSON.stringify(PROJECT_HEADER));
  check(
    '旧マッチタブの末尾に担当者メール等の列を追記する',
    JSON.stringify(sheets.header(SES_BOOK, 'マッチ')) === JSON.stringify([...OLD_MATCH_HEADER, ...DRAFT_REQUEST_COLUMNS, JUDGE_COLUMN]),
    sheets.header(SES_BOOK, 'マッチ').join(','),
  );
  const legacy = sheets.record(SES_BOOK, 'マッチ', 'ID', 'match_legacy_1');
  check('ヘッダー移行で既存の行を変えない', legacy?.['ステータス'] === '紹介済' && legacy?.['判定根拠'] === '旧根拠');
  check(
    '人が定義の後ろに足した列はそのまま残し、増えた定義の列はその後ろに追記する',
    JSON.stringify(sheets.header(SES_BOOK, '要員')) === JSON.stringify([...ENGINEER_HEADER, '社内メモ', MATCHED_COLUMN, '年齢', '稼働率', INJECTION_COLUMN, LAST_SEEN_COLUMN]),
    sheets.header(SES_BOOK, '要員').join(','),
  );
  check(
    '新規作成するタブは定義の列数だけの小さなグリッドにする（セル数の上限を無駄に使わない）',
    sheets.grid(SES_BOOK, '処理済みメール').columns === 5 && sheets.grid(SES_BOOK, '処理済みメール').rows <= 100,
    JSON.stringify(sheets.grid(SES_BOOK, '処理済みメール')),
  );
  const dropdown = sheets.validations.find((v) => v.spreadsheetId === SES_BOOK && v.options.includes('未確認'));
  check('新規作成した「プロパー候補」タブのステータス列にプルダウンを付ける', Boolean(dropdown) && dropdown!.column === 14);

  const writes = sheets.writeCount(SES_BOOK);
  const metaCalls = sheets.calls.filter((c) => c.method === 'batchUpdate').length;
  newRun();
  await fetchOpenProjects(10);
  check(
    '2回目の実行ではタブ・ヘッダーを作り直さない',
    sheets.writeCount(SES_BOOK) === writes && sheets.calls.filter((c) => c.method === 'batchUpdate').length === metaCalls,
  );
  check('既存のマッチIDを判定済みとして読む', (await fetchJudgedMatchIds()).has('match_legacy_1'));

  // 共有されていない等でスプレッドシートを開けない → 原因の分かる例外。次の呼び出しでは開き直す
  newRun();
  sheets.failNext('get', 403);
  let message = '';
  try {
    await fetchOpenProjects(10);
  } catch (err) {
    message = err instanceof SafeLogError ? err.message : `unexpected: ${String(err)}`;
  }
  check('開けないときは共有の確認を促す例外にする', message.includes('共有'), message);
  check('失敗後の呼び出しではタブの確認をやり直して読める', (await fetchOpenProjects(10)).length === 0);
}

// ===== 2. upsert の冪等性と人の列の保持 =====

async function saveAll(projects: Project[], engineers: Engineer[], matches: MatchResult[]): Promise<void> {
  for (const p of projects) await saveProject(p);
  for (const e of engineers) await saveEngineer(e);
  for (const m of matches) await saveMatch(m);
}

async function testUpsertIdempotency(): Promise<void> {
  section('案件・要員・マッチの upsert（2回の実行で行が増えない・人の列を保持）');
  newRun();
  await saveAll(PROJECTS, ENGINEERS, allMatches());
  const count = (tab: string) => sheets.records(SES_BOOK, tab).length;
  check('1回目: 案件3行・要員3行・マッチ7行（既存1行＋6行）', count('案件') === 3 && count('要員') === 3 && count('マッチ') === 7);
  const draftRow = sheets.record(SES_BOOK, 'マッチ', 'ID', m11().id);
  check(
    '下書きのあるマッチは状態「未作成」と文面・下書きデータを持つ',
    draftRow?.['案件側下書き状態'] === '未作成' &&
      draftRow?.['要員側下書き状態'] === '未作成' &&
      /^To: .*hanako@alpha\.example\.jp/.test(draftRow?.['案件側文面'] ?? '') &&
      draftRow?.['下書きデータ'].includes('"project"') === true,
  );
  const reviewRow = sheets.record(SES_BOOK, 'マッチ', 'ID', mR().id);
  check('要確認のマッチは下書き状態「不要」', reviewRow?.['案件側下書き状態'] === '不要' && reviewRow?.['要員側下書き状態'] === '不要');

  // 人の編集（次の実行までの間にシート上で行う操作）
  sheets.setByKey(SES_BOOK, '案件', 'ID', p3.id, 'ステータス', '終了');
  sheets.setByKey(SES_BOOK, '要員', 'ID', e3.id, 'ステータス', '決定済');
  sheets.setByKey(SES_BOOK, 'マッチ', 'ID', m11().id, 'ステータス', '紹介済');
  sheets.setByKey(SES_BOOK, 'マッチ', 'ID', m11().id, '担当者メール', `taro＠${OWN_DOMAIN}`);
  sheets.setByKey(SES_BOOK, 'マッチ', 'ID', m21().id, '案件側下書き状態', '不要');

  // 2回目（同じメールを再抽出した等で同じ案件・要員・マッチをもう一度保存する。機械の列は更新）
  newRun();
  const p1b = { ...p1, rateMax: 80 };
  const m11b = { ...m11(), reason: '更新後の判定根拠' };
  await saveAll([p1b, p2, p3], ENGINEERS, [m11b, m22(), m12(), m21(), m13(), mR()]);
  check('2回目: 行が増えない（案件3・要員3・マッチ7）', count('案件') === 3 && count('要員') === 3 && count('マッチ') === 7);
  const ids = sheets.records(SES_BOOK, 'マッチ').map((r) => r['ID']);
  check('マッチIDの重複行が無い', new Set(ids).size === ids.length);
  check('機械の列は最新の値に更新する（単金上限）', sheets.record(SES_BOOK, '案件', 'ID', p1.id)?.['単金上限'] === '80');
  check('案件のステータス（人が付けた「終了」）を再保存で巻き戻さない', sheets.record(SES_BOOK, '案件', 'ID', p3.id)?.['ステータス'] === '終了');
  check('要員のステータス（人が付けた「決定済」）を再保存で巻き戻さない', sheets.record(SES_BOOK, '要員', 'ID', e3.id)?.['ステータス'] === '決定済');
  const row11 = sheets.record(SES_BOOK, 'マッチ', 'ID', m11().id);
  check('マッチのステータス（紹介済）を保持', row11?.['ステータス'] === '紹介済');
  check('担当者メールを入力どおり保持（正規化もしない）', row11?.['担当者メール'] === `taro＠${OWN_DOMAIN}`);
  check('マッチの判定根拠は更新する', row11?.['判定根拠'] === '更新後の判定根拠');
  check('人が付けた下書き状態「不要」を保持', sheets.record(SES_BOOK, 'マッチ', 'ID', m21().id)?.['案件側下書き状態'] === '不要');

  const open = await fetchOpenProjects(100);
  const available = await fetchAvailableEngineers(100);
  check('終了にした案件は突合対象から外れる', open.length === 2 && !open.some((p) => p.id === p3.id));
  check('決定済にした要員は突合対象から外れる', available.length === 2 && !available.some((e) => e.id === e3.id));
  const back = open.find((p) => p.id === p1.id);
  check(
    '案件の読み戻し（スキル・単金・返信メタ）',
    back !== undefined &&
      back.requiredSkills.join(',') === 'PHP,MySQL' &&
      back.rateMax === 80 &&
      back.replyTarget?.messageId === '<p1@flow.example.jp>' &&
      back.prefecture === '東京都',
  );
}

// ===== 3. 空行を挟んだ表への追記・実行中の行挿入 =====

async function testShiftedRows(): Promise<void> {
  section('人が空行・行を差し込んでも別の行を上書きしない');
  newRun();
  await fetchJudgedMatchIds(); // 行キャッシュを読み込んだ状態にする
  const before = sheets.records(SES_BOOK, 'マッチ').length;
  // 実行中に人が3行目へ空行を挿入（以降の行が1行ずつ下がり、キャッシュの行番号はずれる）
  sheets.insertRowAt(SES_BOOK, 'マッチ', 3, []);
  const mNew = makeMatch(p3, e1, 'tentative');
  await saveMatch(mNew); // 追記（表は空行で途切れるため、表の途中に挿入され下の行がさらにずれる）
  await saveMatch({ ...mR(), reason: '空行の後の更新' }); // キャッシュ上の行番号がずれた既存行の更新
  const rows = sheets.records(SES_BOOK, 'マッチ');
  const ids = rows.map((r) => r['ID']);
  check('追記で1行だけ増え、重複しない', rows.length === before + 1 && new Set(ids).size === ids.length);
  check(
    'すべての行でIDと案件ID・要員IDが対応している（別の行を上書きしていない）',
    rows.every((r) => r['ID'] === 'match_legacy_1' || r['ID'] === matchIdOf(r['案件ID'], r['要員ID'])),
  );
  check('ずれた位置の既存行を正しく更新する', sheets.record(SES_BOOK, 'マッチ', 'ID', mR().id)?.['判定根拠'] === '空行の後の更新');
  newRun();
  const judged = await fetchJudgedMatchIds();
  check('次の実行で空行の前後の行をすべて読む', judged.has(mNew.id) && judged.has(mR().id) && judged.has('match_legacy_1'));
}

// ===== 3b. AI最終判定の関門・判定予算・再提案抑制 =====

const JUDGE_BOOK = 'fakeJudgeBook';

async function testJudgeGateAndSuppression(): Promise<void> {
  section('AI最終判定の関門・判定予算・再提案抑制（不適合は判定列に残す・未判定は次回判定・見送りの再送は載せない）');
  sheets.createBook(JUDGE_BOOK);
  process.env.SHEETS_DB_SPREADSHEET_ID = JUDGE_BOOK;
  const calls: string[] = [];
  const judgedProjects: string[] = [];
  // 偽のAI判定: eng_gate_ng は即NG（年齢）、それ以外は通過。1回あたり約1.6円を使ったことにする
  __setMatchJudgeForTest(async (pair) => {
    calls.push(pair.engineer.id);
    judgedProjects.push(pair.project.id);
    recordLlmUsage('claude-sonnet-5', 5000, 0);
    return pair.engineer.id === 'eng_gate_ng' || pair.project.id.startsWith('proj_bf_ng')
      ? { score: 30, reason: '年齢の上限を超えています', dealBreakers: ['age'], questions: [] }
      : { score: 82, reason: '条件に合っています', dealBreakers: [], questions: ['面談の日程は調整できますか？'] };
  });
  const gateProject = (id: string) =>
    project(id, {
      title: `【検証】Java保守案件 ${id}`,
      requiredSkills: ['Java', 'Spring Boot', 'Oracle'],
      rateMin: 60,
      rateMax: 70,
      location: '東京都港区',
      prefecture: '東京都',
      remote: 'partial',
      businessFlow: '45歳まで',
      agentCompany: 'ゼータ検証',
      agentContact: '検証七子',
      agentEmail: 'nanako@zeta-gate.example.jp',
      replyTarget: rt('検証七子', 'nanako@zeta-gate.example.jp', `【案件】Java保守（検証 ${id}）`, id),
    });
  // 必須3件のうち2件（参考提案）なので、判定を通っても下書きは作らない（生成AIを呼ばない）
  const gateEngineer = (id: string, name: string, over: Partial<Engineer> = {}) =>
    engineer(id, {
      displayName: name,
      skills: ['Java', 'Spring Boot'],
      desiredRate: 50,
      residence: '東京都',
      prefecture: '東京都',
      agentCompany: `エータ検証${name}`,
      agentContact: '検証八郎',
      agentEmail: `hachiro@eta-gate.example.jp`,
      replyTarget: rt('検証八郎', 'hachiro@eta-gate.example.jp', `【要員】${name}（検証）`, id),
      ...over,
    });
  const load = async () => {
    const projects = await fetchOpenProjects(100);
    const engineers = await fetchAvailableEngineers(100);
    return {
      projects,
      engineers,
      scope: {
        newProjectIds: new Set(projects.filter((p) => p.matched === false).map((p) => p.id)),
        newEngineerIds: new Set(engineers.filter((e) => e.matched === false).map((e) => e.id)),
        judgedMatchIds: await fetchJudgedMatchIds(),
      },
    };
  };
  const row = (projectId: string, engineerId: string) => sheets.record(JUDGE_BOOK, 'マッチ', 'ID', matchIdOf(projectId, engineerId));
  try {
    // 1回目: 予算の上限なし。通過は「通過」、即NGは「不適合」（下書きなし）で保存し、案件を突合済にする
    process.env.SES_JUDGE_BUDGET_JPY = '0';
    newRun();
    await saveProject(gateProject('proj_gate'));
    await saveEngineer(gateEngineer('eng_gate_ok', 'T.A.', { age: 41, utilization: '週4' }));
    await saveEngineer(gateEngineer('eng_gate_ng', 'T.B.'));
    const first = await load();
    const back = first.engineers.find((e) => e.id === 'eng_gate_ok');
    check('要員の年齢・稼働率を保存して読み戻す（最終判定の入力に使う）', back?.age === 41 && back.utilization === '週4', JSON.stringify([back?.age, back?.utilization]));
    const r1 = await matchIncrementally(first.projects, first.engineers, first.scope);
    const ok1 = row('proj_gate', 'eng_gate_ok');
    const ng1 = row('proj_gate', 'eng_gate_ng');
    check('AI判定を通った組は判定「通過」・確認事項を根拠に載せる', ok1?.[JUDGE_COLUMN] === '通過' && (ok1?.['判定根拠'] ?? '').includes('確認事項: 面談の日程'), ok1?.[JUDGE_COLUMN]);
    check(
      '即NGの組は判定「不適合」でマッチタブに残し、下書きは作らない',
      ng1?.[JUDGE_COLUMN] === '不適合' && ng1?.['案件側下書き状態'] === '不要' && (ng1?.['判定根拠'] ?? '').includes('即NG: 年齢') &&
        r1.saved.some((m) => m.category === 'rejected'),
      JSON.stringify([ng1?.[JUDGE_COLUMN], ng1?.['案件側下書き状態']]),
    );
    const judged1 = await fetchJudgedMatchIds();
    check('通過・不適合の組は判定済み（再判定しない）、案件は突合済', judged1.has(matchIdOf('proj_gate', 'eng_gate_ng')) && judged1.has(matchIdOf('proj_gate', 'eng_gate_ok')) &&
      Boolean(sheets.record(JUDGE_BOOK, '案件', 'ID', 'proj_gate')?.[MATCHED_COLUMN]));

    // 2回目: 予算1円。1件目の判定で使い切り、2件目は「未判定」で保存して案件を突合済にしない
    process.env.SES_JUDGE_BUDGET_JPY = '1';
    newRun();
    await saveProject(gateProject('proj_budget'));
    calls.length = 0;
    const second = await load();
    const r2 = await matchIncrementally(second.projects, second.engineers, second.scope);
    const deferred = r2.saved.filter((m) => m.category === 'deferred');
    const dRow = deferred[0] ? sheets.record(JUDGE_BOOK, 'マッチ', 'ID', deferred[0].id) : undefined;
    check('予算に達した後の組はAIを呼ばず「未判定」で保存する', calls.length === 1 && deferred.length === 1 && dRow?.[JUDGE_COLUMN] === '未判定', JSON.stringify(calls));
    check('未判定の組の下書き状態は「判定待ち」（依頼を受けない）', dRow?.['案件側下書き状態'] === DRAFT_STATE.awaitingJudge, dRow?.['案件側下書き状態']);
    check(
      '未判定の組は判定済みに含めず、その案件は突合済にしない（次回の実行で判定する）',
      !(await fetchJudgedMatchIds()).has(deferred[0]?.id ?? '') && !sheets.record(JUDGE_BOOK, '案件', 'ID', 'proj_budget')?.[MATCHED_COLUMN] && r2.deferredItems === 1,
    );

    // 3回目: 予算の上限なし。未判定の組を判定し、案件を突合済にする
    process.env.SES_JUDGE_BUDGET_JPY = '0';
    newRun();
    calls.length = 0;
    const third = await load();
    await matchIncrementally(third.projects, third.engineers, third.scope);
    const again = deferred[0] ? sheets.record(JUDGE_BOOK, 'マッチ', 'ID', deferred[0].id) : undefined;
    check(
      '次の回で未判定の組だけを判定し、判定列と下書き状態を更新する（参考提案なので「不要」）',
      calls.length === 1 && again?.[JUDGE_COLUMN] === '通過' && again?.['案件側下書き状態'] === '不要' &&
        Boolean(sheets.record(JUDGE_BOOK, '案件', 'ID', 'proj_budget')?.[MATCHED_COLUMN]),
      JSON.stringify([calls, again?.[JUDGE_COLUMN], again?.['案件側下書き状態']]),
    );
    newRun();
    await saveMatch({ ...makeMatch(p1, e1, 'deferred'), verdict: 'deferred' });
    await saveMatch({ ...makeMatch(p1, e1, 'confirmed'), verdict: 'passed' });
    check('「判定待ち」の側は判定後に文面が入ると「未作成」になる', row(p1.id, e1.id)?.['案件側下書き状態'] === '未作成');

    // 4回目: 見送り（マッチタブのステータス）とズレ（評価）の組の再送。単金がほぼ同じ再送は載せず、見送りの組で有利に大きく変わった再送は注意つきで通す
    sheets.setByKey(JUDGE_BOOK, 'マッチ', 'ID', matchIdOf('proj_gate', 'eng_gate_ok'), 'ステータス', '見送り');
    await recordFeedback({
      matchId: matchIdOf('proj_budget', 'eng_gate_ok'),
      matchTitle: '検証',
      verdict: 'bad',
      note: '',
      reviewer: '検証',
      at: new Date().toISOString(),
    });
    newRun();
    await saveEngineer(gateEngineer('eng_gate_ok2', 'T.A.', { desiredRate: 51, age: 41 }));
    await saveEngineer(gateEngineer('eng_gate_ok3', 'T.A.', { desiredRate: 45, age: 41 }));
    calls.length = 0;
    const fourth = await load();
    const suppression = await loadSuppressionIndex({ projects: fourth.projects, engineers: fourth.engineers });
    const r4 = await matchIncrementally(fourth.projects, fourth.engineers, fourth.scope, { suppression });
    check(
      '見送り・ズレの組の再送（単金の差が小さい）は判定も保存もしない（再提案抑制）',
      r4.primaryStats.suppressed === 3 && !row('proj_gate', 'eng_gate_ok2') && !row('proj_budget', 'eng_gate_ok2') && !calls.includes('eng_gate_ok2'),
      JSON.stringify(r4.primaryStats),
    );
    const changed = row('proj_gate', 'eng_gate_ok3')?.['判定根拠'] ?? '';
    check(
      '見送りの組で単金が有利に大きく変わった再送は「以前見送り」の注意つきで判定し、ズレの組は単金が変わっても載せない（スキルの不一致は変わらない）',
      r4.primaryStats.resuggested === 1 && changed.includes('以前「見送り」にした組の再送です（希望単金 50→45万円）') &&
        !row('proj_budget', 'eng_gate_ok3'),
      changed,
    );

    // 5回目: AIへの指示らしき記載のあるメールの案件（印を保存して読み戻す）の組は要確認（AI判定・下書きなし）。
    // 以前の版で保存したフルネームの表示名は、読み出しの時点でイニシャルにする
    newRun();
    await saveProject({ ...gateProject('proj_inject'), injectionSuspected: true });
    await saveEngineer(gateEngineer('eng_fullname', 'Yamada Taro', { agentEmail: 'hachiro@iota-gate.example.jp' }));
    await saveEngineer(gateEngineer('eng_kanji', '山田太郎', { agentEmail: 'hachiro@kappa-gate.example.jp' }));
    calls.length = 0;
    const fifth = await load();
    const injected = fifth.projects.find((p) => p.id === 'proj_inject');
    const names = ['eng_fullname', 'eng_kanji'].map((id) => fifth.engineers.find((e) => e.id === id)?.displayName);
    check(
      '指示混入疑いの印を保存して読み戻し、フルネームの表示名はイニシャル（決められなければ「（イニシャル不明）」）で読む',
      injected?.injectionSuspected === true && sheets.record(JUDGE_BOOK, '案件', 'ID', 'proj_inject')?.[INJECTION_COLUMN] === 'あり' &&
        names[0] === 'Y.T.' && names[1] === '（イニシャル不明）',
      JSON.stringify([injected?.injectionSuspected, names]),
    );
    await matchIncrementally(fifth.projects, fifth.engineers, fifth.scope);
    const injectedRows = sheets.records(JUDGE_BOOK, 'マッチ').filter((r) => r['案件ID'] === 'proj_inject');
    check(
      '指示混入疑いの案件の組は要確認（判定「ルールのみ」・下書き不要・根拠に理由）で、AI判定を呼ばない',
      injectedRows.length > 0 && !judgedProjects.includes('proj_inject') &&
        injectedRows.every((r) => r[JUDGE_COLUMN] === 'ルールのみ' && r['案件側下書き状態'] === '不要' && r['判定根拠'].includes(INJECTION_REVIEW_REASON)),
      JSON.stringify(injectedRows.map((r) => [r[JUDGE_COLUMN], r['案件側下書き状態']])),
    );

    // 6回目: 要員ごとの上限（1件）であふれた組は、上位の組が不適合になって枠が空けば同じ実行のうちに判定する
    process.env.MAX_PROJECTS_PER_ENGINEER = '1';
    newRun();
    const cobol = (id: string, rateMax: number) =>
      project(id, { ...gateProject(id), requiredSkills: ['COBOL', 'JCL'], rateMax, businessFlow: '' });
    await saveProject(cobol('proj_bf_ng1', 80));
    await saveProject(cobol('proj_bf_ok', 70));
    await markItemsMatchedSheets('project', ['proj_bf_ng1', 'proj_bf_ok']);
    await saveEngineer(gateEngineer('eng_bf', 'T.C.', { skills: ['COBOL', 'JCL'] }));
    calls.length = 0;
    const sixth = await load();
    await matchIncrementally(sixth.projects, sixth.engineers, sixth.scope);
    delete process.env.MAX_PROJECTS_PER_ENGINEER;
    check(
      '上限であふれた次点の組を、上位の組が不適合で空けた枠で同じ実行のうちに判定し、要員を突合済にする',
      row('proj_bf_ng1', 'eng_bf')?.[JUDGE_COLUMN] === '不適合' && row('proj_bf_ok', 'eng_bf')?.[JUDGE_COLUMN] === '通過' &&
        calls.filter((c) => c === 'eng_bf').length === 2 && Boolean(sheets.record(JUDGE_BOOK, '要員', 'ID', 'eng_bf')?.[MATCHED_COLUMN]),
      JSON.stringify([row('proj_bf_ng1', 'eng_bf')?.[JUDGE_COLUMN], row('proj_bf_ok', 'eng_bf')?.[JUDGE_COLUMN], calls]),
    );

    // 7回目: 判定待ちの組は、相手が突合の対象期間を外れても（プールに無くても）IDで読んで判定する
    process.env.SES_JUDGE_BUDGET_JPY = '1';
    newRun();
    const abap = (id: string, name: string) => gateEngineer(id, name, { skills: ['ABAP'], agentEmail: `${id}@theta-gate.example.jp` });
    await saveEngineer(abap('eng_pend1', 'T.D.'));
    await saveEngineer(abap('eng_pend2', 'T.E.'));
    await markItemsMatchedSheets('engineer', ['eng_pend1', 'eng_pend2']);
    await saveProject(project('proj_pend', { ...gateProject('proj_pend'), requiredSkills: ['ABAP'], businessFlow: '' }));
    const seventh = await load();
    const r7 = await matchIncrementally(seventh.projects, seventh.engineers, seventh.scope);
    const pendingPair = r7.saved.find((m) => m.category === 'deferred');
    delete process.env.SES_JUDGE_BUDGET_JPY;
    newRun();
    await markItemsMatchedSheets('project', ['proj_pend']); // 案件の組がほかに無くなり突合済になった状態
    const ledger = await fetchMatchLedger();
    const partnerId = pendingPair?.engineerId ?? '';
    const eighth = await load();
    const outOfPool = eighth.engineers.filter((e) => e.id !== partnerId); // 相手は対象期間の外
    const extra = await fetchItemsByIds(new Set(), new Set([partnerId]));
    calls.length = 0;
    await matchIncrementally(eighth.projects, outOfPool, { ...eighth.scope, capFreeMatchIds: ledger.capFree, pendingMatchIds: ledger.deferred }, {
      pendingItems: extra,
    });
    check(
      '判定待ちの組は、案件・要員が突合済で相手がプールに無くても次の回で判定する',
      Boolean(pendingPair) && ledger.deferred.has(pendingPair!.id) && calls.includes(partnerId) && row('proj_pend', partnerId)?.[JUDGE_COLUMN] === '通過',
      JSON.stringify([pendingPair?.id, [...ledger.deferred], calls, row('proj_pend', partnerId)?.[JUDGE_COLUMN]]),
    );
    const pendState = row('proj_pend', partnerId)?.['案件側下書き状態'] ?? '';
    check(
      '相手がプールに無い判定待ちの組も文面を用意できる（「文面を用意できませんでした」にしない）・次回の作業の列に残さない',
      pendState !== '' && !pendState.startsWith(DRAFT_STATE.genFailed) && !(await fetchMatchLedger()).deferred.has(pendingPair?.id ?? ''),
      pendState,
    );

    // 8回目: 判定待ちのまま相手が見つからなくなった組は「ルールのみ」で閉じ、判定待ちの状態を「不要」にする
    newRun();
    const lost = { ...makeMatch(gateProject('proj_lost'), abap('eng_lost', 'T.F.'), 'deferred'), verdict: 'deferred' as const };
    await saveMatch(lost);
    const ledger8 = await fetchMatchLedger();
    const ninth = await load();
    const r9 = await matchIncrementally(ninth.projects, ninth.engineers, { ...ninth.scope, pendingMatchIds: ledger8.deferred });
    const lostRow = sheets.record(JUDGE_BOOK, 'マッチ', 'ID', lost.id);
    check(
      '相手の見つからない判定待ちの組は閉じる（判定「ルールのみ」・下書き状態「不要」）',
      r9.closedPending === 1 && lostRow?.[JUDGE_COLUMN] === 'ルールのみ' && lostRow?.['案件側下書き状態'] === '不要' && !(await fetchMatchLedger()).deferred.has(lost.id),
      JSON.stringify([r9.closedPending, lostRow?.[JUDGE_COLUMN], lostRow?.['案件側下書き状態']]),
    );

    // 9回目: 文面の作り直し待ちの組も、相手が見つからなくなれば閉じる（判定は残し、下書き状態を「不要」に）
    newRun();
    const regen: MatchResult = {
      ...makeMatch(gateProject('proj_regen'), abap('eng_regen', 'T.G.'), 'confirmed'),
      draftToProject: undefined,
      draftToEngineer: undefined,
      draftFailed: true,
      verdict: 'passed',
    };
    await saveMatch(regen);
    const ledgerR = await fetchMatchLedger();
    const tenth = await load();
    const r10 = await matchIncrementally(tenth.projects, tenth.engineers, { ...tenth.scope, pendingMatchIds: ledgerR.deferred });
    const regenRow = sheets.record(JUDGE_BOOK, 'マッチ', 'ID', regen.id);
    check(
      '相手の見つからない作り直し待ちの組は閉じる（判定「通過」は残し・下書き状態「不要」・作業の列から外す）',
      ledgerR.deferred.has(regen.id) && r10.closedPending === 1 && regenRow?.[JUDGE_COLUMN] === '通過' &&
        regenRow?.['案件側下書き状態'] === '不要' && !(await fetchMatchLedger()).deferred.has(regen.id),
      JSON.stringify([r10.closedPending, regenRow?.[JUDGE_COLUMN], regenRow?.['案件側下書き状態']]),
    );

    // 10回目: 最終判定のAIが指示らしき記載を見つけた案件は「指示混入疑い」を保存し、次の実行の組はAI判定・自動の下書きに回さない
    newRun();
    const taintCalls: string[] = [];
    __setMatchJudgeForTest(async (pair) => {
      taintCalls.push(pair.engineer.id);
      const tainted = pair.project.id === 'proj_taint';
      return { score: 90, reason: '条件に合っています', dealBreakers: [], questions: [], injectionSuspected: tainted, injectionSource: tainted ? 'project' : 'unknown' };
    });
    await saveProject(project('proj_taint', { ...gateProject('proj_taint'), requiredSkills: ['Rust'], businessFlow: '' }));
    await saveEngineer(gateEngineer('eng_taint1', 'T.H.', { skills: ['Rust'], agentEmail: 'h@lambda-gate.example.jp' }));
    const eleventh = await load();
    await matchIncrementally(eleventh.projects, eleventh.engineers, eleventh.scope);
    const taint1 = row('proj_taint', 'eng_taint1');
    newRun();
    await saveEngineer(gateEngineer('eng_taint2', 'T.I.', { skills: ['Rust'], agentEmail: 'i@mu-gate.example.jp' }));
    taintCalls.length = 0;
    const twelfth = await load();
    await matchIncrementally(twelfth.projects, twelfth.engineers, twelfth.scope);
    const taint2 = row('proj_taint', 'eng_taint2');
    check(
      'AI判定が指示を見つけた案件に「指示混入疑い」を保存し（要員には付けない）、次の実行の組はAI判定を呼ばず要確認・下書きなし',
      taint1?.['案件側下書き状態'] === '不要' && sheets.record(JUDGE_BOOK, '案件', 'ID', 'proj_taint')?.[INJECTION_COLUMN] === 'あり' &&
        sheets.record(JUDGE_BOOK, '要員', 'ID', 'eng_taint1')?.[INJECTION_COLUMN] === '' && !taintCalls.includes('eng_taint2') &&
        (taint2?.['判定根拠'] ?? '').includes(INJECTION_REVIEW_REASON) && taint2?.['案件側下書き状態'] === '不要',
      JSON.stringify([taint1?.['案件側下書き状態'], taintCalls, taint2?.[JUDGE_COLUMN], taint2?.['案件側下書き状態']]),
    );
    // 同じメールを抽出し直して印の無い案件として保存し直しても、AI判定が付けた印は消さない（外すのは人だけ）
    newRun();
    const tainted = twelfth.projects.find((p) => p.id === 'proj_taint')!;
    await saveProjectsSheets([{ ...tainted, injectionSuspected: false }]);
    check(
      '指示混入疑いの印は、同じ案件を印なしで保存し直しても残る',
      sheets.record(JUDGE_BOOK, '案件', 'ID', 'proj_taint')?.[INJECTION_COLUMN] === 'あり',
      sheets.record(JUDGE_BOOK, '案件', 'ID', 'proj_taint')?.[INJECTION_COLUMN],
    );

    // 13回目: 認証・残高・モデル名の誤り（組によらない失敗）は「判定失敗」で埋もれさせず、未判定で次回に回す（突合済にしない）。
    // 最初の1件の後はAIを呼ばない。直った次の実行で判定する
    newRun();
    const acctCalls: string[] = [];
    __setMatchJudgeForTest(async (pair) => {
      acctCalls.push(pair.engineer.id);
      throw Object.assign(new Error('Your credit balance is too low'), { status: 400 });
    });
    await saveProject(project('proj_acct', { ...gateProject('proj_acct'), requiredSkills: ['Haskell'], businessFlow: '' }));
    await saveEngineer(gateEngineer('eng_acct1', 'A.A.', { skills: ['Haskell'], agentEmail: 'a@acct1-gate.example.jp' }));
    for (const n of [2, 3, 4, 5, 6]) {
      await saveEngineer(gateEngineer(`eng_acct${n}`, `A.${'BCDEF'[n - 2]}.`, { skills: ['Haskell'], agentEmail: `x@acct${n}-gate.example.jp` }));
    }
    const acctLoad = await load();
    await matchIncrementally(acctLoad.projects, acctLoad.engineers, acctLoad.scope);
    const acct1 = row('proj_acct', 'eng_acct1');
    const acct2 = row('proj_acct', 'eng_acct2');
    check(
      'アカウント・設定のエラーの組は未判定で保存し（判定済みにしない）、案件を突合済にせず、同時に始めた分の後はAIを呼ばない',
      acct1?.[JUDGE_COLUMN] === '未判定' && acct2?.[JUDGE_COLUMN] === '未判定' && acctCalls.length <= 3 &&
        !(await fetchJudgedMatchIds()).has(matchIdOf('proj_acct', 'eng_acct1')) &&
        !sheets.record(JUDGE_BOOK, '案件', 'ID', 'proj_acct')?.[MATCHED_COLUMN] && hasFatal(),
      JSON.stringify([acct1?.[JUDGE_COLUMN], acct2?.[JUDGE_COLUMN], acctCalls]),
    );
    newRun();
    __setMatchJudgeForTest(async () => ({ score: 90, reason: '条件に合っています', dealBreakers: [], questions: [], injectionSuspected: false, injectionSource: 'unknown' }));
    const acctRetry = await load();
    await matchIncrementally(acctRetry.projects, acctRetry.engineers, acctRetry.scope);
    check(
      '直った次の実行で未判定の組を判定する',
      row('proj_acct', 'eng_acct1')?.[JUDGE_COLUMN] === '通過' && row('proj_acct', 'eng_acct2')?.[JUDGE_COLUMN] === '通過',
      JSON.stringify([row('proj_acct', 'eng_acct1')?.[JUDGE_COLUMN], row('proj_acct', 'eng_acct2')?.[JUDGE_COLUMN]]),
    );
  } finally {
    __setMatchJudgeForTest(null);
    delete process.env.SES_JUDGE_BUDGET_JPY;
    delete process.env.MAX_PROJECTS_PER_ENGINEER;
    process.env.SHEETS_DB_SPREADSHEET_ID = SES_BOOK;
  }
}

// ===== 4. 処理済みメールIDの持ち越し =====

function rawMail(id: string, from: string, subject: string, minutesAgo: number): SesRawMail {
  return {
    id,
    from,
    to: SALES,
    cc: '',
    subject,
    body: '検証用の本文',
    messageIdHeader: `<${id}@flow.example.jp>`,
    references: '',
    receivedAt: new Date(NOW.getTime() - minutesAgo * 60_000),
    attachments: [],
    sheetLinks: [],
  };
}

async function testProcessedIds(): Promise<void> {
  section('処理済みメールIDの持ち越し（次の実行で本文を取得し直さない）');
  mail.inbox = [
    rawMail('sesmail_flow_a', '検証花子 <hanako@alpha.example.jp>', '【案件】検証A', 30),
    rawMail('sesmail_flow_b', '検証次郎 <jiro@beta.example.jp>', '【要員】検証B', 20),
    rawMail('sesmail_flow_self', SALES, 'SES案件・要員マッチング バッチ実行結果（10:00）', 10),
    rawMail('sesmail_flow_own', `taro@${OWN_DOMAIN}`, 'Re: 【案件】検証A', 5),
  ];
  newRun();
  const r1 = await collectSesMail();
  check(
    '1回目: 外部のメール2件を新しい順に返し、自分たちのメール2件を除外する',
    r1.mails.map((m) => m.id).join(',') === 'sesmail_flow_b,sesmail_flow_a' && r1.excludedMailIds.length === 2,
  );
  const saved =
    (await markMailProcessed(r1.mails.map((m) => m.id), '抽出済')) && (await markMailProcessed(r1.excludedMailIds, '除外'));
  const rows = sheets.records(SES_BOOK, '処理済みメール');
  check('処理済みメールタブに4行（結果つき）', saved && rows.length === 4 && rows.filter((r) => r['結果'] === '除外').length === 2);

  newRun();
  mail.skippedAsProcessed = [];
  const r2 = await collectSesMail();
  check('2回目: 処理済みの4件は本文を取得しない', r2.mails.length === 0 && mail.skippedAsProcessed.length === 4);
  await markMailProcessed(['sesmail_flow_a'], '抽出済');
  check('同じIDをもう一度記録しても行は増えない', sheets.records(SES_BOOK, '処理済みメール').length === 4);
  sheets.failNext('values.append', 429, '処理済みメール');
  const retried = await markMailProcessed(['sesmail_flow_quota'], '抽出済');
  check(
    'クォータ超過（429）は待って再試行し、1行だけ記録する',
    retried && sheets.records(SES_BOOK, '処理済みメール').filter((r) => r['メールID'] === 'sesmail_flow_quota').length === 1,
  );

  mail.inbox.push(rawMail('sesmail_flow_c', '検証三子 <miko@gamma.example.jp>', '【案件】検証C', 1));
  newRun();
  const r3 = await collectSesMail();
  check('3回目: 新着の1件だけを返す', r3.mails.map((m) => m.id).join(',') === 'sesmail_flow_c');

  newRun();
  sheets.failNext('values.get', 403, '処理済みメール');
  let threw = false;
  try {
    await collectSesMail();
  } catch {
    threw = true;
  }
  check('処理済みIDを読めないときは空とみなさず収集失敗にする（全件の再抽出を防ぐ）', threw);
}

// ===== 5. 隔離リストの持ち越し =====

async function testQuarantine(): Promise<void> {
  section('隔離リスト（_状態タブ）の持ち越し');
  const broken = rawMail('sesmail_flow_broken', '検証七子 <nana@eta.example.jp>', '【要員】検証 090-1111-2222', 60);
  newRun();
  const f1 = await recordFailure(broken, new Error('解析失敗 nana@eta.example.jp'));
  check('1回目の失敗: 1回目・未隔離', f1.attempts === 1 && !f1.quarantined);
  newRun();
  const f2 = await recordFailure(broken, new Error('解析失敗 nana@eta.example.jp'));
  check('2回目の失敗（別の実行）: 回数を引き継いで隔離（上限2回）', f2.attempts === 2 && f2.quarantined);
  newRun();
  const writes = sheets.writeCount(SES_BOOK, '_状態');
  await recordSuccess('sesmail_flow_unknown');
  check('無関係なメールの成功では状態を書き直さない', sheets.writeCount(SES_BOOK, '_状態') === writes);
  const list = await listQuarantined();
  const stateRows = sheets.records(SES_BOOK, '_状態');
  check('次の実行でも隔離済みとして読める', list.length === 1 && list[0].mailId === broken.id && list[0].attempts === 2);
  check('_状態タブの行は1つ（キー quarantine）', stateRows.length === 1 && stateRows[0]['キー'] === 'quarantine');
  const json = stateRows[0]?.['JSON'] ?? '';
  check(
    '隔離リストに電話番号・アドレス・氏名を残さない（送信元はドメインのみ）',
    !json.includes('090-1111-2222') && !json.includes('nana@') && !json.includes('検証七子') && list[0]?.from === '@eta.example.jp',
  );
}

// ===== 6. 担当者メールによる下書き作成 =====

async function testPendingDrafts(): Promise<void> {
  section('担当者メールによる下書き作成（作成済・エラー・不要・許可ドメイン・再作成しない）');
  sheets.setByKey(SES_BOOK, 'マッチ', 'ID', m22().id, '担当者メール', 'mallory@evil.example.com');
  sheets.setByKey(SES_BOOK, 'マッチ', 'ID', m12().id, '担当者メール', 'not-an-address');
  sheets.setByKey(SES_BOOK, 'マッチ', 'ID', m21().id, '担当者メール', `jiro@${OWN_DOMAIN}`);
  sheets.setByKey(SES_BOOK, 'マッチ', 'ID', m13().id, '担当者メール', `fail@${OWN_DOMAIN}`);
  sheets.setByKey(SES_BOOK, 'マッチ', 'ID', mR().id, '担当者メール', `taro@${OWN_DOMAIN}`);
  mail.failDraftFrom.add(`fail@${OWN_DOMAIN}`);
  mail.drafts = [];

  newRun();
  // 一覧を読んだ後・1件目の行の読み直しの直前に、人がデータ行の先頭へ行を挿入する（全行が1行ずつ下がる）
  sheets.beforeNext('values.get', () =>
    sheets.beforeNext('values.batchGet', () => sheets.insertRowAt(SES_BOOK, 'マッチ', 2, ['match_human_note', '人が追加した行'])),
  );
  const r1 = await materializePendingDrafts();
  const row = (m: MatchResult) => sheets.record(SES_BOOK, 'マッチ', 'ID', m.id);
  check('1回目: 作成3件・失敗6件', r1.created === 3 && r1.failed === 6, JSON.stringify(r1));
  check(
    '有効な担当者メール（全角＠も可）の行は両側とも「作成済 日時」',
    STAMP.test(row(m11())?.['案件側下書き状態'] ?? '') && STAMP.test(row(m11())?.['要員側下書き状態'] ?? ''),
  );
  const draftsFrom = (addr: string) => mail.drafts.filter((d) => d.from === addr);
  const taro = draftsFrom(`taro@${OWN_DOMAIN}`);
  check(
    '送信元は正規化した担当者メール・宛先は元メールの送信者・Ccに本人を含めない',
    taro.length === 2 &&
      taro.some((d) => d.ref.to.includes('hanako@alpha.example.jp')) &&
      taro.every((d) => !(d.ref.cc ?? '').includes(`taro@${OWN_DOMAIN}`)),
  );
  check(
    '許可されていないドメインはエラー（作成しない）',
    (row(m22())?.['案件側下書き状態'] ?? '').startsWith('エラー: 送信元ドメインが許可されていません') &&
      draftsFrom('mallory@evil.example.com').length === 0,
  );
  check('形式の誤った担当者メールはエラー', (row(m12())?.['要員側下書き状態'] ?? '').startsWith('エラー: 担当者メールの形式'));
  check(
    '「不要」の側は作らず、もう片側だけ作る',
    row(m21())?.['案件側下書き状態'] === '不要' && STAMP.test(row(m21())?.['要員側下書き状態'] ?? '') && draftsFrom(`jiro@${OWN_DOMAIN}`).length === 1,
  );
  check('両側「不要」の行（要確認）は何も作らない', row(mR())?.['案件側下書き状態'] === '不要' && row(mR())?.['要員側下書き状態'] === '不要');
  const failState = row(m13())?.['案件側下書き状態'] ?? '';
  check('作成に失敗した側は「エラー: 理由」', failState.startsWith('エラー: 下書きの作成に失敗しました'), failState);
  const stateCells = sheets
    .records(SES_BOOK, 'マッチ')
    .flatMap((r) => [r['案件側下書き状態'], r['要員側下書き状態']]);
  check('状態列にメールアドレスを書かない', stateCells.every((c) => !c.includes('@')));
  const note = sheets.record(SES_BOOK, 'マッチ', 'ID', 'match_human_note');
  check(
    '実行中に人が挿入した行には書き込まない（行のずれを検知して正しい行へ）',
    note !== undefined && note['マッチ名'] === '人が追加した行' && note['案件側下書き状態'] === '' && note['要員側下書き状態'] === '',
  );

  // 2回目: 失敗の原因が解消 → エラーの側だけを再作成。作成済は作り直さず、変わらないエラーは書き直さない
  mail.failDraftFrom.clear();
  newRun();
  const writes = sheets.writeCount(SES_BOOK, 'マッチ');
  const r2 = await materializePendingDrafts();
  check('2回目: エラーだった2件だけを作成（作成済は作り直さない）', r2.created === 2 && mail.drafts.length === 5, JSON.stringify(r2));
  check('2回目: 書き込みは再作成した行の2回（作成中→作成済）だけ', sheets.writeCount(SES_BOOK, 'マッチ') - writes === 2);
  check('再作成した側は作成済', STAMP.test(row(m13())?.['案件側下書き状態'] ?? ''));

  newRun();
  const r3 = await materializePendingDrafts();
  check('3回目: 新たに作成しない', r3.created === 0 && mail.drafts.length === 5);

  // 下書き作成後に状態を書き戻せなかった → 「作成中」のまま残し、次の実行で二重に作らない
  sheets.setByKey(SES_BOOK, 'マッチ', 'ID', m22().id, '担当者メール', `hanako2@${OWN_DOMAIN}`);
  newRun();
  sheets.beforeNext('values.batchUpdate', () =>
    sheets.beforeNext('values.batchUpdate', () => sheets.failNext('values.batchUpdate', 403, 'マッチ')),
  );
  const r4 = await materializePendingDrafts();
  check(
    '作成後に状態を書き戻せなければ「作成中 日時」のまま残す',
    r4.created === 2 &&
      /^作成中 \d{4}-\d{2}-\d{2} \d{2}:\d{2} #[A-Za-z0-9_-]{6,}$/.test(row(m22())?.['案件側下書き状態'] ?? '') &&
      (row(m22())?.['要員側下書き状態'] ?? '').startsWith('作成中'),
    JSON.stringify(r4),
  );
  newRun();
  const draftsBefore = mail.drafts.length;
  const r5 = await materializePendingDrafts();
  check('「作成中」の行は次の実行で作り直さない（二重作成の防止）', mail.drafts.length === draftsBefore);
  check(
    '「作成中」のまま残った側は、下書きフォルダに同じ識別子の下書きがあれば「作成済」にする',
    (row(m22())?.['案件側下書き状態'] ?? '').startsWith('作成済') && (row(m22())?.['要員側下書き状態'] ?? '').startsWith('作成済') && r5.stale === 0,
    JSON.stringify(r5),
  );

  // 下書きの作成は済んだのに応答だけ失敗した（エラーになった）側は、次回の再試行の前に下書きフォルダを確かめて二重に作らない
  sheets.setByKey(SES_BOOK, 'マッチ', 'ID', m12().id, '担当者メール', `amb@${OWN_DOMAIN}`);
  mail.ambiguousDraftFrom.add(`amb@${OWN_DOMAIN}`);
  newRun();
  const beforeAmb = mail.drafts.length;
  await materializePendingDrafts();
  const afterFirst = mail.drafts.length;
  mail.ambiguousDraftFrom.clear();
  newRun();
  await materializePendingDrafts();
  check(
    '応答だけ失敗した下書きは、次回の再試行で下書きフォルダに見つかれば作り直さず「作成済」にする',
    afterFirst - beforeAmb === 2 && mail.drafts.length === afterFirst && (row(m12())?.['案件側下書き状態'] ?? '').startsWith('作成済'),
    `${beforeAmb}→${afterFirst}→${mail.drafts.length} / ${row(m12())?.['案件側下書き状態']}`,
  );
  check(
    '作成した下書きには識別子のヘッダ（X-SES-Draft-Key）の値を付ける',
    mail.drafts.slice(beforeAmb).every((d) => /^[A-Za-z0-9_-]{24}$/.test(d.ref.draftKey ?? '')),
  );

  // 作成済になった側の文面・下書きデータは再保存で差し替えない
  const textBefore = row(m11())?.['案件側文面'];
  const changed = m11();
  changed.draftToProject = { ...changed.draftToProject!, body: '差し替え後の本文' };
  newRun();
  await saveMatch(changed);
  check('作成済の側の文面は再保存で差し替えない', row(m11())?.['案件側文面'] === textBefore && STAMP.test(row(m11())?.['案件側下書き状態'] ?? ''));
}

// ===== 7. プロパー管理表の同期 =====

const FILE_TIME = (day: number) => `2026-09-${String(day).padStart(2, '0')}T00:00:00.000Z`;

function profile(tag: string, over: Partial<ProfileSeed>): ProfileSeed {
  return {
    tag,
    displayName: '',
    initials: '',
    skills: [],
    experienceYears: 5,
    residence: '',
    prefecture: null,
    remoteWish: 'unknown',
    availableDateText: '',
    availableFromIso: null,
    desiredRateMan: null,
    ...over,
  };
}

const PROFILE_A = profile('A', {
  displayName: '山田太郎',
  initials: 'T.Y.',
  skills: ['PHP', 'MySQL', 'AWS'],
  experienceYears: 8,
  residence: '東京都世田谷区',
  prefecture: '東京都',
  remoteWish: 'partial',
  availableDateText: '即日',
});
const PROFILE_B = profile('B', {
  displayName: '佐藤花子',
  initials: 'H.S.',
  skills: ['Python', 'GCP', 'SQL'],
  residence: '千葉県千葉市',
  prefecture: '千葉県',
  remoteWish: 'full',
  availableDateText: '2026年10月〜',
  availableFromIso: '2026-10-01',
});
const PROFILE_C = profile('C', { displayName: '鈴木一郎', skills: ['Java'], residence: '大阪府大阪市', prefecture: '大阪府' });

function driveFile(id: string, over: Partial<FakeDriveFile>): FakeDriveFile {
  return { id, name: `${id}.pdf`, mimeType: 'application/pdf', modifiedTime: FILE_TIME(1), parents: ['folderRoot'], ...over };
}

const GDOC = 'application/vnd.google-apps.document';

async function testProperMaster(): Promise<void> {
  section('プロパー管理表の同期（新規・更新・変更なし・抽出上限・所在不明）');
  sheets.createBook(PROPER_BOOK);
  drive.put({ id: 'folderSub', name: 'sub', mimeType: 'application/vnd.google-apps.folder', modifiedTime: FILE_TIME(1), parents: ['folderRoot'] });
  drive.put(driveFile('fileA', { name: 'スキルシート_山田太郎', mimeType: GDOC, modifiedTime: FILE_TIME(1), content: profileJson(PROFILE_A) }));
  drive.put(driveFile('fileB', { name: 'スキルシート_佐藤花子.pdf', parents: ['folderSub'], modifiedTime: FILE_TIME(2), content: profileJson(PROFILE_B) }));
  drive.put(driveFile('fileC', { name: '鈴木一郎', mimeType: GDOC, parents: ['folderSub'], modifiedTime: FILE_TIME(3), content: profileJson(PROFILE_C) }));
  drive.put(driveFile('fileD', { name: 'photo.png', mimeType: 'image/png', content: 'png' }));

  const master = () => sheets.records(PROPER_BOOK, PROPER_MASTER_TAB);
  const byFile = (id: string) => sheets.record(PROPER_BOOK, PROPER_MASTER_TAB, 'ファイルID', id);

  // 1回目: 抽出上限2件 → 更新の新しい C・B を抽出し、A は次回へ
  newRun();
  extractCalls = [];
  const s1 = await syncProperMaster();
  check(
    '1回目: 対応形式3件・新規2件・次回へ保留1件・未対応形式1件',
    s1.listed === 3 && s1.added === 2 && s1.deferred === 1 && s1.unsupportedNames.length === 1,
    JSON.stringify({ ...s1, presentFileIds: undefined, unsupportedNames: s1.unsupportedNames.length }),
  );
  check('抽出は上限（2件）まで・更新の新しい順', extractCalls.join(',') === 'C,B', extractCalls.join(','));
  check('サブフォルダとページ送りをたどって一覧を取得する', drive.listCalls >= 3);
  const rowB = byFile('fileB');
  check(
    '新規ファイルは行を追加し、稼働状況「稼働可」・氏名・提案用表記・稼働可能日を埋める',
    rowB?.['稼働状況'] === '稼働可' && rowB?.['氏名'] === '佐藤花子' && rowB?.['提案用表記'] === 'H.S.' && rowB?.['稼働可能日'] === '2026-10-01',
  );
  check('イニシャルを読み取れない行は抽出メモで入力を促す', (byFile('fileC')?.['抽出メモ'] ?? '').includes('イニシャル'));
  check(
    '管理表の稼働状況列にプルダウンを付ける',
    sheets.validations.some((v) => v.spreadsheetId === PROPER_BOOK && v.options.join(',') === '稼働可,アサイン済,対象外'),
  );

  // 人の入力
  sheets.setByKey(PROPER_BOOK, PROPER_MASTER_TAB, 'ファイルID', 'fileB', '氏名', '佐藤 花子（確認済）');
  sheets.setByKey(PROPER_BOOK, PROPER_MASTER_TAB, 'ファイルID', 'fileB', '必要案件単価', '６５万円');
  sheets.setByKey(PROPER_BOOK, PROPER_MASTER_TAB, 'ファイルID', 'fileC', '稼働状況', 'アサイン済');

  // 2回目: B を更新（氏名・スキルが変わる）。A は初回抽出、C は変更なし
  drive.put(
    driveFile('fileB', {
      name: 'スキルシート_佐藤花子.pdf',
      parents: ['folderSub'],
      modifiedTime: FILE_TIME(10),
      content: profileJson({ ...PROFILE_B, displayName: '佐藤花子（改）', skills: ['Python', 'GCP', 'SQL', 'BigQuery'] }),
    }),
  );
  newRun();
  extractCalls = [];
  const s2 = await syncProperMaster();
  check('2回目: 更新のBと保留していたAだけを抽出（変更のないCは抽出しない）', [...extractCalls].sort().join(',') === 'A,B', extractCalls.join(','));
  check('2回目: 追加1・更新1・変更なし1', s2.added === 1 && s2.updated === 1 && s2.unchanged === 1);
  const rowB2 = byFile('fileB');
  check(
    '更新時も人が入力した氏名・必要案件単価は書き換えない',
    rowB2?.['氏名'] === '佐藤 花子（確認済）' && rowB2?.['必要案件単価'] === '６５万円',
  );
  check('更新時に機械の列（スキル・ファイル更新日時）は更新する', (rowB2?.['スキル'] ?? '').includes('BigQuery') && rowB2?.['ファイル更新日時'] === FILE_TIME(10));
  check('人が変えた稼働状況（アサイン済）を保持', byFile('fileC')?.['稼働状況'] === 'アサイン済');
  check('保留していたファイルは次の実行で追加される', byFile('fileA')?.['稼働状況'] === '稼働可' && master().length === 3);

  // 3回目: 何も変わらない → 抽出も書き込みもしない
  newRun();
  extractCalls = [];
  const writes = sheets.writeCount(PROPER_BOOK);
  const s3 = await syncProperMaster();
  check('3回目: 変更が無ければLLM抽出も管理表への書き込みもしない', extractCalls.length === 0 && sheets.writeCount(PROPER_BOOK) === writes && s3.unchanged === 3);

  // 4回目以降: 抽出に失敗するファイル E と、フォルダから消えた C
  drive.put(driveFile('fileE', { name: 'broken.pdf', modifiedTime: FILE_TIME(11), content: 'これはJSONではない' }));
  drive.files.get('fileC')!.trashed = true;
  newRun();
  extractCalls = [];
  const s4 = await syncProperMaster();
  const memoE = byFile('fileE')?.['抽出メモ'] ?? '';
  check('抽出失敗は抽出メモに回数つきで残し、次回再試行する', s4.failed === 1 && memoE.startsWith('エラー') && memoE.includes('（1回目）') && byFile('fileE')?.['ファイル更新日時'] === '', memoE);
  check('フォルダから消えたファイルの行に「ファイルが見つかりません」を付ける', s4.missing === 1 && (byFile('fileC')?.['抽出メモ'] ?? '').startsWith(MISSING_FILE_MEMO));
  const engineers = await loadProperEngineers(s4.presentFileIds);
  check(
    '突合対象は稼働可でスキルのある行だけ（所在不明・アサイン済・抽出失敗は除く）',
    engineers.map((e) => e.fileId).sort().join(',') === 'fileA,fileB',
    engineers.map((e) => e.fileId).join(','),
  );
  const b = engineers.find((e) => e.fileId === 'fileB');
  check('必要案件単価「６５万円」を65万円として読む', b?.requiredProjectRate === 65);

  newRun();
  await syncProperMaster();
  newRun();
  const s6 = await syncProperMaster();
  const memoE3 = byFile('fileE')?.['抽出メモ'] ?? '';
  check('失敗が上限（3回）に達したら再試行をやめる', s6.failed === 1 && memoE3.includes('（3回目）') && memoE3.includes('ファイルを更新すると再抽出'), memoE3);
  newRun();
  extractCalls = [];
  drive.files.get('fileC')!.trashed = false;
  await syncProperMaster();
  check('上限に達したファイルは更新されるまで抽出しない', !extractCalls.includes('E') && extractCalls.length === 0);
  check('フォルダに戻ったファイルは「ファイルが見つかりません」を外す', !(byFile('fileC')?.['抽出メモ'] ?? '').startsWith(MISSING_FILE_MEMO));

  sheets.setByKey(PROPER_BOOK, PROPER_MASTER_TAB, 'ファイルID', 'fileA', '必要案件単価', '60');
}

// ===== 7b. ショートカットでまとめたスキルシート =====

async function testDriveShortcuts(): Promise<void> {
  section('スキルシートのフォルダのショートカット（既定はたどらない・有効にしてもファイルへのショートカットだけ）');
  drive.put({ id: 'scRoot', name: 'root', mimeType: 'application/vnd.google-apps.folder', modifiedTime: FILE_TIME(1), parents: [] });
  drive.put({ id: 'scOrigDir', name: '原本', mimeType: 'application/vnd.google-apps.folder', modifiedTime: FILE_TIME(1), parents: ['elsewhere'] });
  drive.put(driveFile('scOrigFile', { name: '原本.pdf', parents: ['elsewhere'], modifiedTime: FILE_TIME(5), content: 'x' }));
  drive.put(driveFile('scInDir', { name: 'サブ.pdf', parents: ['scOrigDir'], modifiedTime: FILE_TIME(6), content: 'y' }));
  drive.put({ id: 'scToFile', name: '原本へのショートカット', mimeType: 'application/vnd.google-apps.shortcut', modifiedTime: FILE_TIME(1), parents: ['scRoot'], shortcutTarget: 'scOrigFile' });
  drive.put({ id: 'scToDir', name: 'フォルダへのショートカット', mimeType: 'application/vnd.google-apps.shortcut', modifiedTime: FILE_TIME(1), parents: ['scRoot'], shortcutTarget: 'scOrigDir' });
  process.env.PROPER_SKILLSHEET_FOLDER_ID = 'scRoot';
  try {
    const off = await listSkillSheetFiles();
    check('既定ではショートカットをたどらない（フォルダに置いたショートカットで、フォルダの外のファイルを読ませない）', off.length === 0, off.map((f) => f.id).join(','));
    process.env.PROPER_FOLLOW_SHORTCUTS = 'true';
    const files = await listSkillSheetFiles();
    const ids = files.map((f) => f.id).sort().join(',');
    const orig = files.find((f) => f.id === 'scOrigFile');
    check(
      '有効にするとファイルへのショートカットだけ参照先を読み（更新日時も参照先）、フォルダへのショートカットはたどらない',
      ids === 'scOrigFile' && orig?.modifiedTime === FILE_TIME(5) && orig.mimeType === 'application/pdf' && orig.viaShortcut === true,
      ids,
    );
  } finally {
    delete process.env.PROPER_FOLLOW_SHORTCUTS;
    process.env.PROPER_SKILLSHEET_FOLDER_ID = 'folderRoot';
  }
}

// ===== 8. プロパー候補の保存と提案文面 =====

async function testProperCandidates(): Promise<void> {
  section('プロパー候補（「プロパー候補」タブ・提案文面はイニシャルのみ）');
  // 人が管理表の行を複製した状態（同じファイルIDの行が2つ）と、イニシャルの無い社員のスキルシート
  const masterRows = sheets.rawRows(PROPER_BOOK, PROPER_MASTER_TAB);
  const idCol = masterRows[0].indexOf('ファイルID');
  const rowOfA = masterRows.find((r) => r[idCol] === 'fileA')!;
  sheets.insertRowAt(PROPER_BOOK, PROPER_MASTER_TAB, masterRows.length + 1, rowOfA);
  drive.put(
    driveFile('fileH', {
      name: 'スキルシート_伊藤八郎',
      mimeType: GDOC,
      modifiedTime: FILE_TIME(15),
      content: profileJson(profile('H', { displayName: '伊藤八郎', skills: ['PHP', 'MySQL'], residence: '東京都', prefecture: '東京都' })),
    }),
  );

  newRun();
  const r1 = await runProperFlow();
  const tab = PROPER_CANDIDATE_TAB;
  const idA = `ownmatch_${properEngineerIdOf('fileA')}_${p1.id}`;
  const idB = `ownmatch_${properEngineerIdOf('fileB')}_${p2.id}`;
  const idH = `ownmatch_${properEngineerIdOf('fileH')}_${p1.id}`;
  const rowA = sheets.record(SES_BOOK, tab, 'ID', idA);
  const rowB = sheets.record(SES_BOOK, tab, 'ID', idB);
  const rowH = sheets.record(SES_BOOK, tab, 'ID', idH);
  check(
    'プロパー候補を保存する（A×PHP案件・B×Python案件・H×PHP案件）',
    r1 !== null && Boolean(rowA) && Boolean(rowB) && Boolean(rowH) && r1.saved === r1.candidates.length,
    `${r1?.candidates.length}`,
  );
  const candidateIds = sheets.records(SES_BOOK, tab).map((r) => r['ID']);
  check('候補のIDにスキルシートのDriveのファイルIDを含めない', candidateIds.every((id) => !/file[A-Z]/.test(id)), candidateIds.join(','));
  check(
    '管理表で行が複製されていても同じ候補を2行にしない',
    new Set(candidateIds).size === candidateIds.length && r1?.engineers === 3,
    `${candidateIds.length}行 / 社員${r1?.engineers}名`,
  );
  const textH = rowH?.['案件側文面'] ?? '';
  check(
    '提案用表記が未入力なら、氏名で代用せず記入を促す差し込みにする',
    textH.includes('《提案用表記（イニシャル）を記入》') && !textH.includes('伊藤') && rowH?.['プロパー'] === '伊藤八郎',
  );
  check('「プロパー」列は社内向けに氏名（提案用表記）', rowA?.['プロパー'] === '山田太郎（T.Y.）' && rowB?.['プロパー'] === '佐藤 花子（確認済）（H.S.）');
  const text = rowA?.['案件側文面'] ?? '';
  check(
    '提案文面はイニシャルを使い、氏名を含めない（下書きデータも同様）',
    text.includes('T.Y.') &&
      !text.includes('山田') &&
      !(rowA?.['下書きデータ'] ?? '').includes('山田') &&
      /^To: .*hanako@alpha\.example\.jp/.test(text),
  );
  check('提案文面に必要案件単価（社内の採算ライン）を書かない', !text.includes('60万') && !text.includes('必要案件単価'));
  check('初期値: ステータス「未確認」・案件側下書き状態「未作成」', rowA?.['ステータス'] === '未確認' && rowA?.['案件側下書き状態'] === '未作成');

  newRun();
  const rows = sheets.records(SES_BOOK, tab).length;
  const writes = sheets.writeCount(SES_BOOK, tab);
  const r2 = await runProperFlow();
  check('2回目: 内容が同じなら書き込まず、行も増えない', r2?.saved === 0 && sheets.writeCount(SES_BOOK, tab) === writes && sheets.records(SES_BOOK, tab).length === rows);

  sheets.setByKey(SES_BOOK, tab, 'ID', idA, '担当者メール', `taro@${OWN_DOMAIN}`);
  sheets.setByKey(SES_BOOK, tab, 'ID', idA, 'ステータス', '紹介済');
  newRun();
  const draftsBefore = mail.drafts.length;
  const d = await materializePendingDrafts(undefined, activeProperEngineerIds);
  const created = mail.drafts.slice(draftsBefore);
  check('担当者メールを入れたプロパー候補は案件側の下書きを1件だけ作る', d.created === 1 && created.length === 1);
  check(
    '作成した下書きの本文はイニシャルのみ（氏名なし）',
    (created[0]?.ref.body ?? '').includes('T.Y.') && !(created[0]?.ref.body ?? '').includes('山田'),
  );
  check('プロパー候補の状態列を「作成済」にする', STAMP.test(sheets.record(SES_BOOK, tab, 'ID', idA)?.['案件側下書き状態'] ?? ''));

  newRun();
  await runProperFlow();
  const after = sheets.record(SES_BOOK, tab, 'ID', idA);
  check(
    '再実行でも人のステータス・担当者メール・作成済を保持',
    after?.['ステータス'] === '紹介済' && after?.['担当者メール'] === `taro@${OWN_DOMAIN}` && STAMP.test(after?.['案件側下書き状態'] ?? ''),
  );

  // 管理表で稼働可でなくした社員: プロパー候補の実行の前に届いた依頼は作らず、実行後は候補の行を退役させる
  sheets.setByKey(PROPER_BOOK, PROPER_MASTER_TAB, 'ファイルID', 'fileH', '稼働状況', '対象外');
  sheets.setByKey(SES_BOOK, tab, 'ID', idH, '担当者メール', `taro@${OWN_DOMAIN}`);
  newRun();
  const beforeRetired = mail.drafts.length;
  await materializePendingDrafts(undefined, activeProperEngineerIds);
  check(
    '稼働可でなくなった社員のプロパー候補は、担当者メールが入っても下書きを作らない',
    mail.drafts.length === beforeRetired && (sheets.record(SES_BOOK, tab, 'ID', idH)?.['案件側下書き状態'] ?? '').includes('稼働可ではない'),
    sheets.record(SES_BOOK, tab, 'ID', idH)?.['案件側下書き状態'],
  );
  sheets.setByKey(PROPER_BOOK, PROPER_MASTER_TAB, 'ファイルID', 'fileB', '稼働状況', 'アサイン済');
  newRun();
  const r3 = await runProperFlow();
  const retiredB = sheets.record(SES_BOOK, tab, 'ID', idB);
  check(
    '稼働可でなくなった社員の候補の行は退役させ、氏名・必要案件単価・文面・下書きデータを消す',
    r3?.retired === 2 && retiredB?.['判定'] === RETIRED_PROPER_VERDICT && retiredB?.['プロパー'] === '（対象外）' &&
      retiredB?.['必要案件単価'] === '' && retiredB?.['案件側文面'] === '' && retiredB?.['下書きデータ'] === '' &&
      retiredB?.['案件側下書き状態'] === DRAFT_STATE.retired && STAMP.test(sheets.record(SES_BOOK, tab, 'ID', idA)?.['案件側下書き状態'] ?? ''),
    JSON.stringify({ retired: r3?.retired, retiredB }),
  );
  sheets.setByKey(PROPER_BOOK, PROPER_MASTER_TAB, 'ファイルID', 'fileB', '稼働状況', '稼働可');
  newRun();
  await runProperFlow();
  const back = sheets.record(SES_BOOK, tab, 'ID', idB);
  check('稼働可に戻れば候補の行も「未作成」に戻る', back?.['案件側下書き状態'] === '未作成' && back?.['プロパー'] !== '（対象外）' && Boolean(back?.['下書きデータ']));
  sheets.setByKey(PROPER_BOOK, PROPER_MASTER_TAB, 'ファイルID', 'fileH', '稼働状況', '稼働可');
}

// ===== 9. 見出しの名前による列の対応付けと、特定できない見出し =====

async function testHeaderByName(): Promise<void> {
  section('見出しの名前で列を対応付ける（並べ替え・メモ列の挿入は可、見出しの変更・重複は書き込まない）');
  // IDとマッチ名が入れ替わり、途中に人のメモ列があるマッチタブ（旧バージョンの定義＋担当者メール等の列）
  const swapped = ['マッチ名', 'ID', '社内メモ', ...OLD_MATCH_HEADER.slice(2), ...DRAFT_REQUEST_COLUMNS];
  sheets.seedTab(CONFLICT_BOOK, 'マッチ', [swapped, ['人のメモ行', 'match_x', 'メモ', 1, 1, '', '', '', '', '', '未確認', '', `taro@${OWN_DOMAIN}`]]);
  // 見出しの1つ（案件名）が変えられたプロパー候補タブ（どの列に書くべきか決められない）
  const properDef = ['ID', 'プロパー', '案件名', '案件単価', '必要案件単価', '単価差', 'スキル一致率', 'バンド', '判定', '適合スコア', '根拠', '案件ID', '営業元メール', '検出日時', 'ステータス', '担当者メール', '案件側下書き状態', '案件側文面', '下書きデータ'];
  const renamed = properDef.map((h) => (h === '案件名' ? '案件タイトル' : h));
  sheets.seedTab(CONFLICT_BOOK, PROPER_CANDIDATE_TAB, [renamed, ['ownmatch_y', 'x', 't', '', '', '', '', '', '', '', '', '', '', '', '', `taro@${OWN_DOMAIN}`]]);
  // 途中に人のメモ列を挿入した、旧バージョン（突合済の列が無い）の案件タブ
  const inserted = [...OLD_PROJECT_HEADER.slice(0, 2), '社内メモ', ...OLD_PROJECT_HEADER.slice(2)];
  sheets.seedTab(CONFLICT_BOOK, '案件', [inserted, ['proj_old', '既存案件', '人のメモ', 'Java']]);
  process.env.SHEETS_DB_SPREADSHEET_ID = CONFLICT_BOOK;
  try {
    newRun();
    const listed = await listDraftRequestRowsSheets('マッチ');
    check('並べ替えたマッチタブも見出しの名前で下書き依頼を読む', listed.length === 1 && listed[0].id === 'match_x' && listed[0].senderEmail === `taro@${OWN_DOMAIN}`);
    const draftsBefore = mail.drafts.length;
    await materializePendingDrafts();
    const x = sheets.record(CONFLICT_BOOK, 'マッチ', 'ID', 'match_x');
    check(
      '結果は名前で探した状態列に書き、人のメモ列・マッチ名は変えない',
      (x?.['案件側下書き状態'] ?? '').startsWith('エラー: 下書きの文面データ') && x?.['社内メモ'] === 'メモ' && x?.['マッチ名'] === '人のメモ行' &&
        mail.drafts.length === draftsBefore,
      JSON.stringify(x),
    );
    const writes = sheets.writeCount(CONFLICT_BOOK, PROPER_CANDIDATE_TAB);
    let refused = false;
    try {
      await saveProperCandidatesSheets([
        {
          id: 'ownmatch_x', ownEngineerId: 'proper_x', ownEngineerName: 'x', projectId: p1.id, projectTitle: p1.title,
          projectRate: 75, requiredProjectRate: 60, rateGapMan: 15, meetsRate: true, skillMatchRate: 1, band: 'strong',
          locationOk: true, timingOk: true, needsReview: false, score: 100, reason: 'r', agentEmail: p1.agentEmail,
          detectedAt: NOW, properLabel: 'x',
        },
      ]);
    } catch (err) {
      refused = err instanceof SafeLogError;
    }
    check('見出しが変えられたプロパー候補タブには保存しない（例外で知らせる）', refused && sheets.writeCount(CONFLICT_BOOK, PROPER_CANDIDATE_TAB) === writes);
    check('特定できない見出し行は自動で書き換えない', sheets.header(CONFLICT_BOOK, PROPER_CANDIDATE_TAB).join(',') === renamed.join(','));

    await saveProject(p1);
    const header = sheets.header(CONFLICT_BOOK, '案件');
    const savedRow = sheets.record(CONFLICT_BOOK, '案件', 'ID', p1.id);
    check(
      '途中にメモ列のある案件タブにも、定義の列へ正しく保存する（増えた列は右端に追記）',
      header.slice(-3).join(',') === `${MATCHED_COLUMN},${INJECTION_COLUMN},${LAST_SEEN_COLUMN}` && savedRow?.['案件名'] === p1.title && savedRow?.['単金上限'] === '75' && savedRow?.['社内メモ'] === '',
      header.join(','),
    );
    const read = await fetchOpenProjects(10);
    const old = read.find((p) => p.id === 'proj_old');
    check(
      '途中にメモ列のある案件タブを列ずれなく読む（人のメモは変えない）',
      old?.title === '既存案件' && old.requiredSkills.join(',') === 'Java' && sheets.record(CONFLICT_BOOK, '案件', 'ID', 'proj_old')?.['社内メモ'] === '人のメモ',
      JSON.stringify(old?.requiredSkills),
    );

    // 長時間動くプロセス（確認UI）の途中で人が列を挿入しても、書き込む前に見出しを確かめて正しい列に書く
    sheets.insertColumnAt(CONFLICT_BOOK, 'マッチ', 2, '追加メモ');
    await updateMatchStatusSheets('match_x', 'introduced');
    const afterInsert = sheets.record(CONFLICT_BOOK, 'マッチ', 'ID', 'match_x');
    check('実行中に列が挿入されても、ステータスは見出しで探した列に書く', afterInsert?.['ステータス'] === '紹介済' && afterInsert?.['追加メモ'] === '', JSON.stringify(afterInsert));
    // 実行中に見出しの名前が変えられた → 以後そのタブには書かない
    sheets.renameHeader(CONFLICT_BOOK, 'マッチ', '判定根拠', '根拠メモ');
    let statusRefused = false;
    try {
      await updateMatchStatusSheets('match_x', 'dropped');
    } catch (err) {
      statusRefused = err instanceof SafeLogError;
    }
    check('実行中に見出しが変えられたタブには書かない', statusRefused && sheets.record(CONFLICT_BOOK, 'マッチ', 'ID', 'match_x')?.['ステータス'] === '紹介済');
  } finally {
    process.env.SHEETS_DB_SPREADSHEET_ID = SES_BOOK;
    newRun();
  }
}

// ===== 9b. 途中で止まっても続きから処理できること・二重の行・容量 =====

const RESUME_BOOK = 'fakeResumeBook';

async function testResumeAndDurability(): Promise<void> {
  section('途中で止まった回の続き（突合済）・再送の追記・複製した行・処理済みの整理・受信日');
  sheets.createBook(RESUME_BOOK);
  // 旧バージョン（突合済の列が無い）の案件タブと既存の行 → 列の追加時に既存の行は突合済みにする（移行の費用を抑える）
  sheets.seedTab(RESUME_BOOK, '案件', [OLD_PROJECT_HEADER, ['proj_legacy', '旧案件', 'Java', '', 60, 70, '東京都', '一部', '', '', '', '', '', '', '', 'm_legacy', '', new Date().toISOString(), '募集中']]);
  process.env.SHEETS_DB_SPREADSHEET_ID = RESUME_BOOK;
  const transport = new FakeMailTransport();
  __setMailTransportForTest(transport);
  try {
    newRun();
    await checkSheetsTabs(['案件', '要員', 'マッチ', '処理済みメール']);
    check('「突合済」列の追加時に既存の行を突合済みにする', (sheets.record(RESUME_BOOK, '案件', 'ID', 'proj_legacy')?.[MATCHED_COLUMN] ?? '').startsWith('移行'));

    // 単金不明（要確認）の組だけにしてLLMを使わずに判定する
    const rp = project('proj_resume', { ...p1, id: 'proj_resume', rateMin: null, rateMax: null, sourceMailId: 'm_r1' });
    const re = engineer('eng_resume', { ...e1, id: 'eng_resume', sourceMailId: 'm_r2' });
    newRun();
    const failedSave = await saveProjectsSheets([rp]);
    await saveEngineer(re);
    const load = async () => {
      const projects = await fetchOpenProjects(100);
      const engineers = await fetchAvailableEngineers(100);
      return {
        projects,
        engineers,
        scope: {
          newProjectIds: new Set(projects.filter((p) => p.matched === false).map((p) => p.id)),
          newEngineerIds: new Set(engineers.filter((e) => e.matched === false).map((e) => e.id)),
          judgedMatchIds: await fetchJudgedMatchIds(),
        },
      };
    };
    const first = await load();
    check('保存したばかりの案件・要員は突合前', failedSave.failed.size === 0 && first.scope.newProjectIds.has(rp.id) && first.scope.newEngineerIds.has(re.id) && !first.scope.newProjectIds.has('proj_legacy'));

    // 1回目: 実行時間の期限を過ぎていた（ジョブの打ち切り相当）→ 何も判定・保存せず、突合前のまま次回へ
    startRunClock(Date.now() - 24 * 60 * 60 * 1000);
    let r1;
    try {
      r1 = await matchIncrementally(first.projects, first.engineers, first.scope);
    } finally {
      stopRunClock();
    }
    check('期限を過ぎた回は判定せず、案件・要員を突合前のまま残す', r1.saved.length === 0 && r1.deferredItems > 0 && !sheets.record(RESUME_BOOK, '案件', 'ID', rp.id)?.[MATCHED_COLUMN]);

    // 2回目: 続きから判定・保存し、終えた案件・要員に突合済を付ける
    newRun();
    const second = await load();
    const r2 = await matchIncrementally(second.projects, second.engineers, second.scope);
    const mid = matchIdOf(rp.id, re.id);
    check(
      '次の回で続きから判定・保存し、案件・要員を突合済にする',
      r2.saved.some((m) => m.id === mid) && Boolean(sheets.record(RESUME_BOOK, 'マッチ', 'ID', mid)) &&
        Boolean(sheets.record(RESUME_BOOK, '案件', 'ID', rp.id)?.[MATCHED_COLUMN]) && Boolean(sheets.record(RESUME_BOOK, '要員', 'ID', re.id)?.[MATCHED_COLUMN]),
    );
    newRun();
    const third = await load();
    const r3 = await matchIncrementally(third.projects, third.engineers, third.scope);
    check('突合済の案件・要員の組は判定し直さない', r3.saved.length === 0 && third.scope.newProjectIds.size === 0 && third.scope.newEngineerIds.size === 0);
    check('突合済の印は案件・要員ごとに付けられる', (await markItemsMatchedSheets('project', ['no_such_id'])) === 0);

    // 成立候補なのに文面を用意できなかったマッチは「不要」にせず、判定済みから外して次回作り直す
    const noDraft: MatchResult = { ...makeMatch(p2, e2, 'confirmed'), draftToProject: undefined, draftToEngineer: undefined, draftFailed: true };
    newRun();
    await saveMatch(noDraft);
    const nd = sheets.record(RESUME_BOOK, 'マッチ', 'ID', noDraft.id);
    check(
      '文面を用意できなかった成立候補は下書き状態を作り直し待ちにし、判定済みに含めない',
      nd?.['案件側下書き状態'] === DRAFT_STATE.genFailed && !(await fetchJudgedMatchIds()).has(noDraft.id),
      nd?.['案件側下書き状態'],
    );
    newRun();
    await saveMatch(makeMatch(p2, e2, 'confirmed'));
    check('作り直した文面が入ると「未作成」に戻る', sheets.record(RESUME_BOOK, 'マッチ', 'ID', noDraft.id)?.['案件側下書き状態'] === '未作成' && (await fetchJudgedMatchIds()).has(noDraft.id));

    // 追記の応答が 503 でも実際には書けていた → 読み直して確かめ、二重に追記しない
    newRun();
    sheets.failNext('values.append', 503, '処理済みメール', 1, true);
    const marked = await markMailProcessed(['sesmail_ambiguous'], '抽出済');
    check(
      '追記の応答が失敗でも書けていれば再送しない（二重の行を作らない）',
      marked && sheets.records(RESUME_BOOK, '処理済みメール').filter((r) => r['メールID'] === 'sesmail_ambiguous').length === 1,
    );

    // 人が行を複製し、2つ目の行に担当者メールを入れた → その行の依頼として作成する
    const dm = makeMatch(p3, e1, 'confirmed');
    newRun();
    await saveMatch(dm);
    const raw = sheets.rawRows(RESUME_BOOK, 'マッチ');
    const hdr = raw[0];
    const at = raw.findIndex((r) => r[hdr.indexOf('ID')] === dm.id);
    const copy = [...raw[at]];
    while (copy.length < hdr.length) copy.push('');
    copy[hdr.indexOf('担当者メール')] = `taro@${OWN_DOMAIN}`;
    sheets.insertRowAt(RESUME_BOOK, 'マッチ', at + 2, copy);
    newRun();
    const draftsBefore = mail.drafts.length;
    __setMailTransportForTest(mail);
    await materializePendingDrafts();
    __setMailTransportForTest(transport);
    const after = sheets.rawRows(RESUME_BOOK, 'マッチ').filter((r) => r[hdr.indexOf('ID')] === dm.id);
    check(
      '同じIDの行が複数あっても、担当者メールを入れた行の依頼として作成する',
      mail.drafts.length - draftsBefore === 2 && after.length === 2 && after[0][hdr.indexOf('案件側下書き状態')] === '未作成' &&
        (after[1][hdr.indexOf('案件側下書き状態')] ?? '').startsWith('作成済'),
      JSON.stringify(after.map((r) => r[hdr.indexOf('案件側下書き状態')])),
    );

    // 収集期間を過ぎた処理済みメールの記録を消す（最近の記録は残す）
    const oldAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    for (let i = 0; i < 3; i++) sheets.insertRowAt(RESUME_BOOK, '処理済みメール', 2, [`sesmail_old_${i}`, oldAt, '抽出済']);
    newRun();
    const removed = await pruneProcessedMailSheets(new Date(Date.now() - 14 * 24 * 60 * 60 * 1000), 1);
    const left = sheets.records(RESUME_BOOK, '処理済みメール').map((r) => r['メールID']);
    check('収集期間を過ぎた処理済みメールの記録だけを消す', removed === 3 && left.includes('sesmail_ambiguous') && !left.some((id) => id.startsWith('sesmail_old_')), left.join(','));

    // 受信日が空欄の行は「今」とみなさず、受信日で絞る突合の対象から外す
    sheets.insertRowAt(RESUME_BOOK, '案件', 2, ['proj_nodate', '受信日なし', 'Java']);
    newRun();
    const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const recent = await fetchOpenProjects(100, { receivedSince: since });
    const all = await fetchOpenProjects(100);
    check(
      '受信日が空欄の行は直近の突合から外し、並べ替えでは最後に回す',
      !recent.some((p) => p.id === 'proj_nodate') && all[all.length - 1]?.id === 'proj_nodate',
      all.map((p) => p.id).join(','),
    );

    // 1回の上限を超える未処理メール: 本文は上限まで選んだものだけ取得し、次回の実行で窓を外れる分は異常終了で知らせる
    process.env.SES_MAX_MAILS_PER_RUN = '1';
    process.env.SES_COLLECT_DAYS = '4';
    const day = 24 * 60 * 60 * 1000;
    transport.inbox = [
      rawMail('sesmail_cap_new', '検証花子 <hanako@alpha.example.jp>', '【案件】新しい', 60),
      rawMail('sesmail_cap_old1', '検証次郎 <jiro@beta.example.jp>', '【案件】古い1', (3.9 * day) / 60_000),
      rawMail('sesmail_cap_old2', '検証三子 <miko@gamma.example.jp>', '【案件】古い2', (3.95 * day) / 60_000),
    ];
    newRun();
    const capped = await collectSesMail();
    check(
      '上限を超えると、次回に窓を外れるメールを優先して上限まで本文を取得し、処理できなくなる分を異常終了で知らせる',
      capped.mails.length === 1 && capped.mails[0].id === 'sesmail_cap_old1' && transport.downloaded.length === 1 && capped.deferred === 2 && hasFatal(),
      `${capped.mails.map((m) => m.id).join(',')} / downloaded=${transport.downloaded.join(',')}`,
    );
  } finally {
    delete process.env.SES_MAX_MAILS_PER_RUN;
    delete process.env.SES_COLLECT_DAYS;
    __setMailTransportForTest(mail);
    process.env.SHEETS_DB_SPREADSHEET_ID = SES_BOOK;
    newRun();
  }
}

// ===== 9c. 本番運用レビューの指摘（冪等でない操作・移行・二重実行・知らせ損ね・署名・表示形式） =====

const REVIEW_BOOK = 'fakeReviewBook';
const MIG_BOOK = 'fakeMigrationBook';

async function testReviewRegressions(): Promise<void> {
  section('冪等でない操作の再送・突合済の移行・二重実行・知らせ損ね・返信メタの署名・表示形式');
  sheets.createBook(REVIEW_BOOK);
  process.env.SHEETS_DB_SPREADSHEET_ID = REVIEW_BOOK;
  const tabsCheck = ['案件', '要員', 'マッチ', '処理済みメール', '_状態'];
  try {
    // タブの作成が済んだのに応答が 503 → 同じ作成を再送せず（再送は「既にある」で失敗する）、読み直して見出しを書く
    newRun();
    sheets.failNext('batchUpdate', 503, undefined, 1, true);
    let createErr = '';
    try {
      await fetchOpenProjects(10);
    } catch (err) {
      createErr = String(err);
    }
    check(
      'タブの作成の応答が失われても、再送せずに読み直して見出しを書き、処理を続ける',
      createErr === '' && ALL_TABS.every((t) => sheets.hasTab(REVIEW_BOOK, t)) &&
        JSON.stringify(sheets.header(REVIEW_BOOK, '案件')) === JSON.stringify(PROJECT_HEADER) &&
        sheets.validations.some((v) => v.spreadsheetId === REVIEW_BOOK && v.options.includes('未確認')),
      createErr,
    );

    // 行の削除が済んだのに応答が 503 → 同じ行番号を再送しない（繰り上がった新しい記録を消さない）
    const oldAt = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const newAt = new Date().toISOString();
    for (let i = 0; i < 3; i++) sheets.insertRowAt(REVIEW_BOOK, '処理済みメール', 2, [`sesmail_prune_old_${i}`, oldAt, '抽出済']);
    for (let i = 0; i < 3; i++) sheets.insertRowAt(REVIEW_BOOK, '処理済みメール', 5, [`sesmail_prune_new_${i}`, newAt, '抽出済']);
    newRun();
    await checkSheetsTabs(tabsCheck);
    sheets.failNext('batchUpdate', 503, undefined, 1, true);
    const removed = await pruneProcessedMailSheets(new Date(Date.now() - 67 * 24 * 60 * 60 * 1000), 1);
    const left = sheets.records(REVIEW_BOOK, '処理済みメール').map((r) => r['メールID']);
    check(
      '行の削除の応答が失われても、読み直して残っている対象だけを消す（新しい記録を消さない）',
      removed === 3 && left.length === 3 && left.every((id) => id.startsWith('sesmail_prune_new_')),
      `${removed} / ${left.join(',')}`,
    );

    // A列の見出しが空（先頭に見出しの無い列を挿入）→ 追記が右にずれるため書き込まない
    sheets.seedTab(REVIEW_BOOK, 'スキル同義', [['', 'スキルA', 'スキルB', '追加者', '日時']]);
    newRun();
    let blankErr = '';
    try {
      await saveSkillEquivalence({ a: 'Java', b: 'JVM', addedBy: 'x', at: newAt });
    } catch (err) {
      blankErr = err instanceof SafeLogError ? err.message : String(err);
    }
    check('A列の見出しが空のタブには追記しない（列がずれて書き込まれるため）', blankErr.includes('A列'), blankErr);
    sheets.seedTab(REVIEW_BOOK, 'スキル同義', [['スキルA', 'スキルB', '追加者', '日時']]);

    // 「突合済」列を別のプロセス（確認UI等）が先に追加しても、バッチの開始時に一度だけ既存の行を突合済みにする
    // （旧バージョンのタブがあるスプレッドシート。新しいスプレッドシートでは最初のバッチで空のタブに対して完了する）
    sheets.seedTab(MIG_BOOK, '案件', [OLD_PROJECT_HEADER, ['proj_mig_1', '旧案件', 'Java', '', 60, 70, '東京都', '一部', '', '', '', '', '', '', '', 'm_mig', '', newAt, '募集中']]);
    process.env.SHEETS_DB_SPREADSHEET_ID = MIG_BOOK;
    newRun();
    await fetchOpenProjects(10); // 別のプロセスが列を追加（移行はしない）
    newRun();
    sheets.failNext('values.batchUpdate', 400, '案件', 1);
    let migErr = false;
    try {
      await checkSheetsTabs(tabsCheck);
    } catch {
      migErr = true;
    }
    const midState = await readStateJson<{ state: string }>(`migration:${MATCHED_COLUMN}:案件`);
    newRun();
    await checkSheetsTabs(tabsCheck);
    check(
      '列を別のプロセスが追加していても、移行が途中で失敗しても、次のバッチで既存の行を突合済みにする',
      migErr && midState?.state === 'started' && (sheets.record(MIG_BOOK, '案件', 'ID', 'proj_mig_1')?.[MATCHED_COLUMN] ?? '').startsWith('移行'),
      JSON.stringify(midState),
    );
    const fresh = project('proj_mig_2', { title: '新着案件', requiredSkills: ['Go'], rateMax: 70, location: '東京都', prefecture: '東京都' });
    await saveProject(fresh);
    newRun();
    await checkSheetsTabs(tabsCheck);
    check(
      '移行は一度だけ（その後に保存した突合前の行は突合済みにしない）',
      !sheets.record(MIG_BOOK, '案件', 'ID', fresh.id)?.[MATCHED_COLUMN] &&
        (await readStateJson<{ state: string }>(`migration:${MATCHED_COLUMN}:案件`))?.state === 'done',
    );

    // 人が「終了」にした案件・突合済の案件を抽出し直して保存 → 保存後の状態はシートの値（終了・突合済）
    sheets.setByKey(MIG_BOOK, '案件', 'ID', fresh.id, 'ステータス', '終了');
    newRun();
    const resaved = await saveProjectsSheets([{ ...fresh, title: '新着案件（再抽出）' }]);
    const migrated = await saveProjectsSheets([project('proj_mig_1', { title: '旧案件', requiredSkills: ['Java'], sourceMailId: 'm_mig' })]);
    check(
      '抽出し直して保存した案件は、人が付けた「終了」と突合済の印をシートの値のまま引き継ぐ',
      resaved.saved.get(fresh.id)?.status === 'closed' && migrated.saved.get('proj_mig_1')?.matched === true &&
        sheets.record(MIG_BOOK, '案件', 'ID', fresh.id)?.['ステータス'] === '終了',
    );
    process.env.SHEETS_DB_SPREADSHEET_ID = REVIEW_BOOK;

    // 人が単金の列に表示形式（0"万円"）を付けても、数値として読む
    const priced = project('proj_fmt', { title: '表示形式', requiredSkills: ['Java'], rateMin: 60, rateMax: 80, location: '東京都', prefecture: '東京都' });
    await saveProject(priced);
    sheets.formatColumn(REVIEW_BOOK, '案件', '単金上限', (v) => `${v}万円`);
    sheets.formatColumn(REVIEW_BOOK, '案件', '単金下限', (v) => v.toLocaleString('de-DE', { minimumFractionDigits: 1 }));
    newRun();
    const readBack = (await fetchOpenProjects(100)).find((x) => x.id === priced.id);
    check('単金の列に表示形式が付いていても数値として読む', readBack?.rateMax === 80 && readBack?.rateMin === 60, JSON.stringify(readBack?.rateMax));

    // 突合済の印付けは、行の位置が変わっていなければタブ全体を読み直さない。行がずれていれば読み直して正しい行に付ける
    newRun();
    await fetchOpenProjects(100);
    const fullReads = () => sheets.calls.filter((c) => c.spreadsheetId === REVIEW_BOOK && c.method === 'values.get' && c.ranges[0] === "'案件'").length;
    const before = fullReads();
    await markItemsMatchedSheets('project', [priced.id]);
    check('突合済の印付けは、行の位置を見出しとキー列だけで確かめる（タブ全体を読み直さない）', fullReads() === before && Boolean(sheets.record(REVIEW_BOOK, '案件', 'ID', priced.id)?.[MATCHED_COLUMN]));
    sheets.setByKey(REVIEW_BOOK, '案件', 'ID', priced.id, MATCHED_COLUMN, '');
    sheets.insertRowAt(REVIEW_BOOK, '案件', 2, ['proj_human', '人が挿入した行']);
    await markItemsMatchedSheets('project', [priced.id]);
    check(
      '人が行を挿入して位置がずれていれば、読み直して正しい行に印を付ける',
      Boolean(sheets.record(REVIEW_BOOK, '案件', 'ID', priced.id)?.[MATCHED_COLUMN]) && !sheets.record(REVIEW_BOOK, '案件', 'ID', 'proj_human')?.[MATCHED_COLUMN],
    );

    // 同時に動くバッチは1つだけ（実行中の印）
    newRun();
    const first = await acquireBatchLeaseSheets(60_000, 0);
    const second = await acquireBatchLeaseSheets(60_000, 0);
    if (first.ok) await releaseBatchLeaseSheets(first.token);
    const third = await acquireBatchLeaseSheets(60_000, 0);
    if (third.ok) await releaseBatchLeaseSheets(third.token);
    check('実行中の印がある間は別のバッチを始めず、終われば次のバッチが始められる', first.ok && !second.ok && third.ok);

    // 文面を用意できなかった成立候補が、判定し直しで参考提案になった → 「不要」にして判定済みに含める（毎回判定し直さない）
    const pA = project('proj_rv_a', { title: '案件RA', requiredSkills: ['Java'], agentEmail: 'a@alpha.example.jp', replyTarget: rt('検証花子', 'hanako@alpha.example.jp', '【案件】RA', 'ra') });
    const eA = engineer('eng_rv_a', { displayName: 'R.A.', skills: ['Java'], agentEmail: 'b@beta.example.jp', replyTarget: rt('検証次郎', 'jiro@beta.example.jp', '【要員】RA', 'ea') });
    newRun();
    await saveMatch({ ...makeMatch(pA, eA, 'confirmed'), draftToProject: undefined, draftToEngineer: undefined, draftFailed: true });
    await saveMatch(makeMatch(pA, eA, 'tentative'));
    const rvRow = sheets.record(REVIEW_BOOK, 'マッチ', 'ID', matchIdOf(pA.id, eA.id));
    check(
      '作り直し待ちのマッチが参考提案になれば「不要」にして判定済みに含める',
      rvRow?.['案件側下書き状態'] === '不要' && (await fetchJudgedMatchIds()).has(matchIdOf(pA.id, eA.id)),
      rvRow?.['案件側下書き状態'],
    );

    // 同じ依頼を別の実行が先に「作成中」にした側は作らない（読み直して自分の印が残っている側だけ作る）
    const eB = engineer('eng_rv_b', { displayName: 'R.B.', skills: ['Java'], agentEmail: 'c@gamma.example.jp', replyTarget: rt('検証三子', 'miko@gamma.example.jp', '【要員】RB', 'eb') });
    const cas = makeMatch(pA, eB, 'confirmed');
    newRun();
    await saveMatch(cas);
    sheets.setByKey(REVIEW_BOOK, 'マッチ', 'ID', cas.id, '担当者メール', `taro@${OWN_DOMAIN}`);
    const foreign = '作成中 2026-01-01 00:00 #foreignNonce1';
    sheets.beforeNext('values.batchUpdate', () =>
      sheets.beforeNext('values.batchGet', () => sheets.setByKey(REVIEW_BOOK, 'マッチ', 'ID', cas.id, '案件側下書き状態', foreign)),
    );
    newRun();
    const draftsBeforeCas = mail.drafts.length;
    await materializePendingDrafts();
    const casRow = sheets.record(REVIEW_BOOK, 'マッチ', 'ID', cas.id);
    check(
      '別の実行が先に「作成中」にした側は作らず、自分の印が残っている側だけ作る',
      mail.drafts.length - draftsBeforeCas === 1 && casRow?.['案件側下書き状態'] === foreign && STAMP.test(casRow?.['要員側下書き状態'] ?? ''),
      JSON.stringify({ n: mail.drafts.length - draftsBeforeCas, p: casRow?.['案件側下書き状態'], e: casRow?.['要員側下書き状態'] }),
    );

    // 担当者を替えて依頼し直し、入力の誤りでエラーになった側は、前の担当者の下書きを「作成済」と取り違えない
    const redo = makeMatch(p1, eB, 'confirmed');
    newRun();
    await saveMatch(redo);
    sheets.setByKey(REVIEW_BOOK, 'マッチ', 'ID', redo.id, '担当者メール', `taro@${OWN_DOMAIN}`);
    newRun();
    await materializePendingDrafts();
    sheets.setByKey(REVIEW_BOOK, 'マッチ', 'ID', redo.id, '担当者メール', 'bob@evil.example.com');
    sheets.setByKey(REVIEW_BOOK, 'マッチ', 'ID', redo.id, '案件側下書き状態', '');
    sheets.setByKey(REVIEW_BOOK, 'マッチ', 'ID', redo.id, '要員側下書き状態', '不要');
    newRun();
    await materializePendingDrafts();
    sheets.setByKey(REVIEW_BOOK, 'マッチ', 'ID', redo.id, '担当者メール', `bob@${OWN_DOMAIN}`);
    newRun();
    const bobBefore = mail.drafts.filter((d) => d.from === `bob@${OWN_DOMAIN}`).length;
    await materializePendingDrafts();
    check(
      '入力の誤りでエラーになった依頼は、直した後に新しい担当者の下書きを作る（前の担当者の下書きと取り違えない）',
      mail.drafts.filter((d) => d.from === `bob@${OWN_DOMAIN}`).length === bobBefore + 1 &&
        STAMP.test(sheets.record(REVIEW_BOOK, 'マッチ', 'ID', redo.id)?.['案件側下書き状態'] ?? ''),
      sheets.record(REVIEW_BOOK, 'マッチ', 'ID', redo.id)?.['案件側下書き状態'],
    );

    // サマリを送れなかった回のマッチは、次の回のサマリに載せる（送れたら控えを消す）
    process.env.SES_NOTIFY_TO = `boss@${OWN_DOMAIN}`;
    const unsent = makeMatch(p2, eB, 'confirmed');
    newRun();
    await saveMatch(unsent);
    const c0 = await loadUnnotifiedMatches();
    await rememberUnnotified(c0.ids, [unsent]);
    mail.failSend = true;
    const failed = await notifyResults([unsent], { created: 0, failed: 0 }, null, c0.rows);
    mail.failSend = false;
    newRun();
    const c1 = await loadUnnotifiedMatches();
    const sentBefore = mail.sent.length;
    const ok = await notifyResults([], { created: 0, failed: 0 }, null, c1.rows);
    if (ok !== 'failed') await clearUnnotified();
    const body = mail.sent.slice(sentBefore).map((m) => m.body).join('\n');
    newRun();
    const c2 = await loadUnnotifiedMatches();
    check(
      'サマリを送れなかった回のマッチは次の回のサマリに載せ、送れたら控えを消す',
      failed === 'failed' && c1.ids.includes(unsent.id) && ok === 'sent' && body.includes('お知らせできなかったマッチ') &&
        body.includes(unsent.title) && c2.ids.length === 0,
      JSON.stringify({ failed, ok, ids: c1.ids, left: c2.ids }),
    );
    delete process.env.SES_NOTIFY_TO;

    // 署名鍵があるとき、返信メタ（下書きの宛先の元）・営業元メールを書き換えた行・写した行は宛先に使わない
    process.env.SES_DRAFT_SIGNING_KEY = 'k'.repeat(32);
    const signedP = project('proj_sig', { title: '署名案件', requiredSkills: ['Java'], agentEmail: 'hanako@alpha.example.jp', replyTarget: rt('検証花子', 'hanako@alpha.example.jp', '【案件】署名', 'sig') });
    const otherP = project('proj_sig2', { title: '署名案件2', requiredSkills: ['Java'], agentEmail: 'jiro@beta.example.jp', replyTarget: rt('検証次郎', 'jiro@beta.example.jp', '【案件】署名2', 'sig2') });
    newRun();
    await saveProjectsSheets([signedP, otherP]);
    newRun();
    const intact = (await fetchOpenProjects(100)).find((x) => x.id === signedP.id);
    const metaCell = sheets.record(REVIEW_BOOK, '案件', 'ID', signedP.id)?.['返信メタ'] ?? '';
    sheets.setByKey(REVIEW_BOOK, '案件', 'ID', signedP.id, '返信メタ', metaCell.replace(/hanako@alpha\.example\.jp/g, 'outsider@competitor.example'));
    sheets.setByKey(REVIEW_BOOK, '案件', 'ID', otherP.id, '返信メタ', metaCell);
    newRun();
    const after = await fetchOpenProjects(100);
    const edited = after.find((x) => x.id === signedP.id);
    const copied = after.find((x) => x.id === otherP.id);
    check(
      '署名鍵があれば、書き換え・写しのあった返信メタ・営業元メールは下書きの宛先に使わない',
      intact?.replyTarget?.from.includes('hanako@alpha.example.jp') === true && intact.agentEmail === 'hanako@alpha.example.jp' &&
        edited !== undefined && edited.replyTarget === undefined && edited.agentEmail === '' &&
        copied !== undefined && copied.replyTarget === undefined && copied.agentEmail === '',
    );
    const draftOf = buildReplyRef(edited?.replyTarget, edited?.agentEmail ?? '', '件名', '本文');
    newRun();
    const sigMatch: MatchResult = { ...makeMatch(signedP, eA, 'confirmed'), draftToProject: draftOf };
    await saveMatch(sigMatch);
    const sigRow = sheets.record(REVIEW_BOOK, 'マッチ', 'ID', sigMatch.id);
    check(
      '宛先の分からない側は「不要（宛先が不明…）」にして依頼を受けず、もう片側は署名つきで作れる',
      sigRow?.['案件側下書き状態'] === DRAFT_STATE.noRecipient && sigRow?.['要員側下書き状態'] === '未作成' && !(sigRow?.['下書きデータ'] ?? '').includes('"project"'),
      JSON.stringify({ p: sigRow?.['案件側下書き状態'], e: sigRow?.['要員側下書き状態'] }),
    );
  } finally {
    delete process.env.SES_NOTIFY_TO;
    process.env.SES_DRAFT_SIGNING_KEY = FLOW_SIGNING_KEY;
    mail.failSend = false;
    process.env.SHEETS_DB_SPREADSHEET_ID = SES_BOOK;
    newRun();
  }
}

// ===== 10. ログ秘匿 =====

function captureConsole(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  const grab = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
  };
  console.log = grab;
  console.warn = grab;
  console.error = grab;
  console.info = grab;
  return { lines, restore: () => Object.assign(console, original) };
}

async function redactedRun(): Promise<void> {
  newRun();
  await materializePendingDrafts();
  const collected = await collectSesMail();
  await markMailProcessed(collected.mails.map((m) => m.id), '抽出済');
  await recordFailure(collected.mails[0] ?? rawMail('x', 'a@b.example.jp', 's', 1), new Error('解析失敗 nana@eta.example.jp 090-1111-2222'));
  const proper = await runProperFlow();
  const matches = allMatches();
  await persistAndNotify(matches, PROJECTS, ENGINEERS, { created: 0, failed: 0 }, proper);
}

async function testRedaction(): Promise<void> {
  section('ログ秘匿（公開のActionsログに氏名・アドレス・件名・案件名を出さない）');
  // ログに出やすい状況を作る: 新しいスキルシート・抽出失敗・下書き作成の失敗（エラー文に宛先を含む）・新着メール
  drive.put(driveFile('fileF', { name: 'スキルシート_高橋五月', mimeType: GDOC, modifiedTime: FILE_TIME(20), content: profileJson(profile('F', { displayName: '高橋五月', initials: 'G.T.', skills: ['PHP', 'MySQL'], residence: '東京都', prefecture: '東京都' })) }));
  drive.put(driveFile('fileG', { name: 'スキルシート_壊れ.pdf', modifiedTime: FILE_TIME(21), content: '{壊れたJSON 山田太郎' }));
  sheets.setByKey(SES_BOOK, 'マッチ', 'ID', m12().id, '担当者メール', `fail@${OWN_DOMAIN}`);
  mail.failDraftFrom.add(`fail@${OWN_DOMAIN}`);
  mail.inbox.push(rawMail('sesmail_flow_secret', '検証七子 <nana@eta.example.jp>', '【要員】秘匿検証メール', 1));
  process.env.SES_NOTIFY_TO = `boss@${OWN_DOMAIN}`;
  process.env.SES_LOG_REDACT = 'true';
  const sentBefore = mail.sent.length;

  const cap = captureConsole();
  let crashed: unknown = null;
  try {
    await redactedRun();
  } catch (err) {
    crashed = err;
  } finally {
    cap.restore();
  }
  check('秘匿モードの一連の処理が例外なく完了する', crashed === null, String(crashed));
  const out = cap.lines.join('\n');
  console.log('  （秘匿モードで出力されたログ）');
  for (const line of cap.lines) console.log(`    | ${line}`);
  const leaked = SENSITIVE.filter((s) => s && out.includes(s));
  check(`秘匿モードのログに氏名・アドレス・件名・案件名が出ない（検査${SENSITIVE.length}語・出力${cap.lines.length}行）`, leaked.length === 0, `漏れ: ${leaked.join(' / ')}`);
  // メールID（Message-IDのハッシュ）や案件・要員・マッチのIDは送り主が手元で計算できるため、公開ログには実行ごとの別名で出す
  const ids = out.match(/\b(?:sesmail|proj|eng|match)_[A-Za-z0-9_-]+/g) ?? [];
  check('秘匿モードのログにメール・案件・要員・マッチのIDを出さない（別名にする）', ids.length === 0, ids.slice(0, 5).join(' / '));
  check('秘匿モードでもエラーの種別は出す', /Error/.test(out));
  const summary = mail.sent.slice(sentBefore).find((m) => m.to === `boss@${OWN_DOMAIN}`);
  check('詳細（案件名・プロパー氏名）は非公開のサマリメールに載せる', Boolean(summary) && summary!.body.includes(p1.title) && summary!.body.includes('山田太郎'));
  const metricsRows = sheets.records(SES_BOOK, METRICS_TAB);
  const metricsText = JSON.stringify(metricsRows);
  check(
    'バッチごとに「メトリクス」タブへ1行追記する（件数・比率だけ。氏名・案件名・アドレスを含まない）',
    metricsRows.length > 0 && JSON.stringify(sheets.header(SES_BOOK, METRICS_TAB)) === JSON.stringify(METRICS_COLUMNS) &&
      metricsRows.every((r) => r['モード'] === '通常' && /^\{"skill":\d+/.test(r['除外理由内訳(JSON)'])) &&
      !SENSITIVE.some((w) => w && metricsText.includes(w)),
    metricsText.slice(0, 300),
  );
  check('サマリメールの診断レポートに同じメトリクスを載せる', Boolean(summary) && summary!.body.includes('【バッチのメトリクス（件数・比率のみ）】'));

  // 比較: 秘匿を解除すると同じ処理で案件名が出る（検査がログを捕まえていることの確認）
  process.env.SES_LOG_REDACT = 'false';
  const cap2 = captureConsole();
  try {
    newRun();
    await persistAndNotify(allMatches(), PROJECTS, ENGINEERS, { created: 0, failed: 0 }, null);
  } finally {
    cap2.restore();
  }
  check('（対照）秘匿を解除すると案件名がログに出る', cap2.lines.join('\n').includes(p1.title));
  mail.failDraftFrom.clear();
}

// ===== 11. セキュリティ監査の指摘の回帰（署名鍵・状態の形・リンク先シート） =====

async function testSecurityRegressions(): Promise<void> {
  section('セキュリティ監査の指摘の回帰（Sheets運用）');
  // 署名鍵が無い本番では、担当者メールの依頼から下書きを作らない（書き換えを検知できないため）
  const pk = project('proj_nokey', { title: '署名鍵なし案件', requiredSkills: ['Java'], agentEmail: 'hanako@alpha.example.jp', replyTarget: rt('検証花子', 'hanako@alpha.example.jp', '【案件】鍵なし', 'nokey') });
  const ek = engineer('eng_nokey', { displayName: 'N.K.', skills: ['Java'], agentEmail: 'jiro@beta.example.jp', replyTarget: rt('検証次郎', 'jiro@beta.example.jp', '【要員】鍵なし', 'nokey-e') });
  const mk = makeMatch(pk, ek, 'confirmed');
  newRun();
  await saveMatch(mk);
  sheets.setByKey(SES_BOOK, 'マッチ', 'ID', mk.id, '担当者メール', `taro@${OWN_DOMAIN}`);
  const draftsBefore = mail.drafts.length;
  delete process.env.SES_DRAFT_SIGNING_KEY;
  try {
    newRun();
    await materializePendingDrafts();
  } finally {
    process.env.SES_DRAFT_SIGNING_KEY = FLOW_SIGNING_KEY;
  }
  const rowK = sheets.record(SES_BOOK, 'マッチ', 'ID', mk.id);
  check(
    '署名鍵の無い本番では担当者メールの依頼から下書きを作らず、状態列にエラーを書く',
    mail.drafts.length === draftsBefore && (rowK?.['案件側下書き状態'] ?? '').includes('署名鍵') && (rowK?.['要員側下書き状態'] ?? '').includes('署名鍵'),
    JSON.stringify({ n: mail.drafts.length - draftsBefore, p: rowK?.['案件側下書き状態'], e: rowK?.['要員側下書き状態'] }),
  );
  newRun();
  await materializePendingDrafts();
  const rowK2 = sheets.record(SES_BOOK, 'マッチ', 'ID', mk.id);
  check(
    '署名鍵を登録した後の実行では、エラーだった依頼から下書きを作る',
    mail.drafts.length === draftsBefore + 2 && STAMP.test(rowK2?.['案件側下書き状態'] ?? '') && STAMP.test(rowK2?.['要員側下書き状態'] ?? ''),
    JSON.stringify({ n: mail.drafts.length - draftsBefore, p: rowK2?.['案件側下書き状態'] }),
  );

  // 指示混入疑いの印は署名した返信メタにも残すため、人が列の印を消しても要確認のまま（宛先は署名どおり使える）
  const injP = project('proj_injsig', { title: '印の検証案件', requiredSkills: ['Java'], agentEmail: 'hanako@alpha.example.jp', replyTarget: rt('検証花子', 'hanako@alpha.example.jp', '【案件】印', 'inj') });
  const extractedInj = project('proj_injsig2', { title: '抽出時の印', requiredSkills: ['Java'], agentEmail: 'jiro@beta.example.jp', injectionSuspected: true, replyTarget: rt('検証次郎', 'jiro@beta.example.jp', '【案件】印2', 'inj2') });
  newRun();
  await saveProjectsSheets([injP, extractedInj]);
  newRun();
  await markItemsInjectionSuspectedSheets('project', [injP.id]);
  sheets.setByKey(SES_BOOK, '案件', 'ID', injP.id, INJECTION_COLUMN, '');
  sheets.setByKey(SES_BOOK, '案件', 'ID', extractedInj.id, INJECTION_COLUMN, '');
  newRun();
  const reread = await fetchOpenProjects(1000);
  const judged = reread.find((x) => x.id === injP.id);
  const extracted = reread.find((x) => x.id === extractedInj.id);
  check(
    '指示混入疑いの列の印を人が消しても、署名した返信メタの印で要確認のまま（抽出時・AI判定時とも）',
    judged?.injectionSuspected === true && judged.replyTarget !== undefined && extracted?.injectionSuspected === true && extracted.replyTarget !== undefined,
    JSON.stringify({ j: judged?.injectionSuspected, jr: Boolean(judged?.replyTarget), e: extracted?.injectionSuspected, er: Boolean(extracted?.replyTarget) }),
  );

  // _状態タブの隔離リストを人が壊しても（配列でない値）、抽出の段を止めずに次の保存で配列に書き直す
  sheets.setByKey(SES_BOOK, '_状態', 'キー', 'quarantine', 'JSON', '{}');
  newRun();
  let threw = '';
  let failure = { attempts: 0, quarantined: false, recorded: false };
  try {
    await recordSuccess('sesmail_flow_any');
    failure = await recordFailure(rawMail('sesmail_flow_q2', '検証 <q@eta.example.jp>', '件名', 5), new Error('解析失敗'));
  } catch (err) {
    threw = String(err);
  }
  const stateJson = sheets.record(SES_BOOK, '_状態', 'キー', 'quarantine')?.['JSON'] ?? '';
  check(
    '壊れた隔離リスト（配列でない）でも例外にせず、次の保存で配列に書き直す',
    threw === '' && failure.recorded && failure.attempts === 1 && stateJson.startsWith('['),
    `${threw} ${stateJson.slice(0, 80)}`,
  );

  // 自社ドメイン・プロパーのフォルダが未設定だと社内のシートか確かめられないため、メール本文のリンク先は読まない
  const savedEnv = { own: process.env.SES_OWN_DOMAINS, folder: process.env.PROPER_SKILLSHEET_FOLDER_ID };
  delete process.env.SES_OWN_DOMAINS;
  delete process.env.PROPER_SKILLSHEET_FOLDER_ID;
  process.env.GOOGLE_SA_CLIENT_EMAIL = 'bot@proj.iam.gserviceaccount.com';
  process.env.GOOGLE_SA_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\\nx\\n-----END PRIVATE KEY-----';
  const link = 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdef/edit';
  const cap = captureConsole();
  let parsed: SesRawMail[] = [];
  try {
    parsed = await parseAttachments([{ ...rawMail('sesmail_flow_link', '検証 <a@x.example.jp>', 's', 1), body: link, sheetLinks: [link] }]);
  } finally {
    cap.restore();
    process.env.SES_OWN_DOMAINS = savedEnv.own ?? OWN_DOMAIN;
    if (savedEnv.folder !== undefined) process.env.PROPER_SKILLSHEET_FOLDER_ID = savedEnv.folder;
    delete process.env.GOOGLE_SA_CLIENT_EMAIL;
    delete process.env.GOOGLE_SA_PRIVATE_KEY;
  }
  check(
    '自社ドメイン等が未設定なら、メール本文のスプレッドシートのリンク先を読まない（社内のシートを読み出させない）',
    parsed.length === 1 && parsed[0].attachments.length === 0 && cap.lines.join('\n').includes('確かめられないため'),
    cap.lines.join(' / '),
  );
}

const RESEND_BOOK = 'fakeResendBook';
const DAY_MS = 24 * 60 * 60 * 1000;

async function testResendSkip(): Promise<void> {
  section('再送スキップ（抽出の前に同じ内容の再送を弾き、元の案件の最終受信日を更新）');
  sheets.createBook(RESEND_BOOK);
  const prevBook = process.env.SHEETS_DB_SPREADSHEET_ID;
  process.env.SHEETS_DB_SPREADSHEET_ID = RESEND_BOOK;
  try {
    await resendSkipSteps();
  } finally {
    process.env.SHEETS_DB_SPREADSHEET_ID = prevBook;
    newRun();
  }
}

async function resendSkipSteps(): Promise<void> {
  newRun();
  const oldAt = new Date(NOW.getTime() - 3 * DAY_MS);
  const first = { ...rawMail('sesmail_rs_1', '検証一郎 <ichiro@alpha.example.jp>', '【案件】Java 検証', 3 * 24 * 60), body: '案件名：Java 検証\n単金：70万\n場所：東京' };
  const firstSplit = splitResends([first], [], { since: new Date(NOW.getTime() - 14 * DAY_MS), threshold: 0.9 });
  const fp = firstSplit.fingerprints.get(first.id)!;
  await markMailProcessed([first.id], '抽出済', new Map([[first.id, { fingerprint: serializeFingerprint(fp.fp), rootMailId: first.id }]]));
  await saveProjectsSheets([{ ...p1, id: 'proj_rs', sourceMailId: first.id, receivedAt: oldAt }]);

  newRun();
  const records = await loadFingerprintRecords(new Date(NOW.getTime() - 14 * DAY_MS));
  const resent = { ...first, id: 'sesmail_rs_2', subject: 'Re: 【再送】【案件】Java 検証', receivedAt: NOW };
  const changed = { ...first, id: 'sesmail_rs_3', body: first.body.replace('70万', '75万'), receivedAt: NOW };
  const split = splitResends([resent, changed], records, { since: new Date(NOW.getTime() - 14 * DAY_MS), threshold: 0.9 });
  check('処理済みメールタブの指紋を読み、同じ内容の再送だけをスキップ（単価を変えた再送は抽出）', records.length === 1 && split.skipped.map((x) => x.mail.id).join() === 'sesmail_rs_2' && split.fresh.map((m) => m.id).join() === 'sesmail_rs_3');
  const skippedIds = split.skipped.map((x) => x.mail.id);
  await markMailProcessed(skippedIds, '再送スキップ', new Map(skippedIds.map((id) => [id, { fingerprint: serializeFingerprint(split.fingerprints.get(id)!.fp), rootMailId: split.fingerprints.get(id)!.rootMailId }])));
  await touchLastSeen(new Map([[first.id, NOW]]));
  const row = sheets.records(RESEND_BOOK, '処理済みメール').find((r) => r['メールID'] === 'sesmail_rs_2');
  check('スキップしたメールは「再送スキップ」と元メールを記録（指紋に本文を含めない）', row?.['結果'] === '再送スキップ' && row?.['元メール'] === first.id && !(row?.['指紋'] ?? '').includes('Java'));
  newRun();
  const read = (await fetchOpenProjects(10)).find((p) => p.id === 'proj_rs');
  check('元の案件の最終受信日を更新し、突合の対象期間では新しい受信として扱う', read?.receivedAt.getTime() === NOW.getTime(), String(read?.receivedAt.toISOString()));
  await saveProjectsSheets([{ ...p1, id: 'proj_rs', sourceMailId: first.id, receivedAt: oldAt }]);
  check('抽出し直して保存しても最終受信日は消えない', sheets.record(RESEND_BOOK, '案件', 'ID', 'proj_rs')?.[LAST_SEEN_COLUMN] === NOW.toISOString());
  newRun();
  const records2 = await loadFingerprintRecords(new Date(NOW.getTime() - 14 * DAY_MS));
  const again = splitResends([{ ...resent, id: 'sesmail_rs_4' }], records2, { since: new Date(NOW.getTime() - 14 * DAY_MS), threshold: 0.9 });
  check('再送の再送も最初のメールを元としてスキップ', again.skipped[0]?.rootMailId === first.id);
}

async function main(): Promise<void> {
  console.log('=== SESスプレッドシート運用 結合自己検証（オフライン・偽のGoogle API） ===');
  isolateEnv();
  blockNetwork();
  rmSync(join(process.cwd(), WORK_DIR), { recursive: true, force: true });
  __setSheetsApiForTest(sheets.asApi());
  __setDriveForTest(drive.asApi());
  __setMailTransportForTest(mail);
  __setSkillSheetExtractorForTest(fakeExtract);

  try {
    await testTabsAndHeaders();
    await testUpsertIdempotency();
    await testShiftedRows();
    await testJudgeGateAndSuppression();
    await testProcessedIds();
    await testQuarantine();
    await testPendingDrafts();
    await testProperMaster();
    await testDriveShortcuts();
    await testProperCandidates();
    await testHeaderByName();
    await testResumeAndDurability();
    await testReviewRegressions();
    await testResendSkip();
    await testRedaction();
    await testSecurityRegressions();
  } catch (err) {
    failures += 1;
    console.log(`  ❌ 検証が例外で中断しました: ${err instanceof Error ? err.stack : String(err)}`);
  } finally {
    __setSheetsApiForTest(null);
    __setDriveForTest(null);
    __setMailTransportForTest(null);
    __setSkillSheetExtractorForTest(null);
    rmSync(join(process.cwd(), WORK_DIR), { recursive: true, force: true });
  }

  section('全体');
  check('実APIなら拒否される呼び方をしていない（RAW以外の書き込み等）', sheets.violations.length === 0, sheets.violations.join(' / '));
  check('ネットワークに一切接続していない', networkAttempts === 0, `${networkAttempts}回`);
  console.log(`\nSheets API 呼び出し: ${sheets.callCount()}回`);
  if (failures > 0) {
    console.log(`\n❌ ${failures}件の検証に失敗しました`);
    process.exit(1);
  }
  console.log('\n✅ すべての検証に合格しました');
}

main().catch((err) => {
  console.error(`ses:flow:check: 予期しないエラー: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
