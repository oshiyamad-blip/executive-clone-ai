// バッチ内の修復イベント・統計の収集、ルールベース異常検知、診断レポート生成。
// レポートはサマリメール末尾に載り、JSONは data/ses-heal/ に残して repair（パッチ案生成）の入力になる。
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { healDataDir, healBudgetJpy, logRedact } from '../config.js';
import { safeErr, redactIdsIn } from '../redact.js';
import { batchCostJpy, healSpentJpy } from './budget.js';
import { quarantineCount, quarantineLocation } from './quarantine.js';

export type HealSeverity = 'info' | 'warn' | 'critical';

export interface HealEvent {
  severity: HealSeverity;
  message: string;
  // 生エラー文など内容を含み得る補足。サマリメール・診断JSONには載せるが、秘匿モードのコンソールには出さない
  detail?: string;
}

export interface BatchStats {
  collected: number;
  extractedItems: number;
  extractFailures: number;
  quarantinedNew: number;
  healedRetry: number;
  healedEscalation: number;
  budgetExhausted: number;
  skillTokens: number; // 抽出したスキル語の数（人名・社名らしい語を除く）
  unknownSkillTokens: number; // うち辞書に無い語の数（辞書拡充の指標）
  // 抽出品質（バッチのメトリクス。件数だけ）
  extractedProjects: number;
  extractedEngineers: number;
  projectRateNull: number; // 単金（下限・上限とも）が不明の案件
  projectStartNull: number; // 開始日が不明の案件
  requiredSkillsEmpty: number; // 必須スキルが空の案件
  prefectureChecked: number; // 都道府県を推定すべき案件（フルリモートを除く）・要員
  prefectureNull: number; // うち都道府県が不明
  engineerRateNull: number; // 希望単金が不明の要員
  draftsCreated: number; // 用意した紹介文面（下書き）の通数
  resendSkipped: number; // 直近に抽出した内容と同じ再送として抽出しなかったメール
}

let events: HealEvent[] = [];
let stats: BatchStats = emptyStats();

function emptyStats(): BatchStats {
  return {
    resendSkipped: 0,
    collected: 0,
    extractedItems: 0,
    extractFailures: 0,
    quarantinedNew: 0,
    healedRetry: 0,
    healedEscalation: 0,
    budgetExhausted: 0,
    skillTokens: 0,
    unknownSkillTokens: 0,
    extractedProjects: 0,
    extractedEngineers: 0,
    projectRateNull: 0,
    projectStartNull: 0,
    requiredSkillsEmpty: 0,
    prefectureChecked: 0,
    prefectureNull: 0,
    engineerRateNull: 0,
    draftsCreated: 0,
  };
}

export function resetHealEvents(): void {
  events = [];
  stats = emptyStats();
}

// message は件数・ID等のみで組み立てること（秘匿モードでもコンソールに出る）。内容を含み得る文は detail へ。
// サマリメール・診断JSONには元のIDのまま残し、秘匿モードのコンソールではIDを実行ごとの別名にする
export function recordHealEvent(severity: HealSeverity, message: string, detail?: string): void {
  events.push({ severity, message, detail });
  const prefix = severity === 'critical' ? '🚨' : severity === 'warn' ? '⚠️' : 'ℹ️';
  const shownDetail = detail && !logRedact() ? `（${detail}）` : '';
  console.log(`SES修復: ${prefix} ${redactIdsIn(message)}${shownDetail}`);
}

// バッチを異常終了（非0の終了コード）にすべき事象を記録する。スケジュール実行の失敗通知に使う。
// critical イベントとして積むため、診断レポート（サマリメール）にも【重大】として載る。
// reason は固定文言＋件数のみ（秘匿モードでもそのまま出力する）
export function recordFatal(reason: string): void {
  events.push({ severity: 'critical', message: reason });
  console.error(`SES: 🚨 異常終了の要因: ${redactIdsIn(reason)}`);
}

