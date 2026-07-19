// バッチ内の修復イベント・統計の収集、ルールベース異常検知、診断レポート生成。
// レポートはサマリメール末尾に載り、JSONは data/ses-heal/ に残して repair（パッチ案生成）の入力になる。
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { healDataDir, healBudgetJpy } from '../config.js';
import { batchCostJpy, healSpentJpy } from './budget.js';
import { quarantineCount } from './quarantine.js';

export type HealSeverity = 'info' | 'warn' | 'critical';

export interface HealEvent {
  severity: HealSeverity;
  message: string;
}

export interface BatchStats {
  collected: number;
  extractedItems: number;
  extractFailures: number;
  quarantinedNew: number;
  healedRetry: number;
  healedEscalation: number;
  budgetExhausted: number;
}

let events: HealEvent[] = [];
let stats: BatchStats = emptyStats();

function emptyStats(): BatchStats {
  return {
    collected: 0,
    extractedItems: 0,
    extractFailures: 0,
    quarantinedNew: 0,
    healedRetry: 0,
    healedEscalation: 0,
    budgetExhausted: 0,
  };
}

export function resetHealEvents(): void {
  events = [];
  stats = emptyStats();
}

export function recordHealEvent(severity: HealSeverity, message: string): void {
  events.push({ severity, message });
  const prefix = severity === 'critical' ? '🚨' : severity === 'warn' ? '⚠️' : 'ℹ️';
  console.log(`SES修復: ${prefix} ${message}`);
}

export function recordStat(key: keyof BatchStats, delta = 1): void {
  stats[key] += delta;
}

export function getStats(): Readonly<BatchStats> {
  return stats;
}

// ルールベースの異常検知（LLM不使用・無料）。検知結果はイベントとして積む
export function detectAnomalies(): void {
  if (stats.collected > 0 && stats.extractedItems === 0 && stats.extractFailures > 0) {
    recordHealEvent(
      'critical',
      `収集${stats.collected}件に対し抽出0件です。ANTHROPIC_API_KEY・モデル設定・Anthropic側の障害情報を確認してください`,
    );
  }
  const qc = quarantineCount();
  if (qc > 0) {
    recordHealEvent(
      'warn',
      `隔離中のメールが${qc}件あります（${healDataDir()}/quarantine.json）。npm run ses:repair で原因分析と修正パッチ案を生成できます`,
    );
  }
}

export interface LastBatchDiagnosis {
  at: string;
  stats: BatchStats;
  events: HealEvent[];
  batchCostJpy: number;
  healSpentJpy: number;
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

// 診断レポート（サマリメール末尾用の日本語ブロック）を生成し、JSONも書き残す
export function buildDiagnosisReport(): string {
  detectAnomalies();

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
      lines.push(`${e.severity === 'critical' ? '【重大】' : '【注意】'}${e.message}`);
    }
  }

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
    };
    writeFileSync(diagnosisPath(), JSON.stringify(diagnosis, null, 2), 'utf-8');
  } catch (err) {
    console.warn(`SES修復: 診断JSONの保存に失敗: ${String(err)}`);
  }

  return lines.join('\n');
}
