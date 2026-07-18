// 紹介メール2通(案件側宛/要員側宛)を生成する。本番=Sonnet 5 生成→Gmail下書き作成、
// demo=テンプレート生成+ローカル保存。自動送信はしない（下書き止まり。要件F5・運用§10-1）。
//
// 基本設計I/F（createDrafts(matches): Promise<MatchResult[]>）に対し、実装では案件・要員の
// 詳細（スキル・単金・宛先メール等）を本文に反映するため projects/engineers を追加引数にしている
// （詳細設計での変更点。docs/ses-matching-detailed-design.md に理由を明記）。
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { generateText } from '../llm/index.js';
import { createReplyDraftViaMail } from './mail/index.js';
import { isDemo, matchModel, demoDataDir } from './config.js';
import { writeDemoArtifact } from './store.js';
import type { MatchResult, Project, Engineer, DraftRef, RemoteOption, ReplyTarget } from '../types/index.js';

let demoDraftCounter = 0;

// 送信元(From)が未確定のうちは placeholder を入れておく。確認UIで担当営業が自分の会社アドレスを
// 入れて下書きを作成するまでこの文言が残る（＝未確定のまま送らないためのガードも兼ねる）。
export const FROM_PLACEHOLDER = '《送信元：あなたの会社ドメインのアドレスを確認して入力してください》';

function ensureRe(subject: string): string {
  const s = (subject || '').trim();
  if (!s) return 'Re:';
  return /^re\s*:/i.test(s) ? s : `Re: ${s}`;
}

function splitAddrs(s: string): string[] {
  return (s || '').split(',').map((x) => x.trim()).filter(Boolean);
}

// 全員に返信の Cc = 元メールの宛先一同（To + Cc、sales@ メーリスを含む）。重複のみ除去。
function mergeCc(...lists: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const addr of splitAddrs(list)) {
      const key = addr.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(addr);
      }
    }
  }
  return out.join(', ');
}

// 元メール(replyTarget)への「全員に返信」として、宛先・件名・スレッド情報＋本文をまとめる。
// To=元送信者、Cc=元の宛先一同（メーリス含む）、件名は Re: 付与、In-Reply-To/References でスレッド継続。
function assembleReplyRef(
  replyTarget: ReplyTarget | undefined,
  fallbackTo: string,
  fallbackSubject: string,
  body: string,
  fromEmail?: string,
): DraftRef {
  demoDraftCounter += 1;
  const to = replyTarget?.from || fallbackTo;
  const cc = replyTarget ? mergeCc(replyTarget.to, replyTarget.cc) : '';
  const subject = replyTarget ? ensureRe(replyTarget.subject) : fallbackSubject;
  const inReplyTo = replyTarget?.messageId || '';
  const references = [replyTarget?.references || '', replyTarget?.messageId || ''].filter(Boolean).join(' ');
  return {
    draftId: `demo_draft_${demoDraftCounter}`,
    url: '',
    to,
    cc,
    from: fromEmail || FROM_PLACEHOLDER,
    subject,
    inReplyTo,
    references,
    body,
  };
}

// 下書き内容をローカルファイルに書き出す（demo/確認用）。ヘッダも人が読める形で残す。
function writeDraftFile(ref: DraftRef): DraftRef {
  try {
    const dir = join(process.cwd(), demoDataDir(), 'drafts');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `${ref.draftId}.txt`);
    const header =
      `From: ${ref.from ?? ''}\nTo: ${ref.to}\nCc: ${ref.cc ?? ''}\nSubject: ${ref.subject}\n` +
      (ref.inReplyTo ? `In-Reply-To: ${ref.inReplyTo}\n` : '');
    writeFileSync(filePath, `${header}\n${ref.body ?? ''}`, 'utf-8');
    return { ...ref, url: filePath };
  } catch (err) {
    console.warn(`SES下書き: ローカル保存に失敗 (${ref.draftId}): ${String(err)}`);
    return ref;
  }
}

// 確認UIから、担当営業本人の会社アドレスで下書きを確定する。
// demo=Fromを入れてローカル保存、prod=メールプロバイダで下書き作成
// （xserver=共有下書きフォルダにAPPEND / gmail=本人のGmailにスレッド下書き）。
export async function materializeReplyDraft(ref: DraftRef, fromEmail: string): Promise<DraftRef> {
  const finalized: DraftRef = { ...ref, from: fromEmail };
  if (isDemo()) return writeDraftFile(finalized);
  return createReplyDraftViaMail(finalized, fromEmail);
}

