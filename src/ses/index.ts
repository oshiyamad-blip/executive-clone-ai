import '../env.js';
import { collectSesMail } from './collect.js';
import { parseAttachments } from './parse.js';
import { extractItems, itemIdOf, type ExtractFlush } from './extract.js';
import { matchAll, parseMatchId, resetPrimarySelectTally, resetJudgeTally, type PairScope } from './match.js';
import { matchIncrementally, persistInjectionFlags } from './matchRun.js';
import { loadSuppressionIndex } from './suppress.js';
import { createDrafts } from './draft.js';
import { persistAndNotify, notifyResults, loadUnnotifiedMatches, rememberUnnotified, clearUnnotified } from './notify.js';
import { materializePendingDrafts, type PendingDraftResult } from './pendingDrafts.js';
import { runProperFlow, activeProperEngineerIds, type ProperRunResult } from './proper/index.js';
import { resetProperMasterCache } from './proper/master.js';
import {
  markMailProcessed,
  loadFingerprintRecords,
  touchLastSeen,
  type ProcessedFingerprint,
  writeDemoArtifact,
  readDemoArtifact,
  dedupeProjects,
  dedupeEngineers,
  withoutResentProjects,
  withoutResentEngineers,
  reconcileReextractedIds,
} from './store.js';
import {
  saveProjects,
  saveEngineers,
  fetchOpenProjects,
  fetchAvailableEngineers,
  fetchMatchLedger,
  fetchItemsByIds,
  fetchSavedItemsForMails,
} from '../database/index.js';
import {
  resetSheetsCache,
  checkSheetsTabs,
  sheetsCellCount,
  pruneProcessedMailSheets,
  pruneStalePersonalDataSheets,
  sheetsDbConfigured,
  countUnmatchedBeyondPoolSheets,
  acquireBatchLeaseSheets,
  releaseBatchLeaseSheets,
} from '../database/sheets.js';
import {
  isDemo,
  liveConfigError,
  minGrossMarginJpy,
  maxCandidatesPerItem,
  repairEnabled,
  matchLookbackDays,
  resendWindowDays,
  resendSimilarity,
  matchPoolLimit,
  dbProvider,
  runDeadlineMinutes,
  logRedact,
  resetExtractModelFallback,
  COLLECT_DAYS_MAX,
  llmProviderName,
  geminiUsesVertex,
  geminiApiAcknowledged,
  pricingSettingsInvalid,
  retentionDays,
} from './config.js';
import { geminiDataUseProblem } from './settingsFormat.js';
import { setMetricsMode, recordBatchMetrics, collectBatchMetrics } from './batchMetrics.js';
import { startHealBatch } from './heal/budget.js';
import { persistUnknownSkillTokens, resetSkillTokenTally } from './skillStats.js';
import {
  resetHealEvents,
  recordStat,
  getStats,
  recordFatal,
  hasFatal,
  fatalReasons,
  recordHealEvent,
} from './heal/events.js';
import { runRepair } from './heal/repair.js';
import { startRunClock, stopRunClock, pastRunDeadline, DAY_MS } from './schedule.js';
import { redactable, safeErr, logId } from './redact.js';
import { splitResends, serializeFingerprint, type ResendSplit } from './resend.js';
import type { Project, Engineer, ExtractedItem, MatchResult, SesRawMail } from '../types/index.js';
import type { MatchLedger } from '../database/sheets.js';

// SESマッチングバッチのオーケストレータ。
// 本番の通常バッチ: 下書き依頼 → 保存先の確認 → collect→parse→extract（10通ごとに保存・処理済み記録）→
//   match（小分けに判定・保存し、終えた案件・要員に突合済）→ proper → notify。
//   実行時間の期限（SES_RUN_DEADLINE_MINUTES）を過ぎたら新しい抽出・判定を始めず、済んだ分でサマリを送る
//   （途中で打ち切られても、処理済みにしていないメール・突合済でない案件と要員は次回の実行で続きから処理する）。
// demo・--match-only: 従来どおり全件を抽出・突合してから保存・通知する。
// 各段は try/catch でエラーを吸収し、途中段が失敗しても後続へ渡せるデータがあれば継続する。
// 収集失敗・保存失敗・重大異常・サマリ送信失敗などは recordFatal で記録し、終了コードを非0にする
// （スケジュール実行で「失敗」として検知・通知させるため）。
export interface SesBatchOptions {
  collectOnly?: boolean; // ①〜④まで（保存で止める）
  matchOnly?: boolean; // ⑤〜⑦のみ（既存DB/demo成果物から読んで突合）
}

