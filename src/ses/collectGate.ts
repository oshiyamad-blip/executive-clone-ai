// index.ts は読み込むだけでバッチが走るため、自己検証から使う判定はここに分ける。
// 新着0通のまま古い案件で判定し直すと、営業リストの未着手の行を期限切れへ移してしまうため、収集に失敗した回は見送る
export function shouldSkipProperAfterCollectFailure(collectFailed: boolean): boolean {
  return collectFailed;
}
