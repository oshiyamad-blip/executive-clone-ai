// 受信サーバーが付けた送信ドメイン認証の結果（Authentication-Results ヘッダ）から、DMARC に合格した From のドメインを読む。
// From は誰でも書けるため、再送スキップの「同じ送り主」の判定に使う送り主の識別は、認証に合格したドメインか、
// 合格していなければアドレスそのものにする（resend.ts）。
// ヘッダは送り主も書けるため、受信サーバーが付けた一番上の1つだけを読み、さらにその authserv-id（受信サーバーの名前）が
// 設定した値（XSERVER_AUTHSERV_ID。1つだけ・完全一致）と一致するときだけ信じる（RFC 8601 5章）。受信サーバーが自分の結果を付けない構成では、
// 一番上のヘッダが送り主の書いたものになるため。設定が無い・一致しないときは認証されていない扱い（fail closed）

// Authentication-Results の値の authserv-id（小文字。無ければ ''）
// ヘッダの値からコメント（括弧）を入れ子も含めて取り除き、空白を1つにする。Postfix の TLS のコメント
// （using TLSv1.3 with cipher ... (256/256 bits) ...）のように括弧の中に括弧と with があるため、1回では取り除けない
export function stripHeaderComments(value: string): string {
  let s = value ?? '';
  for (let i = 0; i < 20 && /\([^()]*\)/.test(s); i++) s = s.replace(/\([^()]*\)/g, ' ');
  return s.replace(/\s+/g, ' ');
}

export function authservIdOf(authResults: string): string {
  const value = stripHeaderComments(authResults).trim();
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
  const value = stripHeaderComments(received);
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
      trusted =
        topReceivedByUs &&
        above.every((x) => authservIdTrusted(receivedByHost(x.h.value), trustedAuthservIds)) &&
        enteredFromOutside(received, arIndex, trustedAuthservIds);
    }
  }
  const authDomain = trusted ? dmarcPassDomain(headers[arIndex].value, trustedAuthservIds) : '';
  return { authDomain, trusted, receivedByUsWithoutResult: topReceivedByUs && !trusted };
}

// 結果より上の受信サーバーの段と、結果を付けた段（結果のすぐ下の受信サーバーの Received。無ければ結果より上の一番下の段）から、
// メールが外のサーバーからの SMTP で受信サーバーに入ったか。結果より下の段は送り主も書けるため、すぐ下の1段より下は見ない。
// 結果より上に認証して送った段・サーバーの中から出した段（from の無い pickup）があれば、結果は送り主が書いたもの
// （受信サーバーは認証して送られたメールに結果を付けないことがある）なので信じない。ローカル配送（LMTP 等）の段は構わない
function enteredFromOutside(
  received: ReadonlyArray<{ h: HeaderField; i: number }>,
  arIndex: number,
  trustedAuthservIds: readonly string[],
): boolean {
  const above = received.filter((x) => x.i < arIndex).map((x) => x.h.value);
  if (above.some((r) => !receivedFromOutside(r) && !isLocalDelivery(r))) return false;
  const next = received.find((x) => x.i > arIndex);
  const entry =
    next && authservIdTrusted(receivedByHost(next.h.value), trustedAuthservIds) ? next.h.value : [...above].reverse().find((r) => !isLocalDelivery(r)) ?? '';
  return receivedFromOutside(entry);
}

// Received の値 → by の後の with のプロトコル（大文字。無ければ ''）。from 句のコメントの中の with（TLS の cipher 等）は読まない
function receivedProtocol(flat: string): string {
  const afterBy = flat.match(/(?:^|\s)by\s+\S+(.*)$/i)?.[1] ?? '';
  return (afterBy.match(/(?:^|\s)with\s+([A-Za-z0-9]+)/i)?.[1] ?? '').toUpperCase();
}

// サーバーの中の配送の段（LMTP・local。from を持たないことが多い）
function isLocalDelivery(received: string): boolean {
  if (/authenticated\s+sender|\(authenticated\b/i.test(received)) return false;
  return /^(?:LMTPS?|LOCAL)$/.test(receivedProtocol(stripHeaderComments(received)));
}

// 受信サーバーに入った段が、外のサーバーからの SMTP の受け取り（MX）か。同じ共有サーバーの別の利用者が認証して送った
// （with ESMTPA・ESMTPSA・Authenticated sender）・サーバーの中から出した（from の無い pickup）メールには、受信サーバーが
// 自分の認証結果を付けないことがあり、送り主の書いた結果が一番上に来るため信じない
export function receivedFromOutside(received: string): boolean {
  if (!received) return false;
  if (/authenticated\s+sender|\(authenticated\b/i.test(received)) return false;
  const flat = stripHeaderComments(received);
  if (!/^\s*from\s+\S/i.test(flat)) return false;
  return /^(?:UTF8)?E?SMTPS?$/.test(receivedProtocol(flat));
}

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
  const value = stripHeaderComments(topAuthResults);
  for (const part of value.split(';').slice(1)) {
    const m = part.trim().match(/^dmarc\s*=\s*([a-z]+)\b(.*)$/i);
    if (!m) continue;
    if (m[1].toLowerCase() !== 'pass') return '';
    const from = m[2].match(/\bheader\.from\s*=\s*"?([a-z0-9.-]+)"?/i)?.[1] ?? '';
    return from.toLowerCase().replace(/\.$/, '');
  }
  return '';
}
