import '../env.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { createHash, timingSafeEqual } from 'crypto';
import { readReviewMatches, readReviewOwnMatches, setMatchStatus, hasReviewData } from './review.js';
import { recordFeedback, loadFeedback } from './feedback.js';
import { addSkillEquivalence } from './skillEquiv.js';
import { computeBandMetrics } from './metrics.js';
import { sesWebPort, sesWebHost } from './config.js';
import type { MatchStatus, MatchFeedback, MatchBand } from '../types/index.js';

// SESマッチ確認UI（複数人運用）。バッチ/自社社員探しが書き出したレビュー成果を一覧表示し、
// 紹介メール下書きを確認し、ステータス更新・妥当/ズレ評価・スキル同義追加を行う。
// 評価と操作には「名前」を添えて誰の操作かを記録する（共有の正は本番=Notion / demo=ローカルJSON）。
// アクセス制御: WEB_ACCESS_TOKEN を設定すると /api/* に Bearer 認証。ホストは SES_WEB_HOST（既定ローカル）。
const HOST = sesWebHost();
const PORT = sesWebPort();
const ACCESS_TOKEN = process.env.WEB_ACCESS_TOKEN ?? '';
const VALID_STATUSES: MatchStatus[] = ['unconfirmed', 'introduced', 'closed_won', 'dropped'];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1_000_000) req.destroy();
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

function authorized(req: IncomingMessage): boolean {
  if (!ACCESS_TOKEN) return true;
  const header = req.headers['authorization'] ?? '';
  return safeEqual(header, `Bearer ${ACCESS_TOKEN}`);
}

async function parseJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readBody(req));
  } catch {
    return null;
  }
}

async function handleData(res: ServerResponse): Promise<void> {
  const matches = readReviewMatches();
  const feedback = await loadFeedback();
  const metrics = computeBandMetrics(matches, feedback);
  json(res, 200, { matches, ownMatches: readReviewOwnMatches(), metrics });
}

async function handleStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await parseJson(req);
  if (!body) return json(res, 400, { error: 'invalid json' });
  const id = String(body.id ?? '').trim();
  const status = body.status as MatchStatus;
  const reviewer = String(body.reviewer ?? '').trim();
  if (!id || !VALID_STATUSES.includes(status)) {
    return json(res, 400, { error: 'id と有効な status が必要です' });
  }
  try {
    const updated = await setMatchStatus(id, status, reviewer);
    if (!updated) return json(res, 404, { error: '該当マッチが見つかりません' });
    return json(res, 200, { ok: true, match: updated });
  } catch (err) {
    return json(res, 502, { error: `更新に失敗しました: ${String(err)}` });
  }
}

async function handleFeedback(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await parseJson(req);
  if (!body) return json(res, 400, { error: 'invalid json' });
  const matchId = String(body.matchId ?? '').trim();
  const verdict = body.verdict === 'bad' ? 'bad' : body.verdict === 'good' ? 'good' : null;
  if (!matchId || !verdict) return json(res, 400, { error: 'matchId と verdict(good/bad) が必要です' });
  const bandRaw = body.band;
  const band: MatchBand | undefined = bandRaw === 'strong' || bandRaw === 'tentative' ? bandRaw : undefined;
  const fb: MatchFeedback = {
    matchId,
    matchTitle: String(body.matchTitle ?? matchId),
    verdict,
    note: String(body.note ?? ''),
    reviewer: String(body.reviewer ?? '').trim() || '(不明)',
    band,
    at: new Date().toISOString(),
  };
  try {
    await recordFeedback(fb);
    return json(res, 200, { ok: true });
  } catch (err) {
    return json(res, 502, { error: `評価の保存に失敗しました: ${String(err)}` });
  }
}

