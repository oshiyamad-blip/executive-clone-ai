// 自分たちが出したメールの除外（自己ループ防止）。
// サマリ通知の宛先（SES_NOTIFY_TO）が収集元の共有メーリス（sales@）と同じだったり、営業が自分の紹介メールの
// Cc に共有メーリスを入れたりすると、次回の収集でそれを「案件・要員のメール」として取り込み直してしまう。
// 収集時に「このバッチ自身の送信元」「サマリ・修復レポートの件名」「自社ドメイン（SES_OWN_DOMAINS）」からの
// メールを除く。除外件数だけをログに出す（件名・アドレスは出さない）。
import addressparser from 'nodemailer/lib/addressparser/index.js';
import { mailProvider, xserverSharedUser, sesTargetGmail, ownDomains, collectOwnDomain } from '../config.js';
import type { SesRawMail } from '../../types/index.js';

// バッチが送るメールの件名（サマリ・修復レポート）。収集時の除外判定と送信側で同じ定数を使う
export const SUMMARY_SUBJECT = 'SES案件・要員マッチング バッチ実行結果';
export const REPAIR_REPORT_SUBJECT = 'SES自己修復: 修正パッチ案レポート';
// 件名だけでは除外しない（「SES案件・要員マッチング会のご案内」のような取引先のメールを落とさない）。
// サマリ・修復レポートの件名そのもの（サマリは「（HH:MM）」付き）で、送り主が自社（自分の送信元・自社ドメイン）のときだけ除く
const OWN_SUBJECTS = [SUMMARY_SUBJECT, REPAIR_REPORT_SUBJECT].map((x) => x.normalize('NFKC'));

function isOwnReportSubject(base: string): boolean {
  return OWN_SUBJECTS.some((x) => base === x || (base.startsWith(x) && /^\s*\(\d{1,2}:\d{2}\)$/.test(base.slice(x.length))));
}

export type OwnMailReason = 'self' | 'report' | 'ownDomain';

export interface OwnMailPolicy {
  selfAddresses: string[]; // このバッチ自身の送信元（小文字）
  ownDomains: string[]; // 自社ドメイン（小文字）
  collectOwnDomain: boolean;
}

export interface ParsedAddress {
  name: string; // 表示名（無ければ ''）
  address: string; // アドレス（小文字。比較・判定用）
  original: string; // アドレス（元の大文字小文字のまま。宛先の表記用）
}

// アドレスヘッダを RFC 5322 の解釈（nodemailer の addressparser。送信時に宛先を決めるのと同じ解釈）で分ける。
// 正規表現で "<...>" を探すと、引用符で囲んだ表示名の中の "<partner@example.jp>" を宛先と取り違えるため使わない。
// アドレスの無い要素（グループ名だけ等）は除く
// 解釈するアドレスヘッダの長さの上限。受信したヘッダ・シートの返信メタのどちらにも長さの上限が無いため、
// 何万字もの宛先で解釈（下書きごとに何度も呼ぶ）の時間を膨らませない。上限で切るときは最後の ',' までにする（途中で切れたアドレスを使わない）
export const ADDRESS_HEADER_MAX_CHARS = 20_000;

function capAddressHeader(header: string): string {
  if (header.length <= ADDRESS_HEADER_MAX_CHARS) return header;
  const cut = header.slice(0, ADDRESS_HEADER_MAX_CHARS);
  const comma = cut.lastIndexOf(',');
  return comma > 0 ? cut.slice(0, comma) : '';
}

export function parseAddressList(header: string): ParsedAddress[] {
  return addressparser(capAddressHeader(header ?? ''), { flatten: true })
    .map((a) => {
      const original = (a.address ?? '').trim();
      return { name: (a.name ?? '').replace(/[\r\n]+/g, ' ').trim(), address: original.toLowerCase(), original };
    })
    .filter((a) => a.address !== '');
}

// "表示名 <addr>" でも素のアドレスでも、先頭の宛先のアドレス部分だけを小文字で取り出す（無ければ ''）
export function addressOf(header: string): string {
  return parseAddressList(header)[0]?.address ?? '';
}

// フリーメール・携帯キャリアのドメイン（個人の営業・フリーランスが使うため、同じドメインでも同じ会社・同じ送り主とはみなさない）
const FREE_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.co.jp', 'ymail.ne.jp', 'yahoo.com', 'outlook.jp', 'outlook.com', 'hotmail.com',
  'hotmail.co.jp', 'live.jp', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'protonmail.com',
  'proton.me', 'zoho.com', 'docomo.ne.jp', 'ezweb.ne.jp', 'au.com', 'softbank.ne.jp', 'i.softbank.jp', 'nifty.com',
  'biglobe.ne.jp', 'so-net.ne.jp', 'ocn.ne.jp', 'plala.or.jp',
]);

export function isFreeMailDomain(domain: string): boolean {
  return FREE_MAIL_DOMAINS.has(domain.toLowerCase().replace(/\.$/, ''));
}

// mailparser が解釈したアドレス（{name, address} とグループ）を、表示名を引用符でエスケープしたヘッダの表記にする。
// mailparser の .text は表示名の '"' をエスケープせずに引用符で囲むため、encoded-word で '"' を含む表示名を送られると
// 解釈し直したときに1つの宛先が複数に割れる（見えない宛先を足される）。解釈済みの値から組み立て直して、宛先の数を変えない
export interface MailboxValue {
  name?: string;
  address?: string;
  group?: MailboxValue[];
}

