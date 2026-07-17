# 運用ガイド（やることベース）

経営者クローンAIの日々の運用を「誰が・いつ・何をするか」で具体的にまとめます。
想定構成: **LINE（主要チャネル）＋ Plaud NotePin S（対面・独り言）**、保存先は Notion。

---

## 0. 最初の一度だけ（セットアップ）

担当: 構築者

1. `npm install`
2. `npm run setup` で `.env.local` を生成し、最低限を記入
   - `ANTHROPIC_API_KEY`（ZDRキー推奨）
   - `NOTION_TOKEN` / `NOTION_SIGNAL_DB_ID` / `NOTION_STORY_DB_ID`
3. Notion に「シグナルDB」「ストーリーDB」を作成（プロパティは `README.md` 参照）→ 各DBの **Connections** でインテグレーションを共有
4. `src/data/executiveProfile.ts` に経営者本人の**価値観・15の意思決定ルール・成功/失敗パターン**を登録（要件3.3 初期設定）
5. 動作確認: `lifelog-inbox/` か `messenger-inbox/` にサンプルを1つ置く → `npm run daily` → Notion にシグナルが入るか確認 → `npm run chat`
6. 自動実行を仕込む（下記「自動化」）

---

## 1. 自動で回る部分（設定後は放置でOK）

| いつ | 何が起きる | 起動 |
|---|---|---|
| 毎日 3:00 | `collect`（収集→名寄せ→永続化）→ `extract`（重要情報だけ抽出→シグナルDB） | cron / systemd |
| 日曜 4:00 | `analyze`（因果を整理→ストーリーDB） | cron / systemd |

### 自動化の設定

**方法A: cron（手軽）**
```bash
./scripts/install-cron.sh
# 時刻を変えたい場合:
# DAILY_CRON="30 2 * * *" WEEKLY_CRON="0 5 * * 0" ./scripts/install-cron.sh
# 解除: crontab -l | grep -v '# executive-clone-ai' | crontab -
```

**方法B: systemd（サーバー常駐向け）**
```bash
# deploy/systemd/*.service の WorkingDirectory / User を自環境に修正してから
sudo cp deploy/systemd/exec-clone-*.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now exec-clone-daily.timer exec-clone-weekly.timer
systemctl list-timers | grep exec-clone   # 次回実行を確認
```

ログは `logs/daily.log` / `logs/weekly.log` に出ます。

---

## 2. 人がやること（これだけ）

### 経営者本人

- **録音する**: Plaud NotePin S を装着し、対面会議・打ち合わせ・独り言を録音。
  文字起こしが `lifelog-inbox/` に入るようにしておく（下記「取り込み経路」）。
- **LINEを週1でエクスポート**（下記手順）。
- **AIと対話する**: 気づきを増やすため、たまに `npm run chat` で壁打ちする（対話は学習ソースとして循環）。
- **四半期に1回**: 新しい判断軸・成功/失敗を `executiveProfile.ts` に追記。

### 経営企画・部門長

- **会議前に壁打ち**: `npm run chat` で「経営者ならどう判断するか」を事前に確認。
  回答末尾の `参照元:`（[S1][T1]）で根拠データを確認できる。

---

## 3. LINE の取り込み手順（週1・5分）

担当: 経営者本人 or 秘書

1. 対象トークを開く → 右上メニュー →「その他」→「トーク履歴を送信」
2. 保存先を **`messenger-inbox/` に同期されるフォルダ**にする（下記のコツ）
3. 次の日次バッチで自動取り込み（手動で今すぐなら `npm run collect`）

> **摩擦を減らすコツ（推奨セットアップ）**:
> 1. PC/サーバー側に Google Drive / iCloud / Dropbox のデスクトップ同期を入れ、
>    LINEエクスポート用フォルダ（例: `.../CloudDocs/LINE`）を1つ決める
> 2. `.env.local` で `MESSENGER_INBOX_DIR` にそのフォルダの**フルパス**を設定
> 3. `MESSENGER_ARCHIVE=false`（既定）のままにする＝**ファイルを動かさない非破壊モード**
>
> これで、スマホで「トーク履歴を送信」→ 保存先をそのクラウドフォルダにするだけで、
> 次の日次バッチが自動取り込みします（**PCでの操作ゼロ**）。
>
> **全履歴を再送してOK**: LINEエクスポートは毎回全履歴を含みますが、システムが
> `トーク×日付`単位で重複排除するため、**未取り込みの日だけ**が処理されます（実測確認済み）。
> 差分管理も、ファイルの削除・移動も不要です。