async function handleSkillEquiv(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await parseJson(req);
  if (!body) return json(res, 400, { error: 'invalid json' });
  const a = String(body.a ?? '').trim();
  const b = String(body.b ?? '').trim();
  const reviewer = String(body.reviewer ?? '').trim();
  try {
    const entry = await addSkillEquivalence(a, b, reviewer);
    if (!entry) return json(res, 400, { error: '異なる2つのスキル名が必要です' });
    return json(res, 200, { ok: true, entry });
  } catch (err) {
    return json(res, 502, { error: `同義の保存に失敗しました: ${String(err)}` });
  }
}

function main(): void {
  if (!hasReviewData()) {
    console.warn('⚠️  レビュー成果がまだありません。先に `npm run ses:demo`（本番は `npm run ses`）や `npm run ses:own-match` を実行してください。');
  }
  if (!ACCESS_TOKEN) {
    console.warn(`⚠️  WEB_ACCESS_TOKEN が未設定です。${HOST === '127.0.0.1' ? 'ローカル(127.0.0.1)以外に公開しないでください。' : 'ネットワーク公開する場合は必ずトークンを設定してください。'}`);
  }

  const page = renderPage();
  const server = createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page);
      return;
    }
    if (req.url === '/api/data' && req.method === 'GET') {
      if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
      void handleData(res);
      return;
    }
    if (req.method === 'POST' && req.url === '/api/status') {
      if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
      void handleStatus(req, res);
      return;
    }
    if (req.method === 'POST' && req.url === '/api/feedback') {
      if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
      void handleFeedback(req, res);
      return;
    }
    if (req.method === 'POST' && req.url === '/api/skill-equivalence') {
      if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
      void handleSkillEquiv(req, res);
      return;
    }
    json(res, 404, { error: 'not found' });
  });

  server.listen(PORT, HOST, () => {
    console.log(`\n🌐 SESマッチ確認UI: http://${HOST}:${PORT} で待受中（Ctrl+Cで終了）\n`);
  });
}

