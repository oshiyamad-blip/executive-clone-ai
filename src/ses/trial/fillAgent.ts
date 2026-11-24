// 試運転の抽出が営業元（agentCompany・agentContact・agentEmail）を空のまま返したときの補い。
// 営業元メールは送信元から、会社・担当者は同じ回の材料の同じ送信元の別の案件から取る（会社だけは同じドメインでも可）。
import { addressOf, domainOfAddress, isFreeMailDomain } from '../mail/ownMail.js';

export interface AgentFields {
  agentCompany?: string;
  agentContact?: string;
  agentEmail?: string;
}

export interface AgentSource {
  from?: string;
  items: AgentFields[];
}

export interface AgentIndex {
  byAddress: Map<string, { company: string; contact: string }>;
  byDomain: Map<string, string>;
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export function buildAgentIndex(sources: AgentSource[]): AgentIndex {
  const byAddress = new Map<string, { company: string; contact: string }>();
  const byDomain = new Map<string, string>();
  for (const s of sources) {
    for (const it of s.items) {
      const addr = addressOf(text(it?.agentEmail)) || addressOf(s.from ?? '');
      const company = text(it?.agentCompany);
      const contact = text(it?.agentContact);
      if (!addr) continue;
      const cur = byAddress.get(addr) ?? { company: '', contact: '' };
      if (!cur.company && company) cur.company = company;
      if (!cur.contact && contact) cur.contact = contact;
      byAddress.set(addr, cur);
      const domain = domainOfAddress(addr);
      if (company && domain && !isFreeMailDomain(domain) && !byDomain.has(domain)) byDomain.set(domain, company);
    }
  }
  return { byAddress, byDomain };
}

// 値が入っている欄は変えない。from は行の送信元（「名前 <addr>」でも可）
export function fillAgent<T extends AgentFields>(target: T, from: string | undefined, index: AgentIndex): T {
  const email = text(target.agentEmail) || addressOf(from ?? '');
  const addr = addressOf(email);
  const same = addr ? index.byAddress.get(addr) : undefined;
  const domain = addr ? domainOfAddress(addr) : '';
  const company = text(target.agentCompany) || same?.company || (domain && !isFreeMailDomain(domain) ? index.byDomain.get(domain) : '') || '';
  const contact = text(target.agentContact) || same?.contact || '';
  return { ...target, agentEmail: text(target.agentEmail) || addressOf(from ?? ''), agentCompany: company, agentContact: contact };
}