export async function runSesBatch(opts: SesBatchOptions = {}): Promise<void> {
  console.log('=== SES案件・要員マッチングバッチ開始 ===');
  // CI等で鍵が渡っていないのに demo（fixture）で「成功」しないよう、設定不備はここで異常終了にする
  const configError = liveConfigError();
  if (configError) {
    console.error(`SESバッチ: 🚨 ${configError}`);
    process.exitCode = 1;
    return;
  }
  if (!isDemo()) {
    const geminiProblem = geminiDataUseProblem({ provider: llmProviderName(), vertex: geminiUsesVertex(), acknowledged: geminiApiAcknowledged(), production: true });
    if (geminiProblem) {
      console.error(`SESバッチ: 🚨 ${geminiProblem}`);
      process.exitCode = 1;
      return;
    }
    // 価格の方針を解釈できないまま既定値（公開されている値）・誤った単位で動かさない（値はログに出さない）
    if (pricingSettingsInvalid()) {
      console.error('SESバッチ: 🚨 価格の方針（SES_PRICING_POLICY_JSON・MIN_GROSS_MARGIN_*・NEGOTIATION_MAX_*）に解釈できない値があるため停止します（npm run ses:preflight で確認）');
      process.exitCode = 1;
      return;
    }
  }
  // 粗利下限は社外に知られたくない方針（Secretsに登録）のため、公開ログ（秘匿モード）には値を出さない
  const margin = logRedact() ? '設定済み（値は表示しません）' : `${minGrossMarginJpy()}円/月`;
  console.log(`モード: ${isDemo() ? 'DEMO（外部呼び出しなし）' : '本番'} / 粗利下限: ${margin} / 候補上限: ${maxCandidatesPerItem()}件`);

  // 自動検証・修復レイヤーの初期化（コストメーターとイベント収集。demoでは実質no-op）
  startHealBatch();
  resetHealEvents();
  resetSkillTokenTally();
  resetPrimarySelectTally();
  resetJudgeTally();
  resetSheetsCache();
  resetProperMasterCache();
  resetExtractModelFallback();
  setMetricsMode(isDemo() ? 'demo' : opts.matchOnly ? '突合のみ' : opts.collectOnly ? '収集のみ' : '通常');
  if (!isDemo()) startRunClock();

  let lease: string | null = null;
  try {
    lease = await acquireLease();
    if (lease !== null) {
      await runStages(opts);
      await persistUnknownSkillTokens();
    }
  } finally {
    if (lease) await releaseLease(lease);
    stopRunClock();
    if (hasFatal()) {
      console.error(`=== SESバッチ: 異常終了扱い（要因${fatalReasons().length}件）: ${fatalReasons().join(' / ')} ===`);
      process.exitCode = 1;
    }
  }
}

// 実行中の印の期限。ジョブの制限時間（40分）を含む長さにする（打ち切られた実行の印は期限で無効になる）
const LEASE_EXTRA_MINUTES = 30;

// 同時に動くバッチを1つに限る（定時実行と手元・自前の定期実行が重なると、同じ依頼の下書き・同じメールの行を二重に作るため）。
// 実行してよければ印の識別子、だめなら null（異常終了として知らせる）。Sheets運用の本番以外は印を使わない（''）
async function acquireLease(): Promise<string | null> {
  if (isDemo() || dbProvider() !== 'sheets' || !sheetsDbConfigured()) return '';
  try {
    const r = await acquireBatchLeaseSheets((runDeadlineMinutes() + LEASE_EXTRA_MINUTES) * 60_000);
    if (r.ok) return r.token;
    recordFatal(
      `別のバッチが実行中のため、この実行では何もしませんでした（その実行の印の期限: ${r.until}）。` +
        '前回の実行が打ち切られた場合は、期限を過ぎれば次の実行から動きます（急ぐ場合はスプレッドシート「_状態」タブの batchLease の行を消してください）',
    );
  } catch (err) {
    console.error(`SES: 実行中の印を確かめられません: ${safeErr(err)}`);
    recordFatal('実行中の印（スプレッドシート「_状態」タブ）を確かめられないため、この実行では何もしませんでした（共有・見出しを確認してください）');
  }
  return null;
}

async function releaseLease(token: string): Promise<void> {
  try {
    await releaseBatchLeaseSheets(token);
  } catch (err) {
    console.warn(`SES: 実行中の印を消せませんでした（期限を過ぎれば無効になります）: ${safeErr(err)}`);
  }
}

