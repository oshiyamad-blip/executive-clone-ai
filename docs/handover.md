# 引き渡しガイド — 新しい端末へのセットアップ（当日チェックリスト付き）

CEO の新端末にシステムを導入し、その場で動く状態で引き渡すための手順書です。
所要時間の目安: **最短コース（デモが動くまで）約30分 / 本番コース（Notion 連携まで）約1〜2時間**。

---

## 0. 前日までに準備しておくもの

| 項目 | 内容 | 備考 |
|---|---|---|
| **リポジトリの持ち込み手段** | GitHub アクセス権（推奨）、または zip | zip の場合 `.env.local` は絶対に含めない |
| **Gemini API キー** | **CEO 本人の Google アカウント**で [Google AI Studio](https://aistudio.google.com/) → 「Get API key」から無料発行 | 当日その場で発行してもOK（5分）。他人のキーを使い回さない |
| **Notion（本番まで行う場合）** | 社内ワークスペース、Internal Integration 作成権限 | シグナルDB / ストーリーDB のプロパティ定義は `README.md` 参照 |
| **経営者プロファイルの下書き** | 価値観 / 意思決定ルール / 成功・失敗パターン / 権限委譲ライン / 採用基準 | **[docs/hearing-sheet.md](hearing-sheet.md)** を使ってヒアリング（60〜90分）。事前に済ませると当日が速い |

---

## 1. 当日: 最短コース（デモが動くまで・約30分）

### 1-1. Node.js を入れる（Mac）

1. 「ターミナル」を開く（⌘+Space →「ターミナル」）
2. `git --version` を実行 — 初回はコマンドラインツールのインストールを求められるので「インストール」（数分）
3. [nodejs.org](https://nodejs.org/) から **LTS**（v20以上）の macOS インストーラ（.pkg）を実行
   （Homebrew があれば `brew install node` でも可）
4. 確認: ターミナルで `node --version` → `v20` 以上

### 1-2. リポジトリを配置して依存を入れる

```bash
git clone <このリポジトリのURL> executive-clone-ai   # または zip を展開
cd executive-clone-ai
npm install
```

### 1-3. 環境変数を設定する

```bash
npm run setup          # .env.local が生成される
```

`.env.local` をエディタで開き、最低限この2行を設定:

```
LLM_PROVIDER=gemini
GEMINI_API_KEY=（CEO本人が発行したキー）
```

### 1-4. 診断 → デモで動作確認

```bash
npm run doctor         # ✅/⚠️/❌ で不足を教えてくれる。❌ ゼロになればOK
npm run demo:decide -- "この案件、15%値引きまでOK？"   # 三木谷デモで即答が返れば成功
npm run demo:web       # http://127.0.0.1:8787 → 即断/採用/壁打ちタブを見せる
```

**ここまでで「動くもの」を見せられます。** デモは Notion 不要（`DEMO_MODE` が組み込み済み）。

---

## 2. 当日: 本番コース（自社データで動かす・+1〜2時間）

### 2-1. Notion を接続する

**本番DBは作成済み**（親ページ「経営者クローンAI」配下にシグナルDB・ストーリーDBをプロパティ設定済みで用意してある）。
残る作業は次の3つだけ:

1. [notion.so/my-integrations](https://www.notion.so/my-integrations) で Internal Integration を作成 → トークンを `.env.local` の `NOTION_TOKEN` へ
2. 親ページ **[経営者クローンAI](https://app.notion.com/p/3a0047a1d4c28189b2e3e7b1f7467d54)** の右上 ⋯ → **Connections** からインテグレーションを追加（配下のDBに権限が継承される）
3. `.env.local` に DB ID を記入:
   ```
   NOTION_SIGNAL_DB_ID=a28913a5c34a412fada700e24ab8c432
   NOTION_STORY_DB_ID=8235a81a0ce54c48a553d81d3c305984
   ```
4. `npm run doctor` → Notion の行が ✅ になることを確認

> DBをゼロから作り直す場合のプロパティ定義は `README.md` の表を参照。

### 2-2. 経営者プロファイルを登録する

**[docs/hearing-sheet.md](hearing-sheet.md)** の記入結果をもとに、
`src/data/executiveProfile.ts` のサンプル値を CEO 本人の内容に差し替え:

- `values`（価値観）/ `decisionRules`（意思決定ルール15個程度）
- `successPatterns` / `failurePatterns`
- `delegationRules`（**営業が自分で決めてよい範囲** — 即断モードの生命線）
- `hiringCriteria`（採用で重視する基準 — 採用モードの生命線）

`.env.local` の `EXECUTIVE_NAME` も本人の名前に。

### 2-3. 取り込みの動作確認

```bash
cp demo/mikitani-inputs/2026-07-15_meeting-minutes.txt lifelog-inbox/   # サンプル投入
npm run daily          # collect + extract → Notion シグナルDBに行が入るか確認
npm run chat           # 壁打ちで応答確認
```

### 2-4. 自動実行を仕込む

```bash
./scripts/install-cron.sh      # 毎日3:00 daily / 日曜4:00 weekly（Macはターミナルのフルディスクアクセス許可が必要な場合あり）
```

詳細・systemd 版・LINE / Plaud の取り込み経路は `docs/operations.md` 参照。
録音デバイス（Plaud NotePin S 等）が届いたら、同ドキュメントの「取り込み経路」で受け皿フォルダに接続します。

---

## 2.5 本番初日ランブック（デバイス入力→出力まで通す）

引き渡し当日に「実データが一周する」ところまで見せる手順。**2-1〜2-2（Notion・プロファイル）完了が前提**。

### (0) 朝イチ: 乾式リハーサル（Notionに書き込まずLLM経路を確認）

```bash
npm run doctor      # ❌ ゼロを確認
npm run rehearse    # サンプル議事録で 抽出→ストーリー構築 が動くことを確認（Notion不要）
```

### (1) デバイスからの音声入力

**Plaud NotePin S がある場合（初日は手動エクスポートが確実）:**
1. CEO に1〜2分、今日の商談や考えごとを録音してもらう（ヒアリングの録音でも可）
2. Plaud アプリで文字起こし → TXT でエクスポート（AirDrop / 共有 → Mac に保存）
3. 保存した `.txt` を `lifelog-inbox/` に置く

> Zapier 連携（Drive 同期フォルダ→自動投入）は2日目以降に設定でOK（`docs/operations.md`）。
> デバイスが未着の場合: iPhone のボイスメモ＋Plaud アプリなしなら、議事録テキストや
> メモの `.txt` を直接 `lifelog-inbox/` に置けば同じ経路が動く（音声は後日差し替え）。

**LINE の入力:**
1. CEO のスマホで対象トークを開く → メニュー → 「トーク履歴を送信」→ `.txt` を Mac へ
2. `messenger-inbox/` に置く

### (2) 取り込み実行と確認

```bash
npm run daily      # collect（取り込み）→ extract（シグナル抽出→Notion保存）
```

- ターミナルに「メッセンジャー: n件」「ライフログ: n件」→「n件のシグナルをNotionに保存」と出る
- **Notion のシグナルDBを開き、行が増えていることを CEO と一緒に確認**（ここが一番のデモ）

### (3) 実データで出力を確認

```bash
npm run decide -- "（今日の実際の商談の状況）"   # 権限委譲ラインどおりの線引きが出るか
npm run web                                    # 3タブを CEO に触ってもらう
```

### (4) ストーリー構築（任意）

`analyze` は**シグナル3件以上**で動く。初日に3件たまっていれば:

```bash
npm run weekly     # analyze（ストーリー構築）+ digest（週次ダイジェスト）
```

たまっていなければ週末の cron に任せる（そのために (5) を忘れずに）。

### (5) 自動実行を仕込んで締め

```bash
./scripts/install-cron.sh && crontab -l | grep executive-clone-ai
```

---

## 3. 引き渡しチェックリスト（この状態で渡す）

- [ ] `npm run doctor` が ❌ ゼロ
- [ ] `npm run rehearse` が シグナル抽出＋ストーリー構築まで成功（乾式リハーサル）
- [ ] `npm run demo:decide` で即答が返る（デモ確認）
- [ ] **実データ一周**: デバイス録音 or LINEエクスポート → `npm run daily` → Notionにシグナル → `npm run decide`（本番初日ランブック 2.5）
- [ ] Web UI（`npm run web` または `demo:web`）の3タブを CEO と一緒に一巡
- [ ] 本番コースまで行った場合: Notion にシグナルが入る／`npm run chat` が本人プロファイルで応答
- [ ] cron 設定済み（`crontab -l` に executive-clone-ai の行）
- [ ] **APIキーは CEO 本人のアカウントで発行したもの**（構築時に借りたキーは無効化）
- [ ] `.env.local` を Git やチャットに載せていない（`.gitignore` 済みだが再確認）
- [ ] `docs/operations.md`（日々の運用）と `docs/users.md`（誰がどう使うか）の場所を案内

## 4. セキュリティの注意（引き渡し時に口頭で伝える）

- `.env.local` にすべての鍵が入る。**端末のログインパスワード＋FileVault（ディスク暗号化）を有効に**（システム設定 → プライバシーとセキュリティ → FileVault）
- Web UI を社内の他端末から使う場合は `WEB_ACCESS_TOKEN` を設定し、VPN/HTTPS 経由で公開する（既定はローカルのみ）
- 極秘データを扱うため、LLM は将来的に Vertex AI（データが自社GCP内に留まる）への切替も可能（`.env.example` の (B) 参照）

## 5. うまくいかないときは

| 症状 | 対処 |
|---|---|
| `npm run doctor` で LLM 疎通が ❌ | キーの貼り間違い（前後の空白）/ AI Studio でキーが有効か確認 |
| Notion 接続が ❌ | DBの **Connections** でインテグレーション共有を忘れていないか / ID が database_id か確認 |
| `npm install` が失敗 | Node バージョン（v20+）確認 / 社内プロキシ環境なら npm のプロキシ設定 |
| Web UI が開かない | ポート競合 → `.env.local` で `WEB_PORT` を変更 |
