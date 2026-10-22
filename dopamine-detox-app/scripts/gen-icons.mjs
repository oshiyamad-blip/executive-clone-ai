// PNG アイコンを生成する。画像ライブラリを足したくないので、zlib だけで PNG を書き出す。
// 図案: 黒地に白の 3/4 リング（タイマーの進捗）。アプリ本体と同じくモノクローム。
//
//   node scripts/gen-icons.mjs

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');

const INK = [0x16, 0x16, 0x1a];
const PAPER = [0xff, 0xff, 0xff];

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/** @param {Buffer} buf @returns {number} */
function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** @param {string} type @param {Buffer} data @returns {Buffer} */
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * RGBA 画素配列を PNG にする。
 * @param {number} width
 * @param {number} height
 * @param {Buffer} rgba
 * @returns {Buffer}
 */
function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // フィルタなし
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const TAU = Math.PI * 2;

/**
 * アイコンを描く。
 * @param {number} size
 * @param {Object} options
 * @param {boolean} options.fullBleed  角丸にせず全面を塗る（maskable / iOS 用）
 * @param {number} options.ringScale   リングの大きさ（size に対する比）
 * @returns {Buffer}
 */
function draw(size, { fullBleed, ringScale }) {
  const SS = 3; // 3x3 スーパーサンプリングで縁をなめらかにする
  const rgba = Buffer.alloc(size * size * 4);

  const cx = size / 2;
  const cy = size / 2;
  const corner = size * 0.22;
  const ringOuter = size * ringScale;
  const ringInner = ringOuter - size * 0.062;
  const start = -Math.PI / 2;
  const sweep = TAU * 0.75;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0; // 背景（黒地）の被覆率
      let fg = 0; // リング（白）の被覆率

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;

          if (fullBleed || insideRoundedRect(px, py, size, corner)) bg++;

          const dx = px - cx;
          const dy = py - cy;
          const dist = Math.hypot(dx, dy);
          if (dist <= ringOuter && dist >= ringInner) {
            const angle = (Math.atan2(dy, dx) - start + TAU) % TAU;
            if (angle <= sweep) fg++;
          }
        }
      }

      const total = SS * SS;
      const alpha = bg / total;
      const white = fg / total;
      const i = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) {
        rgba[i + c] = Math.round(INK[c] * (1 - white) + PAPER[c] * white);
      }
      rgba[i + 3] = Math.round(255 * Math.max(alpha, white));
    }
  }
  return encodePng(size, size, rgba);
}

/**
 * @param {number} px @param {number} py @param {number} size @param {number} r
 * @returns {boolean}
 */
function insideRoundedRect(px, py, size, r) {
  const x = Math.min(px, size - px);
  const y = Math.min(py, size - py);
  if (x >= r || y >= r) return px >= 0 && py >= 0 && px <= size && py <= size;
  return Math.hypot(r - x, r - y) <= r;
}

mkdirSync(OUT_DIR, { recursive: true });

const files = [
  { name: 'icon-192.png', buffer: draw(192, { fullBleed: false, ringScale: 0.33 }) },
  { name: 'icon-512.png', buffer: draw(512, { fullBleed: false, ringScale: 0.33 }) },
  { name: 'icon-maskable-512.png', buffer: draw(512, { fullBleed: true, ringScale: 0.26 }) },
  { name: 'icon-180.png', buffer: draw(180, { fullBleed: true, ringScale: 0.31 }) },
];

for (const { name, buffer } of files) {
  writeFileSync(join(OUT_DIR, name), buffer);
  console.log(`${name}  ${buffer.length.toLocaleString()} bytes`);
}