async function runStages(opts: SesBatchOptions): Promise<void> {
  // 前回バッチ以降にスプレッドシートの「担当者メール」で依頼された下書きを、収集より先に作成する
  let requestedDrafts: PendingDraftResult = { created: 0, failed: 0 };
  try {
    requestedDrafts = await materializePendingDrafts(undefined, activeProperEngineerIds);
  } catch (err) {
    console.error(`SES下書き依頼: 失敗: ${safeErr(err)}`);
    recordFatal('担当者指定の下書き作成段が例外で停止しました');
  }

  if (opts.matchOnly || isDemo()) {
    await runWholeBatch(opts, requestedDrafts);
    return;
  }

  // 本番の通常バッチ
  const pool = await loadStorePool();
  let stored: StoredItems = { projects: [], engineers: [] };
  if (pool) {
    stored = await collectAndStoreLive(pool);
    if (opts.collectOnly) {
      // サマリは送らないが、抽出の不明率等は「メトリクス」タブに残す
      await recordBatchMetrics(collectBatchMetrics({ requestedDrafts: requestedDrafts.created }));
      console.log(`=== --collect-only指定のため収集・保存のみで終了（案件${stored.projects.length}件・要員${stored.engineers.length}件） ===`);
      return;
    }
  }

  // 前回までの実行で保存したがサマリで知らせ損ねたマッチ（今回のサマリに載せる）
  const carried = await loadUnnotifiedMatches();
  const saved: MatchResult[] = [];
  const remember = () => rememberUnnotified(carried.ids, saved);
  if (pool) {
    try {
      const { projects, engineers, scope } = matchScope(pool, stored);
      console.log(
        `SESマッチング: 新着 案件${stored.projects.length}件・要員${stored.engineers.length}件を、直近${matchLookbackDays()}日の` +
          `案件${projects.length - stored.projects.length}件・要員${engineers.length - stored.engineers.length}件とも突合します（判定済み${pool.ledger.judged.size}組は除外・判定待ち${pool.ledger.deferred.size}組は判定し直し）`,
      );
      const suppression = await loadSuppressionIndex({ projects, engineers });
      await matchIncrementally(projects, engineers, scope, {
        saved,
        checkpoint: remember,
        suppression,
        pendingItems: pool.pendingItems,
      });
    } catch (err) {
      console.error(`SESマッチング: 失敗: ${safeErr(err)}`);
      recordFatal('マッチング段が例外で停止しました（突合済でない案件・要員は次回の実行で突合します）');
    }
  }
  try {
    await remember();
  } catch (err) {
    console.warn(`SES通知: 知らせていないマッチの控えを書けません: ${safeErr(err)}`);
  }

  const proper = pastRunDeadline() ? skipProperForDeadline() : await runProperStage([]);
  try {
    // 送れた（または送る先が無い）ときだけ控えを消す。送れなければ次の回のサマリに持ち越す
    if ((await notifyResults(saved, requestedDrafts, proper, carried.rows)) !== 'failed') await clearUnnotified();
  } catch (err) {
    console.error(`SES通知: 失敗: ${safeErr(err)}`);
    recordFatal('通知段が例外で停止しました');
  }
  console.log(`=== SESバッチ完了: マッチ候補 計${saved.length}件 ===`);
  await pruneProcessedMails();
  await pruneStalePersonalData();
  await maybeRepair();
}

// demo・--match-only: 全件を抽出・突合してから保存・通知する（従来の流れ）
async function runWholeBatch(opts: SesBatchOptions, requestedDrafts: PendingDraftResult): Promise<void> {
  let projects: Project[];
  let engineers: Engineer[];
  if (opts.matchOnly) {
    ({ projects, engineers } = await loadExisting());
  } else {
    ({ projects, engineers } = await collectAndStoreWhole());
    if (opts.collectOnly) {
      console.log(`=== --collect-only指定のため収集・保存のみで終了（案件${projects.length}件・要員${engineers.length}件） ===`);
      return;
    }
  }
  const matches = await matchDraftAndNotify(projects, engineers, requestedDrafts);
  console.log(`=== SESバッチ完了: マッチ候補 計${matches.length}件 ===`);
  await maybeRepair();
}

async function maybeRepair(): Promise<void> {
  // 隔離が増えた場合、opt-in（SES_REPAIR_ENABLED=true）なら修正パッチ案を自動生成（1日1回まで）。
  // 生成には時間がかかるため、実行時間の期限を過ぎていれば次の回に回す（手動の npm run ses:repair はいつでも可）
  if (!isDemo() && repairEnabled() && getStats().quarantinedNew > 0) {
    if (pastRunDeadline()) {
      console.log('SES修復: 実行時間の上限を過ぎたため、修正パッチ案の自動生成は次の回に回します（手動: npm run ses:repair）');
      return;
    }
    try {
      await runRepair(true);
    } catch (err) {
      console.error(`SES修復: パッチ案の自動生成に失敗: ${safeErr(err)}`);
    }
  }
}

