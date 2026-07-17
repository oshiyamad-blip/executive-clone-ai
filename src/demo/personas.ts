import type { ExecutiveProfile, Signal, Story } from '../types/index.js';
import { DEMO_PROFILE, DEMO_SIGNALS, DEMO_STORIES } from './sampleData.js';
import { MIKITANI_PROFILE, MIKITANI_SIGNALS, MIKITANI_STORIES } from './mikitani.js';

// デモ用ペルソナの切り替え。DEMO_PERSONA 環境変数で選ぶ（既定: mikitani）。
export interface PersonaData {
  profile: ExecutiveProfile;
  signals: Signal[];
  stories: Story[];
}

const PERSONAS: Record<string, PersonaData> = {
  // 架空企業「サンプルテック」の代表
  sample: { profile: DEMO_PROFILE, signals: DEMO_SIGNALS, stories: DEMO_STORIES },
  // 三木谷浩史スタイル（公開情報ベースの再現デモ）
  mikitani: { profile: MIKITANI_PROFILE, signals: MIKITANI_SIGNALS, stories: MIKITANI_STORIES },
};

export function getPersona(name?: string): PersonaData {
  return PERSONAS[name ?? ''] ?? PERSONAS.mikitani;
}
