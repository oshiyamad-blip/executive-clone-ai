// マッチ結果DB更新 + サマリ生成。demo=ローカルJSON+コンソール、本番=DB保存+サマリメール送信。
// Sheets運用の本番では、担当者メールによる下書き作成の結果と依頼方法もサマリに載せる。
// 0件でも実行結果を通知する（要件F6）。ログ秘匿モードではコンソールに件数1行だけを出す（詳細はメールのみ）。
//
// 基本設計I/F（persistAndNotify(matches): Promise<void>）に対し、実装ではマッチ結果DBのrelation
// （案件・要員）を張るため projects/engineers を追加引数にしている（draft.tsと同様の変更点）。
import { saveMatch } from '../database/index.js';
import { sendPlainMailViaMail, sendMailReady } from './mail/index.js';
import { SUMMARY_SUBJECT } from './mail/ownMail.js';
import { isDemo, sesNotifyTo, logRedact, mailProvider, requireLive } from './config.js';
import { writeDemoArtifact } from './store.js';
import { writeReviewMatches } from './review.js';
import { buildDiagnosisReport, recordFatal } from './heal/events.js';
import { redactable, safeErr } from './redact.js';
import { draftRequestsEnabled, type PendingDraftResult } from './pendingDrafts.js';
import { properSummaryLines, type ProperRunResult } from './proper/index.js';
import type { MatchResult, Project, Engineer, DraftRef } from '../types/index.js';

export async function persistAndNotify(
  matches: MatchResult[],
  projects: Project[],
  engineers: Engineer[],
  requestedDrafts: PendingDraftResult = { created: 0, failed: 0 },
  proper: ProperRunResult | null = null,
): Promise<void> {
  const projectPageIds = new Map(projects.map((p) => [p.id, p.notionPageId]));
  const engineerPageIds = new Map(engineers.map((e) => [e.id, e.notionPageId]));

  const saved = await persistMatches(matches, projectPageIds, engineerPageIds);
  // 確認UI(web.ts)用のレビュー成果を書き出す（demo/本番共通。UIはこれを読む）
  writeReviewMatches(saved);
  // プロパー候補の節は、メールには氏名・案件名つき、コンソールには件数だけを載せる
  const base = buildSummary(saved, requestedDrafts);
  let summary = `${base}\n${properSummaryLines(proper, true).join('\n')}`;
  const consoleSummary = `${base}\n${properSummaryLines(proper, false).join('\n')}`;
  // 本番のみ、自動検証・修復の診断レポートをサマリ末尾に添える（コスト概算・異常検知・隔離状況）
  if (!isDemo()) {
    summary = `${summary}\n${await buildDiagnosisReport()}`;
  }
  await notifySummary(summary, consoleSummary, countLine(saved, proper));
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
      console.error(`SES通知: マッチ保存失敗 (${match.id} ${redactable(match.title)}): ${safeErr(err)}`);
      results.push(match);
    }
  }
  return results;
}

// 区分ごとの件数（サマリ本文とログ秘匿モードのコンソール出力で共用。人名・案件名を含まない）
function countLine(matches: MatchResult[], proper: ProperRunResult | null = null): string {
  const count = (category: MatchResult['category']) => matches.filter((m) => m.category === category).length;
  const properCount = proper ? ` / プロパー候補: ${proper.candidates.length}件` : '';
  return `成立候補: ${count('confirmed')}件 / 交渉提案: ${count('negotiable')}件 / 参考提案: ${count('tentative')}件 / 要確認: ${count('review')}件${properCount}`;
}

// Sheets運用では下書きは担当者メールの入力で次回バッチが作るため、URLの代わりに文面の在りかを示す
function draftLine(label: string, ref: DraftRef): string {
  if (ref.url) return `  ${label}: ${ref.url}`;
  if (draftRequestsEnabled()) return `  ${label}: 文面はスプレッドシート「マッチ」タブにあります（担当者メール入力で作成）`;
  return `  ${label}: 未作成（確認UIで送信元のアドレスを入力すると作成されます）`;
}

// 利用者向けの日時は日本時間で表記する（UTCのランナーでも10:00/14:00の実行と一致させる）
function jstNow(): string {
  return new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

// 件名に実行時刻（JST）を添え、1日2回のサマリを見分けられるようにする
function summarySubject(): string {
  const hm = new Date().toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });
  return `${SUMMARY_SUBJECT}（${hm}）`;
}