function isProjectItem(item: ExtractedItem): item is { kind: 'project'; project: Project } {
  return item.kind === 'project';
}

function isEngineerItem(item: ExtractedItem): item is { kind: 'engineer'; engineer: Engineer } {
  return item.kind === 'engineer';
}

interface StorePool {
  projects: Project[];
  engineers: Engineer[];
  ledger: MatchLedger;
  // 判定待ちの組の相手のうち、突合の対象期間を外れた案件・要員（その組の判定にだけ使う）
  pendingItems: { projects: Project[]; engineers: Engineer[] };
}

interface StoredItems {
  projects: Project[];
  engineers: Engineer[];
}

// スプレッドシートのセル数の上限（1,000万）に近づいたら知らせる（上限に達すると追記がすべて失敗する）
const SHEETS_CELL_LIMIT = 10_000_000;

// 保存先を確かめ、直近の案件・要員と判定済みのペアを読む。読めなければ（共有の解除・見出しの変更等）
// LLMで抽出しても保存できず毎回同じメールを抽出し直すことになるため、収集・抽出・突合をせずに異常終了として知らせる
async function loadStorePool(): Promise<StorePool | null> {
  const since = new Date(Date.now() - matchLookbackDays() * DAY_MS);
  try {
    if (dbProvider() === 'sheets' && sheetsDbConfigured()) {
      // _状態（隔離リスト等）も先に確かめる（読めないまま抽出すると、失敗したメールを隔離できずに取りこぼすため）
      await checkSheetsTabs(['案件', '要員', 'マッチ', '処理済みメール', '_状態']);
      const cells = sheetsCellCount();
      if (cells > SHEETS_CELL_LIMIT * 0.8) {
        recordHealEvent(
          cells > SHEETS_CELL_LIMIT * 0.95 ? 'critical' : 'warn',
          `スプレッドシートのセル数が上限（1,000万）の${Math.round((cells / SHEETS_CELL_LIMIT) * 100)}%です（古い行を別のスプレッドシートへ移してください）`,
        );
      }
    }
    const [projects, engineers, ledger] = await Promise.all([
      fetchOpenProjects(matchPoolLimit(), { receivedSince: since }),
      fetchAvailableEngineers(matchPoolLimit(), { receivedSince: since }),
      fetchMatchLedger(since),
    ]);
    const pendingItems = await loadPendingItems(ledger, projects, engineers);
    if (dbProvider() === 'sheets' && sheetsDbConfigured()) {
      const beyond = await countUnmatchedBeyondPoolSheets(matchPoolLimit(), since);
      if (beyond.projects + beyond.engineers > 0) {
        recordHealEvent(
          'critical',
          `突合前の案件${beyond.projects}件・要員${beyond.engineers}件が、突合の対象の上限（SES_MATCH_POOL_LIMIT=${matchPoolLimit()}件）を超えて` +
            '対象から外れています（判定されないまま残ります。SES_MATCH_POOL_LIMIT を上げてください）',
        );
      }
    }
    return { projects, engineers, ledger, pendingItems };
  } catch (err) {
    console.error(`SES: 保存先を読み込めません: ${safeErr(err)}`);
    recordFatal('保存先（スプレッドシート等）を読み込めないため、メールの抽出と突合を行いませんでした（共有・見出しを確認してください）');
    return null;
  }
}

// 判定待ちの組（判定「未判定」）の相手のうち、突合の対象期間を外れた案件・要員を ID で読む。
// 読めなかった組は今回は判定も閉じもせず、判定待ちのまま次回に回す（ledger.deferred から外す）
async function loadPendingItems(
  ledger: MatchLedger,
  projects: Project[],
  engineers: Engineer[],
): Promise<{ projects: Project[]; engineers: Engineer[] }> {
  const knownProjects = new Set(projects.map((p) => p.id));
  const knownEngineers = new Set(engineers.map((e) => e.id));
  const wantProjects = new Set<string>();
  const wantEngineers = new Set<string>();
  for (const id of ledger.deferred) {
    const ids = parseMatchId(id);
    if (!ids) {
      ledger.deferred.delete(id);
      continue;
    }
    if (!knownProjects.has(ids.projectId)) wantProjects.add(ids.projectId);
    if (!knownEngineers.has(ids.engineerId)) wantEngineers.add(ids.engineerId);
  }
  if (wantProjects.size + wantEngineers.size === 0 || dbProvider() !== 'sheets') {
    // Notion は ID で読めないため、対象期間内の案件・要員の組だけを判定し直す（それ以外は閉じずに残す）
    for (const id of [...ledger.deferred]) {
      const ids = parseMatchId(id)!;
      if (wantProjects.has(ids.projectId) || wantEngineers.has(ids.engineerId)) ledger.deferred.delete(id);
    }
    return { projects: [], engineers: [] };
  }
  try {
    return await fetchItemsByIds(wantProjects, wantEngineers);
  } catch (err) {
    console.warn(`SES: 判定待ちの組の案件・要員を読めません（今回はその組を判定せず次回に回します）: ${safeErr(err)}`);
    for (const id of [...ledger.deferred]) {
      const ids = parseMatchId(id)!;
      if (wantProjects.has(ids.projectId) || wantEngineers.has(ids.engineerId)) ledger.deferred.delete(id);
    }
    return { projects: [], engineers: [] };
  }
}

