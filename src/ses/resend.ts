// 再送スキップ（抽出の前に弾いてAPI費用を節約する）。
// パートナーによっては同じ案件・要員を毎日のように送り直してくるため、本文の「指紋」を取り、
// 同じ送信元ドメインが直近に送った内容とほぼ同じなら Haiku の抽出を呼ばずに処理済み（再送スキップ）にする。
// 抽出後の名寄せ（store.ts withoutResent*）でも二重登録は防げるが、それでは抽出の費用が毎回かかる。
// 指紋はハッシュ値だけで本文は保存しない（元の文面に戻せない）。
// 単価などの数字は残すので、条件を変えた再送は別の内容として抽出し直す。添付が違う（スキルシートの差し替え）、
// 項目の見出し（【要員2】・氏名: 等）が増えた一覧も抽出し直す
import { createHash } from 'crypto';
import { addressOf, domainOfAddress } from './mail/ownMail.js';
import type { SesRawMail } from '../types/index.js';

const SIG_SIZE = 128;
const SHINGLE = 5;
const VERSION = 'v1';

export interface MailFingerprint {
  exact: string; // 正規化した件名＋本文＋添付の SHA-256（先頭16桁）
  domain: string; // 送信元ドメインのハッシュ（先頭8桁）
  attachments: string; // 添付の中身のハッシュ（なければ空）
  markers: number; // 項目の見出しらしき行の数（一覧に1件足した再送を見分ける）
  numbers: string; // 本文の数字（単価・年齢・年数・年のない日付）の並びのハッシュ。長いメールで単価だけ変えた再送を見分ける
  sig: number[]; // MinHash（文字5-gram）
}

export interface FingerprintRecord {
  mailId: string;
  rootMailId: string; // 最初に抽出したメール（再送の再送でも元をたどれる）
  at: Date;
  fp: MailFingerprint;
}

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

