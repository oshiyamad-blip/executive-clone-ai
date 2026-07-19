import '../env.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { createHash, timingSafeEqual } from 'crypto';
import {
  loadCloneContext,
  askClone,
  feedbackChatLog,
  CLONE_MODES,
  type CloneContext,
  type CloneMode,
} from '../clone/engine.js';
import type { LlmMessage } from '../llm/index.js';

// ② Web チャットUI（要件3.4 意思決定シミュレーション対話 / 4.1 アクセス制御）
// 経営企画・役員がブラウザで壁打ちできる軽量ローカルサーバー。
// アクセス制御: WEB_ACCESS_TOKEN を設定すると /api/* に Bearer 認証を要求する。
// 既定では 127.0.0.1（ローカルのみ）にバインドする。

const HOST = process.env.WEB_HOST ?? '127.0.0.1';
const PORT = Number(process.env.WEB_PORT ?? '8787');
const ACCESS_TOKEN = process.env.WEB_ACCESS_TOKEN ?? '';

interface ChatRequest {
  message: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  mode?: CloneMode;
}

// JSONボディの mode は型保証がないため、既知のモードのみ受け付けて chat に縮退する
function normalizeMode(mode: unknown): CloneMode {
  return CLONE_MODES.includes(mode as CloneMode) ? (mode as CloneMode) : 'chat';
}

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
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

// 定数時間比較（トークンのタイミング攻撃対策）。長さ差を隠すため両者をハッシュ化して比較。
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

// コンテキストは日次バッチで増えるため、TTLで再読込して陳腐化を防ぐ。
let cachedCtx: CloneContext | null = null;
let ctxLoadedAt = 0;
let ctxLoading: Promise<void> | null = null;
const CTX_TTL_MS = 10 * 60 * 1000;
const MAX_HISTORY = 40; // 直近メッセージ数の上限（トークン/コスト対策）

async function getContext(): Promise<CloneContext> {
  const stale = Date.now() - ctxLoadedAt > CTX_TTL_MS;
  if ((stale || !cachedCtx) && !ctxLoading) {
    ctxLoading = loadCloneContext()
      .then((c) => {
        cachedCtx = c;
        ctxLoadedAt = Date.now();
      })
      .catch((err) => console.error(`コンテキスト再読込に失敗: ${String(err)}`))
      .finally(() => {
        ctxLoading = null;
      });
  }
  if (!cachedCtx && ctxLoading) await ctxLoading; // 初回のみ待つ（以降はバックグラウンド更新）
  if (!cachedCtx) throw new Error('コンテキスト未読込');
  return cachedCtx;
}

async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });

  let body: ChatRequest;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { error: 'invalid json' });
  }
  const message = (body.message ?? '').trim();
  if (!message) return json(res, 400, { error: 'message is required' });

  const history: LlmMessage[] = (body.history ?? [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
    .map((m) => ({ role: m.role, content: m.content }));
  history.push({ role: 'user', content: message });

  // 直近 MAX_HISTORY 件に制限し、先頭が user になるよう調整（Messages APIの制約）
  let messages = history.slice(-MAX_HISTORY);
  while (messages.length && messages[0].role === 'assistant') messages = messages.slice(1);

  try {
    const ctx = await getContext();
    const mode = normalizeMode(body.mode);
    const result = await askClone(ctx.prompts[mode], messages, ctx.sourceIndex);
    // 採用モードは候補者の個人情報（履歴書・面接メモ等）を含むため、
    // シグナルDBへはフィードバックしない（恒久保存・再学習への混入を防ぐ）。
    // フィードバックはベストエフォート（内部でtry/catch済み）なので応答を待たせない。
    if (mode !== 'hiring') void feedbackChatLog(message, result.answer);
    json(res, 200, {
      answer: result.answer,
      sources: result.sources.map((s) => ({ tag: s.tag, label: s.label, url: s.url ?? null })),
    });
  } catch (err) {
    json(res, 502, { error: `生成に失敗しました: ${String(err)}` });
  }
}

async function main(): Promise<void> {
  console.log('経営者クローンAI — Web対話サーバーを起動中...');
  const ctx = await getContext();
  console.log(`✅ コンテキスト読込（シグナル${ctx.signals.length}件 / ストーリー${ctx.stories.length}件）`);
  if (!ACCESS_TOKEN) {
    console.warn('⚠️  WEB_ACCESS_TOKEN が未設定です。ローカル(127.0.0.1)以外に公開しないでください。');
  }

  const page = renderPage(ctx.profile.name);

  const server = createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page);
      return;
    }
    if (req.method === 'POST' && req.url === '/api/chat') {
      void handleChat(req, res);
      return;
    }
    json(res, 404, { error: 'not found' });
  });

  server.listen(PORT, HOST, () => {
    console.log(`\n🌐 http://${HOST}:${PORT} で待受中（Ctrl+Cで終了）\n`);
  });
}

