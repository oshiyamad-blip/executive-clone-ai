// 受信サーバーが付けた送信ドメイン認証の結果（Authentication-Results ヘッダ）から、DMARC に合格した From のドメインを読む。
// From は誰でも書けるため、再送スキップの「同じ送り主」の判定に使う送り主の識別は、認証に合格したドメインか、
// 合格していなければアドレスそのものにする（resend.ts）。
// ヘッダは送り主も書けるため、受信サーバーが付けた一番上の1つだけを読み、さらにその authserv-id（受信サーバーの名前）が
// 設定した値（XSERVER_AUTHSERV_ID。1つだけ・完全一致）と一致するときだけ信じる（RFC 8601 5章）。受信サーバーが自分の結果を付けない構成では、
// 一番上のヘッダが送り主の書いたものになるため。設定が無い・一致しないときは認証されていない扱い（fail closed）

// Authentication-Results の値の authserv-id（小文字。無ければ ''）
export function authservIdOf(authResults: string): string {
  const value = (authResults ?? '').replace(/\([^()]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  const first = value.split(';')[0]?.trim() ?? '';
  return (first.split(' ')[0] ?? '').toLowerCase().replace(/\.$/, '');
}

// authserv-id が信頼する値のどれかと完全に一致するか。'*.xserver.jp' のようなワイルドカードは受け付けない
// （共有ホスティングでは同じドメインの別のサーバー名を誰でも名乗れ、受信サーバーは自分の名前のヘッダしか取り除かないため）
export function authservIdTrusted(id: string, trusted: readonly string[]): boolean {
  const v = id.toLowerCase();
  if (!v) return false;
  return trusted.some((t) => {
    const x = t.trim().toLowerCase().replace(/\.$/, '');
    if (!x || x.includes('*')) return false;
    return v === x;
  });
}

// Received ヘッダの値 → 受け取ったサーバー（by の後の名前。小文字。無ければ ''）
export function receivedByHost(received: string): string {
  const value = (received ?? '').replace(/\([^()]*\)/g, ' ').replace(/\s+/g, ' ');
  return (value.match(/(?:^|\s)by\s+([^\s;]+)/i)?.[1] ?? '').toLowerCase().replace(/\.$/, '');
}

export interface HeaderField {
  key: string;
  value: string;
}

export interface AuthResultsCheck {
  authDomain: string; // DMARC に合格した header.from のドメイン（信じられなければ ''）
  trusted: boolean; // 信じてよい受信サーバーの結果（dmarc= を含む）が一番上にあったか
  receivedByUsWithoutResult: boolean; // 一番上の Received が受信サーバーなのに、信じてよい結果が無い
}

// ヘッダの並び（上から順）から、受信サーバーが付けた送信ドメイン認証の結果を読む。
// 一番上の Authentication-Results の authserv-id が信頼する値と一致すること。requireReceivedBy のときはさらに、
// 一番上の Received が受信サーバー（信頼する名前）のもので、その結果より上に他のサーバーの Received が無いこと
// （受信サーバーが結果を付けない経路では、一番上の結果は送り主の書いたものになるため）
export function checkAuthResults(
  headers: readonly HeaderField[],
  trustedAuthservIds: readonly string[],
  opts: { requireReceivedBy: boolean },
): AuthResultsCheck {
  const lower = (k: string) => k.trim().toLowerCase();
  const arIndex = headers.findIndex((h) => lower(h.key) === 'authentication-results');
  const received = headers.map((h, i) => ({ h, i })).filter((x) => lower(x.h.key) === 'received');
  const topReceivedByUs = received.length > 0 && authservIdTrusted(receivedByHost(received[0].h.value), trustedAuthservIds);
  let trusted = false;
  if (arIndex >= 0) {
    const ar = headers[arIndex].value;
    trusted = authservIdTrusted(authservIdOf(ar), trustedAuthservIds) && /\bdmarc\s*=/i.test(ar);
    if (trusted && opts.requireReceivedBy) {
      const above = received.filter((x) => x.i < arIndex);
      trusted = topReceivedByUs && above.every((x) => authservIdTrusted(receivedByHost(x.h.value), trustedAuthservIds));
    }
  }
  const authDomain = trusted ? dmarcPassDomain(headers[arIndex].value, trustedAuthservIds) : '';
  return { authDomain, trusted, receivedByUsWithoutResult: topReceivedByUs && !trusted };
}

// 1回の収集で、受信サーバーの結果を信じられたメールの数から出す警告（無ければ null）。Xserver・Gmail の両経路で使う
export function authResultsWarning(
  label: string,
  setting: string,
  counts: { mails: number; trusted: number; receivedByUsWithoutResult: number },
): string | null {
  if (counts.mails >= 3 && counts.trusted === 0) {
    return (
      `${label}: ${setting} と一致し dmarc= の結果を含む Authentication-Results が一番上にあるメールがありませんでした` +
      '（受信したメールのヘッダを確かめ、設定を直してください。一致しないメールの送り主は認証されていない扱いです）'
    );
  }
  if (counts.trusted > 0 && counts.receivedByUsWithoutResult > 0) {
    return (
      `${label}: 受信サーバーを通ったのに信じてよい認証結果が一番上に無いメールが${counts.receivedByUsWithoutResult}件ありました` +
      '（受信サーバーが結果を付けない経路があります。そのメールの送り主は認証されていない扱いです）'
    );
  }
  return null;
}

// 一番上の Authentication-Results の値 → DMARC に合格した header.from のドメイン（小文字）。
// authserv-id が信頼する値と一致しなければ（設定が無ければ）''
export function dmarcPassDomain(topAuthResults: string, trustedAuthservIds: readonly string[]): string {
  if (!authservIdTrusted(authservIdOf(topAuthResults), trustedAuthservIds)) return '';
  const value = (topAuthResults ?? '').replace(/\([^()]*\)/g, ' ').replace(/\s+/g, ' ');
  for (const part of value.split(';').slice(1)) {
    const m = part.trim().match(/^dmarc\s*=\s*([a-z]+)\b(.*)$/i);
    if (!m) continue;
    if (m[1].toLowerCase() !== 'pass') return '';
    const from = m[2].match(/\bheader\.from\s*=\s*"?([a-z0-9.-]+)"?/i)?.[1] ?? '';
    return from.toLowerCase().replace(/\.$/, '');
  }
  return '';
}
