// 構造化出力を保証しないプロバイダ（Gemini はスキーマをプロンプトで伝えるだけ）の応答を、渡したJSON Schemaの範囲で確かめる。
// 形の違うJSON（配列のはずがオブジェクト、真偽値のはずが文字列 等）をそのまま呼び出し側に渡すと、読み出しの TypeError が
// 基盤の障害と見分けられず、同じメールで毎回止まるため。使っている範囲（type・enum・properties・required・
// additionalProperties・items・anyOf）だけを確かめる。合っていれば null、違えば最初の違いの場所を返す
type Schema = {
  type?: string | string[];
  enum?: readonly unknown[];
  properties?: Record<string, Schema>;
  required?: readonly string[];
  additionalProperties?: boolean;
  items?: Schema;
  anyOf?: readonly Schema[];
};

function typeOk(value: unknown, type: string): boolean {
  switch (type) {
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return true;
  }
}

export function schemaMismatch(value: unknown, schema: object, path = '$', depth = 0): string | null {
  const s = schema as Schema;
  if (depth > 20) return null;
  if (s.anyOf) {
    return s.anyOf.some((sub) => schemaMismatch(value, sub, path, depth + 1) === null) ? null : path;
  }
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some((t) => typeOk(value, t))) return path;
  }
  if (s.enum && !s.enum.includes(value)) return path;
  if (Array.isArray(value) && s.items) {
    for (let i = 0; i < value.length; i++) {
      const bad = schemaMismatch(value[i], s.items, `${path}[${i}]`, depth + 1);
      if (bad) return bad;
    }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && s.properties) {
    const obj = value as Record<string, unknown>;
    for (const key of s.required ?? []) if (!(key in obj)) return `${path}.${key}`;
    for (const [key, v] of Object.entries(obj)) {
      const sub = s.properties[key];
      if (!sub) {
        if (s.additionalProperties === false) return `${path}.${key}`;
        continue;
      }
      const bad = schemaMismatch(v, sub, `${path}.${key}`, depth + 1);
      if (bad) return bad;
    }
  }
  return null;
}
