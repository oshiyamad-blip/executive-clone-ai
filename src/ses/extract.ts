// 分類+抽出（1メール1コール）。本番=Haiku 4.5+構造化出力（PDFはdocumentブロック）、
// demo=fixture対応の決定的スタブ（LLM不使用）。1メール複数件対応（配列で返す）。
import { createHash } from 'crypto';
import { generateJson } from '../llm/index.js';
import { anthropicJsonWithDocuments } from '../llm/anthropic.js';
import { isDemo, extractModel } from './config.js';
import { normalizeSkills } from './skillDict.js';
import { normalizePrefecture } from './prefecture.js';
import { normalizeRate, type RateUnit } from './pricing.js';
import { EXPECTED_EXTRACTIONS } from './fixtures/expectedExtractions.js';
import type { SesRawMail, ExtractedItem, Project, Engineer, RemoteOption, ReplyTarget } from '../types/index.js';

const EXTRACT_SYSTEM = `あなたはSES（システムエンジニアリングサービス）業界の営業メールを解析する専門家です。
メール本文・添付ファイルのテキスト・PDFから、「案件情報」と「要員（エンジニア）情報」を抽出してください。

抽出のルール:
- 1通のメールに複数の案件・複数の要員が記載されている場合は、それぞれを配列の別要素として抽出してください
- 単金（金額）は原文の単位をそのまま rateUnit / desiredRateUnit で指定してください
  （万円/月表記は manYenPerMonth、円/時給表記は yenPerHour、円/月表記は yenPerMonth）
- 「スキル見合い」「応相談」など金額が読み取れない場合は rateMin/rateMax/desiredRate を null にし、
  rateUnit/desiredRateUnit は manYenPerMonth を設定してください（nullなら単位は無視されます）
- 開始時期・稼働可能日から具体的な日付が読み取れる場合はISO 8601形式（YYYY-MM-DD）で
  startDateIso / availableFromIso に設定し、読み取れなければ null にしてください
- リモート可否は full（フルリモート可）/ partial（一部リモート可）/ none（不可）/ unknown（不明）から選んでください
- 案件情報も要員情報も含まれないメール（雑談・事務連絡等）の場合は projects, engineers とも空配列にしてください
- 営業元の会社名・担当者名・メールアドレスは、記載があれば必ず抽出してください（紹介メールの宛先に使用します）`;

const RATE_UNIT_ENUM = ['manYenPerMonth', 'yenPerHour', 'yenPerMonth'] as const;
const REMOTE_ENUM = ['full', 'partial', 'none', 'unknown'] as const;

const PROJECT_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    requiredSkills: { type: 'array', items: { type: 'string' } },
    preferredSkills: { type: 'array', items: { type: 'string' } },
    rateMin: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    rateMax: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    rateUnit: { type: 'string', enum: [...RATE_UNIT_ENUM] },
    location: { type: 'string' },
    remote: { type: 'string', enum: [...REMOTE_ENUM] },
    startPeriod: { type: 'string' },
    startDateIso: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    duration: { type: 'string' },
    businessFlow: { type: 'string' },
    agentCompany: { type: 'string' },
    agentContact: { type: 'string' },
    agentEmail: { type: 'string' },
  },
  required: [
    'title',
    'requiredSkills',
    'preferredSkills',
    'rateMin',
    'rateMax',
    'rateUnit',
    'location',
    'remote',
    'startPeriod',
    'startDateIso',
    'duration',
    'businessFlow',
    'agentCompany',
    'agentContact',
    'agentEmail',
  ],
} as const;

const ENGINEER_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    displayName: { type: 'string' },
    age: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    skills: { type: 'array', items: { type: 'string' } },
    experienceYears: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    desiredRate: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    desiredRateUnit: { type: 'string', enum: [...RATE_UNIT_ENUM] },
    residence: { type: 'string' },
    nearestStation: { type: 'string' },
    availableDate: { type: 'string' },
    availableFromIso: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    utilization: { type: 'string' },
    remoteWish: { type: 'string', enum: [...REMOTE_ENUM] },
    agentCompany: { type: 'string' },
    agentContact: { type: 'string' },
    agentEmail: { type: 'string' },
  },
  required: [
    'displayName',
    'age',
    'skills',
    'experienceYears',
    'desiredRate',
    'desiredRateUnit',
    'residence',
    'nearestStation',
    'availableDate',
    'availableFromIso',
    'utilization',
    'remoteWish',
    'agentCompany',
    'agentContact',
    'agentEmail',
  ],
} as const;

const EXTRACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    projects: { type: 'array', items: PROJECT_ITEM_SCHEMA },
    engineers: { type: 'array', items: ENGINEER_ITEM_SCHEMA },
  },
  required: ['projects', 'engineers'],
} as const;

interface RawProject {
  title: string;
  requiredSkills: string[];
  preferredSkills: string[];
  rateMin: number | null;
  rateMax: number | null;
  rateUnit: RateUnit;
  location: string;
  remote: RemoteOption;
  startPeriod: string;
  startDateIso: string | null;
  duration: string;
  businessFlow: string;
  agentCompany: string;
  agentContact: string;
  agentEmail: string;
}

interface RawEngineer {
  displayName: string;
  age: number | null;
  skills: string[];
  experienceYears: number | null;
  desiredRate: number | null;
  desiredRateUnit: RateUnit;
  residence: string;
  nearestStation: string;
  availableDate: string;
  availableFromIso: string | null;
  utilization: string;
  remoteWish: RemoteOption;
  agentCompany: string;
  agentContact: string;
  agentEmail: string;
}