// 本番の①〜④: 収集 → 展開 → 抽出。10通ごとに、再送を除いて保存し、保存できたメールを処理済みにする
// （途中で打ち切られても済んだ分を失わず、次回同じメールを抽出し直さないため）
async function collectAndStoreLive(pool: StorePool): Promise<StoredItems> {
  const parsedMails = await collectAndParse();
  const stored: StoredItems = { projects: [], engineers: [] };
  const knownProjects = [...pool.projects];
  const knownEngineers = [...pool.engineers];
  const matchedById = new Map<string, boolean | undefined>([
    ...pool.projects.map((p) => [p.id, p.matched] as const),
    ...pool.engineers.map((e) => [e.id, e.matched] as const),
  ]);
  let saveFailures = 0;
  let markFailed = false;

  const flush: ExtractFlush = async ({ items, processedMailIds }) => {
    const extracted = await withStableIds(
      items.filter(isProjectItem).map((i) => i.project),
      items.filter(isEngineerItem).map((i) => i.engineer),
    );
    const projects = withoutResentProjects(knownProjects, dedupeProjects(extracted.projects));
    const engineers = withoutResentEngineers(knownEngineers, dedupeEngineers(extracted.engineers));
    const failedMailIds = new Set<string>();
    const [pr, er] = [await saveProjects(projects), await saveEngineers(engineers)];
    for (const p of projects) {
      const err = pr.failed.get(p.id);
      if (err !== undefined) {
        console.error(`SES保存: 案件保存失敗 (${logId(p.id)} ${redactable(p.title)}): ${safeErr(err)}`);
        failedMailIds.add(p.sourceMailId);
        continue;
      }
      // 保存済みの行を抽出し直した場合は、人が付けた「終了」と突合済の印をシートの値のまま引き継ぐ
      // （抽出し直した値で「募集中・突合前」として扱うと、終了した案件を紹介し直してしまう）
      const kept = pr.saved?.get(p.id) ?? { ...p, matched: matchedById.get(p.id) ?? false };
      const saved = { ...kept, notionPageId: pr.pageIds.get(p.id) };
      stored.projects.push(saved);
      knownProjects.push(saved);
    }
    for (const e of engineers) {
      const err = er.failed.get(e.id);
      if (err !== undefined) {
        console.error(`SES保存: 要員保存失敗 (${logId(e.id)} ${redactable(e.displayName)}): ${safeErr(err)}`);
        failedMailIds.add(e.sourceMailId);
        continue;
      }
      const kept = er.saved?.get(e.id) ?? { ...e, matched: matchedById.get(e.id) ?? false };
      const saved = { ...kept, notionPageId: er.pageIds.get(e.id) };
      stored.engineers.push(saved);
      knownEngineers.push(saved);
    }
    const failures = pr.failed.size + er.failed.size;
    saveFailures += failures;
    // 保存に失敗した案件・要員の元メールは処理済みにしない（次回再抽出。IDはメールIDと出現順から決まるため同じ行を更新する）
    const doneIds = processedMailIds.filter((id) => !failedMailIds.has(id));
    if (!(await markMailProcessed(doneIds, '抽出済', processedFingerprints(parsedMails.resend, doneIds)))) markFailed = true;
    // この回の保存がすべて失敗した（保存先に書けない）なら、これ以上LLMで抽出しても保存できないため止める
    const attempted = projects.length + engineers.length;
    return !markFailed && !(attempted > 0 && failures === attempted);
  };

  let quarantinedMailIds: string[] = [];
  try {
    ({ quarantinedMailIds } = await extractItems(parsedMails.mails, { onBatch: flush, batchSize: 10 }));
  } catch (err) {
    console.error(`SES抽出: 失敗: ${safeErr(err)}（未保存のメールは処理済みにせず次回再処理します）`);
    recordFatal('抽出段が例外で停止しました');
  }
  if (saveFailures > 0) {
    recordFatal(`抽出した案件・要員${saveFailures}件を保存できませんでした（元のメールは処理済みにせず次回再処理します）`);
  }
  const quarantinedMarked = await markMailProcessed(quarantinedMailIds, '隔離');
  // 再送スキップ: 抽出せずに処理済みにし、元の案件・要員の最終受信日を更新する（直近の突合の対象から外れないように）
  const skippedIds = parsedMails.resend.skipped.map((x) => x.mail.id);
  const skippedMarked = await markMailProcessed(skippedIds, '再送スキップ', processedFingerprints(parsedMails.resend, skippedIds));
  const lastSeen = new Map<string, Date>();
  for (const { mail, rootMailId } of parsedMails.resend.skipped) {
    const prev = lastSeen.get(rootMailId);
    if (!prev || prev.getTime() < mail.receivedAt.getTime()) lastSeen.set(rootMailId, mail.receivedAt);
  }
  await touchLastSeen(lastSeen);
  // 自分たちのメールとして除外した分も記録し、次回から本文を取得し直さない
  const excludedMarked = await markMailProcessed(parsedMails.excludedMailIds, '除外');
  if (markFailed || !quarantinedMarked || !excludedMarked || !skippedMarked) {
    recordFatal('処理済みメールIDを保存できませんでした（次回同じメールを再処理します）');
  }
  return stored;
}

