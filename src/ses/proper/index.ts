// プロパー（自社社員のスキルシート）→ 案件候補の実行本体。SESバッチ（runSesBatch）と ses:own-match から呼ぶ。
// 本番: スキルシートのフォルダと管理表「プロパー管理」を同期 → 稼働可の社員 × 直近の募集中案件を突合 →
//       案件スプレッドシートの「プロパー候補」タブへ保存（提案の全員に返信文面つき。担当者メールで次回バッチが下書きにする）
// demo: fixtureの自社社員 × 渡された案件で突合と文面作成だけを行う（Drive・Sheets・LLMに接続しない）
// コンソールには件数だけを出す（氏名・案件名は出さない。詳細はサマリメールと案件スプレッドシート）
import { isDemo, properEnabled, properProjectLookbackDays } from '../config.js';
import { matchOwnEngineersToProjects } from '../ownMatch.js';
import { loadSkillEquivalences } from '../skillEquiv.js';
import { writeDemoArtifact } from '../store.js';
import { recordHealEvent } from '../heal/events.js';
import { loadFixtureProperEngineers } from '../fixtures/ownEngineers.js';
import { fetchOpenProjects } from '../../database/index.js';
import {
  saveProperCandidatesSheets,
  retireProperCandidatesSheets,
  sheetsDbConfigured,
  PROPER_CANDIDATE_TAB,
} from '../../database/sheets.js';
import { syncProperMaster, loadProperEngineers, properLabelOf, properMasterConfigured, type ProperSyncResult } from './master.js';
import { buildProperProposalDraft } from './proposal.js';
import type { Project, ProperEngineer, ProperCandidate } from '../../types/index.js';

export interface ProperRunResult {
  demo: boolean;
  sync: ProperSyncResult | null;
  engineers: number; // 突合対象（稼働可）の社員数
  projects: number; // 突合対象の案件数
  candidates: ProperCandidate[];
  saved: number; // 「プロパー候補」タブに追加・更新した行数
  retired: number; // 稼働可でなくなった社員の候補として退役させた行数
}

// Sheetsの案件タブは全行を読むため、直近の遡り期間に絞った上での上限は大きめでよい（Notionは100件で頭打ち）
const PROJECT_FETCH_LIMIT = 1000;

export function buildProperCandidates(engineers: ProperEngineer[], projects: Project[]): ProperCandidate[] {
  const engineerById = new Map(engineers.map((e) => [e.id, e]));
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const candidates: ProperCandidate[] = [];
  const seen = new Set<string>();
  for (const m of matchOwnEngineersToProjects(engineers, projects)) {
    // 人がシートの行を複製していても、同じ社員×案件の候補は1件にする（同じIDの行が2つあると
    // 担当者メールを入れた側の行が下書き依頼として読まれない）
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    const engineer = engineerById.get(m.ownEngineerId);
    const project = projectById.get(m.projectId);
    if (!engineer || !project) continue;
    // 元のメールにAIへの指示らしき記載がある案件には、提案文面（下書きの元）を用意しない（要確認で人が確かめる）
    const draftToProject = project.injectionSuspected ? undefined : buildProperProposalDraft(engineer, project);
    candidates.push({ ...m, properLabel: properLabelOf(engineer), ...(draftToProject ? { draftToProject } : {}) });
  }
  return candidates;
}

function logCounts(prefix: string, r: ProperRunResult): void {
  const drafts = r.candidates.filter((c) => c.draftToProject).length;
  console.log(`${prefix}: 社員${r.engineers}名 × 案件${r.projects}件 → 候補${r.candidates.length}件（提案文面${drafts}件）`);
}

function runProperDemo(projects: Project[]): ProperRunResult {
  const engineers = loadFixtureProperEngineers();
  const candidates = buildProperCandidates(engineers, projects);
  writeDemoArtifact('proper-candidates', candidates);
  const result: ProperRunResult = {
    demo: true, sync: null, engineers: engineers.length, projects: projects.length, candidates, saved: 0, retired: 0,
  };
  logCounts('プロパー候補(DEMO・fixture社員)', result);
  return result;
}

function logSync(s: ProperSyncResult): void {
  console.log(
    `プロパー: スキルシート${s.listed}件（新規${s.added}・更新${s.updated}・変更なし${s.unchanged}・` +
      `抽出失敗${s.failed}・次回へ保留${s.deferred}・所在不明${s.missing}・未対応形式${s.unsupportedNames.length}）`,
  );
}