function renderPage(): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>SESマッチ確認</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, "Hiragino Sans", sans-serif; margin: 0; background: #0f1115; color: #e6e6e6; }
  header { padding: 12px 16px; background: #171a21; border-bottom: 1px solid #2a2f3a; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; }
  header input { background: #0f1115; color: #e6e6e6; border: 1px solid #2a2f3a; border-radius: 6px; padding: 6px 8px; }
  #name { width: 140px; }
  #token { width: 140px; margin-left: auto; }
  main { max-width: 960px; margin: 0 auto; padding: 16px; }
  h2 { font-size: 14px; color: #9aa4b2; border-bottom: 1px solid #2a2f3a; padding-bottom: 6px; margin: 24px 0 12px; }
  .metrics { display: flex; gap: 10px; flex-wrap: wrap; }
  .metric { background: #171a21; border: 1px solid #2a2f3a; border-radius: 10px; padding: 10px 14px; font-size: 13px; min-width: 150px; }
  .metric b { font-size: 15px; }
  .card { background: #171a21; border: 1px solid #2a2f3a; border-radius: 10px; padding: 14px; margin-bottom: 12px; }
  .card.confirmed { border-left: 3px solid #3fb950; }
  .card.tentative { border-left: 3px solid #58a6ff; }
  .card.negotiable { border-left: 3px solid #a371f7; }
  .card.review { border-left: 3px solid #d9a441; }
  .title { font-weight: 600; margin-bottom: 4px; }
  .meta { font-size: 13px; color: #9aa4b2; margin-bottom: 6px; }
  .reason { font-size: 13px; line-height: 1.5; margin-bottom: 8px; }
  .badge { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 999px; margin-left: 8px; }
  .b-confirmed { background: #238636; color: #fff; }
  .b-tentative { background: #1f6feb; color: #fff; }
  .b-negotiable { background: #8957e5; color: #fff; }
  .b-review { background: #9e6a00; color: #fff; }
  .b-unconfirmed { background: #30363d; color: #c9d1d9; }
  .b-introduced { background: #1f6feb; color: #fff; }
  .b-closed_won { background: #238636; color: #fff; }
  .b-dropped { background: #6e2f2f; color: #fff; }
  .neg { font-size: 13px; color: #c8a6ff; background: #1c1630; border: 1px solid #3a2f52; border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; }
  .actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; align-items: center; }
  .actions button { background: #0f1115; color: #c9d1d9; border: 1px solid #2a2f3a; border-radius: 6px; padding: 5px 12px; font-size: 12px; cursor: pointer; }
  .actions button:hover { border-color: #2f6feb; }
  .fb { margin-top: 8px; padding-top: 8px; border-top: 1px dashed #2a2f3a; display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  .fb input { background: #0f1115; color: #e6e6e6; border: 1px solid #2a2f3a; border-radius: 6px; padding: 5px 8px; font-size: 12px; }
  .fb .note { flex: 1; min-width: 160px; }
  .good { border-color: #238636 !important; color: #7ee787 !important; }
  .bad { border-color: #6e2f2f !important; color: #ff9b9b !important; }
  .drafts { margin-top: 10px; }
  .drafts summary { cursor: pointer; font-size: 13px; color: #6ea8fe; }
  pre { white-space: pre-wrap; background: #0f1115; border: 1px solid #2a2f3a; border-radius: 8px; padding: 10px; font-size: 12px; line-height: 1.5; overflow-x: auto; }
  .own-eng { margin: 14px 0 6px; font-weight: 600; }
  .own-proj { font-size: 13px; padding: 6px 10px; border-left: 2px solid #2a2f3a; margin: 4px 0; }
  .empty { color: #9aa4b2; font-size: 13px; }
  a { color: #6ea8fe; }
</style>
</head>
<body>
<header>
  <h1>SESマッチ確認</h1>
  <input id="name" placeholder="あなたの名前" />
  <button id="reload" type="button" style="background:#2f6feb;color:#fff;border:0;border-radius:8px;padding:7px 14px;cursor:pointer">再読込</button>
  <input id="token" type="password" placeholder="アクセストークン" />
</header>
<main>
  <span id="status" class="empty"></span>
  <h2>バンド別メトリクス（フィードバックで精度を可視化）</h2>
  <div id="metrics" class="metrics"></div>
  <h2>スキル同義の追加（例: PHP ≈ Laravel）</h2>
  <div class="fb" style="border:0">
    <input id="eqA" placeholder="スキルA" style="width:140px" />
    <span>≈</span>
    <input id="eqB" placeholder="スキルB" style="width:140px" />
    <button id="eqAdd" type="button">同義に追加</button>
    <span id="eqMsg" class="empty"></span>
  </div>
  <h2>外部マッチ（案件 × 外部要員）</h2>
  <div id="matches"></div>
  <h2>自社社員 → 合いそうな案件</h2>
  <div id="own"></div>
</main>
<script>
  var nameEl = document.getElementById('name');
  var tokenEl = document.getElementById('token');
  nameEl.value = localStorage.getItem('ses_reviewer') || '';
  tokenEl.value = localStorage.getItem('ses_token') || '';
  nameEl.addEventListener('change', function(){ localStorage.setItem('ses_reviewer', nameEl.value); });
  tokenEl.addEventListener('change', function(){ localStorage.setItem('ses_token', tokenEl.value); });

  var STATUS_LABEL = { unconfirmed: '未確認', introduced: '紹介済', closed_won: '成約', dropped: '見送り' };
  var CAT = {
    confirmed: { cls: 'confirmed', label: '成立候補' },
    tentative: { cls: 'tentative', label: '参考提案' },
    negotiable: { cls: 'negotiable', label: '交渉提案' },
    review: { cls: 'review', label: '要確認' }
  };
  var BAND_LABEL = { strong: '強マッチ', tentative: '参考(許容範囲)', negotiable: '交渉提案' };

  function esc(s){ var d=document.createElement('div'); d.textContent = s==null?'':String(s); return d.innerHTML; }
  function headers(){ return { 'content-type': 'application/json', 'authorization': 'Bearer ' + tokenEl.value }; }
  function reviewer(){ return nameEl.value.trim(); }
  function pct(x){ return x==null ? '—' : Math.round(x*100) + '%'; }

  function statusBadge(s){ return '<span class="badge b-' + s + '">' + (STATUS_LABEL[s]||s) + '</span>'; }
  function catBadge(c){ var v = CAT[c] || CAT.review; return '<span class="badge b-' + c + '">' + v.label + '</span>'; }

  function draftBlock(label, text, url){
    if (text) return '<details class="drafts"><summary>' + label + 'の下書きを見る</summary><pre>' + esc(text) + '</pre></details>';
    if (url) return '<div class="drafts"><a href="' + esc(url) + '" target="_blank">' + label + 'の下書き（Gmail）を開く</a></div>';
    return '';
  }

  function renderMetrics(metrics){
    var root = document.getElementById('metrics');
    if (!metrics || !metrics.length) { root.innerHTML = '<span class="empty">データなし</span>'; return; }
    root.innerHTML = metrics.map(function(m){
      return '<div class="metric">' + esc(BAND_LABEL[m.band]||m.band) +
        '<br>検出 <b>' + m.total + '</b>件 ・ 成約率 <b>' + pct(m.winRate) + '</b>' +
        '<br><span class="empty">妥当率 ' + pct(m.goodRate) + '（成約' + m.closedWon + '/見送り' + m.dropped + '・妥当' + m.good + '/ズレ' + m.bad + '）</span></div>';
    }).join('');
  }

  function renderMatches(matches){
    var root = document.getElementById('matches');
    if (!matches.length) { root.innerHTML = '<p class="empty">マッチはまだありません。</p>'; return; }
    root.innerHTML = matches.map(function(m){
      var cat = CAT[m.category] || CAT.review;
      var man = (m.grossMarginJpy/10000).toFixed(1);
      var negBanner = '';
      if (m.negotiation) {
        var n = m.negotiation;
        negBanner = '<div class="neg">交渉案: 案件単金 +' + n.projectRaiseMan + '万円（→' + n.targetProjectRateMan + '万円/月） ／ 要員単金 −' + n.engineerCutMan + '万円（→' + n.targetEngineerRateMan + '万円/月）　⇒ 粗利 ' + (n.resultingGrossMarginJpy/10000).toFixed(1) + '万円/月</div>';
      }
      var acts = ['unconfirmed','introduced','closed_won','dropped'].map(function(s){
        return '<button data-act="status" data-id="' + esc(m.id) + '" data-status="' + s + '">' + STATUS_LABEL[s] + 'にする</button>';
      }).join('');
      var by = m.lastActionBy ? '<span class="empty" style="margin-left:6px">最終更新: ' + esc(m.lastActionBy) + '</span>' : '';
      var fb = '<div class="fb">評価: ' +
        '<button class="good" data-act="fb" data-id="' + esc(m.id) + '" data-title="' + esc(m.title) + '" data-band="' + esc(m.band) + '" data-verdict="good">妥当</button>' +
        '<button class="bad" data-act="fb" data-id="' + esc(m.id) + '" data-title="' + esc(m.title) + '" data-band="' + esc(m.band) + '" data-verdict="bad">ズレ</button>' +
        '<input class="note" placeholder="メモ（例: PHPとLaravelは実質同じ）" />' +
        '</div>';
      return '<div class="card ' + cat.cls + '">' +
        '<div class="title">' + esc(m.title) + catBadge(m.category) + statusBadge(m.status) + by + '</div>' +
        '<div class="meta">現状粗利 ' + man + '万円/月 ・ 適合スコア ' + esc(m.score) + ' ・ ' + (BAND_LABEL[m.band]||m.band) + '</div>' +
        negBanner +
        '<div class="reason">' + esc(m.reason) + '</div>' +
        draftBlock('案件側', m.draftToProjectText, m.draftToProjectUrl) +
        draftBlock('要員側', m.draftToEngineerText, m.draftToEngineerUrl) +
        '<div class="actions">' + acts + '</div>' +
        fb +
      '</div>';
    }).join('');
  }

  function renderOwn(own){
    var root = document.getElementById('own');
    if (!own.length) { root.innerHTML = '<p class="empty">自社社員の候補案件はまだありません（npm run ses:own-match を実行）。</p>'; return; }
    var byEng = {};
    own.forEach(function(m){ (byEng[m.ownEngineerName] = byEng[m.ownEngineerName] || []).push(m); });
    root.innerHTML = Object.keys(byEng).map(function(name){
      var items = byEng[name].map(function(m){
        var tag = m.needsReview ? '[要確認] ' : (m.meetsRate ? '[単価充足] ' : '');
        return '<div class="own-proj">' + tag + esc(m.projectTitle) + ' — 案件単価' + esc(m.projectRate==null?'不明':m.projectRate) + '万円/月, スコア' + esc(m.score) + '点<br><span class="empty">' + esc(m.reason) + '</span></div>';
      }).join('');
      return '<div class="own-eng">' + esc(name) + '</div>' + items;
    }).join('');
  }

  async function post(url, payload){
    var res = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(payload) });
    var data = await res.json().catch(function(){ return {}; });
    return { ok: res.ok, status: res.status, data: data };
  }

  async function load(){
    var st = document.getElementById('status');
    try {
      var res = await fetch('/api/data', { headers: headers() });
      if (!res.ok) { st.textContent = '[エラー] ' + res.status; return; }
      var data = await res.json();
      renderMetrics(data.metrics || []);
      renderMatches(data.matches || []);
      renderOwn(data.ownMatches || []);
      st.textContent = '外部マッチ ' + (data.matches||[]).length + '件 / 自社候補 ' + (data.ownMatches||[]).length + '件';
    } catch (e) { st.textContent = '[通信エラー] ' + e; }
  }

  document.getElementById('reload').addEventListener('click', load);

  document.getElementById('eqAdd').addEventListener('click', async function(){
    var msg = document.getElementById('eqMsg');
    var a = document.getElementById('eqA').value.trim();
    var b = document.getElementById('eqB').value.trim();
    if (!a || !b) { msg.textContent = 'スキルA・Bを入力してください'; return; }
    var r = await post('/api/skill-equivalence', { a: a, b: b, reviewer: reviewer() });
    if (!r.ok) { msg.textContent = '失敗: ' + (r.data.error || r.status); return; }
    msg.textContent = a + ' ≈ ' + b + ' を追加しました（次回マッチから反映）';
    document.getElementById('eqA').value = ''; document.getElementById('eqB').value = '';
  });

  document.getElementById('matches').addEventListener('click', async function(e){
    var b = e.target.closest('button[data-act]'); if (!b) return;
    b.disabled = true;
    try {
      if (b.dataset.act === 'status') {
        var r = await post('/api/status', { id: b.dataset.id, status: b.dataset.status, reviewer: reviewer() });
        if (!r.ok) { alert('更新失敗: ' + (r.data.error||r.status)); return; }
        await load();
      } else if (b.dataset.act === 'fb') {
        var card = b.closest('.card');
        var noteEl = card ? card.querySelector('.note') : null;
        var note = noteEl ? noteEl.value.trim() : '';
        var r2 = await post('/api/feedback', { matchId: b.dataset.id, matchTitle: b.dataset.title, band: b.dataset.band, verdict: b.dataset.verdict, note: note, reviewer: reviewer() });
        if (!r2.ok) { alert('評価失敗: ' + (r2.data.error||r2.status)); return; }
        if (noteEl) noteEl.value = '';
        b.textContent = b.dataset.verdict === 'good' ? '妥当✓' : 'ズレ✓';
        await load();
      }
    } catch (err) { alert('通信エラー: ' + err); } finally { b.disabled = false; }
  });

  load();
</script>
</body>
</html>`;
}

main();
