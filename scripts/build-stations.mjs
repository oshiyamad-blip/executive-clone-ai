// 駅の表（src/ses/data/stations.json）を作り直すスクリプト。
//   node scripts/build-stations.mjs [作業フォルダ]
// 作業フォルダ（既定: os.tmpdir()/stations-build）にダウンロードと展開をする。コミットするのは出力の stations.json だけ（境界データは入れない）。
//
// 元データ（国土交通省 国土数値情報ダウンロードサイト。利用条件は PDL1.0 / 鉄道データ N02 は CC BY 4.0）
//   駅    : 鉄道データ N02-24 の Station（UTF-8 の GeoJSON）
//   境界  : 行政区域データ N03-20240101（Shapefile。駅の緯度経度から都道府県を判定するときだけ使う）
// 出典の書き方は docs/ses-trial-runbook.md を参照。
// 出力: { "<駅名（「駅」なし・NFKC）>": [{ pref, lat, lon }, ...] }。同名の駅は全部持つ。路線・事業者名は持たない。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const N02_URL = 'https://nlftp.mlit.go.jp/ksj/gml/data/N02/N02-24/N02-24_GML.zip';
const N03_URL = 'https://nlftp.mlit.go.jp/ksj/gml/data/N03/N03-2024/N03-20240101_GML.zip';
const work = process.argv[2] ?? join(tmpdir(), 'stations-build');
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ses', 'data', 'stations.json');

