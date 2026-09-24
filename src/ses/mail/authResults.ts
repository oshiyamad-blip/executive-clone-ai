// 受信サーバーが付けた送信ドメイン認証の結果（Authentication-Results ヘッダ）から、DMARC に合格した From のドメインを読む。
// From は誰でも書けるため、再送スキップの「同じ送り主」の判定に使う送り主の識別は、認証に合格したドメインか、
// 合格していなければアドレスそのものにする（resend.ts）。
// ヘッダは送り主も書けるため、受信サーバーが付けた一番上の1つだけを読み、さらにその authserv-id（受信サーバーの名前）が
// 設定した値（XSERVER_AUTHSERV_ID）と一致するときだけ信じる（RFC 8601 5章）。受信サーバーが自分の結果を付けない構成では、
// 一番上のヘッダが送り主の書いたものになるため。設定が無い・一致しないときは認証されていない扱い（fail closed）

// Authentication-Results の値の authserv-id（小文字。無ければ ''）
export function authservIdOf(authResults: string): string {
  const value = (authResults ?? '').replace(/\([^()]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  const first = value.split(';')[0]?.trim() ?? '';
  return (first.split(' ')[0] ?? '').toLowerCase().replace(/\.$/, '');
}

// authserv-id が信頼する値のどれかと一致するか（'*.xserver.jp' のように先頭の '*.' はそのドメインの配下すべて）
export function authservIdTrusted(id: string, trusted: readonly string[]): boolean {
  const v = id.toLowerCase();
  if (!v) return false;
  return trusted.some((t) => {
    const x = t.trim().toLowerCase().replace(/\.$/, '');
    if (!x) return false;
    if (x.startsWith('*.')) {
      const suffix = x.slice(1);
      return v.endsWith(suffix) && v.length > suffix.length;
    }
    return v === x;
  });
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
