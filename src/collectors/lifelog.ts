import type { RawLog } from '../types/index.js';

// ライフログデバイスから対面会話・独り言を収集する
// 対応デバイス・サービス: Plaud Note / Otter.ai / Notta など
export async function collectFromLifelog(): Promise<RawLog[]> {
  // TODO: 各サービスのAPIまたはエクスポートデータを取り込む
  // - Plaud Note: エクスポートJSON/CSV の解析
  // - Otter.ai: API連携（conversations endpoint）
  // - Notta: API連携
  // 取得した文字起こしテキストをRawLogとして格納

  console.log('ライフログ: 収集処理は未実装です');
  return [];
}