// 担当者メールによる下書き依頼の結果と使い方（Sheets運用の本番のみ）
function draftRequestSection(requested: PendingDraftResult): string[] {
  if (!draftRequestsEnabled()) return [];
  return [
    '【紹介メール下書き（担当者指定）】',
    `下書き作成: ${requested.created}件（担当者指定分）${requested.failed > 0 ? ` / 失敗: ${requested.failed}件` : ''}`,
    '■下書きの作り方',
    '1. スプレッドシート「マッチ」タブで、成立候補・交渉提案の行の「案件側文面」「要員側文面」を確認する',
    '2. その行の「担当者メール」列に、送信元にするご自身の会社メールアドレスを1件入力する',
    '3. 次回のバッチ（平日10:00／14:00）で、そのアドレスを送信元とした「全員に返信」の下書きが作成され、',
    '   「案件側下書き状態」「要員側下書き状態」が「作成済 日時」になります（送信はご自身で内容を確認してから）',
    `   作成先: ${mailProvider() === 'gmail' ? 'ご自身のGmailの下書き' : '共有メールボックスの下書きフォルダ'}`,
    '・片側だけ作る場合は、不要な側の状態を「不要」にしてください',
    '・状態が「エラー: …」の側は次回バッチで再試行します（担当者メールを直せば反映されます）',
    '・文面の修正は、作成された下書き上で行ってください（シートの文面列を書き換えても下書きには反映されません）',
    '・「プロパー候補」タブ（自社社員のご提案）も同じ手順です（案件側の下書きのみ）',
    '',
  ];
}

function buildSummary(matches: MatchResult[], requestedDrafts: PendingDraftResult): string {
  const confirmed = matches.filter((m) => m.category === 'confirmed');
  const tentative = matches.filter((m) => m.category === 'tentative');
  const negotiable = matches.filter((m) => m.category === 'negotiable');
  const needsReview = matches.filter((m) => m.category === 'review');

  const lines: string[] = [];
  lines.push('=== SESマッチング結果サマリ ===');
  lines.push(`検出日時: ${jstNow()}`);
  lines.push(countLine(matches));
  lines.push('');
  lines.push(...draftRequestSection(requestedDrafts));

  if (matches.length === 0) {
    lines.push('今回のバッチで成立・交渉・参考のいずれの候補も検出されませんでした。');
  } else {
    if (confirmed.length > 0) {
      lines.push('【成立候補】');
      for (const m of confirmed) {
        lines.push(`・${m.title} — 粗利${(m.grossMarginJpy / 10000).toFixed(1)}万円/月, 適合スコア${m.score}点`);
        lines.push(`  根拠: ${m.reason}`);
        if (m.draftToProject) lines.push(draftLine('案件側下書き', m.draftToProject));
        if (m.draftToEngineer) lines.push(draftLine('要員側下書き', m.draftToEngineer));
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
        if (m.draftToProject) lines.push(draftLine('案件側下書き（交渉前提）', m.draftToProject));
        if (m.draftToEngineer) lines.push(draftLine('要員側下書き（交渉前提）', m.draftToEngineer));
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

async function notifySummary(summary: string, consoleSummary: string, counts: string): Promise<void> {
  if (logRedact()) console.log(`SES通知: 結果 ${counts}（詳細はサマリメールを参照）`);
  else console.log(`\n${consoleSummary}\n`);
  if (isDemo()) return; // demoはコンソール出力のみ

  const to = sesNotifyTo();
  if (!to) {
    console.warn('SES通知: SES_NOTIFY_TO が未設定のためサマリメール送信をスキップ');
    return;
  }
  if (!sendMailReady()) {
    // 宛先があるのに送れない設定は、スケジュール実行では結果が誰にも届かないため異常終了扱いにする
    const message = 'サマリメールの送信設定（XSERVER_SMTP_* または SES_TARGET_GMAIL と Google認証）が未完了です';
    if (requireLive()) recordFatal(message);
    else console.warn(`SES通知: ${message} — 送信をスキップします`);
    return;
  }
  try {
    await sendPlainMailViaMail(to, summarySubject(), summary);
  } catch (err) {
    console.error(`SES通知: サマリメール送信に失敗: ${safeErr(err)}`);
    recordFatal('サマリメールの送信に失敗しました');
  }
}
