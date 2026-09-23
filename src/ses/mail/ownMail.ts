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
const OWN_SUBJECT_PREFIXES = ['SES案件・要員マッチング', 'SES自己修復'];

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
export function parseAddressList(header: string): ParsedAddress[] {
  return addressparser(header ?? '', { flatten: true })
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
  // 転送・返信された形でも、バッチの送ったサマリ・修復レポートは取り込まない
  const base = baseSubject(subject);
  if (OWN_SUBJECT_PREFIXES.some((p) => base.startsWith(p))) return 'report';
  const domain = addr.includes('@') ? addr.slice(addr.lastIndexOf('@') + 1) : '';
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
