import type { DailyReport } from './types.js';

/**
 * レポートの中身を「見出し＋行」の並びに落とす。
 * コンソールとSlackで同じ内容を出すため、整形はここに一本化する。
 */

export interface Section {
  title: string;
  lines: string[];
}

const pct = (x: number, digits = 2): string => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(digits)}%`;
const usd = (x: number): string => `${x < 0 ? '-' : ''}$${Math.abs(x).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

export function renderSections(r: DailyReport): Section[] {
  const sections: Section[] = [];

  // 1. 一番上は「いくら勝ったか」ではなく、ベンチマークに対してどうだったか
  sections.push({
    title: `評価額 ${usd(r.equity)}（前日比 ${pct(r.dayChange)} / ${usd(r.dayChangeAmount)}）`,
    lines: [
      `当日 ${r.benchmark}比       ${pct(r.dayChange - r.benchDayChange)}   （${r.benchmark} ${pct(r.benchDayChange)}）`,
      `開始来            ${pct(r.sinceInception)}   （${r.benchmark} ${pct(r.benchSinceInception)}）`,
      `開始来の${r.benchmark}比    ${pct(r.sinceInception - r.benchSinceInception)}`,
      `最大ドローダウン  ${pct(r.maxDrawdown)}`,
    ],
  });

  // 2. 実力の検定。総リターンより先にこれを見るための配置
  const verdict =
    Math.abs(r.alphaTStat) < 2
      ? `t値2未満 → まだ運とルールの実力を区別できない（観測${r.observationDays}営業日）`
      : `t値2以上 → この期間に限れば偶然では説明しにくい`;
  sections.push({
    title: '実力の検定',
    lines: [
      `ベータ            ${r.beta.toFixed(2)}`,
      `年率アルファ      ${pct(r.alpha)}`,
      `アルファのt値     ${r.alphaTStat.toFixed(2)}`,
      verdict,
    ],
  });

  // 3. リスク上限。ここが赤なら他を読む前に止める判断
  if (r.riskLimit !== null) {
    const breached = r.dayChange <= -r.riskLimit;
    sections.push({
      title: breached ? '🛑 リスク上限に抵触' : 'リスク上限',
      lines: breached
        ? [
            `当日 ${pct(r.dayChange)} が停止ライン −${(r.riskLimit * 100).toFixed(1)}% を割りました。`,
            '新規建てを止めて内容を確認してください。',
          ]
        : [`当日 ${pct(r.dayChange)} / 停止ライン −${(r.riskLimit * 100).toFixed(1)}%`],
    });
  }

  // 4. 保有銘柄
  if (r.positions.length > 0) {
    const lines = r.positions.map((p) => {
      const flag =
        p.unrealizedPlpc <= -r.stopWarnAt ? '  ⚠損切り接近'
        : p.unrealizedPlpc >= r.targetWarnAt ? '  ◎利確接近'
        : '';
      return `${p.symbol.padEnd(6)} ${String(p.qty).padStart(5)}株  ` +
        `取得 $${p.avgEntryPrice.toFixed(2)} → $${p.currentPrice.toFixed(2)}  ` +
        `${pct(p.unrealizedPlpc)}（${usd(p.unrealizedPl)}）${flag}`;
    });
    sections.push({ title: `保有 ${r.positions.length}銘柄`, lines });
  } else {
    sections.push({ title: '保有銘柄なし', lines: ['現金のみ。'] });
  }

  // 5. 当日の約定
  sections.push({
    title: r.fills.length > 0 ? `当日の約定 ${r.fills.length}件` : '当日の約定なし',
    lines:
      r.fills.length > 0
        ? r.fills.map((f) =>
            `${f.side === 'buy' ? '買' : '売'} ${f.symbol.padEnd(6)} ${String(f.qty).padStart(5)}株 @ $${f.price.toFixed(2)}`,
          )
        : ['—'],
  });

  // 6. 配当
  if (r.dividends.length > 0) {
    const total = r.dividends.reduce((a, d) => a + d.netAmount, 0);
    sections.push({
      title: `配当入金 ${usd(total)}`,
      lines: r.dividends.map((d) => `${d.symbol.padEnd(6)} ${usd(d.netAmount)}  （1株 $${d.perShare.toFixed(4)}）`),
    });
  }

  if (r.notes.length > 0) sections.push({ title: '注記', lines: r.notes });

  return sections;
}

export function toConsole(r: DailyReport): string {
  const out: string[] = ['', '='.repeat(64), `  日次レポート  ${r.date}${r.demo ? '  ※デモ（実データではありません）' : ''}`, '='.repeat(64)];
  for (const s of renderSections(r)) {
    out.push('', `── ${s.title} ──`);
    for (const l of s.lines) out.push(`  ${l}`);
  }
  out.push('');
  return out.join('\n');
}

/** Slackのブロック。1ブロックあたり3000文字の上限があるため長い節は切り詰める */
export function toSlackBlocks(r: DailyReport): unknown[] {
  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${r.demo ? '【デモ】' : ''}日次レポート ${r.date}`, emoji: true },
    },
  ];
  for (const s of renderSections(r)) {
    const body = s.lines.join('\n').slice(0, 2800);
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*${s.title}*\n\`\`\`${body}\`\`\`` },
    });
  }
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: '総リターンではなくベンチマーク超過とt値で判断してください。' }],
  });
  return blocks;
}

export async function postToSlack(webhookUrl: string, r: DailyReport): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blocks: toSlackBlocks(r) }),
  });
  if (!res.ok) {
    throw new Error(`Slackへの投稿に失敗しました: HTTP ${res.status} ${await res.text().catch(() => '')}`);
  }
}
