// 案件の「地方不可」は、首都圏（1都3県）に住んでいない人は不可という意味で使われる。本文・備考・勤務地・商流メモから読む
import type { Project } from '../types/index.js';

export const METRO_PREFECTURES = ['東京都', '神奈川県', '埼玉県', '千葉県'];

// 「地方可」「地方在住可」「地方の方も歓迎」には一致しない
const METRO_ONLY = /地方(?:在住)?(?:の方)?(?:不可|NG)|首都圏在住|都内在住|[1一]都[3三]県在住/;

// 関東は1都6県なので、群馬・茨城・栃木の人は「関東圏内」では外さない
export const KANTO_PREFECTURES = ['東京都', '神奈川県', '埼玉県', '千葉県', '茨城県', '栃木県', '群馬県'];

// 「関東圏内」「関東在住」「関東圏在住の方のみ」。「【関東】」「関東出社可能」「関東以外も可」には一致しない
const KANTO_ONLY = /関東(?:圏内在住|圏内|圏在住|在住|(?:圏)?(?:在住)?の方のみ)/;

export function requiresMetroResidence(text: string): boolean {
  return METRO_ONLY.test(text.normalize('NFKC'));
}

export function projectRequiresMetroResidence(p: Pick<Project, 'title' | 'location' | 'businessFlow' | 'detail'>): boolean {
  return requiresMetroResidence([p.title, p.location, p.businessFlow, p.detail ?? ''].join('\n'));
}

// 住まいの都道府県が分からない人は通す（営業リストで人が見る）
export function livesOutsideMetro(prefecture: string | null): boolean {
  return prefecture !== null && !METRO_PREFECTURES.includes(prefecture);
}

export function requiresKantoResidence(text: string): boolean {
  return KANTO_ONLY.test(text.normalize('NFKC'));
}

export function projectRequiresKantoResidence(p: Pick<Project, 'title' | 'location' | 'businessFlow' | 'detail'>): boolean {
  return requiresKantoResidence([p.title, p.location, p.businessFlow, p.detail ?? ''].join('\n'));
}

export function livesOutsideKanto(prefecture: string | null): boolean {
  return prefecture !== null && !KANTO_PREFECTURES.includes(prefecture);
}

export function excludedByResidence(prefecture: string | null, p: Pick<Project, 'title' | 'location' | 'businessFlow' | 'detail'>): boolean {
  return (livesOutsideMetro(prefecture) && projectRequiresMetroResidence(p)) || (livesOutsideKanto(prefecture) && projectRequiresKantoResidence(p));
}
