// Phase B: 修正パッチ案の自動生成。
// 隔離メール・直近バッチの診断結果と該当ソース（許可リストのみ）をClaudeに渡し、
// 「原因分析＋unified diff のパッチ案」をレポートとして生成する。
// ★コードの自動適用は絶対にしない。人がレビューして適用する（レポート止まり）。
// PII対策: メール本文は渡さない。件名・エラーはmaskPii済みのものだけを使う。
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { generateJson } from '../../llm/index.js';
import { totalLlmCostJpy } from '../../llm/pricing.js';
import { sendPlainMailViaMail } from '../mail/index.js';
import { isDemo, healDataDir, repairBudgetJpy, repairModel, mailProvider, sesNotifyTo } from '../config.js';
import { listQuarantined, type QuarantineEntry } from './quarantine.js';
import { readLastBatchDiagnosis, type LastBatchDiagnosis } from './events.js';

const REPAIR_SYSTEM = `あなたはTypeScript製のSESマッチングシステムの保守エンジニアです。
障害ログ・隔離されたメールのエラー情報・関連ソースコードを読み、以下を日本語で出力してください:
- 根本原因の分析（設定問題かコード問題かを区別する）
- 再現条件
- コード修正が必要な場合は unified diff 形式のパッチ案（最小限の変更に留める）
- 設定変更で直る場合はその手順（パッチ案は空でよい）
注意: パッチは提案であり自動適用されません。確信が持てない場合は confidence を低くし、その旨を書いてください。`;

const REPAIR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    rootCause: { type: 'string' },
    reproduction: { type: 'string' },
    isConfigIssue: { type: 'boolean' },
    patches: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: { type: 'string' },
          rationale: { type: 'string' },
          unifiedDiff: { type: 'string' },
        },
        required: ['file', 'rationale', 'unifiedDiff'],
      },
    },
    applySteps: { type: 'string' },
    risks: { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['rootCause', 'reproduction', 'isConfigIssue', 'patches', 'applySteps', 'risks', 'confidence'],
} as const;

interface RepairProposal {
  rootCause: string;
  reproduction: string;
  isConfigIssue: boolean;
  patches: Array<{ file: string; rationale: string; unifiedDiff: string }>;
  applySteps: string;
  risks: string;
  confidence: 'high' | 'medium' | 'low';
}

// 失敗の種類から読ませるソースを選ぶ（許可リスト方式。合計サイズも制限）
function pickSourceFiles(diagnosis: LastBatchDiagnosis | null): string[] {
  const files = ['src/ses/extract.ts', 'src/ses/parse.ts'];
  const collectTrouble = (diagnosis?.events ?? []).some((e) => e.message.includes('収集'));
  if (collectTrouble || (diagnosis?.stats.collected ?? 1) === 0) {
    files.push(mailProvider() === 'gmail' ? 'src/ses/mail/gmail.ts' : 'src/ses/mail/xserver.ts');
    files.push('src/ses/collect.ts');
  }
  return files;
}

function readSourceCapped(relPath: string, capChars = 12000): string {
  try {
    const full = readFileSync(join(process.cwd(), relPath), 'utf-8');
    return full.length > capChars ? `${full.slice(0, capChars)}\n…（以下省略）` : full;
  } catch {
    return '（読み込み失敗）';
  }
}

function buildRepairPrompt(quarantined: QuarantineEntry[], diagnosis: LastBatchDiagnosis | null): string {
  const qLines = quarantined
    .slice(0, 10)
    .map((q) => `- mail ${q.mailId} / 件名: ${q.subject} / 失敗${q.attempts}回 / 最終エラー: ${q.lastError}`)
    .join('\n');
  const eLines = (diagnosis?.events ?? [])
    .map((e) => `- [${e.severity}] ${e.message}`)
    .join('\n');
  const sources = pickSourceFiles(diagnosis)
    .map((f) => `### ${f}\n\`\`\`typescript\n${readSourceCapped(f)}\n\`\`\``)
    .join('\n\n');
  return `【隔離されたメール（本文は共有していません）】\n${qLines || '（なし）'}\n\n【直近バッチの診断イベント】\n${eLines || '（なし）'}\n\n【関連ソースコード】\n${sources}`;
}

function reportPath(): string {
  const d = new Date().toISOString().slice(0, 10);
  return join(process.cwd(), healDataDir(), `repair-${d}.md`);
}

function lastRepairPath(): string {
  return join(process.cwd(), healDataDir(), 'last-repair.json');
}

function ranToday(): boolean {
  try {
    if (!existsSync(lastRepairPath())) return false;
    const { at } = JSON.parse(readFileSync(lastRepairPath(), 'utf-8')) as { at: string };
    return at.slice(0, 10) === new Date().toISOString().slice(0, 10);
  } catch {
    return false;
  }
}