// 同じメールを抽出し直した（前回は一部の保存に失敗して処理済みにしなかった等）とき、IDを保存済みの行と内容で対応付ける。
// IDはメール内の出現順から作るため、LLMが項目の順番・件数を変えて返すと、別の案件・要員の行を上書きしてしまう
async function withStableIds(projects: Project[], engineers: Engineer[]): Promise<{ projects: Project[]; engineers: Engineer[] }> {
  const mailIds = new Set([...projects.map((p) => p.sourceMailId), ...engineers.map((e) => e.sourceMailId)]);
  let savedItems: { projects: Project[]; engineers: Engineer[] };
  try {
    savedItems = await fetchSavedItemsForMails(mailIds);
  } catch (err) {
    console.warn(`SES保存: 保存済みの行を確かめられないため、抽出した順のIDで保存します: ${safeErr(err)}`);
    return { projects, engineers };
  }
  return {
    projects: reconcileReextractedIds('project', projects, savedItems.projects, (mailId, i) => itemIdOf('proj', mailId, i)),
    engineers: reconcileReextractedIds('engineer', engineers, savedItems.engineers, (mailId, i) => itemIdOf('eng', mailId, i)),
  };
}

async function collectAndParse(): Promise<{ mails: SesRawMail[]; excludedMailIds: string[]; resend: ResendSplit }> {
  let mails: SesRawMail[] = [];
  let excludedMailIds: string[] = [];
  let collectFailed = false;
  try {
    ({ mails, excludedMailIds } = await collectSesMail());
  } catch (err) {
    collectFailed = true;
    console.error(`SES収集: 失敗: ${safeErr(err)}`);
    recordFatal('メール収集に失敗しました');
  }
  console.log(`SES収集: 未処理メール${mails.length}件`);
  recordStat('collected', mails.length);
  if (mails.length === 0 && !collectFailed) {
    console.log('SES収集: 未処理の新着メールはありません（続く場合はメーリスの配信・転送設定を確認してください）');
  }
  const resend = await splitResendMails(mails);
  let parsedMails = resend.fresh;
  try {
    parsedMails = await parseAttachments(resend.fresh);
  } catch (err) {
    console.error(`SES展開: 失敗: ${safeErr(err)}`);
  }
  return { mails: parsedMails, excludedMailIds, resend };
}

// 抽出の前に、直近に抽出した内容と同じ再送を分ける（Haikuの抽出を呼ばない。件数だけログに出す）
async function splitResendMails(mails: SesRawMail[]): Promise<ResendSplit> {
  const days = resendWindowDays();
  if (days <= 0 || mails.length === 0) return { fresh: mails, skipped: [], fingerprints: splitResends(mails, [], { since: new Date(), threshold: 1 }).fingerprints };
  const since = new Date(Date.now() - days * DAY_MS);
  const records = await loadFingerprintRecords(since);
  const split = splitResends(mails, records, { since, threshold: resendSimilarity() });
  if (split.skipped.length > 0) {
    console.log(`SES再送: 直近${days}日に抽出済みの内容と同じ再送${split.skipped.length}通を抽出せずにスキップします`);
  }
  recordStat('resendSkipped', split.skipped.length);
  return split;
}

