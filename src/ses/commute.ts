// 通勤距離の印: 常駐・出社のある案件で、要員の最寄駅と勤務地の駅の直線距離が SES_COMMUTE_FLAG_KM 以上なら確認事項に1行足す。
// 組は外さない（営業の反応を見て基準を決めるため）。駅の位置は src/ses/station.ts
import { commuteFlagKm, commuteMinPerKm } from './config.js';
import { isFullRemoteLocation } from './prefecture.js';
import { distanceKm, locatePair } from './station.js';
import type { Project } from '../types/index.js';

export interface CommuteDistance {
  km: number;
  minutes: number;
}

// 両方の位置が引けたときの直線距離と片道の目安。案件がフルリモート（remote が full・勤務地がフルリモート）なら null。
// homes は要員の最寄駅・住まいの文（先に引けたものを使う）
export function commuteDistanceOf(project: Pick<Project, 'location' | 'remote'>, homes: string[]): CommuteDistance | null {
  if (project.remote === 'full' || isFullRemoteLocation(project.location)) return null;
  for (const home of homes) {
    if (!home.trim()) continue;
    const pair = locatePair(project.location, home);
    if (!pair) continue;
    const km = distanceKm(pair.a, pair.b);
    return { km, minutes: km * commuteMinPerKm() };
  }
  return null;
}

// 確認事項の1行。印を付けないときは null
export function commuteNoteOf(project: Pick<Project, 'location' | 'remote'>, homes: string[]): string | null {
  const flag = commuteFlagKm();
  if (flag <= 0) return null;
  const d = commuteDistanceOf(project, homes);
  if (!d || d.km < flag) return null;
  return `通勤: 直線約${Math.round(d.km)}km（片道約${Math.round(d.minutes)}分の見込み）`;
}