// 件名の付け足し（Re:/Fw:/【再送】【本日】等の角括弧タグ・日付）を除く
export function normalizeSubject(subject: string): string {
  let s = subject.normalize('NFKC').toLowerCase();
  for (let i = 0; i < 5; i++) s = s.replace(/^\s*(re|fw|fwd|転送|返信)\s*[:：]\s*/, '');
  return s
    .replace(/[【\[［(（][^】\]］)）]{0,12}[】\]］)）]/g, ' ')
    .replace(/\d{4}[/年.-]\d{1,2}[/月.-]\d{1,2}日?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 本文の正規化: 引用・転送元・配信日時の行・年つき日付・時刻・曜日・URL・区切り線・余分な空白を除く。
// 単価・年数などの数字と、年のない日付（稼働開始日など条件そのもの）は残す
export function normalizeBody(body: string): string {
  const lines: string[] = [];
  for (const raw of body.normalize('NFKC').split(/\r?\n/)) {
    const line = raw.trim();
    if (/^-{2,}\s*(original message|forwarded message|元のメッセージ|転送されたメッセージ)/i.test(line)) break;
    if (/^(>|＞)/.test(line)) continue;
    if (/(wrote|書きました)[:：]\s*$/i.test(line)) break;
    if (/^(配信日|送信日時|配信日時|date|sent|送信日)\s*[:：]/i.test(line)) continue;
    lines.push(line);
  }
  return lines
    .join('\n')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\d{4}[/年.-]\d{1,2}[/月.-]\d{1,2}日?/g, ' ')
    .replace(/\d{1,2}:\d{2}(:\d{2})?/g, ' ')
    .replace(/[(（][月火水木金土日][)）]/g, ' ')
    .replace(/[-=_*~━─＝＿]{3,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 項目の見出しらしき行（「【要員1】」「No.2」「氏名：」「案件名：」等）の数
export function countItemMarkers(body: string): number {
  let n = 0;
  for (const raw of body.normalize('NFKC').split(/\r?\n/)) {
    const line = raw.trim();
    if (/^(>|＞)/.test(line)) continue;
    if (
      /^[\s【\[■◆●◇□▼▽★☆<]*(要員|案件|人材|技術者|エンジニア)\s*[0-9①-⑳]/.test(line) ||
      /^[\s【\[■◆●◇□▼▽★☆<]*(no|№)\s*\.?\s*\d/i.test(line) ||
      /^[\s【\[■◆●◇□▼▽★☆<]*(氏名|名前|イニシャル|案件名)\s*[】\]]?\s*[:：】]/.test(line)
    ) {
      n += 1;
    }
  }
  return n;
}

function fnv1a(s: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function minhash(text: string): number[] {
  const sig = new Array<number>(SIG_SIZE).fill(0xffffffff);
  const shingles = new Set<string>();
  if (text.length <= SHINGLE) shingles.add(text);
  for (let i = 0; i + SHINGLE <= text.length; i++) shingles.add(text.slice(i, i + SHINGLE));
  for (const sh of shingles) {
    const base = fnv1a(sh, 0);
    const base2 = fnv1a(sh, 0x9e3779b9);
    for (let k = 0; k < SIG_SIZE; k++) {
      const h = (base + Math.imul(k + 1, base2)) >>> 0;
      if (h < sig[k]) sig[k] = h;
    }
  }
  return sig;
}

export function estimatedSimilarity(a: number[], b: number[]): number {
  if (a.length !== SIG_SIZE || b.length !== SIG_SIZE) return 0;
  let same = 0;
  for (let k = 0; k < SIG_SIZE; k++) if (a[k] === b[k]) same += 1;
  return same / SIG_SIZE;
}

// 送り主のドメイン。表示名の中の "@partner.jp" に惑わされないよう、アドレスヘッダとして解釈したアドレスから取る
function senderDomain(from: string): string {
  const domain = domainOfAddress(addressOf(from));
  return (domain || from.toLowerCase()).replace(/\.$/, '');
}

export function fingerprintOf(mail: SesRawMail): MailFingerprint {
  const body = normalizeBody(mail.body);
  const text = `${normalizeSubject(mail.subject)}\n${body}`;
  const attachments = mail.attachments.length
    ? sha(mail.attachments.map((a) => sha(Buffer.from(a.data ?? '', 'base64'))).sort().join(',')).slice(0, 16)
    : '';
  const links = [...mail.sheetLinks].sort().join(',');
  return {
    exact: sha(`${text}\n${attachments}\n${links}`).slice(0, 16),
    domain: sha(senderDomain(mail.from)).slice(0, 8),
    attachments: links ? sha(`${attachments}|${links}`).slice(0, 16) : attachments,
    markers: countItemMarkers(mail.body),
    numbers: sha((body.match(/\d+(?:\.\d+)?/g) ?? []).join(',')).slice(0, 12),
    sig: minhash(text),
  };
}

// 保存用の1セル文字列（v1|exact|domain|attachments|markers|numbers|sig(base64)）
export function serializeFingerprint(fp: MailFingerprint): string {
  const buf = Buffer.alloc(SIG_SIZE * 4);
  fp.sig.forEach((v, i) => buf.writeUInt32BE(v >>> 0, i * 4));
  return [VERSION, fp.exact, fp.domain, fp.attachments, String(fp.markers), fp.numbers, buf.toString('base64')].join('|');
}

export function parseFingerprint(raw: string): MailFingerprint | null {
  const parts = raw.split('|');
  if (parts.length !== 7 || parts[0] !== VERSION) return null;
  const buf = Buffer.from(parts[6], 'base64');
  if (buf.length !== SIG_SIZE * 4) return null;
  const sig = Array.from({ length: SIG_SIZE }, (_, i) => buf.readUInt32BE(i * 4));
  const markers = Number(parts[4]);
  return { exact: parts[1], domain: parts[2], attachments: parts[3], markers: Number.isFinite(markers) ? markers : 0, numbers: parts[5], sig };
}

// 直近の記録のうち、同じ送信元ドメインから届いた同じ内容（完全一致、または近さ threshold 以上で添付・本文の数字が同じ・
// 見出しが増えていない）のものを返す。無ければ null
export function findResend(
  fp: MailFingerprint,
  records: FingerprintRecord[],
  opts: { since: Date; threshold: number },
): FingerprintRecord | null {
  let best: { rec: FingerprintRecord; sim: number } | null = null;
  for (const rec of records) {
    if (rec.at.getTime() < opts.since.getTime() || rec.fp.domain !== fp.domain) continue;
    if (rec.fp.exact === fp.exact) return rec;
    if (rec.fp.attachments !== fp.attachments || rec.fp.numbers !== fp.numbers || fp.markers > rec.fp.markers) continue;
    const sim = estimatedSimilarity(fp.sig, rec.fp.sig);
    if (sim >= opts.threshold && (!best || sim > best.sim)) best = { rec, sim };
  }
  return best?.rec ?? null;
}

export interface ResendSplit {
  fresh: SesRawMail[];
  skipped: Array<{ mail: SesRawMail; rootMailId: string }>;
  fingerprints: Map<string, { fp: MailFingerprint; rootMailId: string }>; // 抽出するメール・スキップしたメールの両方
}

// 今回のメールのうち、保存済みの記録（抽出済み・再送スキップ済み）の再送を分ける。
// 同じ回に届いた同士は比べない（先のメールの抽出・保存が失敗すると、再送側も処理済みになって取りこぼすため。
// その場合は抽出後の名寄せで二重登録を防ぐ）
export function splitResends(
  mails: SesRawMail[],
  records: FingerprintRecord[],
  opts: { since: Date; threshold: number },
): ResendSplit {
  const fresh: SesRawMail[] = [];
  const skipped: ResendSplit['skipped'] = [];
  const fingerprints: ResendSplit['fingerprints'] = new Map();
  for (const mail of mails) {
    const fp = fingerprintOf(mail);
    const hit = findResend(fp, records, opts);
    const rootMailId = hit ? hit.rootMailId : mail.id;
    fingerprints.set(mail.id, { fp, rootMailId });
    if (hit) skipped.push({ mail, rootMailId });
    else fresh.push(mail);
  }
  return { fresh, skipped, fingerprints };
}
