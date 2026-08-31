# 株式会社ジーンステイト 新卒採用サイト

コーポレートサイト（genestate.co.jp）配下に設置する、新卒採用サイト `/newgrad/` の一式。
既存のWordPressテーマの上に、**ページテンプレートとして載せる**構成になっている。

---

## いまの状態

| | 状態 |
| --- | --- |
| 採用トップ `/newgrad/` | ✅ 実装済み（このリポジトリ） |
| 下層ページ | 📄 コンテンツ設計済み・未実装（`docs/02-sitemap-ia.md`） |
| 掲載する数値・募集要項 | ⚠️ **未確定。プレースホルダ**（`docs/05-data-requests.md`） |
| 写真 | ⚠️ **未入稿。18カット必要**（`docs/04-photo-requirements.md`） |
| 配色・フォント | ⚠️ **暫定値。実サイトのCSS取得待ち**（`theme/assets/css/newgrad.css` 冒頭） |

未確定の項目があるあいだは**下書きモード**で動作し、
該当箇所に「要確認」バッジが表示され、検索エンジンにも拾われない（noindex）。

---

## ディレクトリ

```
genestate-newgrad/
├── README.md                          このファイル
│
├── docs/                              企画・設計ドキュメント
│   ├── 01-strategy.md                 採用コンセプト / メッセージ設計 / コピー候補
│   ├── 02-sitemap-ia.md               サイトマップ / 下層ページのコンテンツ設計
│   ├── 04-photo-requirements.md       必要写真18カットの撮影指示書
│   └── 05-data-requests.md            社内で確定が必要な情報リスト
│
├── theme/                             WordPress子テーマに設置するファイル
│   ├── page-newgrad.php               採用トップのページテンプレート
│   ├── functions-snippet.php          子テーマ functions.php への追記内容
│   ├── inc/
│   │   ├── newgrad-functions.php      ヘルパー関数・アセット読み込み・OGP
│   │   ├── newgrad-content.php        ★掲載する文言・数値（ここだけ編集すればよい）
│   │   └── newgrad-photos.php         ★写真の定義（ID・代替テキスト・撮影指示）
│   └── assets/
│       ├── css/newgrad.css            ★冒頭にデザイントークン（トンマナ差し替え箇所）
│       ├── js/newgrad.js              アコーディオン・フェードイン・固定CTA
│       └── img/                       ここに P-01.jpg 〜 P-18.jpg を置く
│
├── tools/
│   └── render-preview.php             WordPress無しで見た目を確認する静的プレビュー生成
│
└── preview/
    └── index.html                     生成済みプレビュー（ブラウザで開ける）
```

**★印の3ファイルだけで、掲載内容・写真・デザインのすべてが変えられる。**
`page-newgrad.php` は原則として触らなくてよい。

---

## WordPress への設置手順

### 前提
- 既存テーマの**子テーマ**があること。無い場合は先に子テーマを作成する
  （親テーマを直接編集すると、テーマ更新時に上書きで消える）

### 手順

**1. ファイルを子テーマにコピーする**

```
wp-content/themes/（子テーマ）/
├── page-newgrad.php          ← theme/page-newgrad.php
├── inc/                      ← theme/inc/ をディレクトリごと
└── assets/                   ← theme/assets/ をディレクトリごと
```

`theme/functions-snippet.php` は**コピーしない**（中身を貼るだけのファイル）。

**2. 子テーマの `functions.php` の末尾に追記する**

```php
require_once get_stylesheet_directory() . '/inc/newgrad-functions.php';
```

詳細と補足は `theme/functions-snippet.php` を参照。

**3. 固定ページを作成する**

WordPress 管理画面 → 固定ページ → 新規追加

| 項目 | 値 |
| --- | --- |
| タイトル | 新卒採用 |
| パーマリンク（スラッグ） | `newgrad` |
| ページ属性 → テンプレート | **新卒採用トップ** |
| 本文 | 空のままでよい（内容はテンプレートが出力する） |

