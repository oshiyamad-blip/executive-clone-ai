# GCP デプロイガイド（Compute Engine）

バッチ（日次収集・毎月1日の検収・週次分析）を GCP の VM 1台で回すための手順。
本システムはローカルフォルダ（`leads-import/` `contracts-import/` `data/` `logs/`）を使うため、
ファイルシステムが永続する **Compute Engine** が無改修で適合する（Cloud Run Jobs は改修が必要）。

## 0. 構成と費用の目安

| 項目 | 推奨 | 備考 |
|---|---|---|
| マシンタイプ | e2-micro | 無料枠対象（us-west1 / us-central1 / us-east1 のいずれか）。バッチは夜間実行なのでリージョンのレイテンシは影響しない |
| 代替 | e2-small（asia-northeast1） | 月2,000円前後。メモリに余裕が欲しい場合 |
| OS | Debian 12 | |
| ディスク | 標準 10〜20GB | PDF・ログの蓄積分 |
| 外部公開 | 不要 | バッチのみ。受信ポートは開けない（Web対話UIを載せる場合は別途検討） |

## 1. VM の作成

```bash
gcloud compute instances create executive-clone-batch \
  --project=<YOUR_PROJECT> \
  --zone=us-west1-b \
  --machine-type=e2-micro \
  --image-family=debian-12 --image-project=debian-cloud \
  --boot-disk-size=20GB
```

## 2. 初期セットアップ（VM 内で実行）

```bash
gcloud compute ssh executive-clone-batch --zone=us-west1-b

# タイムゾーンをJSTに（cron の実行時刻が日本時間になる。重要）
sudo timedatectl set-timezone Asia/Tokyo

# Node.js 20 のインストール
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git

# リポジトリの取得（GitHub のデプロイキーまたは PAT を利用）
git clone https://github.com/oshiyamad-blip/executive-clone-ai.git
cd executive-clone-ai
npm install
npm run build

# 環境変数の設定
npm run setup          # .env.local の雛形を生成
nano .env.local        # APIキー・DB ID・BILLING_TARGET_EMAIL 等を記入
```

`.env.local` には Google サービスアカウントの秘密鍵が入るため、権限を絞っておく:

```bash
chmod 600 .env.local
```

## 3. 動作確認 → cron 登録

```bash
npm run engagements            # Notion 接続とマスタの確認
npm run billing:inspect -- --dry-run   # 検収のドライラン
./scripts/install-cron.sh      # 日次3:00 / 週次 日曜4:00 / 月次 毎月1日7:00（JST）
crontab -l                     # 登録確認
```

ログは `logs/daily.log` / `logs/weekly.log` / `logs/monthly.log` に出る。

## 4. 運用

- **コード更新**: `git pull && npm install && npm run build`（cron はそのまま）
- **手動実行**: 検収の再実行は何度でも安全（`npm run billing:inspect`。処理済みメールはスキップされる）
- **取込フォルダ**: `leads-import/` `contracts-import/` `engagements-import/` は VM 上のパス。
  手元のファイルは `gcloud compute scp <file> executive-clone-batch:~/executive-clone-ai/contracts-import/ --zone=us-west1-b`
  で送るか、Google Drive の同期を挟む
- **監視**: 通知メール（NOTIFY_EMAILS）が毎月1日に届くこと自体が生存確認になる。
  届かなければ `logs/monthly.log` を確認

## 5. セキュリティの注意

- 受信ポートは開けない（既定のファイアウォールで SSH のみ）。Web対話UI（`npm run web`）を
  このVMで公開したい場合は IAP トンネルまたは `WEB_ACCESS_TOKEN` + HTTPS を必ず併用する
- サービスアカウント鍵・APIキーは `.env.local` のみに置き、リポジトリにコミットしない
- VM への SSH アクセスは IAM（OS Login）で管理者のみに絞る

## 6. 発展（同じGCPプロジェクトでできること）

- **Vertex AI**: `.env.local` で `LLM_PROVIDER=gemini` + `GOOGLE_GENAI_USE_VERTEXAI=true` に
  切り替えると、LLM 呼び出しを自社 GCP プロジェクト内で完結できる（データガバナンス重視の選択肢。
  ただし PDF 読解の検収は Anthropic 前提のため、billing 系は ANTHROPIC_API_KEY を維持すること）
- **Secret Manager**: 鍵管理を厳格化したい場合、`.env.local` の値を Secret Manager に移し
  起動時に取得する構成に拡張できる（現状は未実装）