interface RawExtraction {
  projects: RawProject[];
  engineers: RawEngineer[];
}

export async function extractItems(mails: SesRawMail[]): Promise<ExtractedItem[]> {
  if (isDemo()) return extractItemsDemo(mails);

  const items: ExtractedItem[] = [];
  for (const mail of mails) {
    try {
      items.push(...(await extractFromMail(mail)));
    } catch (err) {
      console.error(`SES抽出: 抽出に失敗 (mail ${mail.id}): ${String(err)}`);
    }
  }
  const extractedCount = items.filter((i) => i.kind !== 'other').length;
  console.log(`SES抽出: ${mails.length}件のメールから案件・要員 計${extractedCount}件を抽出`);
  return items;
}

function extractItemsDemo(mails: SesRawMail[]): ExtractedItem[] {
  const items: ExtractedItem[] = [];
  for (const mail of mails) {
    items.push(...withReplyTarget(EXPECTED_EXTRACTIONS[mail.id] ?? [{ kind: 'other' as const }], mail));
  }
  return items;
}

// 元メールのヘッダから返信情報を作り、抽出された案件/要員に付与する（全員に返信の下書き用）。
function buildReplyTarget(mail: SesRawMail): ReplyTarget {
  return {
    from: mail.from,
    to: mail.to,
    cc: mail.cc,
    subject: mail.subject,
    messageId: mail.messageIdHeader,
    references: mail.references,
  };
}

function withReplyTarget(items: ExtractedItem[], mail: SesRawMail): ExtractedItem[] {
  const rt = buildReplyTarget(mail);
  return items.map((item) => {
    if (item.kind === 'project') return { kind: 'project', project: { ...item.project, replyTarget: rt } };
    if (item.kind === 'engineer') return { kind: 'engineer', engineer: { ...item.engineer, replyTarget: rt } };
    return item;
  });
}

async function extractFromMail(mail: SesRawMail): Promise<ExtractedItem[]> {
  const documents = mail.attachments
    .filter((a) => a.mimeType === 'application/pdf' && a.data)
    .map((a) => ({ mediaType: 'application/pdf' as const, dataBase64: a.data }));

  const attachmentText = mail.attachments
    .filter((a) => a.text)
    .map((a) => `【添付: ${a.filename}】\n${a.text}`)
    .join('\n\n');

  const user = `件名: ${mail.subject}\nFrom: ${mail.from}\n\n本文:\n${mail.body}\n\n${attachmentText}`.trim();

  const parsed =
    documents.length > 0
      ? ((await anthropicJsonWithDocuments(
          EXTRACT_SYSTEM,
          user,
          EXTRACT_SCHEMA,
          documents,
          4000,
          extractModel(),
        )) as RawExtraction)
      : await generateJson<RawExtraction>(EXTRACT_SYSTEM, user, EXTRACT_SCHEMA, {
          model: extractModel(),
          maxTokens: 4000,
        });

  const items: ExtractedItem[] = [
    ...parsed.projects.map((p) => ({ kind: 'project' as const, project: buildProject(p, mail) })),
    ...parsed.engineers.map((e) => ({ kind: 'engineer' as const, engineer: buildEngineer(e, mail) })),
  ];
  return withReplyTarget(items.length > 0 ? items : [{ kind: 'other' }], mail);
}

function hashId(prefix: string, parts: string[]): string {
  const digest = createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12);
  return `${prefix}_${digest}`;
}

function buildProject(raw: RawProject, mail: SesRawMail): Project {
  return {
    id: hashId('proj', [mail.id, raw.title, raw.agentEmail]),
    title: raw.title,
    requiredSkills: normalizeSkills(raw.requiredSkills),
    preferredSkills: normalizeSkills(raw.preferredSkills),
    rateMin: raw.rateMin === null ? null : normalizeRate(raw.rateMin, raw.rateUnit),
    rateMax: raw.rateMax === null ? null : normalizeRate(raw.rateMax, raw.rateUnit),
    location: raw.location,
    prefecture: normalizePrefecture(raw.location),
    remote: raw.remote,
    startPeriod: raw.startPeriod,
    startDate: raw.startDateIso,
    duration: raw.duration,
    businessFlow: raw.businessFlow,
    agentCompany: raw.agentCompany,
    agentContact: raw.agentContact,
    agentEmail: raw.agentEmail,
    sourceMailId: mail.id,
    receivedAt: mail.receivedAt,
    status: 'open',
  };
}

function buildEngineer(raw: RawEngineer, mail: SesRawMail): Engineer {
  return {
    id: hashId('eng', [mail.id, raw.displayName, raw.agentEmail]),
    displayName: raw.displayName,
    age: raw.age,
    skills: normalizeSkills(raw.skills),
    experienceYears: raw.experienceYears,
    desiredRate: raw.desiredRate === null ? null : normalizeRate(raw.desiredRate, raw.desiredRateUnit),
    residence: raw.residence,
    prefecture: normalizePrefecture(raw.residence),
    nearestStation: raw.nearestStation,
    availableDate: raw.availableDate,
    availableFrom: raw.availableFromIso,
    utilization: raw.utilization,
    remoteWish: raw.remoteWish,
    agentCompany: raw.agentCompany,
    agentContact: raw.agentContact,
    agentEmail: raw.agentEmail,
    sourceMailId: mail.id,
    receivedAt: mail.receivedAt,
    status: 'available',
  };
}