公開すると `https://genestate.co.jp/newgrad/` で表示される。

**4. 表示を確認する**

ヘッダー・フッターが既存サイトと同じものになっていることを確認する。
`get_header()` / `get_footer()` で親テーマのものを読んでいるため、
**グローバルナビ・ロゴ・フッターは自動的に同一**になる。

もし本文のスタイルが親テーマに負けている場合は、
`theme/functions-snippet.php` の「補足1」を参照。

---

## 掲載内容の編集

`theme/inc/newgrad-content.php` を開いて、該当箇所の文字列を書き換えるだけ。
WordPress の管理画面での操作は不要（＝**表示崩れの事故が起きない**）。

```php
'hero' => array(
    'catch' => '素質は、動き出せる。',        // ← ここを書き換える
    'sub'   => 'まだ名前のついていない…',
```

確認が済んだ項目は、その項目の `'todo' => true,` の行を削除する。
すべて削除できたら、`functions.php` に次を追記して下書きモードを解除する。

```php
define( 'NG_DRAFT_MODE', false );   // require_once より前に書くこと
```

---

## 写真の入れ方

`theme/assets/img/` に、**写真IDをそのままファイル名にして置く**。

```
assets/img/P-01.jpg
assets/img/P-03.webp
```

対応拡張子は `.webp` → `.jpg` → `.jpeg` → `.png` の順で探索する。
置いた瞬間に反映される。撮影の指定は `docs/04-photo-requirements.md` を参照。

---

## プレビュー（WordPress無しで見た目を確認する）

```bash
php tools/render-preview.php > preview/index.html
```

生成された `preview/index.html` をブラウザで開く。
CSSとJSがインライン化された1枚のHTMLなので、そのままメールで送って
社内確認に回すこともできる。

⚠️ プレビューのヘッダー・フッターは**確認用の仮のもの**。
本番では親テーマの実物に置き換わる。

---

## トンマナを実サイトに合わせる

`theme/assets/css/newgrad.css` の冒頭「0. デザイントークン」ブロックが、
唯一の差し替えポイント。現在の値は暫定であり、実サイトの値ではない。

コーポレートサイトで DevTools を開き、以下を採取して置き換える。

| 採取するもの | 差し替え先の変数 |
| --- | --- |
| ブランドカラー | `--ng-c-brand` `--ng-c-brand-dark` `--ng-c-brand-tint` |
| CTA・強調色 | `--ng-c-accent` `--ng-c-accent-dark` |
| 本文の文字色 | `--ng-c-fg` `--ng-c-fg-muted` |
| 罫線の色 | `--ng-c-line` `--ng-c-line-strong` |
| `font-family` | `--ng-font` |
| ボタンの `border-radius` | `--ng-radius` |
| コンテンツ最大幅 | `--ng-container` |

**ここを書き換えるだけでページ全体の見た目が既存サイトに揃う。**
各セクションのCSSはすべてこの変数を参照しており、色やフォントを直接
書いている箇所は無い。

---

## 動作要件

- WordPress 5.0 以上 / PHP 7.4 以上
- 追加プラグイン不要
- 外部ライブラリ不要（JavaScriptは依存なしの素のJS。約5KB）
- IntersectionObserver 非対応のブラウザでは、アニメーションが無効になるだけで
  内容はすべて表示される

## アクセシビリティ / SEO

- 見出しの階層（h1 → h2 → h3）を維持している
- FAQ アコーディオンは `aria-expanded` / `aria-controls` に対応
- キーボード操作時のフォーカスリングを維持
- `prefers-reduced-motion` に対応（アニメーションを自動で無効化）
- 写真には代替テキストを設定（`inc/newgrad-photos.php`）
- meta description / OGP を出力（SEOプラグイン併用時は要調整）
- 下書きモード中は `noindex,nofollow`
- 印刷用スタイルあり（学生が募集要項を印刷して持参する場合に対応）