export async function createDrafts(
  matches: MatchResult[],
  projects: Project[],
  engineers: Engineer[],
): Promise<MatchResult[]> {
  const projectMap = new Map(projects.map((p) => [p.id, p]));
  const engineerMap = new Map(engineers.map((e) => [e.id, e]));

  const results: MatchResult[] = [];
  const demoRecords: Array<{ matchId: string; title: string; draftToProject: DraftRef; draftToEngineer: DraftRef }> =
    [];

  for (const match of matches) {
    // 要確認枠(情報不足)・参考提案枠(スキルが許容範囲)は自動下書き対象外。
    // 人が内容を確認・確定してから紹介する（誤提案を防ぐ）。
    if (match.needsReview || match.category === 'tentative') {
      results.push(match);
      continue;
    }
    const project = projectMap.get(match.projectId);
    const engineer = engineerMap.get(match.engineerId);
    if (!project || !engineer) {
      console.warn(`SES下書き: 案件/要員情報が見つからずスキップ (${match.title})`);
      results.push(match);
      continue;
    }
    try {
      const [draftToProject, draftToEngineer] = isDemo()
        ? createDemoDraftPair(project, engineer, match)
        : await createProdDraftPair(project, engineer, match);
      results.push({ ...match, draftToProject, draftToEngineer });
      if (isDemo()) demoRecords.push({ matchId: match.id, title: match.title, draftToProject, draftToEngineer });
    } catch (err) {
      console.error(`SES下書き: 生成に失敗 (${match.title}): ${String(err)}`);
      results.push(match);
    }
  }

  if (isDemo()) writeDemoArtifact('drafts', demoRecords);
  return results;
}

// ---------- demo（テンプレート文面 + ローカル保存。全員に返信の形） ----------

function createDemoDraftPair(project: Project, engineer: Engineer, match: MatchResult): [DraftRef, DraftRef] {
  const toProject = assembleReplyRef(
    project.replyTarget,
    project.agentEmail,
    subjectToProject(project, engineer),
    buildTemplateToProject(project, engineer, match),
  );
  const toEngineer = assembleReplyRef(
    engineer.replyTarget,
    engineer.agentEmail,
    subjectToEngineer(project, engineer),
    buildTemplateToEngineer(project, engineer, match),
  );
  return [writeDraftFile(toProject), writeDraftFile(toEngineer)];
}

function buildTemplateToProject(project: Project, engineer: Engineer, match: MatchResult): string {
  return `${project.agentContact || 'ご担当'}様

いつもお世話になっております。
貴社ご案内の案件「${project.title}」につきまして、以下要員をご提案いたします。

■ご提案要員
表示名: ${engineer.displayName}
スキル: ${engineer.skills.join('、') || '（記載なし）'}
経験年数: ${engineer.experienceYears ?? '不明'}年
稼働開始可能日: ${engineer.availableDate}
リモート希望: ${remoteLabel(engineer.remoteWish)}
希望単金: ${engineer.desiredRate ?? '応相談'}万円/月（★送付前に単金開示の要否をご確認ください）

■マッチ判定
適合スコア: ${match.score}点
判定根拠: ${match.reason}${negotiationNoteToProject(match)}

ご検討のほど、よろしくお願いいたします。`;
}

// 交渉提案がある場合、案件側（案件を出している営業）宛に「単金を上げるご相談」を添える
function negotiationNoteToProject(match: MatchResult): string {
  const n = match.negotiation;
  if (!n) return '';
  return `

■単金のご相談
本案件、現行のご提示より+${n.projectRaiseMan}万円（→${n.targetProjectRateMan}万円/月）でご調整いただけますと、双方の採算が合い、ご成約に進めやすくなります。ぜひご相談させてください。`;
}

// 交渉提案がある場合、要員側（要員を抱える営業）宛に「単金を下げるご相談」を添える
function negotiationNoteToEngineer(match: MatchResult): string {
  const n = match.negotiation;
  if (!n) return '';
  return `

■単金のご相談
ご登録単金より−${n.engineerCutMan}万円（→${n.targetEngineerRateMan}万円/月）でご調整いただけますと、本案件でのご提案が可能です。ぜひご相談させてください。`;
}

function buildTemplateToEngineer(project: Project, engineer: Engineer, match: MatchResult): string {
  return `${engineer.agentContact || 'ご担当'}様

いつもお世話になっております。
貴社ご登録の要員「${engineer.displayName}」様に合う案件がございますので、ご紹介いたします。

■ご紹介案件
案件名: ${project.title}
必須スキル: ${project.requiredSkills.join('、') || '（記載なし）'}
尚可スキル: ${project.preferredSkills.join('、') || '（記載なし）'}
単金: ${project.rateMin ?? '応相談'}〜${project.rateMax ?? '応相談'}万円/月
勤務地: ${project.location}（リモート: ${remoteLabel(project.remote)}）
開始時期: ${project.startPeriod}
商流メモ: ${project.businessFlow || '（記載なし）'}

■マッチ判定
適合スコア: ${match.score}点
判定根拠: ${match.reason}${negotiationNoteToEngineer(match)}

ご検討のほど、よろしくお願いいたします。`;
}

