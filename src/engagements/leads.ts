import '../env.js';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'fs';
import { extname, join } from 'path';
import { google } from 'googleapis';
import { getGoogleAuth } from '../collectors/googleAuth.js';
import { generateJson } from '../llm/index.js';
import { fetchProjects, fetchMembers, saveProject, saveMember } from './notionDb.js';
import type { Project, Member } from '../types/engagements.js';

// 案件票・要員提案の自動取込（npm run leads）
//
// パートナー企業からメールやLINE（コピペ/手動メモ）で流れてくる案件情報・要員提案をLLMで
// 検出・構造化し、案件DB/要員DBに「ドラフト」ステータスで登録する。人がNotionで確認して
// 「募集中」「稼働中/待機」等に昇格させるまでは npm run match の対象にならない
// （マッチングは 提案中/募集中 の案件のみを見るため）。
//
// 誤登録防止のデザイン: 既定はプレビューのみ。--apply を付けた時だけ Notion へ書き込む。
// 使い方:
//   npm run leads              # プレビュー（書き込みなし）
//   npm run leads -- --apply   # 実際に「ドラフト」登録する

const SUPPORTED_EXT = new Set(['.txt', '.md']);
const MAX_BODY_CHARS = 8000;
const DEFAULT_GMAIL_QUERY =
  '(案件 OR 要員 OR エンジニア OR 提案 OR パートナー) newer_than:7d -in:drafts -in:spam -in:trash';

// --- LLM抽出結果の型 ---

type LeadKind = 'project_lead' | 'member_lead' | 'both' | 'other';

interface LeadProject {
  name: string;
  clientName: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  requiredSkills: string[];
  rateMin: number | null;
  rateMax: number | null;
  headcount: number | null;
  note: string | null;
}

interface LeadMember {
  name: string;
  skills: string[];
  monthlyRateHint: number | null;
  availabilityNote: string | null;
  note: string | null;
}

interface LeadPayload {
  kind: LeadKind;
  projects: LeadProject[];
  members: LeadMember[];
}

// --- JSON Schema（構造化出力）---

const LEAD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'projects', 'members'],
  properties: {
    kind: {
      type: 'string',
      enum: ['project_lead', 'member_lead', 'both', 'other'],
      description:
        '内容の種類。案件情報のみ=project_lead、要員提案のみ=member_lead、両方混在=both、どちらでもない=other',
    },
    projects: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'name', 'clientName', 'periodStart', 'periodEnd',
          'requiredSkills', 'rateMin', 'rateMax', 'headcount', 'note',
        ],
        properties: {
          name: { type: 'string', description: '案件名（必須）' },
          clientName: { type: ['string', 'null'], description: '案件元（パートナー企業）の会社名' },
          periodStart: { type: ['string', 'null'], description: '開始日。YYYY-MM-DD形式（不明ならnull）' },
          periodEnd: { type: ['string', 'null'], description: '終了日。YYYY-MM-DD形式（不明ならnull）' },
          requiredSkills: { type: 'array', items: { type: 'string' }, description: '必要スキル一覧' },
          rateMin: { type: ['number', 'null'], description: '単価下限（月額・円）' },
          rateMax: { type: ['number', 'null'], description: '単価上限（月額・円）' },
          headcount: { type: ['number', 'null'], description: '必要人数' },
          note: { type: ['string', 'null'], description: '案件の要点メモ（200字程度）' },
        },
      },
    },
    members: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'skills', 'monthlyRateHint', 'availabilityNote', 'note'],
        properties: {
          name: {
            type: 'string',
            description: '氏名または会社名（必須）。イニシャル表記（例: T.K）のみの場合もそのまま入れる',
          },
          skills: { type: 'array', items: { type: 'string' }, description: 'スキル一覧' },
          monthlyRateHint: { type: ['number', 'null'], description: '単価目安（月額・円）' },
          availabilityNote: { type: ['string', 'null'], description: '稼働開始時期・稼働条件など' },
          note: { type: ['string', 'null'], description: '提案文の要点メモ（200字程度）' },
        },
      },
    },
  },
} as const;

const LEAD_SYSTEM = `あなたはSES企業の営業アシスタント。メール/メモから「案件情報（案件票）」と「要員情報（要員提案・スキルシート）」を抽出してください。
案件でも要員でもない内容（社内連絡・営業挨拶・請求書など）は kind: 'other' として projects/members を空にしてください。
記載されている情報だけを抽出し、推測で埋めないでください。単価は月額・円の数値、日付はYYYY-MM-DD形式で出力してください。
氏名がイニシャル表記（例: T.K）のみの要員提案もそのまま name に入れてください。`;

