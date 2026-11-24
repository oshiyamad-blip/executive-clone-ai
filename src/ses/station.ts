// 駅の表（src/ses/data/stations.json）から、文に書かれた駅名の位置（都道府県・緯度経度）を引く。
// 表の作り方・出典は scripts/build-stations.mjs と docs/ses-trial-runbook.md。このファイルは他の ses のモジュールを読み込まない
// （prefecture.ts から呼ばれるため）。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface StationPoint {
  pref: string;
  lat: number;
  lon: number;
}

export type StationTable = Record<string, StationPoint[]>;

let table: StationTable | null = null;

// 表は実行時に1度だけ読む（tsc の出力先 dist からでも src の表を探す）。読めなければ空の表（駅の引きは何も返さない）
function loadTable(): StationTable {
  if (table) return table;
  for (const rel of ['./data/stations.json', '../../src/ses/data/stations.json']) {
    try {
      table = JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')) as StationTable;
      return table;
    } catch {
      // 次の場所を試す
    }
  }
  table = {};
  return table;
}

let prefNames: string[] | null = null;
function prefectureNames(): string[] {
  if (!prefNames) prefNames = [...new Set(Object.values(loadTable()).flatMap((l) => l.map((p) => p.pref)))];
  return prefNames;
}

// 文に明示された都道府県（「愛知県」「東京都」、かっこ書きの「（愛知）」）。駅名・市区名からの推定はしない
export function explicitPrefectureOf(text: string): string | null {
  const t = text.normalize('NFKC');
  let best: { pref: string; at: number } | null = null;
  for (const p of prefectureNames()) {
    const at = t.indexOf(p);
    if (at >= 0 && (!best || at < best.at)) best = { pref: p, at };
  }
  if (best) return best.pref;
  // 「（愛知）」「(神奈川)」のように、かっこの中が県名の語幹だけのもの
  for (const m of t.matchAll(/[（(]\s*([^（）()\s]{2,4})\s*[）)]/g)) {
    const hit = prefectureNames().find((p) => p.slice(0, -1) === m[1] && p !== '北海道');
    if (hit) return hit;
  }
  return null;
}

const DELIMS = '\\s()（）【】「」『』［］\\[\\]・、,，/／:：〜~|｜';
const STATION_TOKEN = new RegExp(`[^${DELIMS}]+?駅`, 'g');
// 先頭の地名のあとに付く語（勤務の形・周辺を表す語）
const NOISE_WORDS = /(?:フル|完全|一部)?(?:常駐|リモート|出社|在宅|テレワーク|勤務|勤務地|対応|相談|可能|可|あり|なし|有り|無し)/g;
const AREA_TAIL = /(?:周辺|付近|近辺|エリア|方面|近郊|最寄り?|徒歩.*|バス.*)$/;

function nameVariants(token: string): string[] {
  const out = [token];
  const prefHead = token.match(/^(?:北海道|[^\s]{2,3}?[都府県])(.+)$/);
  if (prefHead) out.push(prefHead[1]);
  for (const t of [...out]) {
    // 路線名が前に付くもの（「小田急線伊勢原」「JR山手線品川」）。表の駅名に一致する形を優先するため、元の語を先に試す
    const route = t.match(/^.*?(?:線|ライン|Line)(.+)$/);
    if (route) out.push(route[1]);
  }
  return out;
}

export interface StationLookup {
  name: string; // 表の駅名
  points: StationPoint[]; // 同名の駅の候補（明示の県で絞った後）
  explicitPref: string | null;
}

function lookupName(token: string, t: StationTable, minLen: number): { name: string; points: StationPoint[] } | null {
  for (const v of nameVariants(token)) {
    const name = v.replace(/駅$/, '');
    if (name.length >= minLen && t[name]) return { name, points: t[name] };
  }
  return null;
}

// 文から駅を取り出す。「○○駅」があればそれ、無ければ文の先頭の地名（かっこ・路線名・勤務形態の語を除く）。表に無ければ null
export function findStation(text: string): StationLookup | null {
  const t = loadTable();
  const s = (text ?? '').normalize('NFKC');
  if (!s.trim()) return null;
  const explicitPref = explicitPrefectureOf(s);
  let found: { name: string; points: StationPoint[] } | null = null;
  for (const m of s.matchAll(STATION_TOKEN)) {
    found = lookupName(m[0], t, 1);
    if (found) break;
  }
  if (!found) {
    const head = s.replace(/[（(][^（）()]*[）)]/g, ' ');
    const tokens = head.split(new RegExp(`[${DELIMS}]+`)).filter(Boolean).slice(0, 3);
    for (const tok of tokens) {
      const cleaned = tok.replace(NOISE_WORDS, '').replace(AREA_TAIL, '');
      if (cleaned.length < 2) continue;
      found = lookupName(cleaned, t, 2);
      if (found) break;
    }
  }
  if (!found) return null;
  const narrowed = explicitPref ? found.points.filter((p) => p.pref === explicitPref) : [];
  return { name: found.name, points: narrowed.length > 0 ? narrowed : found.points, explicitPref: narrowed.length > 0 ? explicitPref : null };
}

export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

const KANTO = ['東京都', '神奈川県', '埼玉県', '千葉県', '茨城県', '栃木県', '群馬県'];

// 相手の位置が無いときに使う候補: 関東を優先し、無ければ表の先頭
function defaultPoint(points: StationPoint[]): StationPoint {
  return points.find((p) => KANTO.includes(p.pref)) ?? points[0];
}

// 1つの文の位置。県が1つに決まる（明示の県・同名の駅が無い）ときはその点、複数あれば相手の位置に一番近い点（相手が無ければ関東優先）
export function locate(text: string, near?: { lat: number; lon: number } | null): StationPoint | null {
  const hit = findStation(text);
  if (!hit) return null;
  if (hit.points.length === 1 || !near) return defaultPoint(hit.points);
  return hit.points.reduce((best, p) => (distanceKm(p, near) < distanceKm(best, near) ? p : best));
}

// 2つの文の位置の組。同名の駅が複数ある側は、相手との距離が短くなる候補を選ぶ（誤って遠いと印を付けないため）
export function locatePair(a: string, b: string): { a: StationPoint; b: StationPoint } | null {
  const ha = findStation(a);
  const hb = findStation(b);
  if (!ha || !hb) return null;
  let best: { a: StationPoint; b: StationPoint; d: number } | null = null;
  for (const pa of ha.points) {
    for (const pb of hb.points) {
      const d = distanceKm(pa, pb);
      if (!best || d < best.d) best = { a: pa, b: pb, d };
    }
  }
  return best ? { a: best.a, b: best.b } : null;
}

// 都道府県を補う（prefecture.ts の辞書で読めないときだけ呼ぶ）。候補が1つの県に決まるときだけ返す
export function stationPrefecture(text: string): string | null {
  const hit = findStation(text);
  if (!hit) return null;
  const prefs = new Set(hit.points.map((p) => p.pref));
  return prefs.size === 1 ? hit.points[0].pref : null;
}

export function stationTableSize(): { names: number; stations: number } {
  const t = loadTable();
  return { names: Object.keys(t).length, stations: Object.values(t).reduce((s, l) => s + l.length, 0) };
}