function processedFingerprints(split: ResendSplit, ids: string[]): Map<string, ProcessedFingerprint> {
  const out = new Map<string, ProcessedFingerprint>();
  for (const id of ids) {
    const f = split.fingerprints.get(id);
    if (f) out.set(id, { fingerprint: serializeFingerprint(f.fp), rootMailId: f.rootMailId });
  }
  return out;
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Map<string, T>();
  for (const item of items) if (!seen.has(item.id)) seen.set(item.id, item);
  return [...seen.values()];
}

// 突合の範囲: 今回保存した案件・要員と直近の保存済みのうち、まだ突合を終えていないもの（突合済でない）を含み、
// 判定済みでないペア。Notion等「突合済」を記録しない保存先では、保存済みのものは突合済みとして扱う
function matchScope(pool: StorePool, stored: StoredItems): { projects: Project[]; engineers: Engineer[]; scope: PairScope } {
  const projects = uniqueById([...stored.projects, ...pool.projects]);
  const engineers = uniqueById([...stored.engineers, ...pool.engineers]);
  return {
    projects,
    engineers,
    scope: {
      newProjectIds: new Set(projects.filter((p) => p.matched === false).map((p) => p.id)),
      newEngineerIds: new Set(engineers.filter((e) => e.matched === false).map((e) => e.id)),
      judgedMatchIds: pool.ledger.judged,
      capFreeMatchIds: pool.ledger.capFree,
      pendingMatchIds: pool.ledger.deferred,
    },
  };
}

// 収集期間を十分過ぎた処理済みメールの記録を消す（スプレッドシートの容量対策。失敗しても次回に回すだけ）。
// 取りこぼしの復旧で SES_COLLECT_DAYS を広げて再実行しても処理済みのメールを抽出し直さないよう、
// 今の設定ではなく設定できる最大の日数（60日）より古い記録だけを消す
async function pruneProcessedMails(): Promise<void> {
  if (dbProvider() !== 'sheets' || !sheetsDbConfigured()) return;
  try {
    const removed = await pruneProcessedMailSheets(new Date(Date.now() - (COLLECT_DAYS_MAX + 7) * DAY_MS));
    if (removed > 0) console.log(`SES: 収集期間を過ぎた処理済みメールの記録${removed}行を削除しました`);
  } catch (err) {
    console.warn(`SES: 処理済みメールの記録の整理に失敗: ${safeErr(err)}`);
  }
}

// 個人データの保存期間（SES_RETENTION_DAYS）を過ぎた案件・要員・マッチ・プロパー候補・評価の行を整理する
// （突合・再確認に使うのは直近の行だけのため。失敗しても次回に回すだけ）
async function pruneStalePersonalData(): Promise<void> {
  if (dbProvider() !== 'sheets' || !sheetsDbConfigured()) return;
  try {
    const r = await pruneStalePersonalDataSheets(new Date(Date.now() - retentionDays() * DAY_MS));
    const total = r.projects + r.engineers + r.matches + r.matchesCleared + r.properCandidates + r.feedback;
    if (total > 0) {
      console.log(
        `SES: 保存期間（${retentionDays()}日）を過ぎた行を整理しました（案件${r.projects}行・要員${r.engineers}行・マッチ${r.matches}行を削除、` +
          `成約のマッチ${r.matchesCleared}行の文面を消去、プロパー候補${r.properCandidates}行・評価${r.feedback}行を削除）`,
      );
    }
  } catch (err) {
    console.warn(`SES: 保存期間を過ぎた行の整理に失敗: ${safeErr(err)}`);
  }
}

function skipProperForDeadline(): null {
  recordHealEvent('warn', `1回の実行時間の上限（${runDeadlineMinutes()}分）に達したため、プロパー候補の処理は次回の実行に回しました`);
  return null;
}

// demo・--collect-only(demo) 用の①〜④: 収集 → 展開 → 抽出 → 保存（名寄せ込み）
async function collectAndStoreWhole(): Promise<{ projects: Project[]; engineers: Engineer[] }> {
  const { mails } = await collectAndParse();
  let items: ExtractedItem[] = [];
  try {
    ({ items } = await extractItems(mails));
  } catch (err) {
    console.error(`SES抽出: 失敗: ${safeErr(err)}`);
    recordFatal('抽出段が例外で停止しました');
  }
  const projects = dedupeProjects(items.filter(isProjectItem).map((i) => i.project));
  const engineers = dedupeEngineers(items.filter(isEngineerItem).map((i) => i.engineer));
  writeDemoArtifact('projects', projects);
  writeDemoArtifact('engineers', engineers);
  return { projects, engineers };
}

