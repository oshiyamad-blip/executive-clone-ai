import '../env.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { createHash, timingSafeEqual } from 'crypto';
import { readReviewMatches, readReviewOwnMatches, setMatchStatus, hasReviewData } from './review.js';
import { sesWebPort } from './config.js';
import type { MatchStatus } from '../types/index.js';

// SESマッチ確認UI。バッチ(notify)と自社社員探し(ownMatch)が書き出したレビュー成果を一覧表示し、
// 紹介メール下書きを確認し、マッチのステータス(未確認/紹介済/成約/見送り)を更新する。
// 既存 src/web/server.ts と同じ「ビルド不要のインラインHTML + 軽量httpサーバー」流儀。
// アクセス制御: WEB_ACCESS_TOKEN を設定すると /api/* に Bearer 認証を要求する。既定は 127.0.0.1 バインド。
const HOST = process.env.WEB_HOST ?? '127.0.0.1';
const PORT = sesWebPort();
const ACCESS_TOKEN = process.env.WEB_ACCESS_TOKEN ?? '';

const VALID_STATUSES: MatchStatus[] = ['unconfirmed', 'introduced', 'closed_won', 'dropped'];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1_000_000) req.destroy(); // 1MB 上限
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

// 定数時間比較（トークンのタイミング攻撃対策）
function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

function authorized(req: IncomingMessage): boolean {
  if (!ACCESS_TOKEN) return true; // 未設定なら認証なし（ローカル利用前提）
  const header = req.headers['authorization'] ?? '';
  return safeEqual(header, `Bearer ${ACCESS_TOKEN}`);
}

function handleData(res: ServerResponse): void {
  json(res, 200, { matches: readReviewMatches(), ownMatches: readReviewOwnMatches() });
}

async function handleStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { id?: string; status?: string };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { error: 'invalid json' });
  }
  const id = (body.id ?? '').trim();
  const status = body.status as MatchStatus;
  if (!id || !VALID_STATUSES.includes(status)) {
    return json(res, 400, { error: 'id と有効な status が必要です' });
  }
  try {
    const updated = await setMatchStatus(id, status);
    if (!updated) return json(res, 404, { error: '該当マッチが見つかりません' });
    return json(res, 200, { ok: true, match: updated });
  } catch (err) {
    return json(res, 502, { error: `更新に失敗しました: ${String(err)}` });
  }
}

function main(): void {
  if (!hasReviewData()) {
    console.warn('⚠️  レビュー成果がまだありません。先に `npm run ses:demo`（本番は `npm run ses`）や `npm run ses:own-match` を実行してください。');
  }
  if (!ACCESS_TOKEN) {
    console.warn('⚠️  WEB_ACCESS_TOKEN が未設定です。ローカル(127.0.0.1)以外に公開しないでください。');
  }

  const page = renderPage();
  const server = createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page);
      return;
    }
    if (req.method === 'GET' && req.url === '/api/data') {
      if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
      return handleData(res);
    }
    if (req.method === 'POST' && req.url === '/api/status') {
      if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
      void handleStatus(req, res);
      return;
    }
    json(res, 404, { error: 'not found' });
  });

  server.listen(PORT, HOST, () => {
    console.log(`\n🌐 SESマッチ確認UI: http://${HOST}:${PORT} で待受中（Ctrl+Cで終了）\n`);
  });
}

