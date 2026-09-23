import '../env.js';
import { collectSesMail } from './collect.js';
import { parseAttachments } from './parse.js';
import { extractItems } from './extract.js';
import { matchAll } from './match.js';
import { createDrafts } from './draft.js';
import { persistAndNotify } from './notify.js';
import { materializePendingDrafts, type PendingDraftResult } from './pendingDrafts.js';
import { runProperFlow, type ProperRunResult } from './proper/index.js';
import { resetProperMasterCache } from './proper/master.js';
import { markMailProcessed, writeDemoArtifact, readDemoArtifact, dedupeProjects, dedupeEngineers } from './store.js';
import {
  saveProject,
  saveEngineer,
  fetchOpenProjects,
  fetchAvailableEngineers,
  fetchJudgedMatchIds,
} from '../database/index.js';
import { resetSheetsCache } from '../database/sheets.js';
import {
  isDemo,
  liveConfigError,
  minGrossMarginJpy,
  maxCandidatesPerItem,
  repairEnabled,
  matchLookbackDays,
  matchPoolLimit,
} from './config.js';
import type { PairScope } from './match.js';
import { startHealBatch } from './heal/budget.js';
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
import { redactable, safeErr } from './redact.js';
import type { Project, Engineer, ExtractedItem, MatchResult, SesRawMail } from '../types/index.js';

// SESマッチングバッチのオーケストレータ。collect→parse→extract→store→(proper)→match→draft→notify を順に呼ぶ。
// 各段は try/catch でエラーを吸収し、途中段が失敗しても後続へ渡せるデータがあれば継続する。
// 収集失敗・重大異常・サマリ送信失敗などは recordFatal で記録し、終了コードを非0にする
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
  console.log(
    `モード: ${isDemo() ? 'DEMO（外部呼び出しなし）' : '本番'} / 粗利下限: ${minGrossMarginJpy()}円/月 / 候補上限: ${maxCandidatesPerItem()}件`,
  );

  // 自動検証・修復レイヤーの初期化（コストメーターとイベント収集。demoでは実質no-op）
  startHealBatch();
  resetHealEvents();
  resetSheetsCache();
  resetProperMasterCache();

  try {
    await runStages(opts);
  } finally {
    if (hasFatal()) {
      console.error(`=== SESバッチ: 異常終了扱い（要因${fatalReasons().length}件）: ${fatalReasons().join(' / ')} ===`);
      process.exitCode = 1;
    }
  }
}

