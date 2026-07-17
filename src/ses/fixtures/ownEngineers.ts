// demo用の固定「自社社員」データ。fixtures/mails.ts の案件と突き合わせて
// 「必要案件単価を満たして成立」「単価不足で除外」の両分岐を再現できるよう用意する。
import type { OwnEngineer } from '../../types/index.js';

export const FIXTURE_OWN_ENGINEERS: OwnEngineer[] = [
  // A.K.: PHP/MySQL/AWS・必要案件単価65万。P1(単金60〜75万・東京)を満たし「成立」
  {
    id: 'own_demo_ak',
    displayName: 'A.K.（自社）',
    skills: ['PHP', 'MySQL', 'AWS'],
    experienceYears: 7,
    requiredProjectRate: 65,
    residence: '東京都世田谷区',
    prefecture: '東京都',
    availableDate: '即日',
    availableFrom: '2026-07-16',
    remoteWish: 'partial',
    status: 'available',
  },
  // B.S.: Python/GCP・必要案件単価70万・フルリモート希望。Python案件(65〜80万・フルリモート)を満たし「成立」
  {
    id: 'own_demo_bs',
    displayName: 'B.S.（自社）',
    skills: ['Python', 'GCP', 'SQL'],
    experienceYears: 5,
    requiredProjectRate: 70,
    residence: '千葉県千葉市',
    prefecture: '千葉県',
    availableDate: '2026年9月〜',
    availableFrom: '2026-09-01',
    remoteWish: 'full',
    status: 'available',
  },
  // C.T.: Java/Spring・必要案件単価65万。Java案件(単金55〜60万)は単価不足のため「除外」される
  {
    id: 'own_demo_ct',
    displayName: 'C.T.（自社）',
    skills: ['Java', 'Spring Boot'],
    experienceYears: 9,
    requiredProjectRate: 65,
    residence: '大阪府大阪市',
    prefecture: '大阪府',
    availableDate: '2026年8月〜',
    availableFrom: '2026-08-01',
    remoteWish: 'none',
    status: 'available',
  },
];

export function loadFixtureOwnEngineers(): OwnEngineer[] {
  return FIXTURE_OWN_ENGINEERS;
}