function buildUserPrompt(label: string, content: string): string {
  return `以下は「${label}」から取得したテキストです。指定のJSON Schemaに従って抽出してください。\n\n---\n${content}\n---`;
}

// --- 類似度判定（純関数）---
// 日本語は単語間に空白が無いため、文字bigram集合のJaccard係数で類似度を計算する
// （src/dedup/index.ts の重複ログ統合と同じ考え方）。

function charBigrams(s: string): Set<string> {
  const t = s.replace(/\s+/g, '');
  const grams = new Set<string>();
  if (t.length <= 1) {
    if (t.length === 1) grams.add(t);
    return grams;
  }
  for (let i = 0; i < t.length - 1; i++) grams.add(t.slice(i, i + 2));
  return grams;
}

export function nameSimilarity(a: string, b: string): number {
  const setA = charBigrams(a);
  const setB = charBigrams(b);
  const intersection = new Set([...setA].filter((g) => setB.has(g)));
  const union = new Set([...setA, ...setB]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

// 完全一致・一方が他方を含む・bigram Jaccard >= 0.6 のいずれかで「類似」と判定する
export function isSimilarName(a: string, b: string): boolean {
  const na = a.trim();
  const nb = b.trim();
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  return nameSimilarity(na, nb) >= 0.6;
}

function findSimilar(names: string[], target: string): string | undefined {
  return names.find((n) => isSimilarName(n, target));
}

// --- 取込元タグ（重複排除の第1段階）---
// 登録時に note/availabilityNote の末尾へ `[取込元:gmail_<messageId>]` / `[取込元:file_<ファイル名>]`
// を付与し、実行時は既存レコードのnoteからこのタグを回収して既取込のソースをスキップする。

const SOURCE_TAG_RE = /\[取込元:([^\]]+)\]/;

export function parseSourceTag(text: string): string | undefined {
  return SOURCE_TAG_RE.exec(text)?.[1];
}

function collectImportedTags(projects: Project[], members: Member[]): Set<string> {
  const tags = new Set<string>();
  for (const p of projects) {
    const tag = parseSourceTag(p.note);
    if (tag) tags.add(tag);
  }
  for (const m of members) {
    const tag = parseSourceTag(m.availabilityNote);
    if (tag) tags.add(tag);
  }
  return tags;
}

function combineNotes(...parts: Array<string | null | undefined>): string {
  return parts.filter((p): p is string => Boolean(p && p.trim())).join(' / ');
}

function buildNote(note: string, sourceTag: string): string {
  const tag = `[取込元:${sourceTag}]`;
  return note ? `${note}\n${tag}` : tag;
}

// --- ヘルパー ---

function parseDate(value: string | null): Date | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function yen(n: number | null | undefined): string {
  return n !== null && n !== undefined ? `${n.toLocaleString()}円` : '未設定';
}

function yenRange(min: number | null, max: number | null): string {
  if (min === null && max === null) return '未設定';
  return `${min !== null ? yen(min) : '?'}〜${max !== null ? yen(max) : '?'}`;
}

// --- 入力ソース ---

interface LeadSource {
  sourceTag: string; // gmail_<messageId> / file_<ファイル名>
  label: string; // 表示用（件名 or ファイル名）
  content: string;
  filePath?: string; // フォルダ・ドロップのみ（--apply時の退避用）
}

// MIMEツリーから text/plain 本文を再帰的に抽出する（src/collectors/email.ts と同じパターン）
function extractGmailBody(payload: unknown): string {
  const p = payload as { mimeType?: string; body?: { data?: string }; parts?: unknown[] } | undefined;
  if (!p) return '';
  if (p.mimeType === 'text/plain' && p.body?.data) return decodeBase64Url(p.body.data);
  for (const part of p.parts ?? []) {
    const text = extractGmailBody(part);
    if (text) return text;
  }
  if (p.body?.data) return decodeBase64Url(p.body.data);
  return '';
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

async function collectGmailSources(): Promise<LeadSource[]> {
  const auth = getGoogleAuth();
  if (!auth) {
    console.warn('案件票取込: Google サービスアカウント設定が未完了のため、Gmailはスキップします');
    return [];
  }

  const gmail = google.gmail({ version: 'v1', auth });
  const query = process.env.LEADS_GMAIL_QUERY || DEFAULT_GMAIL_QUERY;
  const sources: LeadSource[] = [];

  try {
    let pageToken: string | undefined;
    do {
      const list = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 100, pageToken });

      for (const ref of list.data.messages ?? []) {
        if (!ref.id) continue;
        try {
          const msg = await gmail.users.messages.get({ userId: 'me', id: ref.id, format: 'full' });
          const headers = msg.data.payload?.headers ?? [];
          const header = (name: string) =>
            headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
          const subject = header('Subject');
          const body = extractGmailBody(msg.data.payload).slice(0, MAX_BODY_CHARS);
          sources.push({
            sourceTag: `gmail_${ref.id}`,
            label: subject || '(件名なし)',
            content: `件名: ${subject}\n\n${body}`,
          });
        } catch (err) {
          console.warn(`案件票取込: メール(${ref.id})の取得中にエラー: ${String(err)}`);
        }
      }

      pageToken = list.data.nextPageToken ?? undefined;
    } while (pageToken);
  } catch (err) {
    console.error(`案件票取込: Gmail検索中にエラー: ${String(err)}`);
  }

  console.log(`Gmail: ${sources.length}件のメールを検出（クエリ: ${query}）`);
  return sources;
}