async function runStages(opts: SesBatchOptions): Promise<void> {
  let projects: Project[];
  let engineers: Engineer[];

  // 前回バッチ以降にスプレッドシートの「担当者メール」で依頼された下書きを、収集より先に作成する
  let requestedDrafts: PendingDraftResult = { created: 0, failed: 0 };
  try {
    requestedDrafts = await materializePendingDrafts();
  } catch (err) {
    console.error(`SES下書き依頼: 失敗: ${safeErr(err)}`);
    recordFatal('担当者指定の下書き作成段が例外で停止しました');
  }

  let scope: PairScope | undefined;
  if (opts.matchOnly) {
    ({ projects, engineers } = await loadExisting());
  } else {
    ({ projects, engineers } = await collectAndStore());
    if (opts.collectOnly) {
      console.log(`=== --collect-only指定のため収集・保存のみで終了（案件${projects.length}件・要員${engineers.length}件） ===`);
      return;
    }
  }

  const proper = await runProperStage(projects);
  // 通常バッチは、今回の新着に加えて前回以前に保存した案件・要員とも突合する（別々の実行回に届いた組を見逃さない）
  if (!opts.matchOnly && !isDemo()) ({ projects, engineers, scope } = await withRecentPool(projects, engineers));
  const matches = await matchDraftAndNotify(projects, engineers, requestedDrafts, proper, scope);
  console.log(`=== SESバッチ完了: マッチ候補 計${matches.length}件 ===`);

  // 隔離が増えた場合、opt-in（SES_REPAIR_ENABLED=true）なら修正パッチ案を自動生成（1日1回まで）
  if (!isDemo() && repairEnabled() && getStats().quarantinedNew > 0) {
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

// ①〜④: 収集 → 展開 → 抽出 → 保存（名寄せ込み）
async function collectAndStore(): Promise<{ projects: Project[]; engineers: Engineer[] }> {
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

  let parsedMails = mails;
  try {
    parsedMails = await parseAttachments(mails);
  } catch (err) {
    console.error(`SES展開: 失敗: ${safeErr(err)}`);
  }

  // 抽出に成功したメールだけを処理済みにする（失敗分は次回バッチで再処理。データ消失防止）
  let items: ExtractedItem[] = [];
  let processedMailIds: string[] = [];
  let quarantinedMailIds: string[] = [];
  try {
    ({ items, processedMailIds, quarantinedMailIds } = await extractItems(parsedMails));
  } catch (err) {
    console.error(`SES抽出: 失敗: ${safeErr(err)}（処理済みマークを保留し次回再処理します）`);
    recordFatal('抽出段が例外で停止しました');
  }

  const rawProjects = dedupeProjects(items.filter(isProjectItem).map((i) => i.project));
  const rawEngineers = dedupeEngineers(items.filter(isEngineerItem).map((i) => i.engineer));

  const failedMailIds = new Set<string>();
  const storedProjects = await storeProjects(rawProjects, failedMailIds);
  const storedEngineers = await storeEngineers(rawEngineers, failedMailIds);

  // DB保存に失敗した案件・要員の元メールは処理済みにしない（次回再抽出。IDは決定的なので重複しない）
  const toMark = processedMailIds.filter((id) => !failedMailIds.has(id));
  const extractedMarked = await markMailProcessed(toMark, '抽出済');
  const quarantinedMarked = await markMailProcessed(quarantinedMailIds, '隔離');
  // 自分たちのメールとして除外した分も記録し、次回から本文を取得し直さない
  const excludedMarked = await markMailProcessed(excludedMailIds, '除外');
  if (!extractedMarked || !quarantinedMarked || !excludedMarked) {
    recordFatal('処理済みメールIDを保存できませんでした（次回同じメールを再処理します）');
  }

  return { projects: storedProjects, engineers: storedEngineers };
}

async function storeProjects(projects: Project[], failedMailIds: Set<string>): Promise<Project[]> {
  if (isDemo()) {
    writeDemoArtifact('projects', projects);
    return projects;
  }
  const results: Project[] = [];
  for (const project of projects) {
    try {
      const notionPageId = await saveProject(project);
      results.push({ ...project, notionPageId });
    } catch (err) {
      console.error(`SES保存: 案件保存失敗 (${project.id} ${redactable(project.title)}): ${safeErr(err)}`);
      failedMailIds.add(project.sourceMailId);
      results.push(project);
    }
  }
  return results;
}

async function storeEngineers(engineers: Engineer[], failedMailIds: Set<string>): Promise<Engineer[]> {
  if (isDemo()) {
    writeDemoArtifact('engineers', engineers);
    return engineers;
  }
  const results: Engineer[] = [];
  for (const engineer of engineers) {
    try {
      const notionPageId = await saveEngineer(engineer);
      results.push({ ...engineer, notionPageId });
    } catch (err) {
      console.error(`SES保存: 要員保存失敗 (${engineer.id} ${redactable(engineer.displayName)}): ${safeErr(err)}`);
      failedMailIds.add(engineer.sourceMailId);
      results.push(engineer);
    }
  }
  return results;
}

// --match-only 用: 既存データを読み込む（本番=Notion、demo=直前の data/ses-demo/*.json）
async function loadExisting(): Promise<{ projects: Project[]; engineers: Engineer[] }> {
  if (isDemo()) {
    const projects = readDemoArtifact<Project[]>('projects') ?? [];
    const engineers = readDemoArtifact<Engineer[]>('engineers') ?? [];
    if (projects.length === 0 && engineers.length === 0) {
      console.warn('SES: --match-only 用の直前データが無いため、先に収集・保存から実行します');
      return collectAndStore();
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

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Map<string, T>();
  for (const item of items) if (!seen.has(item.id)) seen.set(item.id, item);
  return [...seen.values()];
}

// 今回の新着に、直近 SES_MATCH_LOOKBACK_DAYS 日に保存済みの募集中案件・提案可要員を加え、
// 「新着を含み、まだ判定していないペア」だけを突合する範囲を作る。
// 読み込みに失敗した場合は新着同士だけで突合する（判定済みのIDが分からないまま既存と組むと二重判定になるため）
async function withRecentPool(
  newProjects: Project[],
  newEngineers: Engineer[],
): Promise<{ projects: Project[]; engineers: Engineer[]; scope: PairScope }> {
  const scope: PairScope = {
    newProjectIds: new Set(newProjects.map((p) => p.id)),
    newEngineerIds: new Set(newEngineers.map((e) => e.id)),
    judgedMatchIds: new Set(),
  };
  if (newProjects.length === 0 && newEngineers.length === 0) return { projects: [], engineers: [], scope };
  const since = new Date(Date.now() - matchLookbackDays() * 24 * 60 * 60 * 1000);
  try {
    const [poolProjects, poolEngineers, judged] = await Promise.all([
      fetchOpenProjects(matchPoolLimit(), { receivedSince: since }),
      fetchAvailableEngineers(matchPoolLimit(), { receivedSince: since }),
      fetchJudgedMatchIds(since),
    ]);
    scope.judgedMatchIds = judged;
    const projects = uniqueById([...newProjects, ...poolProjects]);
    const engineers = uniqueById([...newEngineers, ...poolEngineers]);
    console.log(
      `SESマッチング: 新着 案件${newProjects.length}件・要員${newEngineers.length}件を、直近${matchLookbackDays()}日の` +
        `案件${projects.length - newProjects.length}件・要員${engineers.length - newEngineers.length}件とも突合します（判定済み${judged.size}組は除外）`,
    );
    return { projects, engineers, scope };
  } catch (err) {
    console.error(`SESマッチング: 既存の案件・要員の読み込みに失敗: ${safeErr(err)}`);
    recordHealEvent('warn', '既存の案件・要員を読み込めなかったため、今回の新着同士だけで突合しました');
    return { projects: newProjects, engineers: newEngineers, scope };
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

// ⑤〜⑦: マッチング → 下書き生成 → 通知
async function matchDraftAndNotify(
  projects: Project[],
  engineers: Engineer[],
  requestedDrafts: PendingDraftResult,
  proper: ProperRunResult | null,
  scope?: PairScope,
): Promise<MatchResult[]> {
  let matches: MatchResult[] = [];
  try {
    matches = await matchAll(projects, engineers, scope);
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