// critical が1件でもあれば異常終了扱い（抽出の過半数失敗・抽出0件などの重大異常を含む）
export function hasFatal(): boolean {
  return events.some((e) => e.severity === 'critical');
}

export function fatalReasons(): string[] {
  return events.filter((e) => e.severity === 'critical').map((e) => e.message);
}

export function recordStat(key: keyof BatchStats, delta = 1): void {
  stats[key] += delta;
}

export function getStats(): Readonly<BatchStats> {
  return stats;
}

// ルールベースの異常検知（LLM不使用・無料）。検知結果はイベントとして積む
export async function detectAnomalies(): Promise<void> {
  if (stats.collected > 0 && stats.extractedItems === 0 && stats.extractFailures > 0) {
    recordHealEvent(
      'critical',
      `収集${stats.collected}件に対し抽出0件です。ANTHROPIC_API_KEY・モデル設定・Anthropic側の障害情報を確認してください`,
    );
  }
  const qc = await quarantineCount();
  if (qc > 0) {
    recordHealEvent(
      'warn',
      `隔離中のメールが${qc}件あります（${quarantineLocation()}）。npm run ses:repair で原因分析と修正パッチ案を生成できます`,
    );
  }
}

export interface LastBatchDiagnosis {
  at: string;
  stats: BatchStats;
  events: HealEvent[];
  batchCostJpy: number;
  healSpentJpy: number;
  metrics?: Record<string, unknown>; // バッチのメトリクス（件数・比率だけ）
}

function diagnosisPath(): string {
  return join(process.cwd(), healDataDir(), 'last-batch-diagnosis.json');
}

export function readLastBatchDiagnosis(): LastBatchDiagnosis | null {
  try {
    if (!existsSync(diagnosisPath())) return null;
    return JSON.parse(readFileSync(diagnosisPath(), 'utf-8')) as LastBatchDiagnosis;
  } catch {
    return null;
  }
}

// 診断レポート（サマリメール末尾用の日本語ブロック）を生成し、JSONも書き残す。
// metrics はバッチのメトリクス（batchMetrics.ts。件数・比率だけ）の表示行と値
export async function buildDiagnosisReport(metrics?: { lines: string[]; values: Record<string, unknown> }): Promise<string> {
  await detectAnomalies();

  const cost = batchCostJpy();
  const heal = healSpentJpy();
  const lines: string[] = [];
  lines.push('=== 診断レポート（自動検証・修復） ===');
  lines.push(
    `LLMコスト概算: 今回バッチ 約${cost.toFixed(1)}円（うち自動修復 ${heal.toFixed(1)}円 / 予算 ${healBudgetJpy()}円）`,
  );
  if (stats.healedRetry + stats.healedEscalation > 0) {
    lines.push(
      `自動修復: 再試行で${stats.healedRetry}件・上位モデル昇格で${stats.healedEscalation}件のメールを救済しました`,
    );
  }
  const notable = events.filter((e) => e.severity !== 'info');
  if (notable.length === 0) {
    lines.push('異常は検知されていません。');
  } else {
    for (const e of notable) {
      lines.push(`${e.severity === 'critical' ? '【重大】' : '【注意】'}${e.message}${e.detail ? `（${e.detail}）` : ''}`);
    }
  }
  if (metrics && metrics.lines.length > 0) lines.push('', ...metrics.lines);

  // repair（パッチ案生成）の入力として書き残す
  try {
    const dir = join(process.cwd(), healDataDir());
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const diagnosis: LastBatchDiagnosis = {
      at: new Date().toISOString(),
      stats,
      events,
      batchCostJpy: cost,
      healSpentJpy: heal,
      ...(metrics ? { metrics: metrics.values } : {}),
    };
    writeFileSync(diagnosisPath(), JSON.stringify(diagnosis, null, 2), 'utf-8');
  } catch (err) {
    console.warn(`SES修復: 診断JSONの保存に失敗: ${safeErr(err)}`);
  }

  return lines.join('\n');
}