// 単一ファイルの確認ダッシュボード（ビルド不要のインラインHTML/JS）
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
  header { padding: 12px 16px; background: #171a21; border-bottom: 1px solid #2a2f3a; display: flex; gap: 12px; align-items: center; }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; }
  #token { background: #0f1115; color: #e6e6e6; border: 1px solid #2a2f3a; border-radius: 6px; padding: 6px 8px; width: 150px; margin-left: auto; }
  main { max-width: 940px; margin: 0 auto; padding: 16px; }
  h2 { font-size: 14px; color: #9aa4b2; border-bottom: 1px solid #2a2f3a; padding-bottom: 6px; margin: 24px 0 12px; }
  .card { background: #171a21; border: 1px solid #2a2f3a; border-radius: 10px; padding: 14px; margin-bottom: 12px; }
  .card.review { border-left: 3px solid #d9a441; }
  .card.ok { border-left: 3px solid #3fb950; }
  .card.negotiate { border-left: 3px solid #a371f7; }
  .neg { font-size: 13px; color: #c8a6ff; background: #1c1630; border: 1px solid #3a2f52; border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; }
  .title { font-weight: 600; margin-bottom: 4px; }
  .meta { font-size: 13px; color: #9aa4b2; margin-bottom: 6px; }
  .reason { font-size: 13px; line-height: 1.5; margin-bottom: 8px; }
  .badge { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 999px; margin-left: 8px; }
  .b-unconfirmed { background: #30363d; color: #c9d1d9; }
  .b-introduced { background: #1f6feb; color: #fff; }
  .b-closed_won { background: #238636; color: #fff; }
  .b-dropped { background: #6e2f2f; color: #fff; }
  .b-negotiate { background: #8957e5; color: #fff; }
  .actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
  .actions button { background: #0f1115; color: #c9d1d9; border: 1px solid #2a2f3a; border-radius: 6px; padding: 5px 12px; font-size: 12px; cursor: pointer; }
  .actions button:hover { border-color: #2f6feb; }
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
  <input id="token" type="password" placeholder="アクセストークン" />
</header>
<main>
  <div style="display:flex;gap:8px;align-items:center">
    <button id="reload" type="button" style="background:#2f6feb;color:#fff;border:0;border-radius:8px;padding:8px 14px;cursor:pointer">再読込</button>
    <span id="status" class="empty"></span>
  </div>
  <h2>外部マッチ（案件 × 外部要員）</h2>
  <div id="matches"></div>
  <h2>自社社員 → 合いそうな案件</h2>
  <div id="own"></div>
</main>
<script>
  var tokenEl = document.getElementById('token');
  tokenEl.value = localStorage.getItem('ses_token') || '';
  tokenEl.addEventListener('change', function () { localStorage.setItem('ses_token', tokenEl.value); });

  var STATUS_LABEL = { unconfirmed: '未確認', introduced: '紹介済', closed_won: '成約', dropped: '見送り' };
  function esc(s){ var d=document.createElement('div'); d.textContent = s==null?'':String(s); return d.innerHTML; }
  function headers(){ return { 'content-type': 'application/json', 'authorization': 'Bearer ' + tokenEl.value }; }

  function statusBadge(s){ return '<span class="badge b-' + s + '">' + (STATUS_LABEL[s]||s) + '</span>'; }

  function draftBlock(label, text, url){
    if (text) return '<details class="drafts"><summary>' + label + 'の下書きを見る</summary><pre>' + esc(text) + '</pre></details>';
    if (url) return '<div class="drafts"><a href="' + esc(url) + '" target="_blank">' + label + 'の下書き（Gmail）を開く</a></div>';
    return '';
  }

  function renderMatches(matches){
    var root = document.getElementById('matches');
    if (!matches.length) { root.innerHTML = '<p class="empty">マッチはまだありません。</p>'; return; }
    root.innerHTML = matches.map(function(m){
      var cls = m.needsReview ? 'review' : (m.negotiation ? 'negotiate' : 'ok');
      var man = (m.grossMarginJpy/10000).toFixed(1);
      var badge = m.negotiation ? '<span class="badge b-negotiate">交渉提案</span>' : '';
      var negBanner = '';
      if (m.negotiation) {
        var n = m.negotiation;
        negBanner = '<div class="neg">交渉案: 案件単金 +' + n.projectRaiseMan + '万円（→' + n.targetProjectRateMan + '万円/月） ／ 要員単金 −' + n.engineerCutMan + '万円（→' + n.targetEngineerRateMan + '万円/月）　⇒ 粗利 ' + (n.resultingGrossMarginJpy/10000).toFixed(1) + '万円/月</div>';
      }
      var acts = ['unconfirmed','introduced','closed_won','dropped'].map(function(s){
        return '<button data-id="' + esc(m.id) + '" data-status="' + s + '">' + STATUS_LABEL[s] + 'にする</button>';
      }).join('');
      return '<div class="card ' + cls + '">' +
        '<div class="title">' + esc(m.title) + badge + statusBadge(m.status) + '</div>' +
        '<div class="meta">現状粗利 ' + man + '万円/月 ・ 適合スコア ' + esc(m.score) + '点' + (m.needsReview?' ・ 要確認':'') + '</div>' +
        negBanner +
        '<div class="reason">' + esc(m.reason) + '</div>' +
        draftBlock('案件側', m.draftToProjectText, m.draftToProjectUrl) +
        draftBlock('要員側', m.draftToEngineerText, m.draftToEngineerUrl) +
        '<div class="actions">' + acts + '</div>' +
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

  async function load(){
    var st = document.getElementById('status');
    try {
      var res = await fetch('/api/data', { headers: headers() });
      if (!res.ok) { st.textContent = '[エラー] ' + res.status; return; }
      var data = await res.json();
      renderMatches(data.matches || []);
      renderOwn(data.ownMatches || []);
      st.textContent = '外部マッチ ' + (data.matches||[]).length + '件 / 自社候補 ' + (data.ownMatches||[]).length + '件';
    } catch (e) { st.textContent = '[通信エラー] ' + e; }
  }

  document.getElementById('reload').addEventListener('click', load);
  document.getElementById('matches').addEventListener('click', async function(e){
    var b = e.target.closest('button[data-id]'); if (!b) return;
    b.disabled = true;
    try {
      var res = await fetch('/api/status', { method: 'POST', headers: headers(), body: JSON.stringify({ id: b.dataset.id, status: b.dataset.status }) });
      if (!res.ok) { var d = await res.json(); alert('更新失敗: ' + (d.error||res.status)); return; }
      await load();
    } catch (err) { alert('通信エラー: ' + err); } finally { b.disabled = false; }
  });
  load();
</script>
</body>
</html>`;
}

main();