// 単一ファイルのチャットページ（ビルド不要のインラインHTML/JS）
function renderPage(name: string): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>経営者クローンAI</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, "Hiragino Sans", sans-serif; margin: 0; background: #0f1115; color: #e6e6e6; }
  header { padding: 12px 16px; background: #171a21; border-bottom: 1px solid #2a2f3a; display: flex; gap: 12px; align-items: center; }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; }
  #token { background: #0f1115; color: #e6e6e6; border: 1px solid #2a2f3a; border-radius: 6px; padding: 6px 8px; width: 150px; }
  .seg { margin-left: auto; display: flex; border: 1px solid #2a2f3a; border-radius: 8px; overflow: hidden; }
  .seg button { background: #0f1115; color: #9aa4b2; border: 0; padding: 7px 15px; font-size: 13px; cursor: pointer; }
  .seg button.on { background: #2f6feb; color: #fff; }
  main { max-width: 820px; margin: 0 auto; padding: 16px; }
  #log { padding-bottom: 120px; }
  .modelog { display: none; flex-direction: column; gap: 12px; }
  .modelog.on { display: flex; }
  .msg { padding: 12px 14px; border-radius: 10px; white-space: pre-wrap; line-height: 1.6; }
  .user { background: #1e2735; align-self: flex-end; max-width: 80%; }
  .bot { background: #171a21; border: 1px solid #2a2f3a; }
  .sources { margin-top: 10px; font-size: 12px; color: #9aa4b2; border-top: 1px dashed #2a2f3a; padding-top: 8px; }
  .sources a { color: #6ea8fe; text-decoration: none; }
  form { position: fixed; bottom: 0; left: 0; right: 0; background: #171a21; border-top: 1px solid #2a2f3a; padding: 12px; }
  .row { max-width: 820px; margin: 0 auto; display: flex; gap: 8px; }
  #input { flex: 1; background: #0f1115; color: #e6e6e6; border: 1px solid #2a2f3a; border-radius: 8px; padding: 10px 12px; font-size: 15px; }
  button { background: #2f6feb; color: #fff; border: 0; border-radius: 8px; padding: 10px 16px; font-size: 15px; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
</style>
</head>
<body>
<header>
  <h1>${name} の分身</h1>
  <div class="seg" id="mode">
    <button data-mode="decision" data-placeholder="値引き可否・提案方針など、その場の判断を相談…" class="on" type="button">即断</button>
    <button data-mode="hiring" data-placeholder="候補者の職歴・面接メモを貼り付けて採用判断を相談…" type="button">採用</button>
    <button data-mode="chat" data-placeholder="議題や相談を入力…" type="button">壁打ち</button>
  </div>
  <input id="token" type="password" placeholder="アクセストークン" />
</header>
<main><div id="log"></div></main>
<form id="form"><div class="row">
  <input id="input" placeholder="議題や相談を入力…" autocomplete="off" />
  <button id="send" type="submit">送信</button>
</div></form>
<script>
  const logRoot = document.getElementById('log');
  const form = document.getElementById('form');
  const input = document.getElementById('input');
  const send = document.getElementById('send');
  const tokenEl = document.getElementById('token');
  tokenEl.value = localStorage.getItem('ec_token') || '';
  tokenEl.addEventListener('change', () => localStorage.setItem('ec_token', tokenEl.value));

  // モードごとに会話履歴と表示欄を分離する。
  // 採用モードに貼られた候補者情報が、他モードのリクエストに紛れ込むのを防ぐ。
  var mode = 'decision';
  var modeEl = document.getElementById('mode');
  var logs = {}, histories = {};
  modeEl.querySelectorAll('button').forEach(function (b) {
    var m = b.dataset.mode;
    histories[m] = [];
    var d = document.createElement('div');
    d.className = 'modelog';
    logRoot.appendChild(d);
    logs[m] = d;
  });
  function applyMode() {
    modeEl.querySelectorAll('button').forEach(function (b) {
      var on = b.dataset.mode === mode;
      b.classList.toggle('on', on);
      logs[b.dataset.mode].classList.toggle('on', on);
      if (on) input.placeholder = b.dataset.placeholder;
    });
  }
  modeEl.addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    mode = b.dataset.mode; applyMode();
  });
  applyMode();

  function add(m, role, text, sources) {
    const div = document.createElement('div');
    div.className = 'msg ' + (role === 'user' ? 'user' : 'bot');
    div.textContent = text;
    if (sources && sources.length) {
      const s = document.createElement('div');
      s.className = 'sources';
      s.innerHTML = '参照元: ' + sources.map(function (x) {
        return x.url ? '<a href="' + x.url + '" target="_blank">[' + x.tag + ']</a> ' + escapeHtml(x.label)
                     : '[' + x.tag + '] ' + escapeHtml(x.label);
      }).join('<br>');
      div.appendChild(s);
    }
    logs[m].appendChild(div);
    window.scrollTo(0, document.body.scrollHeight);
  }
  function escapeHtml(s){ const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    const msg = input.value.trim();
    if (!msg) return;
    const m = mode; // 応答待ちの間に切り替えても、送信時のモードの欄・履歴に入れる
    add(m, 'user', msg);
    input.value = '';
    send.disabled = true;
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + tokenEl.value },
        body: JSON.stringify({ message: msg, history: histories[m], mode: m })
      });
      const data = await res.json();
      if (!res.ok) { add(m, 'bot', '[エラー] ' + (data.error || res.status)); return; }
      add(m, 'bot', data.answer, data.sources);
      histories[m].push({ role: 'user', content: msg });
      histories[m].push({ role: 'assistant', content: data.answer });
    } catch (err) {
      add(m, 'bot', '[通信エラー] ' + err);
    } finally {
      send.disabled = false;
      input.focus();
    }
  });
</script>
</body>
</html>`;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