async function download(url, dest) {
  if (existsSync(dest)) return;
  console.log(`ダウンロード: ${url}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`ダウンロード失敗 ${res.status} ${url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

function unzip(zip, dir, ...members) {
  mkdirSync(dir, { recursive: true });
  execFileSync('unzip', ['-o', '-q', zip, ...members, '-d', dir], { stdio: 'inherit' });
}

// --- Shapefile（ポリゴン）と dbf の最小の読み取り ---
function readDbfField(buf, name) {
  const nRec = buf.readUInt32LE(4);
  const headLen = buf.readUInt16LE(8);
  const recLen = buf.readUInt16LE(10);
  let off = 1;
  let target = null;
  for (let p = 32; buf[p] !== 0x0d; p += 32) {
    const fname = buf.toString('latin1', p, p + 11).replace(/\0.*$/, '');
    const len = buf[p + 16];
    if (fname === name) target = { off, len };
    off += len;
  }
  if (!target) throw new Error(`dbf に ${name} が無い`);
  const vals = [];
  for (let i = 0; i < nRec; i++) {
    const s = headLen + i * recLen + target.off;
    vals.push(buf.toString('utf8', s, s + target.len).trim());
  }
  return vals;
}

function readPolygons(buf) {
  const recs = [];
  let p = 100;
  while (p + 8 <= buf.length) {
    const len = buf.readInt32BE(p + 4) * 2;
    const c = p + 8;
    if (buf.readInt32LE(c) === 5) {
      const bbox = [buf.readDoubleLE(c + 4), buf.readDoubleLE(c + 12), buf.readDoubleLE(c + 20), buf.readDoubleLE(c + 28)];
      const nParts = buf.readInt32LE(c + 36);
      const nPts = buf.readInt32LE(c + 40);
      const partsOff = c + 44;
      const ptsOff = partsOff + nParts * 4;
      const parts = [];
      for (let i = 0; i < nParts; i++) parts.push(buf.readInt32LE(partsOff + i * 4));
      parts.push(nPts);
      recs.push({ bbox, parts, ptsOff, buf });
    } else recs.push(null);
    p += 8 + len;
  }
  return recs;
}

function inside(rec, x, y) {
  const [minx, miny, maxx, maxy] = rec.bbox;
  if (x < minx || x > maxx || y < miny || y > maxy) return false;
  let ins = false;
  for (let k = 0; k + 1 < rec.parts.length; k++) {
    const a = rec.parts[k];
    const b = rec.parts[k + 1];
    for (let i = a, j = b - 1; i < b; j = i++) {
      const xi = rec.buf.readDoubleLE(rec.ptsOff + i * 16);
      const yi = rec.buf.readDoubleLE(rec.ptsOff + i * 16 + 8);
      const xj = rec.buf.readDoubleLE(rec.ptsOff + j * 16);
      const yj = rec.buf.readDoubleLE(rec.ptsOff + j * 16 + 8);
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ins = !ins;
    }
  }
  return ins;
}

// 海上・桟橋などで境界の外に出た点は、近い頂点を持つポリゴンの県に寄せる
function nearestPref(recs, prefs, x, y) {
  let best = Infinity;
  let pref = null;
  for (let r = 0; r < recs.length; r++) {
    const rec = recs[r];
    if (!rec) continue;
    const [minx, miny, maxx, maxy] = rec.bbox;
    if (x < minx - 0.1 || x > maxx + 0.1 || y < miny - 0.1 || y > maxy + 0.1) continue;
    const n = rec.parts[rec.parts.length - 1];
    for (let i = 0; i < n; i++) {
      const dx = rec.buf.readDoubleLE(rec.ptsOff + i * 16) - x;
      const dy = rec.buf.readDoubleLE(rec.ptsOff + i * 16 + 8) - y;
      const d = dx * dx + dy * dy;
      if (d < best) {
        best = d;
        pref = prefs[r];
      }
    }
  }
  return best < 0.05 * 0.05 ? pref : null;
}

function normalizeName(raw) {
  // 路面電車の停留場は「中町(西町北)」のように別名がかっこで付くので、かっこは外す
  return raw.normalize('NFKC').replace(/\s+/g, '').replace(/[(（].*$/, '').replace(/駅$/, '');
}

function distKm(a, b) {
  const R = 6371;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function main() {
  mkdirSync(work, { recursive: true });
  const n02zip = join(work, 'N02-24_GML.zip');
  const n03zip = join(work, 'N03-20240101_GML.zip');
  await download(N02_URL, n02zip);
  await download(N03_URL, n03zip);
  unzip(n02zip, join(work, 'n02'), 'UTF-8/N02-24_Station.geojson');
  unzip(n03zip, join(work, 'n03'), 'N03-20240101.shp', 'N03-20240101.dbf');

  // 駅: 同じ駅グループ（N02_005g。事業者違いの同一駅）ごとに中心を1点にする
  const gj = JSON.parse(readFileSync(join(work, 'n02', 'UTF-8', 'N02-24_Station.geojson'), 'utf8'));
  const groups = new Map();
  for (const f of gj.features) {
    const name = normalizeName(f.properties.N02_005 ?? '');
    if (!name) continue;
    const coords = f.geometry.type === 'LineString' ? f.geometry.coordinates : f.geometry.coordinates.flat();
    const lon = coords.reduce((s, c) => s + c[0], 0) / coords.length;
    const lat = coords.reduce((s, c) => s + c[1], 0) / coords.length;
    const key = `${name}|${f.properties.N02_005g ?? f.properties.N02_005c}`;
    const g = groups.get(key) ?? { name, lons: [], lats: [] };
    g.lons.push(lon);
    g.lats.push(lat);
    groups.set(key, g);
  }
  const points = [...groups.values()].map((g) => ({
    name: g.name,
    lon: g.lons.reduce((a, b) => a + b, 0) / g.lons.length,
    lat: g.lats.reduce((a, b) => a + b, 0) / g.lats.length,
  }));
  console.log(`駅グループ: ${points.length}`);

  // 都道府県の判定
  const shp = readFileSync(join(work, 'n03', 'N03-20240101.shp'));
  const prefs = readDbfField(readFileSync(join(work, 'n03', 'N03-20240101.dbf')), 'N03_001');
  const recs = readPolygons(shp);
  if (recs.length !== prefs.length) throw new Error(`shp と dbf の件数が違う ${recs.length} / ${prefs.length}`);
  let fallback = 0;
  let unknown = 0;
  const table = {};
  for (const pt of points) {
    let pref = null;
    for (let r = 0; r < recs.length; r++) {
      if (recs[r] && inside(recs[r], pt.lon, pt.lat)) {
        pref = prefs[r];
        break;
      }
    }
    if (!pref) {
      pref = nearestPref(recs, prefs, pt.lon, pt.lat);
      if (pref) fallback++;
    }
    if (!pref) {
      unknown++;
      continue;
    }
    const entry = { pref, lat: Math.round(pt.lat * 1e4) / 1e4, lon: Math.round(pt.lon * 1e4) / 1e4 };
    const list = (table[pt.name] ??= []);
    // 別の事業者・別グループでも同じ県の 1.5km 以内にある同名の駅は同じ駅として畳む
    if (!list.some((e) => e.pref === pref && distKm(e, entry) < 1.5)) list.push(entry);
  }
  const names = Object.keys(table).sort();
  const sorted = {};
  for (const n of names) sorted[n] = table[n];
  writeFileSync(out, JSON.stringify(sorted) + '\n');
  const total = names.reduce((s, n) => s + sorted[n].length, 0);
  console.log(`出力: ${out}（駅名 ${names.length}・候補 ${total}・境界外から寄せた ${fallback}・県不明で除外 ${unknown}）`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