function collectFolderSources(inboxDir: string): LeadSource[] {
  const files = readdirSync(inboxDir, { withFileTypes: true })
    .filter((f) => f.isFile() && SUPPORTED_EXT.has(extname(f.name).toLowerCase()))
    .map((f) => f.name);

  const sources = files.map((fileName): LeadSource => {
    const filePath = join(inboxDir, fileName);
    const content = readFileSync(filePath, 'utf-8').slice(0, MAX_BODY_CHARS);
    return { sourceTag: `file_${fileName}`, label: fileName, content, filePath };
  });

  console.log(`フォルダ: ${sources.length}件のファイルを検出（${inboxDir}）`);
  return sources;
}

// --- 取込本体 ---

interface ProcessCounters {
  projectsNew: number;
  projectsSkipped: number;
  membersNew: number;
  membersSkipped: number;
}

interface ProcessResult {
  ok: boolean;
  kind: LeadKind;
  counters: ProcessCounters;
}

async function processSource(
  source: LeadSource,
  apply: boolean,
  projectNamesSeen: string[],
  memberNamesSeen: string[],
): Promise<ProcessResult> {
  console.log(`\n--- ${source.label} ---`);
  const emptyCounters: ProcessCounters = { projectsNew: 0, projectsSkipped: 0, membersNew: 0, membersSkipped: 0 };

  let payload: LeadPayload;
  try {
    payload = await generateJson<LeadPayload>(
      LEAD_SYSTEM,
      buildUserPrompt(source.label, source.content),
      LEAD_SCHEMA,
      { maxTokens: 8000 },
    );
  } catch (err) {
    console.error(`  抽出に失敗したためこのソースはスキップします: ${String(err)}`);
    return { ok: false, kind: 'other', counters: emptyCounters };
  }

  if (payload.kind === 'other') {
    console.log('  案件情報・要員情報のいずれにも該当しないためスキップします');
    return { ok: true, kind: 'other', counters: emptyCounters };
  }

  const counters: ProcessCounters = { ...emptyCounters };

  for (const p of payload.projects) {
    const name = p.name?.trim();
    if (!name) continue;
    const similar = findSimilar(projectNamesSeen, name);
    if (similar) {
      console.log(`  ⚠ 既存『${similar}』と類似のためスキップ（案件: ${name}）`);
      counters.projectsSkipped++;
      continue;
    }
    console.log(`  案件: ${name}（案件元:${p.clientName ?? '未設定'} / 単価:${yenRange(p.rateMin, p.rateMax)}）`);
    counters.projectsNew++;
    projectNamesSeen.push(name);
    if (apply) {
      const project: Omit<Project, 'id'> = {
        name,
        status: 'ドラフト',
        period: { start: parseDate(p.periodStart), end: parseDate(p.periodEnd) },
        requiredSkills: p.requiredSkills ?? [],
        rateRange: { min: p.rateMin ?? undefined, max: p.rateMax ?? undefined },
        headcount: p.headcount ?? undefined,
        note: buildNote(combineNotes(p.note), source.sourceTag),
      };
      try {
        await saveProject(project);
      } catch (err) {
        console.error(`  案件「${name}」のNotion登録に失敗（残りの取込は継続）: ${String(err)}`);
        counters.projectsNew--;
      }
    }
  }

  for (const m of payload.members) {
    const name = m.name?.trim();
    if (!name) continue;
    const similar = findSimilar(memberNamesSeen, name);
    if (similar) {
      console.log(`  ⚠ 既存『${similar}』と類似のためスキップ（要員: ${name}）`);
      counters.membersSkipped++;
      continue;
    }
    console.log(
      `  要員: ${name}（スキル:${(m.skills ?? []).join('/') || '未設定'} / 単価目安:${yen(m.monthlyRateHint)}）`,
    );
    counters.membersNew++;
    memberNamesSeen.push(name);
    if (apply) {
      const member: Omit<Member, 'id'> = {
        name,
        kind: 'contractor_corp',
        email: '',
        skills: m.skills ?? [],
        availabilityNote: buildNote(combineNotes(m.availabilityNote, m.note), source.sourceTag),
        status: 'ドラフト',
        monthlyRateHint: m.monthlyRateHint ?? undefined,
      };
      try {
        await saveMember(member);
      } catch (err) {
        console.error(`  要員「${name}」のNotion登録に失敗（残りの取込は継続）: ${String(err)}`);
        counters.membersNew--;
      }
    }
  }

  return { ok: true, kind: payload.kind, counters };
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const inboxDir = process.env.LEADS_IMPORT_DIR ?? './leads-import';

  if (!existsSync(inboxDir)) {
    mkdirSync(inboxDir, { recursive: true });
    console.log(`受け皿フォルダを作成しました: ${inboxDir}`);
    console.log('LINEのコピペや手動メモ（.txt/.md）をこのフォルダに置くと、次回実行時に取り込みます。');
  }

  console.log(`案件票・要員提案の${apply ? '取込' : 'プレビュー'}を開始します`);
  if (!apply) {
    console.log('※ --apply を付けずに実行するとプレビューのみです。Notionへの書き込みは行われません。\n');
  }

  const [gmailSources, existingProjects, existingMembers] = await Promise.all([
    collectGmailSources(),
    fetchProjects(),
    fetchMembers(),
  ]);
  const folderSources = collectFolderSources(inboxDir);
  const allSources = [...gmailSources, ...folderSources];

  const importedTags = collectImportedTags(existingProjects, existingMembers);
  const projectNamesSeen = existingProjects.map((p) => p.name);
  const memberNamesSeen = existingMembers.map((m) => m.name);

  let sourcesAlreadyImported = 0;
  let sourcesOther = 0;
  let sourcesFailed = 0;
  let sourcesProcessed = 0;
  const totals: ProcessCounters = { projectsNew: 0, projectsSkipped: 0, membersNew: 0, membersSkipped: 0 };
  const processedDir = join(inboxDir, '_imported');

  for (const source of allSources) {
    if (importedTags.has(source.sourceTag)) {
      sourcesAlreadyImported++;
      continue;
    }

    const result = await processSource(source, apply, projectNamesSeen, memberNamesSeen);
    if (!result.ok) {
      sourcesFailed++;
      continue;
    }
    if (result.kind === 'other') {
      sourcesOther++;
      continue;
    }

    sourcesProcessed++;
    totals.projectsNew += result.counters.projectsNew;
    totals.projectsSkipped += result.counters.projectsSkipped;
    totals.membersNew += result.counters.membersNew;
    totals.membersSkipped += result.counters.membersSkipped;
    console.log(
      `  検出: 案件${result.counters.projectsNew}件・要員${result.counters.membersNew}件` +
        `（スキップ${result.counters.projectsSkipped + result.counters.membersSkipped}件）`,
    );

    if (apply && source.filePath) {
      try {
        if (!existsSync(processedDir)) mkdirSync(processedDir, { recursive: true });
        renameSync(source.filePath, join(processedDir, source.label));
      } catch (err) {
        console.warn(`  ${source.label} の退避に失敗（再実行で重複登録の可能性あり）: ${String(err)}`);
      }
    }
  }

  console.log('\n=== 取込サマリ ===');
  console.log(`検出ソース: ${allSources.length}件（Gmail${gmailSources.length}件 / フォルダ${folderSources.length}件）`);
  console.log(`既取込のためスキップ: ${sourcesAlreadyImported}件`);
  console.log(`案件・要員情報なし: ${sourcesOther}件`);
  if (sourcesFailed > 0) console.log(`抽出失敗: ${sourcesFailed}件`);
  console.log(`処理対象: ${sourcesProcessed}件`);
  console.log(`案件: 新規${totals.projectsNew}件 / 類似のためスキップ${totals.projectsSkipped}件`);
  console.log(`要員: 新規${totals.membersNew}件 / 類似のためスキップ${totals.membersSkipped}件`);

  if (apply) {
    console.log(
      '\nNotionで「ドラフト」の内容を確認し、案件は「募集中」、要員は「稼働中/待機」へ変更してください。' +
        'その後 npm run match でマッチングできます。',
    );
  } else {
    console.log('\n--apply を付けると登録します（例: npm run leads -- --apply）。');
  }
}

main().catch((err) => {
  console.error(`案件票取込処理でエラーが発生しました: ${String(err)}`);
  process.exitCode = 1;
});
