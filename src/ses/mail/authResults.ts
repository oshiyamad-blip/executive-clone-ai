// 受信サーバーが付けた送信ドメイン認証の結果（Authentication-Results ヘッダ）から、DMARC に合格した From のドメインを読む。
// From は誰でも書けるため、再送スキップの「同じ送り主」の判定に使う送り主の識別は、認証に合格したドメインか、
// 合格していなければアドレスそのものにする（resend.ts）。
// ヘッダは送り主も書けるため、受信サーバーが付けた一番上の1つだけを読む（下にある送り主の書いたものは読まない）

// 一番上の Authentication-Results の値 → DMARC に合格した header.from のドメイン（小文字）。無ければ ''
export function dmarcPassDomain(topAuthResults: string): string {
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