function remoteLabel(r: RemoteOption): string {
  const labels: Record<RemoteOption, string> = {
    full: 'フルリモート可',
    partial: '一部リモート可',
    none: '不可',
    unknown: '不明',
  };
  return labels[r];
}

function subjectToProject(project: Project, engineer: Engineer): string {
  return `【ご提案】${engineer.displayName}様のご紹介 - ${project.title}`;
}

function subjectToEngineer(project: Project, engineer: Engineer): string {
  return `【ご紹介】${project.title} - ${engineer.displayName}様向け`;
}

// ---------- 本番（Sonnet 5生成 → 全員に返信の下書き内容を用意） ----------
// 送信元は担当営業個人の会社アドレスのため、実際のGmail下書き作成は確認UIで本人が行う
// （materializeReplyDraft）。ここでは全員に返信の文面・宛先・スレッド情報を用意する。

const DRAFT_SYSTEM = `あなたはSES事業者の営業担当として、案件と要員をつなぐ紹介メールを作成するアシスタントです。
丁寧なビジネス日本語で、簡潔かつ具体的な文面を作成してください。件名は含めず、本文のみを返してください。
これは共有メーリスに届いた元メールへの「全員に返信」です。冒頭に相手の担当者名への宛名を入れてください。
単金の開示は商習慣上センシティブなため、断定せず「ご相談の上」等の含みを持たせた表現にしてください。`;

async function createProdDraftPair(
  project: Project,
  engineer: Engineer,
  match: MatchResult,
): Promise<[DraftRef, DraftRef]> {
  const [bodyToProject, bodyToEngineer] = await Promise.all([
    generateText(DRAFT_SYSTEM, [{ role: 'user', content: buildDraftPrompt('project', project, engineer, match) }], {
      model: matchModel(),
      maxTokens: 2000,
    }),
    generateText(DRAFT_SYSTEM, [{ role: 'user', content: buildDraftPrompt('engineer', project, engineer, match) }], {
      model: matchModel(),
      maxTokens: 2000,
    }),
  ]);

  return [
    assembleReplyRef(project.replyTarget, project.agentEmail, subjectToProject(project, engineer), bodyToProject),
    assembleReplyRef(engineer.replyTarget, engineer.agentEmail, subjectToEngineer(project, engineer), bodyToEngineer),
  ];
}

function buildDraftPrompt(
  target: 'project' | 'engineer',
  project: Project,
  engineer: Engineer,
  match: MatchResult,
): string {
  const context = `【案件情報】
案件名: ${project.title}
必須スキル: ${project.requiredSkills.join('、')}
尚可スキル: ${project.preferredSkills.join('、')}
単金: ${project.rateMin ?? '不明'}〜${project.rateMax ?? '不明'}万円/月
勤務地: ${project.location}（リモート: ${project.remote}）
開始時期: ${project.startPeriod}
商流メモ: ${project.businessFlow}
営業元: ${project.agentCompany} ${project.agentContact}

【要員情報】
表示名: ${engineer.displayName}
スキル: ${engineer.skills.join('、')}
経験年数: ${engineer.experienceYears ?? '不明'}年
希望単金: ${engineer.desiredRate ?? '不明'}万円/月
居住地: ${engineer.residence}（リモート希望: ${engineer.remoteWish}）
稼働開始可能日: ${engineer.availableDate}
営業元: ${engineer.agentCompany} ${engineer.agentContact}

【マッチ判定】
適合スコア: ${match.score}点
判定根拠: ${match.reason}${buildNegotiationContext(target, match)}`;

  return target === 'project'
    ? `${context}\n\n上記の案件を出している営業担当（${project.agentContact}様）宛に、上記の要員をご提案する紹介メールの本文を作成してください。`
    : `${context}\n\n上記の要員を抱える営業担当（${engineer.agentContact}様）宛に、上記の案件をご紹介する紹介メールの本文を作成してください。`;
}

// 交渉提案がある場合、生成AIに単金交渉を織り込んでもらうための文脈を付す
function buildNegotiationContext(target: 'project' | 'engineer', match: MatchResult): string {
  const n = match.negotiation;
  if (!n) return '';
  const ask =
    target === 'project'
      ? `案件側には、単金を+${n.projectRaiseMan}万円（→${n.targetProjectRateMan}万円/月）に上げていただけないか、丁寧に相談する一文を含めてください。`
      : `要員側には、単金を−${n.engineerCutMan}万円（→${n.targetEngineerRateMan}万円/月）に調整いただけないか、丁寧に相談する一文を含めてください。`;
  return `\n\n【単金交渉の提案】\n現状の粗利は${(match.grossMarginJpy / 10000).toFixed(1)}万円/月で下限に届かないため、案件単金を+${n.projectRaiseMan}万円・要員単金を−${n.engineerCutMan}万円で調整すると粗利${(n.resultingGrossMarginJpy / 10000).toFixed(1)}万円/月になります。${ask}`;
}

