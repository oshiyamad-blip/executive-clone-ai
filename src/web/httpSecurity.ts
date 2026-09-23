// ローカルWeb UI（経営者クローンの対話UI・SESマッチ確認UI）共通のHTTP防御。
// - 本文は Buffer で集めてから一度だけUTF-8に復号する（チャンク境界で日本語が化けないように）。上限超過は413
// - トークン無しの運用（ローカル専用）では、Host がループバック以外の要求を拒否する（DNSリバインディング対策）
// - 状態を変える POST は JSON の Content-Type と同一オリジンの Origin を必須にする（他サイトからの送信=CSRF対策。
//   text/plain の「単純リクエスト」はプリフライト無しで送れてしまうため）
// - 画面は他サイトに埋め込ませない（クリックジャッキング対策）
import type { IncomingMessage, ServerResponse } from 'http';

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function readBody(req: IncomingMessage, maxBytes = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        reject(new HttpError(413, 'リクエストが大きすぎます'));
        req.resume(); // 残りは読み捨てる（応答を返せるように接続は切らない）
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!tooLarge) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

// JSONのオブジェクト本文を読む。形式・Content-Type が不正なら HttpError(400/415)
export async function readJsonObject(req: IncomingMessage, maxBytes?: number): Promise<Record<string, unknown>> {
  const type = String(req.headers['content-type'] ?? '').toLowerCase();
  if (!type.startsWith('application/json')) throw new HttpError(415, 'Content-Type は application/json にしてください');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBody(req, maxBytes));
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, 'JSONの形式が不正です');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'JSONの形式が不正です');
  return parsed as Record<string, unknown>;
}

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.split(':')[0];
}

// 要求を受け付けてよいか。拒否する場合は理由（ステータスと文言）を返す
export function rejectReason(req: IncomingMessage, opts: { tokenRequired: boolean }): HttpError | null {
  const host = String(req.headers.host ?? '');
  // トークン認証が無い運用ではループバック名以外の Host を拒否する（攻撃者のドメインを127.0.0.1に向ける手口を防ぐ）
  if (!opts.tokenRequired && !isLoopbackHost(hostnameOf(host))) {
    return new HttpError(403, 'このUIはローカル（127.0.0.1 / localhost）からのみ利用できます');
  }
  if (req.method === 'POST') {
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${host}` && origin !== `https://${host}`) {
      return new HttpError(403, '他のサイトからの要求は受け付けません');
    }
  }
  return null;
}

export function securityHeaders(): Record<string, string> {
  return {
    'x-frame-options': 'DENY',
    'content-security-policy': "frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  };
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...securityHeaders() });
  res.end(JSON.stringify(body));
}

// ハンドラの例外（形式不正・上限超過・想定外）を応答に変える（未処理の reject でプロセスを落とさない）
export function runHandler(res: ServerResponse, handler: () => Promise<void>): void {
  handler().catch((err: unknown) => {
    if (err instanceof HttpError) sendJson(res, err.status, { error: err.message });
    else {
      console.error(`Web UI: 処理中にエラー: ${err instanceof Error ? err.name : typeof err}`);
      sendJson(res, 500, { error: '処理中にエラーが発生しました' });
    }
  });
}

// トークン無しで非ループバックに公開しようとしていないか（起動時の確認）
export function unsafeBind(host: string, token: string): boolean {
  return !token && !isLoopbackHost(host);
}

// 非ループバックで平文HTTPのまま待ち受けようとしていないか（起動時の確認）。平文ではアクセストークン（Authorizationヘッダ）と
// 応答の中身が同じネットワークの誰からも読めるため、HTTPS で待ち受けるか、TLS終端（リバースプロキシ・VPN）の内側である
// ことを明示したときだけ許す
export function plaintextExposure(host: string, tlsProtected: boolean): boolean {
  return !tlsProtected && !isLoopbackHost(host);
}