// demoProjects は demo でだけ使う（本番は案件DBから直近の募集中案件を読む）。
// 未設定なら null（スキップ）。例外は呼び出し側で受け、本体のバッチは止めない
export async function runProperFlow(demoProjects: Project[] = []): Promise<ProperRunResult | null> {
  if (!isDemo() && !properEnabled()) {
    console.log('プロパー候補: PROPER_SKILLSHEET_FOLDER_ID / PROPER_MASTER_SPREADSHEET_ID が未設定のためスキップします');
    return null;
  }
  await loadSkillEquivalences(); // 育てた同義辞書をスキル判定に反映
  if (isDemo()) return runProperDemo(demoProjects);

  const sync = await syncProperMaster();
  logSync(sync);
  if (sync.writeFailed > 0) {
    recordHealEvent('warn', `管理表「プロパー管理」への書き込みに${sync.writeFailed}件失敗しました（次回の実行で再試行します）`);
  }
  const engineers = await loadProperEngineers(sync.presentFileIds);
  const since = new Date(Date.now() - properProjectLookbackDays() * 24 * 60 * 60 * 1000);
  const projects = await fetchOpenProjects(PROJECT_FETCH_LIMIT, { receivedSince: since });
  const candidates = buildProperCandidates(engineers, projects);

  let saved = 0;
  let retired = 0;
  if (sheetsDbConfigured()) {
    saved = await saveProperCandidatesSheets(candidates);
    // 管理表を読めたとき（未設定で空に見えているのではないとき）だけ、稼働可でなくなった社員の候補を退役させる
    if (properMasterConfigured()) retired = await retireProperCandidatesSheets(new Set(engineers.map((e) => e.id)));
    if (retired > 0) console.log(`プロパー候補: 稼働可でなくなった社員の候補${retired}行を退役させました（氏名・必要案件単価・文面を消去）`);
  } else if (candidates.length > 0) {
    console.warn(`プロパー候補: 案件スプレッドシート（SHEETS_DB_SPREADSHEET_ID）が未設定のため「${PROPER_CANDIDATE_TAB}」タブに保存できません`);
  }
  const result: ProperRunResult = { demo: false, sync, engineers: engineers.length, projects: projects.length, candidates, saved, retired };
  logCounts('プロパー候補', result);
  return result;
}

// 担当者メールによるプロパー候補の下書き依頼を受けてよい社員（管理表で稼働可の社員）のID。確かめられなければ null
// （依頼は作らずに次回へ回す）
export async function activeProperEngineerIds(): Promise<Set<string> | null> {
  if (isDemo() || !properEnabled() || !properMasterConfigured()) return null;
  return new Set((await loadProperEngineers(null)).map((e) => e.id));
}

// ===== サマリメール =====

const MAIL_LIST_MAX = 30;

function candidateLine(c: ProperCandidate): string {
  const rate = c.projectRate !== null ? `${c.projectRate}万円/月` : '単価不明';
  // 社員ごとの必要案件単価（社内の原価に近い値）はメールに載せず、案件単価との差だけにする
  const need =
    c.requiredProjectRate !== null ? (c.rateGapMan !== null ? `必要案件単価との差+${c.rateGapMan}万円` : '必要案件単価あり') : '必要案件単価未入力';
  const tags = `${c.band === 'tentative' ? '[参考提案]' : ''}${c.needsReview ? '[要確認]' : ''}`;
  return `・${tags}${c.properLabel} × ${c.projectTitle} — 案件${rate}（${need}）・スキル一致率${Math.round(c.skillMatchRate * 100)}%`;
}

// サマリメール用の節。forMail=false（コンソール用）では氏名・案件名を含めず件数だけにする
export function properSummaryLines(r: ProperRunResult | null, forMail: boolean): string[] {
  if (!r) return [];
  const lines = ['【プロパー候補（自社社員 × 案件）】'];
  lines.push(
    r.demo
      ? `プロパー候補: ${r.candidates.length}件（demo・fixture社員）`
      : `プロパー候補: ${r.candidates.length}件（詳細は案件スプシの『${PROPER_CANDIDATE_TAB}』タブ）`,
  );
  const s = r.sync;
  if (s) {
    lines.push(
      `スキルシート: ${s.listed}件（新規${s.added}・更新${s.updated}・抽出失敗${s.failed}・次回へ保留${s.deferred}・所在不明${s.missing}）`,
    );
    if (s.failed > 0) lines.push('・抽出失敗は管理表「プロパー管理」の「抽出メモ」に理由があります');
  }
  if (forMail) {
    // ファイル名は氏名を含むことが多いため、サマリメールには件数だけを載せる（ファイルはスキルシートのフォルダで確認）
    if (s && s.unsupportedNames.length > 0) {
      lines.push(
        `・未対応形式のため読み取っていないファイル: ${s.unsupportedNames.length}件（スキルシートのフォルダで確認し、PDF・Excel・Word(.docx)・Googleドキュメントで保存してください）`,
      );
    }
    for (const c of r.candidates.slice(0, MAIL_LIST_MAX)) lines.push(candidateLine(c));
    if (r.candidates.length > MAIL_LIST_MAX) lines.push(`  ほか${r.candidates.length - MAIL_LIST_MAX}件`);
    if (!r.demo && r.candidates.length > 0) {
      lines.push(
        `■提案の下書き: 「${PROPER_CANDIDATE_TAB}」タブで「案件側文面」を確認し、「担当者メール」にご自身の会社アドレスを入れると、`,
        '  次回のバッチでそのアドレスから案件の元メールへの「全員に返信」下書きが作成されます（イニシャルのみ記載・必要案件単価は記載しません）',
      );
    }
  }
  lines.push('');
  return lines;
}