### Plaud（ライフログ）の取り込み経路
- **公式Zapier**「Transcript & Summary Ready」→ Drive等 → 同期フォルダを `LIFELOG_INBOX_DIR` に（ほぼ自動・推奨）
- 非公式CLI `plaud sync <dir>` を日次cron（完全ローカル、ToSリスクあり）
- アプリから手動エクスポート

---

## 3.5 デバイス到着後セットアップ（Plaud NotePin S → 推奨: Zapier自動化）

デバイスが届いたら、**録音 → 文字起こし → `lifelog-inbox/` 反映まで自動**にする。

### A. デバイス初期設定
1. Plaud アプリを入れてアカウント作成 → NotePin S を充電・ペアリング
2. 言語を日本語に設定 → テスト録音で文字起こし＆要約が出るか確認

### B. Zapier で「文字起こし → クラウドフォルダ」を自動化
1. Zapを新規作成
2. **トリガー**: Plaud → イベント「Transcript & Summary Ready」→ Plaudアカウント連携
3. **アクション**: Google Drive →「Create File from Text」（テキストからファイル作成）
   - Folder: 専用フォルダ（例 `PlaudTranscripts`）
   - **File Name**: `{{StartTime|date:YYYY-MM-DD}}_{{Title}}.txt`
     （日付をファイル名先頭に入れる。`/ : *` 等の禁止文字はTitle整形で除去）
   - **File Content**: `{{Transcript}}`（話者ラベル付き本文。先頭に `{{Summary}}` を足してもよい）
   - ⚠️ 出力が **Googleドキュメントでなく本物の `.txt`** になる設定にする。
     難しければ **Dropbox の "Create/Upload File"** を使う（プレーンテキストで確実に保存される）
4. テスト → Zapを ON

### C. マシン側（PC/サーバー）
1. Google Drive for desktop（またはDropbox）を入れ、上記フォルダを**ローカル同期**
2. `.env.local` に設定:
   ```
   LIFELOG_INBOX_DIR=/絶対パス/.../PlaudTranscripts
   LIFELOG_ARCHIVE=false      # 同期フォルダ上でファイルを動かさない
   ```

### D. 疎通確認（一度だけ）
1. テスト録音 → 数分後にフォルダへ `.txt` が現れる
2. `npm run collect` → `npm run extract` → Notion シグナルDB に入るか確認
3. `npm run chat` で参照されるか確認 → 以降は日次バッチが自動処理

### 注意
- 文字起こしは会議終了後に**非同期生成**（リアルタイムではない・数分〜）
- ファイル名は変えない（一意な録音名を重複排除IDに使う）
- 対面録音は相手の**同意**を（特に社外）
- Zapier連携に Plaud 有料プラン/Zapier プランが要る場合あり（要確認）

---

## 4. 週次・月次の確認（推奨）

- **週次**: Notion のシグナルDB/ストーリーDBに新規が増えているか、`logs/` にエラーが出ていないか
- **月次**: 抽出の粒度が荒い/細かい場合は `SIGNAL_IMPORTANCE_THRESHOLD` を調整（既定5）

---

## 5. トラブル時のチェック

| 症状 | 確認 |
|---|---|
| シグナルが増えない | inbox にファイルが入っているか / `logs/daily.log` / `.env.local` の必須3項目 |
| cronが動かない | `logs/daily.log` に記録があるか / `scripts/run-daily.sh` に実行権限があるか / node のPATH |
| Notionに保存されない | Connections でDBにインテグレーション共有済みか / DBプロパティ名が一致しているか |
| 特定ソースが空 | そのソースの環境変数が未設定（未設定ソースは安全にスキップされる） |

---

## まとめ（定常運用の1週間）

```
毎日      : （自動）3:00 に収集＋抽出
日曜      : （自動）4:00 にストーリー生成
週1回     : 人が LINE をエクスポートして inbox へ（5分）
随時      : 人が Plaud で録音、会議前に AI と壁打ち
四半期    : 人がプロファイルを見直し
```