// 1つのヘッダから組み立てる宛先の上限（件数・表示名の長さ）。送り主が何千件・何万字の宛先を並べても保存・解釈する量を抑える
export const MAILBOX_LIST_MAX = 100;
const MAILBOX_NAME_MAX_CHARS = 200;

export function formatMailboxes(values: MailboxValue[]): string {
  const out: string[] = [];
  const walk = (list: MailboxValue[], depth: number) => {
    for (const v of list) {
      if (out.length >= MAILBOX_LIST_MAX) return;
      if (v.group && depth < 3) {
        walk(v.group, depth + 1);
        continue;
      }
      const address = (v.address ?? '').replace(/[\s<>"]/g, '');
      if (!address || address.length > 254) continue;
      const name = (v.name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAILBOX_NAME_MAX_CHARS);
      out.push(name ? `"${name.replace(/[\\"]/g, '\\$&')}" <${address}>` : address);
    }
  };
  walk(values, 0);
  return out.join(', ');
}

// RFC 2047 の encoded-word（=?charset?B|Q?...?=）を1回だけ戻す（Gmail API のヘッダは戻さずに返るため、
// Xserver 経路の mailparser と同じく表示名を1回だけデコードする。2回目はしない＝二重に encode した表示名は '=?' が残り、紛らわしい表示名として扱う）
export function decodeEncodedWordsOnce(s: string): string {
  return (s ?? '').replace(/=\?([^?\s]{1,40})\?([bBqQ])\?([^?\s]{0,2000})\?=(?:\s+(?==\?))?/g, (m, charset: string, enc: string, text: string) => {
    try {
      const bytes =
        enc.toUpperCase() === 'B'
          ? Buffer.from(text, 'base64')
          : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9a-fA-F]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1');
      return new TextDecoder(charset.toLowerCase().replace(/\*.*$/, '')).decode(bytes);
    } catch {
      return m;
    }
  });
}

// 生のアドレスヘッダ（Gmail API）→ 表示名を1回デコードし、引用符をエスケープした表記（Xserver 経路と同じ形）
export function normalizeAddressHeader(raw: string): string {
  return formatMailboxes(
    addressparser(raw ?? '', { flatten: true }).map((a) => ({ name: decodeEncodedWordsOnce(a.name ?? ''), address: a.address ?? '' })),
  );
}

export function domainOfAddress(address: string): string {
  return address.includes('@') ? address.slice(address.lastIndexOf('@') + 1) : '';
}

// 返信・転送の接頭辞（Re: / Fwd: / 転送: 等）を除いた件名
function baseSubject(subject: string): string {
  let s = subject.normalize('NFKC').trim();
  for (;;) {
    const next = s.replace(/^(re|fw|fwd|転送|返信)\s*[:：]\s*/i, '');
    if (next === s) return s;
    s = next;
  }
}

// 除外すべき理由。収集対象なら null
export function ownMailReason(from: string, subject: string, policy: OwnMailPolicy): OwnMailReason | null {
  const addr = addressOf(from);
  if (addr && policy.selfAddresses.includes(addr)) return 'self';
  const domain = addr.includes('@') ? addr.slice(addr.lastIndexOf('@') + 1) : '';
  // 転送・返信された形でも、バッチの送ったサマリ・修復レポートは取り込まない（自社の人が転送したものだけ。
  // 社外の送り主のメールは件名が似ていても取り込む）
  const ownReportSenders = [...policy.ownDomains, ...policy.selfAddresses.map(domainOfAddress)];
  if (isOwnReportSubject(baseSubject(subject)) && domain && ownReportSenders.includes(domain)) return 'report';
  if (!policy.collectOwnDomain && domain && policy.ownDomains.includes(domain)) return 'ownDomain';
  return null;
}

// このバッチ自身が送信に使うアドレス（Xserverは共有メールボックスのユーザー、Gmailは SES_TARGET_GMAIL）
export function currentOwnMailPolicy(): OwnMailPolicy {
  const self = mailProvider() === 'gmail' ? sesTargetGmail() : xserverSharedUser();
  return {
    selfAddresses: [self].filter((a) => a.includes('@')).map((a) => a.toLowerCase()),
    ownDomains: ownDomains(),
    collectOwnDomain: collectOwnDomain(),
  };
}

export interface OwnMailSplit {
  kept: SesRawMail[];
  excluded: SesRawMail[];
  counts: Record<OwnMailReason, number>;
}

export function splitOwnMails(mails: SesRawMail[], policy: OwnMailPolicy = currentOwnMailPolicy()): OwnMailSplit {
  const counts: Record<OwnMailReason, number> = { self: 0, report: 0, ownDomain: 0 };
  const kept: SesRawMail[] = [];
  const excluded: SesRawMail[] = [];
  for (const m of mails) {
    const reason = ownMailReason(m.from, m.subject, policy);
    if (reason) {
      counts[reason] += 1;
      excluded.push(m);
    } else {
      kept.push(m);
    }
  }
  return { kept, excluded, counts };
}
