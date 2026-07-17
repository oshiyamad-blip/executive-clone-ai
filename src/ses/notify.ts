// マッチ結果DB更新 + サマリ生成。demo=ローカルJSON+コンソール、本番=Notion保存+Gmailサマリ送信。
// 0件でも実行結果を通知する（要件F6）。
//
// 基本設計I/F（persistAndNotify(matches): Promise<void>）に対し、実装ではマッチ結果DBのrelation
// （案件・要員）を張るため projects/engineers を追加引数にしている（draft.tsと同様の変更点）。
import { google } from 'googleapis';
import { saveMatch } from '../database/index.js';
import { getGoogleAuth } from '../collectors/googleAuth.js';
import { isDemo, sesNotifyTo } from './config.js';
import { writeDemoArtifact } from './store.js';
import type { MatchResult, Project, Engineer } from '../types/index.js';

export async function persistAndNotify(
  matches: MatchResult[],
  projects: Project[],
  engineers: Engineer[],
): Promise<void> {
  const projectPageIds = new Map(projects.map((p) => [p.id, p.notionPageId]));
  const engineerPageIds = new Map(engineers.map((e) => [e.id, e.notionPageId]));

  const saved = await persistMatches(matches, projectPageIds, engineerPageIds);
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
  const confirmed = matches.filter((m) => !m.needsReview);
  const needsReview = matches.filter((m) => m.needsReview);

  const lines: string[] = [];
  lines.push('=== SESマッチング結果サマリ ===');
  lines.push(`検出日時: ${new Date().toLocaleString('ja-JP')}`);
  lines.push(`成立候補: ${confirmed.length}件 / 要確認: ${needsReview.length}件`);
  lines.push('');

  if (matches.length === 0) {
    lines.push('今回のバッチで粗利条件を満たすペアは検出されませんでした。');
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
  const auth = getGoogleAuth();
  if (!auth) {
    console.warn('SES通知: Google認証未設定のためサマリメール送信をスキップ');
    return;
  }
  try {
    const gmail = google.gmail({ version: 'v1', auth });
    await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: buildRawSummaryEmail(to, summary) },
    });
  } catch (err) {
    console.error(`SES通知: サマリメール送信に失敗: ${String(err)}`);
  }
}

function buildRawSummaryEmail(to: string, body: string): string {
  const subject = 'SES案件・要員マッチング バッチ実行結果';
  const message = [
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject, 'utf-8').toString('base64')}?=`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    body,
  ].join('\n');
  return Buffer.from(message).toString('base64url');
}
