import type { BacktestResult, Trade } from './types.js';
import { yearsToSignificance } from './metrics.js';

/**
 * バックテスト結果を1枚のHTMLにする。
 * ターミナルの出力は流れて消えるが、これは残せて他人に見せられる。
 *
 * 表示の優先順位は docs/stock-trading-automation-review.md の結論に合わせてある。
 * 総リターンを大きく出すのではなく、ベータ調整後アルファのt値を先に見せる。
 */

const pct = (x: number, d = 2): string => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`;
const pctPlain = (x: number, d = 2): string => `${(x * 100).toFixed(d)}%`;
const usd = (x: number): string =>
  `${x < 0 ? '-' : ''}$${Math.abs(x).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 点が多すぎるとSVGが重くなるので、等間隔に間引く（末尾は必ず残す） */
function downsample<T>(xs: T[], max: number): { values: T[]; indices: number[] } {
  if (xs.length <= max) return { values: xs, indices: xs.map((_, i) => i) };
  const step = (xs.length - 1) / (max - 1);
  const indices: number[] = [];
  for (let i = 0; i < max; i++) indices.push(Math.round(i * step));
  return { values: indices.map((i) => xs[i]!), indices };
}

function drawdownSeries(equity: number[]): number[] {
  let peak = equity[0] ?? 0;
  return equity.map((v) => {
    if (v > peak) peak = v;
    return peak > 0 ? v / peak - 1 : 0;
  });
}

function exitReasonSummary(trades: Trade[]): { label: string; count: number; avg: number }[] {
  const labels: Record<string, string> = {
    stop: '損切り（指値どおり）',
    stop_gap: '損切り（ギャップ約定）',
    target: '利確（指値どおり）',
    target_gap: '利確（ギャップ約定）',
    timeout: '時間切れ',
    eod: '期間終了',
  };
  const groups = new Map<string, Trade[]>();
  for (const t of trades) {
    const list = groups.get(t.reason) ?? [];
    list.push(t);
    groups.set(t.reason, list);
  }
  return [...groups.entries()]
    .map(([reason, ts]) => ({
      label: labels[reason] ?? reason,
      count: ts.length,
      avg: ts.reduce((a, t) => a + t.netReturn, 0) / ts.length,
    }))
    .sort((a, b) => b.count - a.count);
}

export function renderHtml(r: BacktestResult, opts: { synthetic?: boolean } = {}): string {
  const { metrics: m, benchmarkMetrics: b, config: cfg } = r;
  const allTrades = r.sleeves.flatMap((s) => s.trades);
  const stops = allTrades.filter((t) => t.reason === 'stop' || t.reason === 'stop_gap');
  const gapped = stops.filter((t) => t.reason === 'stop_gap');
  const significant = Math.abs(m.alphaTStat) >= 2;
  const needYears = yearsToSignificance(m.alpha, m.annualVol);

  const chart = downsample(r.dates, 600);
  const series = {
    dates: chart.values,
    port: chart.indices.map((i) => r.equity[i]!),
    bench: chart.indices.map((i) => r.benchmarkEquity[i]!),
    dd: chart.indices.map((i) => drawdownSeries(r.equity)[i]!),
  };

  const tiles = [
    { label: '総リターン', value: pct(m.totalReturn), sub: `${cfg.benchmark} ${pct(b.totalReturn)}` },
    { label: '年率（CAGR）', value: pct(m.cagr), sub: `${cfg.benchmark} ${pct(b.cagr)}` },
    { label: `年率の${cfg.benchmark}比`, value: pct(m.cagr - b.cagr), sub: 'CAGRの差（ベータ調整前）' },
    { label: '最大ドローダウン', value: pctPlain(m.maxDrawdown), sub: `${cfg.benchmark} ${pctPlain(b.maxDrawdown)}` },
  ];

  const sleeveRows = r.sleeves
    .map((s) => {
      const wins = s.trades.filter((t) => t.netReturn > 0).length;
      const pnl = s.trades.reduce((a, t) => a + t.pnl, 0);
      const days = s.trades.length > 0 ? s.trades.reduce((a, t) => a + t.holdingDays, 0) / s.trades.length : 0;
      return `<tr>
        <td>${esc(s.name)}</td>
        <td class="n">${s.trades.length}</td>
        <td class="n">${s.trades.length > 0 ? pctPlain(wins / s.trades.length, 1) : '—'}</td>
        <td class="n">${days > 0 ? `${days.toFixed(0)}日` : '—'}</td>
        <td class="n ${pnl >= 0 ? 'pos' : 'neg'}">${usd(pnl)}</td>
        <td class="n">${s.dividendGross > 0 ? usd(s.dividendGross) : '—'}</td>
      </tr>`;
    })
    .join('');

  const reasonRows = exitReasonSummary(allTrades)
    .map(
      (x) => `<tr><td>${esc(x.label)}</td><td class="n">${x.count}</td>
        <td class="n ${x.avg >= 0 ? 'pos' : 'neg'}">${pct(x.avg)}</td></tr>`,
    )
    .join('');

  const worstTrades = [...allTrades]
    .sort((a, b2) => a.netReturn - b2.netReturn)
    .slice(0, 8)
    .map(
      (t) => `<tr><td>${esc(t.symbol)}</td><td>${t.entryDate} → ${t.exitDate}</td>
        <td>${esc(t.reason)}</td><td class="n neg">${pct(t.netReturn)}</td></tr>`,
    )
    .join('');

  const d = r.dividends;
  const dividendBlock =
    cfg.priceAdjustment === 'total'
      ? `<p>価格が配当込みで調整されているため、配当はリターンに含まれています。金額の内訳を見るには <code>--price-adjustment split</code> で実行してください。</p>`
      : d.gross === 0
        ? `<div class="callout alarm"><p><strong>配当データが読み込まれていません。</strong>配当収入をゼロとして計算しているため、配当貴族スリーブのリターンが実際より低く出ています。<code>--provider alpaca</code> で実行してください。</p></div>`
        : `<div class="table-scroll"><table>
            <tbody>
              <tr><td>受取総額（税引前）</td><td class="n">${usd(d.gross)}</td></tr>
              <tr><td>米国源泉税（${pctPlain(cfg.dividendWithholding, 0)}）</td><td class="n neg">-${usd(d.withheld).replace('$', '$')}</td></tr>
              <tr><td>日本の追加課税<span class="note">外国税額控除で源泉分を相殺した差額</span></td><td class="n neg">-${usd(d.japanTax).replace('$', '$')}</td></tr>
              <tr class="mark"><td>手取り</td><td class="n">${usd(d.net)}</td></tr>
              <tr><td>総リターンに占める割合</td><td class="n">${pctPlain(d.shareOfReturn)}</td></tr>
            </tbody></table></div>`;

  return `<title>バックテスト結果 ${r.dates[0]}〜${r.dates[r.dates.length - 1]}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Zen+Old+Mincho:wght@700;900&family=Zen+Kaku+Gothic+New:wght@400;500;700&family=JetBrains+Mono:wght@400;600&display=swap">
<style>
:root {
  color-scheme: light;
  --bg:#f6f7f9; --surface:#fff; --surface-2:#eef1f5;
  --ink:#14181f; --ink-2:#4d5766; --ink-3:#79828f;
  --rule:#dee2e8; --rule-soft:#e9edf2;
  --accent:#1c5cab; --good:#0ca30c; --critical:#d03b3b; --warning:#b5750a;
  --s-port:#2a78d6; --s-bench:#eb6834; --s-dd:#e34948;
  --viz-surface:#fff; --grid:#e6eaef;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  color-scheme: dark;
  --bg:#101318; --surface:#181c23; --surface-2:#21262f;
  --ink:#eef1f5; --ink-2:#a3adbb; --ink-3:#7c8695;
  --rule:#2a303a; --rule-soft:#232830;
  --accent:#5598e7; --good:#2fbf2f; --critical:#ef6a6a; --warning:#e0a52a;
  --s-port:#3987e5; --s-bench:#d95926; --s-dd:#e66767;
  --viz-surface:#181c23; --grid:#262c35;
} }
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg:#101318; --surface:#181c23; --surface-2:#21262f;
  --ink:#eef1f5; --ink-2:#a3adbb; --ink-3:#7c8695;
  --rule:#2a303a; --rule-soft:#232830;
  --accent:#5598e7; --good:#2fbf2f; --critical:#ef6a6a; --warning:#e0a52a;
  --s-port:#3987e5; --s-bench:#d95926; --s-dd:#e66767;
  --viz-surface:#181c23; --grid:#262c35;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font-family:"Zen Kaku Gothic New","Hiragino Sans","Noto Sans JP",system-ui,sans-serif;
  font-size:16px;line-height:1.85;font-feature-settings:"palt" 1;-webkit-font-smoothing:antialiased}
.wrap{max-width:46rem;margin:0 auto;padding:0 1.5rem 6rem}
.masthead{padding:4rem 0 2rem;border-bottom:1px solid var(--ink)}
.eyebrow{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:.7rem;letter-spacing:.16em;
  text-transform:uppercase;color:var(--ink-3);display:flex;flex-wrap:wrap;gap:.5rem 1.25rem;margin-bottom:1.5rem}
h1{font-family:"Zen Old Mincho","Hiragino Mincho ProN",serif;font-weight:900;
  font-size:clamp(1.9rem,5vw,2.7rem);line-height:1.3;margin:0 0 .75rem;text-wrap:balance}
.standfirst{font-size:1rem;color:var(--ink-2);margin:0;max-width:34rem}
section{margin-top:3.5rem}
.sec-head{border-top:1px solid var(--ink);padding-top:1rem;margin-bottom:1.5rem}
.sec-head h2{font-family:"Zen Old Mincho","Hiragino Mincho ProN",serif;font-size:clamp(1.3rem,3.4vw,1.6rem);
  font-weight:700;margin:0;line-height:1.45;text-wrap:balance}
h3.sub{font-family:"Zen Old Mincho","Hiragino Mincho ProN",serif;font-size:1.08rem;font-weight:700;
  margin:2.5rem 0 .85rem;line-height:1.55}
p{margin:0 0 1.1rem}p:last-child{margin-bottom:0}
code{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:.86em;background:var(--surface-2);
  padding:.1em .35em;border-radius:2px}
.verdict{border:1px solid var(--rule);border-left:3px solid var(--accent);background:var(--surface);
  border-radius:0 3px 3px 0;padding:1.25rem 1.4rem;margin:2rem 0 0}
.verdict.warn{border-left-color:var(--warning)}
.verdict.good{border-left-color:var(--good)}
.verdict h3{font-family:"Zen Old Mincho",serif;font-size:1.1rem;margin:0 0 .5rem;font-weight:700}
.verdict p{font-size:.95rem;color:var(--ink-2);margin:0}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(9.5rem,1fr));gap:1px;
  background:var(--rule);border:1px solid var(--rule);border-radius:3px;overflow:hidden;margin:2rem 0}
.tile{background:var(--surface);padding:1rem 1.1rem}
.tile .label{font-family:"JetBrains Mono",monospace;font-size:.66rem;letter-spacing:.1em;
  text-transform:uppercase;color:var(--ink-3);display:block;margin-bottom:.35rem}
.tile .value{font-size:1.5rem;font-weight:700;font-variant-numeric:tabular-nums;line-height:1.2;display:block}
.tile .sub{font-size:.74rem;color:var(--ink-3);font-variant-numeric:tabular-nums}
figure{margin:2rem 0;background:var(--surface);border:1px solid var(--rule);border-radius:3px;padding:1.3rem 1.3rem 1rem}
.fig-title{font-weight:700;font-size:.93rem;margin:0 0 .15rem}
.fig-sub{font-family:"JetBrains Mono",monospace;font-size:.67rem;letter-spacing:.06em;color:var(--ink-3);margin:0 0 .9rem}
figcaption{font-size:.79rem;color:var(--ink-2);line-height:1.7;margin-top:.85rem;padding-top:.85rem;border-top:1px solid var(--rule-soft)}
.legend{display:flex;flex-wrap:wrap;gap:.4rem 1.1rem;font-size:.78rem;color:var(--ink-2);margin-bottom:.85rem}
.legend span{display:inline-flex;align-items:center;gap:.4rem}
.swatch{width:11px;height:11px;border-radius:2px;display:inline-block}
.chart-host{position:relative}
svg{display:block;width:100%;height:auto;overflow:visible}
svg text{font-family:"JetBrains Mono",ui-monospace,monospace;font-variant-numeric:tabular-nums}
.tick{fill:var(--ink-3);font-size:10px}
.tick{paint-order:stroke fill;stroke:var(--viz-surface);stroke-width:3px;stroke-linejoin:round}
.grid-line{stroke:var(--grid);stroke-width:1}
.axis-line{stroke:var(--rule);stroke-width:1}
.tip{position:absolute;pointer-events:none;opacity:0;transform:translate(-50%,-115%);
  background:var(--ink);color:var(--bg);font-family:"JetBrains Mono",monospace;font-size:.7rem;
  line-height:1.5;padding:.4rem .6rem;border-radius:3px;white-space:nowrap;transition:opacity .12s ease;z-index:5}
.tip.on{opacity:1}
.hit{fill:transparent;cursor:crosshair}
.table-scroll{overflow-x:auto;margin:1.4rem 0}
table{width:100%;border-collapse:collapse;font-size:.87rem;font-variant-numeric:tabular-nums;min-width:20rem}
th,td{padding:.55rem .85rem .55rem 0;text-align:left;border-bottom:1px solid var(--rule-soft);line-height:1.55}
thead th{font-weight:500;font-size:.75rem;color:var(--ink-3);border-bottom:1px solid var(--rule);white-space:nowrap}
td.n,th.n{text-align:right;padding-right:0;font-family:"JetBrains Mono",monospace}
tbody tr:last-child td{border-bottom:0}
tr.mark td{background:var(--surface-2);font-weight:700}
.pos{color:var(--good)}.neg{color:var(--critical)}
.note{display:block;font-size:.72rem;color:var(--ink-3);line-height:1.5}
.callout{border-left:2px solid var(--accent);background:var(--surface);padding:1rem 1.2rem;margin:1.6rem 0;border-radius:0 3px 3px 0}
.callout.alarm{border-left-color:var(--critical)}
.callout p{font-size:.95rem}
ul{margin:0 0 1.1rem;padding-left:1.2rem}li{margin-bottom:.45rem}li::marker{color:var(--ink-3)}
footer{margin-top:4rem;border-top:1px solid var(--ink);padding-top:1.4rem;font-size:.79rem;color:var(--ink-3);line-height:1.8}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style>

<div class="wrap">
<header class="masthead">
  <div class="eyebrow">
    <span>バックテスト</span><span>${esc(r.dates[0]!)} 〜 ${esc(r.dates[r.dates.length - 1]!)}</span>
    <span>${r.dates.length}営業日</span>
  </div>
  <h1>${esc(cfg.benchmark)}を上回ったのか</h1>
  <p class="standfirst">
    「−8%損切り / +20%利確」を実際の寄値・高値・安値の上で執行した結果。
    初期資金 ${usd(cfg.initialCapital)}、母集団 ${cfg.universe.length}銘柄、
    スリッページ片道 ${cfg.slippageBps}bps。
  </p>
</header>

${opts.synthetic ? `<div class="callout alarm"><p><strong>⚠ これは合成データによる自己テストです。</strong>実際の株価ではないため、ここに出ている成績を運用の判断材料にしないでください。</p></div>` : ''}

<div class="tiles">
${tiles.map((t) => `<div class="tile"><span class="label">${esc(t.label)}</span><span class="value">${esc(t.value)}</span><span class="sub">${esc(t.sub)}</span></div>`).join('')}
</div>

<div class="verdict ${significant ? 'good' : 'warn'}">
  <h3>${significant ? 'この期間に限れば、偶然では説明しにくい差が出ている' : 'この成績は、運とルールの実力を区別できない'}</h3>
  <p>
    ベータ ${m.beta.toFixed(2)} / 年率アルファ ${pct(m.alpha)} / <strong>t値 ${m.alphaTStat.toFixed(2)}</strong>。
    ${significant
      ? 'ただし1本の履歴でしかありません。開始日をずらした複数回で結論が変わらないかを確認してください。'
      : `t値が2に届かないうちは、プラスでも実力の証明になりません。${needYears !== null ? `このアルファが本物だとしても、確認には約${needYears.toFixed(1)}年かかります。` : ''}`}
  </p>
</div>

<section>
  <div class="sec-head"><h2>資産推移</h2></div>
  <figure>
    <p class="fig-title">ポートフォリオと${esc(cfg.benchmark)}</p>
    <p class="fig-sub">初期資金 ${usd(cfg.initialCapital)} を同時に投じた場合</p>
    <div class="legend">
      <span><i class="swatch" style="background:var(--s-port)"></i>ポートフォリオ</span>
      <span><i class="swatch" style="background:var(--s-bench)"></i>${esc(cfg.benchmark)}</span>
    </div>
    <div class="chart-host" id="host-eq">
      <svg id="chart-eq" viewBox="0 0 680 300" role="img" aria-label="ポートフォリオとベンチマークの資産推移の比較"></svg>
      <div class="tip" id="tip-eq"></div>
    </div>
    <figcaption>2本が重なっているほど、やっていることは「市場を買っている」のに近づきます。差が開いた区間がどこかを見てください。</figcaption>
  </figure>

  <figure>
    <p class="fig-title">ドローダウン</p>
    <p class="fig-sub">直近の最高値からの下落率</p>
    <div class="chart-host" id="host-dd">
      <svg id="chart-dd" viewBox="0 0 680 200" role="img" aria-label="ポートフォリオのドローダウン推移"></svg>
      <div class="tip" id="tip-dd"></div>
    </div>
    <figcaption>最大 ${pctPlain(m.maxDrawdown)}。これが実際に起きたとき、ルールを守り続けられたかどうかが本番との差になります。</figcaption>
  </figure>
</section>

<section>
  <div class="sec-head"><h2>スリーブ別</h2></div>
  <div class="table-scroll"><table>
    <thead><tr><th>スリーブ</th><th class="n">トレード</th><th class="n">勝率</th><th class="n">平均保有</th><th class="n">損益</th><th class="n">配当</th></tr></thead>
    <tbody>${sleeveRows}</tbody>
  </table></div>

  <h3 class="sub">決済理由の内訳</h3>
  <div class="table-scroll"><table>
    <thead><tr><th>理由</th><th class="n">件数</th><th class="n">平均リターン</th></tr></thead>
    <tbody>${reasonRows}</tbody>
  </table></div>
</section>

<section>
  <div class="sec-head"><h2>損切りは想定どおりに効いたか</h2></div>
  ${stops.length === 0
    ? '<p>損切りは発生しませんでした。</p>'
    : `<div class="table-scroll"><table><tbody>
        <tr><td>損切り回数</td><td class="n">${stops.length}回</td></tr>
        <tr class="mark"><td>うちギャップ約定<span class="note">寄りが損切り価格を割っており、指値では止まらなかった</span></td><td class="n">${gapped.length}回（${pctPlain(gapped.length / stops.length, 1)}）</td></tr>
        <tr><td>最悪の1トレード</td><td class="n neg">${pct(Math.min(...stops.map((t) => t.grossReturn)))}</td></tr>
      </tbody></table></div>
      <p>ギャップ約定の割合が高いほど、「${pctPlain(-(cfg.sleeves.find((s) => s.stopLoss !== null)?.stopLoss ?? 0.08))}で止まる」という前提が実際には成立していないことを意味します。</p>
      <h3 class="sub">損失が大きかったトレード</h3>
      <div class="table-scroll"><table>
        <thead><tr><th>銘柄</th><th>期間</th><th>決済理由</th><th class="n">リターン</th></tr></thead>
        <tbody>${worstTrades}</tbody>
      </table></div>`}
</section>

<section>
  <div class="sec-head"><h2>配当と税</h2></div>
  ${dividendBlock}
  <p>課税後の総リターンは <strong>${pct(r.afterTaxTotalReturn)}</strong>（税引前 ${pct(m.totalReturn)}）。
  実現益にのみ課税し、含み益は繰り延べています。短期売買が多いほどこの差は開きます。</p>
</section>

<footer>
  <p><strong>この数字を過信しないための注記</strong></p>
  <ul>
    <li>母集団に現在の上場銘柄だけを使うと生存者バイアスが入り、成績が上振れします</li>
    <li>日足では1日の値動きの順序が分からないため、損切りと利確の両方に触れた日は損切り側に倒しています</li>
    <li>1回のバックテストは1本の履歴でしかありません。開始日をずらして結論が安定するか確認してください</li>
    <li>PDT規制・信用余力・約定量の制約はモデル化していません</li>
  </ul>
  <p>詳細は <code>docs/backtest.md</code> / <code>docs/stock-trading-automation-review.md</code>。
  本レポートは投資助言ではありません。</p>
</footer>
</div>

<script>
(function(){
"use strict";
var D = ${JSON.stringify(series)};
var css = function(n){ return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); };
var SVG = "http://www.w3.org/2000/svg";
function el(t,a){ var n=document.createElementNS(SVG,t); for(var k in a) n.setAttribute(k,a[k]); return n; }

function tipFor(hostId, tipId){
  var host=document.getElementById(hostId), tip=document.getElementById(tipId);
  return {
    show:function(x,y,html){ var r=host.getBoundingClientRect(); tip.innerHTML=html;
      tip.style.left=Math.max(4,Math.min(r.width-4,x-r.left))+"px"; tip.style.top=(y-r.top)+"px";
      tip.classList.add("on"); },
    hide:function(){ tip.classList.remove("on"); }
  };
}

function lineChart(svgId, hostId, tipId, seriesDefs, fmt, zeroBased){
  var svg=document.getElementById(svgId);
  while(svg.firstChild) svg.removeChild(svg.firstChild);
  var vb=svg.getAttribute("viewBox").split(" ").map(Number), W=vb[2], H=vb[3];
  var L=58,R=12,T=16,B=32, pw=W-L-R, ph=H-T-B;

  var all=[]; seriesDefs.forEach(function(s){ all=all.concat(s.data); });
  var lo=Math.min.apply(null,all), hi=Math.max.apply(null,all);
  var padY=(hi-lo)*0.08 || 1; lo-=padY;
  // ドローダウンは0が上限。プラス側に余白を取ると「上がった」ように見えてしまう
  hi = zeroBased ? 0 : hi + padY;
  var n=D.dates.length;
  var X=function(i){ return L + (n<2?0:(i/(n-1))*pw); };
  var Y=function(v){ return T + ph - ((v-lo)/(hi-lo))*ph; };

  for(var g=0; g<=4; g++){
    var v=lo+(hi-lo)*g/4;
    svg.appendChild(el("line",{x1:L,y1:Y(v),x2:L+pw,y2:Y(v),class:"grid-line"}));
    var t=el("text",{x:L-9,y:Y(v)+3.5,class:"tick","text-anchor":"end"});
    t.textContent=fmt(v); svg.appendChild(t);
  }

  seriesDefs.forEach(function(s){
    var pts=s.data.map(function(v,i){ return X(i)+","+Y(v); }).join(" ");
    if(s.fill){
      svg.appendChild(el("polygon",{points:X(0)+","+Y(0)+" "+pts+" "+X(n-1)+","+Y(0),
        fill:css(s.color),opacity:"0.14"}));
    }
    svg.appendChild(el("polyline",{points:pts,fill:"none",stroke:css(s.color),
      "stroke-width":"2","stroke-linejoin":"round","stroke-linecap":"round"}));
  });

  var step=Math.max(1,Math.floor(n/5));
  for(var i=0;i<n;i+=step){
    var lab=el("text",{x:X(i),y:H-10,class:"tick","text-anchor":"middle"});
    lab.textContent=D.dates[i].slice(0,7); svg.appendChild(lab);
  }
  svg.appendChild(el("line",{x1:L,y1:T+ph,x2:L+pw,y2:T+ph,class:"axis-line"}));

  var tip=tipFor(hostId,tipId);
  var cursor=el("line",{x1:0,y1:T,x2:0,y2:T+ph,stroke:css("--ink-3"),"stroke-width":"1","stroke-dasharray":"3 3",opacity:"0"});
  svg.appendChild(cursor);
  var dots=seriesDefs.map(function(s){
    var c=el("circle",{r:"4",fill:css(s.color),stroke:css("--viz-surface"),"stroke-width":"2",opacity:"0"});
    svg.appendChild(c); return c;
  });
  var hit=el("rect",{x:L,y:T,width:pw,height:ph,class:"hit"});
  svg.appendChild(hit);
  hit.addEventListener("pointermove",function(e){
    var r=svg.getBoundingClientRect();
    var i=Math.round(((e.clientX-r.left)/r.width*W - L)/pw*(n-1));
    if(i<0||i>=n) return;
    cursor.setAttribute("x1",X(i)); cursor.setAttribute("x2",X(i)); cursor.setAttribute("opacity","1");
    var html=D.dates[i];
    seriesDefs.forEach(function(s,k){
      dots[k].setAttribute("cx",X(i)); dots[k].setAttribute("cy",Y(s.data[i])); dots[k].setAttribute("opacity","1");
      html+="<br>"+s.label+" "+fmt(s.data[i]);
    });
    tip.show(e.clientX,e.clientY,html);
  });
  hit.addEventListener("pointerleave",function(){
    tip.hide(); cursor.setAttribute("opacity","0");
    dots.forEach(function(d){ d.setAttribute("opacity","0"); });
  });
}

var money=function(v){ return "$"+Math.round(v).toLocaleString("en-US"); };
var percent=function(v){ return (v*100).toFixed(0)+"%"; };

function renderAll(){
  lineChart("chart-eq","host-eq","tip-eq",[
    {data:D.port,color:"--s-port",label:"ポートフォリオ"},
    {data:D.bench,color:"--s-bench",label:${JSON.stringify(cfg.benchmark)}}
  ], money, false);
  lineChart("chart-dd","host-dd","tip-dd",[
    {data:D.dd,color:"--s-dd",label:"ドローダウン",fill:true}
  ], percent, true);
}
renderAll();
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change",renderAll);
new MutationObserver(renderAll).observe(document.documentElement,{attributes:true,attributeFilter:["data-theme"]});
})();
</script>`;
}
