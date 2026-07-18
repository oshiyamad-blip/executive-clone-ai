// マッチ結果DB更新 + サマリ生成。demo=ローカルJSON+コンソール、本番=Notion保存+Gmailサマリ送信。
// 0件でも実行結果を通知する（要件F6）。
//
// 基本設計I/F（persistAndNotify(matches): Promise<void>）に対し、実装ではマッチ結果DBのrelation
// （案件・要員）を張るため projects/engineers を追加引数にしている（draft.tsと同様の変更点）。
import { saveMatch } from '../database/index.js';
import { sendPlainMailViaMail } from './mail/index.js';
import { isDemo, sesNotifyTo } from './config.js';
import { writeDemoArtifact } from './store.js';
import { writeReviewMatches } from './review.js';
import type { MatchResult, Project, Engineer } from '../types/index.js';

export async function persistAndNotify(
  matches: MatchResult[],
  projects: Project[],
  engineers: Engineer[],
): Promise<void> {
  const projectPageIds = new Map(projects.map((p) => [p.id, p.notionPageId]));
  const engineerPageIds = new Map(engineers.map((e) => [e.id, e.notionPageId]));

  const saved = await persistMatches(matches, projectPageIds, engineerPageIds);
  // 確認UI(web.ts)用のレビュー成果を書き出す（demo/本番共通。UIはこれを読む）
  writeReviewMatches(saved);
  const summary = buildSummary(saved);
  await notifySummary(summary);
}

async function persistMatches(
  matches: MatchResult[],
  projectPageIds: Map<string, string | undefined>,
  engineerPageIds: Map<string, string | undefined>,
): Promise<MatchResult[]> {
  if (isDemo()) {
    writeDemoArtifact('matches', matches);
    return matches;
  }
  const results: MatchResult[] = [];
  for (const match of matches) {
    try {
      const notionPageId = await saveMatch(match, {
        projectNotionPageId: projectPageIds.get(match.projectId),
        engineerNotionPageId: engineerPageIds.get(match.engineerId),
      });
      results.push({ ...match, notionPageId });
    } catch (err) {
      console.error(`SES通知: マッチ保存失敗 (${match.title}): ${String(err)}`);
      results.push(match);
    }
  }
  return results;
}

function buildSummary(matches: MatchResult[]): string {
  const confirmed = matches.filter((m) => m.category === 'confirmed');
  const tentative = matches.filter((m) => m.category === 'tentative');
  const negotiable = matches.filter((m) => m.category === 'negotiable');
  const needsReview = matches.filter((m) => m.category === 'review');

  const lines: string[] = [];
  lines.push('=== SESマッチング結果サマリ ===');
  lines.push(`検出日時: ${new Date().toLocaleString('ja-JP')}`);
  lines.push(
    `成立候補: ${confirmed.length}件 / 交渉提案: ${negotiable.length}件 / 参考提案: ${tentative.length}件 / 要確認: ${needsReview.length}件`,
  );
  lines.push('');

  if (matches.length === 0) {
    lines.push('今回のバッチで成立・交渉・参考のいずれの候補も検出されませんでした。');
  } else {
    if (confirmed.length > 0) {
      lines.push('【成立候補】');
      for (const m of confirmed) {
        lines.push(`・${m.title} — 粗利${(m.grossMarginJpy / 10000).toFixed(1)}万円/月, 適合スコア${m.score}点`);
        lines.push(`  根拠: ${m.reason}`);
        if (m.draftToProject) lines.push(`  案件側下書き: ${m.draftToProject.url}`);
        if (m.draftToEngineer) lines.push(`  要員側下書き: ${m.draftToEngineer.url}`);
      }
      lines.push('');
    }
    if (tentative.length > 0) {
      lines.push('【参考提案（スキルは許容範囲内・人によるご確認を推奨）】');
      for (const m of tentative) {
        lines.push(`・${m.title} — 適合スコア${m.score}点`);
        lines.push(`  根拠: ${m.reason}`);
      }
      lines.push('');
    }
    if (negotiable.length > 0) {
      lines.push('【交渉提案（単金を両者で調整すれば成立見込み）】');
      for (const m of negotiable) {
        const n = m.negotiation!;
        lines.push(
          `・${m.title} — 案件+${n.projectRaiseMan}万円／要員−${n.engineerCutMan}万円で粗利${(n.resultingGrossMarginJpy / 10000).toFixed(1)}万円/月, 適合スコア${m.score}点`,
        );
        lines.push(`  根拠: ${m.reason}`);
        if (m.draftToProject) lines.push(`  案件側下書き（交渉前提）: ${m.draftToProject.url}`);
        if (m.draftToEngineer) lines.push(`  要員側下書き（交渉前提）: ${m.draftToEngineer.url}`);
      }
      lines.push('');
    }
    if (needsReview.length > 0) {
      lines.push('【要確認（単金・勤務地等が不明のため人による確認が必要）】');
      for (const m of needsReview) {
        lines.push(`・${m.title} — ${m.reason}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

async function notifySummary(summary: string): Promise<void> {
  console.log(`\n${summary}\n`);
  if (isDemo()) return; // demoはコンソール出力のみ

  const to = sesNotifyTo();
  if (!to) {
    console.warn('SES通知: SES_NOTIFY_TO が未設定のためサマリメール送信をスキップ');
    return;
  }
  try {
    await sendPlainMailViaMail(to, 'SES案件・要員マッチング バッチ実行結果', summary);
  } catch (err) {
    console.error(`SES通知: サマリメール送信に失敗: ${String(err)}`);
  }
}