// --match-only 用: 既存データを読み込む（本番=DB、demo=直前の data/ses-demo/*.json）
async function loadExisting(): Promise<{ projects: Project[]; engineers: Engineer[] }> {
  if (isDemo()) {
    const projects = readDemoArtifact<Project[]>('projects') ?? [];
    const engineers = readDemoArtifact<Engineer[]>('engineers') ?? [];
    if (projects.length === 0 && engineers.length === 0) {
      console.warn('SES: --match-only 用の直前データが無いため、先に収集・保存から実行します');
      return collectAndStoreWhole();
    }
    // JSON復元時に Date が文字列になるため戻す
    return {
      projects: projects.map((p) => ({ ...p, receivedAt: new Date(p.receivedAt) })),
      engineers: engineers.map((e) => ({ ...e, receivedAt: new Date(e.receivedAt) })),
    };
  }
  try {
    const [projects, engineers] = await Promise.all([
      fetchOpenProjects(matchPoolLimit()),
      fetchAvailableEngineers(matchPoolLimit()),
    ]);
    return { projects, engineers };
  } catch (err) {
    console.error(`SES: 既存データの読み込みに失敗: ${safeErr(err)}`);
    recordFatal('既存の案件・要員データを読み込めませんでした');
    return { projects: [], engineers: [] };
  }
}

// プロパー（自社社員のスキルシート）× 案件の候補探し。失敗しても本体のマッチング・通知は続ける
async function runProperStage(projects: Project[]): Promise<ProperRunResult | null> {
  try {
    return await runProperFlow(projects);
  } catch (err) {
    console.error(`プロパー候補: 失敗: ${safeErr(err)}`);
    recordHealEvent('warn', 'プロパー候補の処理が途中で停止しました（外部要員とのマッチング・通知は継続します）');
    return null;
  }
}

// --match-only（本番）: 判定の予算に達して「未判定」になった組のうち、既にAI判定のある組は保存しない
// （判定済みの行を未判定で上書きすると、案件・要員は突合済のため定時の実行でも判定し直されず、良い組が埋もれる）
async function withoutDeferredOverwrites(matches: MatchResult[]): Promise<MatchResult[]> {
  if (isDemo() || !matches.some((m) => m.category === 'deferred')) return matches;
  let judged: Set<string>;
  try {
    judged = (await fetchMatchLedger()).judged;
  } catch (err) {
    console.warn(`SESマッチング: 判定済みの組を確かめられないため、未判定の組は保存しません: ${safeErr(err)}`);
    return matches.filter((m) => m.category !== 'deferred');
  }
  const kept = matches.filter((m) => !(m.category === 'deferred' && judged.has(m.id)));
  if (kept.length < matches.length) {
    console.log(`SESマッチング: 判定の予算に達したため、判定済みの${matches.length - kept.length}組は前回の判定のまま残します`);
  }
  return kept;
}

// demo・--match-only の⑤〜⑦: マッチング → 下書き生成 → プロパー → 保存・通知
async function matchDraftAndNotify(
  projects: Project[],
  engineers: Engineer[],
  requestedDrafts: PendingDraftResult,
): Promise<MatchResult[]> {
  let matches: MatchResult[] = [];
  try {
    matches = await matchAll(projects, engineers, undefined, { suppression: await loadSuppressionIndex({ projects, engineers }) });
    matches = await withoutDeferredOverwrites(matches);
    await persistInjectionFlags();
  } catch (err) {
    console.error(`SESマッチング: 失敗: ${safeErr(err)}`);
    recordFatal('マッチング段が例外で停止しました');
  }

  try {
    matches = await createDrafts(matches, projects, engineers);
  } catch (err) {
    console.error(`SES下書き: 失敗: ${safeErr(err)}`);
    recordFatal('下書き生成段が例外で停止しました');
  }

  const proper = await runProperStage(projects);
  try {
    await persistAndNotify(matches, projects, engineers, requestedDrafts, proper);
  } catch (err) {
    console.error(`SES通知: 失敗: ${safeErr(err)}`);
    recordFatal('保存・通知段が例外で停止しました');
  }

  return matches;
}

function parseArgs(): SesBatchOptions {
  const args = process.argv.slice(2);
  return {
    collectOnly: args.includes('--collect-only'),
    matchOnly: args.includes('--match-only'),
  };
}

runSesBatch(parseArgs()).catch((err) => {
  console.error(`SESバッチ: 予期しないエラーで終了しました: ${safeErr(err)}`);
  process.exitCode = 1;
});