function markRan(): void {
  try {
    const dir = join(process.cwd(), healDataDir());
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(lastRepairPath(), JSON.stringify({ at: new Date().toISOString() }), 'utf-8');
  } catch {
    /* noop */
  }
}

function renderReport(proposal: RepairProposal, costJpy: number): string {
  const patches = proposal.patches.length
    ? proposal.patches
        .map((p) => `### ${p.file}\n${p.rationale}\n\n\`\`\`diff\n${p.unifiedDiff}\n\`\`\``)
        .join('\n\n')
    : '（コード修正は不要と判断。設定変更で対応してください）';
  return `# SES自己修復: 修正パッチ案レポート

> ⚠️ このパッチ案は自動生成されたものであり、**自動適用はされません**。
> 必ず人がレビューし、\`npm run build\` と \`npm run ses:demo\` で確認のうえ適用してください。

- 生成日時: ${new Date().toLocaleString('ja-JP')}
- 確信度: ${proposal.confidence}
- 種別: ${proposal.isConfigIssue ? '設定の問題（コード修正不要の可能性）' : 'コードの問題の可能性'}
- 生成コスト概算: 約${costJpy.toFixed(1)}円

## 原因分析
${proposal.rootCause}

## 再現条件
${proposal.reproduction}

## パッチ案
${patches}

## 適用手順
${proposal.applySteps}

## リスク・注意
${proposal.risks}
`;
}

function writeReport(md: string): string {
  const dir = join(process.cwd(), healDataDir());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(reportPath(), md, 'utf-8');
  return reportPath();
}

// demo用の決定的スタブ（外部呼び出しゼロでフローを検証するため）
function demoReport(): string {
  return renderReport(
    {
      rootCause:
        '（demoスタブ）隔離メールのエラーは添付xlsxのMIMEタイプ不一致に起因する可能性が高い、といった分析がここに入ります。',
      reproduction: '（demoスタブ）application/octet-stream の .xlsx を含むメールを受信したとき。',
      isConfigIssue: false,
      patches: [
        {
          file: 'src/ses/parse.ts',
          rationale: '（demoスタブ）拡張子でも判定するよう条件を広げる例。',
          unifiedDiff: '--- a/src/ses/parse.ts\n+++ b/src/ses/parse.ts\n@@ （例示） @@',
        },
      ],
      applySteps: '（demoスタブ）レビュー後、該当ファイルへ適用し npm run build で確認。',
      risks: '（demoスタブ）実際のレポートではリスク説明が入ります。',
      confidence: 'low',
    },
    0,
  );
}

// 修正パッチ案の生成本体。auto=true はバッチ末尾からの自動起動（1日1回ゲートあり）
export async function runRepair(auto = false): Promise<void> {
  console.log('=== SES自己修復: 修正パッチ案の生成 ===');

  if (isDemo()) {
    const p = writeReport(demoReport());
    console.log(`demoモード: スタブレポートを生成しました → ${p}`);
    return;
  }

  if (auto && ranToday()) {
    console.log('本日はすでに自動生成済みのためスキップします（手動実行: npm run ses:repair）');
    return;
  }

  const quarantined = listQuarantined();
  const diagnosis = readLastBatchDiagnosis();
  const hasCritical = (diagnosis?.events ?? []).some((e) => e.severity === 'critical');
  if (quarantined.length === 0 && !hasCritical) {
    console.log('隔離メール・重大異常がないため、生成するパッチ案はありません。');
    return;
  }

  const before = totalLlmCostJpy();
  try {
    const proposal = await generateJson<RepairProposal>(
      REPAIR_SYSTEM,
      buildRepairPrompt(quarantined, diagnosis),
      REPAIR_SCHEMA,
      { model: repairModel(), maxTokens: 8000 },
    );
    const costJpy = totalLlmCostJpy() - before;
    if (costJpy > repairBudgetJpy()) {
      console.warn(
        `SES修復: 生成コスト約${costJpy.toFixed(1)}円が予算${repairBudgetJpy()}円を超過しました。SES_REPAIR_BUDGET_JPY の見直しを検討してください`,
      );
    }
    const md = renderReport(proposal, costJpy);
    const p = writeReport(md);
    markRan();
    console.log(`パッチ案レポートを生成しました → ${p}（コスト約${costJpy.toFixed(1)}円）`);

    const to = sesNotifyTo();
    if (to) {
      try {
        await sendPlainMailViaMail(to, 'SES自己修復: 修正パッチ案レポート', md);
      } catch (err) {
        console.warn(`SES修復: レポートメールの送信に失敗: ${String(err)}`);
      }
    }
  } catch (err) {
    console.error(`SES修復: パッチ案の生成に失敗しました: ${String(err)}`);
  }
}
