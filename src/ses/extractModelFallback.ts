// 抽出モデル（既定 Haiku 4.5）の退役・提供終了への備え。設定されたモデルが使えないとAPIが答えたら、
// このプロセスの残りの抽出（メール・スキルシート）を判定用モデル（既定 Sonnet 5）に切り替えて続け、
// 費用が増える旨をバッチの診断（サマリメール）に載せる。Haiku 向けの設定（thinking なし・effort なし）は
// llm/anthropic.ts がモデル名で決めるため、代替モデルには従来どおりの規則で adaptive thinking が付く
import { isModelUnavailableError } from '../llm/errors.js';
import {
  isDemo,
  configuredExtractModel,
  matchModel,
  activateExtractModelFallback,
  extractModelFallbackActive,
} from './config.js';
import { recordHealEvent } from './heal/events.js';

export const EXTRACT_FALLBACK_MESSAGE = '抽出モデルが利用できないため判定モデルで代替（費用増）';

// 切り替えてよいか: 設定どおりの抽出モデルでの失敗で、判定用モデルが別のモデルのときだけ
export function shouldFallbackExtractModel(err: unknown, usedModel: string): boolean {
  if (isDemo() || extractModelFallbackActive()) return false;
  const configured = configuredExtractModel();
  return usedModel === configured && matchModel() !== configured && isModelUnavailableError(err);
}

function activate(): void {
  activateExtractModelFallback();
  recordHealEvent(
    'warn',
    `${EXTRACT_FALLBACK_MESSAGE}: 抽出モデル ${configuredExtractModel()} をAPIが受け付けないため、この実行の残りの抽出は ${matchModel()} で行います。` +
      '退役・提供終了の可能性があります。Variables（.env.local）の ANTHROPIC_MODEL_EXTRACT を後継のモデルに変更してください',
  );
}

// model で呼び、モデルが使えないエラーなら代替モデルで1回だけ呼び直す（以後の呼び出しは extractModel() が代替モデルを返す）
export async function withExtractModelFallback<T>(model: string, call: (model: string) => Promise<T>): Promise<T> {
  try {
    return await call(model);
  } catch (err) {
    if (!shouldFallbackExtractModel(err, model)) throw err;
    activate();
    return call(matchModel());
  }
}
