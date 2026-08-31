# デザイントークン採取依頼

`theme/assets/css/newgrad.css` 冒頭「0. デザイントークン」を実サイトの値へ差し替えるために
必要な情報のリスト。**この1ファイルが埋まれば、トンマナ反映は完了する。**

> 現状：作業環境のネットワーク許可リスト（Claude Code の「Trusted」レベル）に
> genestate.co.jp が含まれておらず到達できないため、トークンは**暫定値のまま**。
> `docs/05-data-requests.md` の 🟡 19〜22 と対応する。

---

## 提供の方法（どれか1つで足りる）

### 方法A：テーマCSSをそのまま渡す（最も確実・推奨）

コーポレートサイトで読み込まれている CSS ファイルの中身を、そのまま貼るか添付する。

- WordPress 管理画面 →「外観」→「テーマファイルエディター」→ `style.css`
- または、トップページを表示して `Ctrl+U`（ページのソース）から
  `<link rel="stylesheet" href="...">` の URL を開いて全文をコピー
- 子テーマがある場合は**親テーマと子テーマの両方**

CSS 変数（`:root { --... }`）を使っているテーマなら、その部分だけでもほぼ足りる。

### 方法B：DevTools で下のスニペットを実行して、出力を貼る

CSSファイルに触れない場合はこちら。**トップページを表示した状態**で
`F12`（DevTools）→「Console」タブ → 下を貼り付けて Enter。
結果がクリップボードにコピーされるので、そのまま貼って返してほしい。

```js
(() => {
  const pick = (el, ...ps) => { const s = getComputedStyle(el), o = {}; ps.forEach(p => o[p] = s[p]); return o; };
  const top = o => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const out = { url: location.href };

  out.stylesheets = [...document.styleSheets].map(s => s.href).filter(Boolean);
  out.fontLinks = [...document.querySelectorAll('link[href*="font" i]')].map(l => l.href);
  out.rootVars = (() => {
    const r = {};
    for (const sh of document.styleSheets) {
      let rules; try { rules = sh.cssRules; } catch (e) { continue; }
      for (const rule of rules || []) {
        if (rule.selectorText && /(^|,)\s*(:root|html|body)\s*(,|$)/.test(rule.selectorText)) {
          for (const p of rule.style) if (p.startsWith('--')) r[p] = rule.style.getPropertyValue(p).trim();
        }
      }
    }
    return r;
  })();

  out.body = pick(document.body, 'color', 'backgroundColor', 'fontFamily', 'fontSize', 'lineHeight', 'letterSpacing');
  out.headings = {};
  ['h1', 'h2', 'h3'].forEach(t => {
    const el = document.querySelector(`main ${t}, article ${t}, ${t}`);
    if (el) out.headings[t] = Object.assign(
      { text: el.textContent.trim().slice(0, 24) },
      pick(el, 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'color')
    );
  });

  out.buttons = [...document.querySelectorAll('a, button')].filter(el => {
    const s = getComputedStyle(el);
    return s.backgroundColor !== 'rgba(0, 0, 0, 0)' && el.offsetWidth > 70 && el.offsetHeight > 26;
  }).slice(0, 8).map(el => Object.assign(
    { text: el.textContent.trim().slice(0, 20) },
    pick(el, 'backgroundColor', 'color', 'borderRadius', 'borderTopWidth', 'borderTopColor', 'padding', 'fontSize', 'fontWeight', 'letterSpacing')
  ));

  const a = document.querySelector('main a, article a, .entry-content a') || document.querySelector('a');
  if (a) out.link = pick(a, 'color', 'textDecorationLine', 'textDecorationColor');

  const bg = {}, bd = {}, mw = {}, py = {};
  document.querySelectorAll('*').forEach(el => {
    const s = getComputedStyle(el);
    if (s.backgroundColor !== 'rgba(0, 0, 0, 0)') bg[s.backgroundColor] = (bg[s.backgroundColor] || 0) + 1;
    if (parseFloat(s.borderTopWidth) > 0) bd[s.borderTopColor] = (bd[s.borderTopColor] || 0) + 1;
    if (s.maxWidth !== 'none') mw[s.maxWidth] = (mw[s.maxWidth] || 0) + 1;
  });
  document.querySelectorAll('section, [class*="sec" i], [class*="block" i]').forEach(el => {
    const s = getComputedStyle(el);
    if (parseFloat(s.paddingTop) > 20) { const k = s.paddingTop + ' / ' + s.paddingBottom; py[k] = (py[k] || 0) + 1; }
  });
  out.backgroundColors = top(bg);
  out.borderColors = top(bd);
  out.maxWidths = top(mw);
  out.sectionPaddings = top(py);

  const json = JSON.stringify(out, null, 2);
  console.log(json);
  try { copy(json); console.log('%c→ クリップボードにコピーしました', 'color:green'); } catch (e) {}
  return out;
})();
```

トップページに加えて **`/about/` と `/recruit/`** でも同じものを実行して、
3ページ分もらえると精度が上がる（下層でしか出てこない罫線色・見出しのあしらいがあるため）。

### 方法C：作業環境から genestate.co.jp への通信を許可する（一度やれば恒久的に解決）

Claude Code on the web の環境設定に `genestate.co.jp` を追加する。
以降のセッションでは自動で採取できるようになるため、**繰り返し作業が発生するなら最も効率がよい**。

1. https://claude.ai/code を開き、**メッセージ入力欄のすぐ上の行**にある雲アイコン
   （現在の環境名が表示されている）をクリックする
   ※ 専用の設定ページや直リンクURLは存在しない
2. 一覧の環境にマウスを乗せると右に出る**歯車アイコン**をクリックする
   （新規に作る場合は **Add cloud environment**）
3. **Network access** を `Custom` に変更する

   | レベル | 通信できる範囲 |
   | --- | --- |
   | None | 外部通信なし |
   | Trusted | 既定の許可リストのみ（**現状ここ**。genestate.co.jp は含まれない） |
   | Full | 任意のドメイン |
   | **Custom** | 自分で指定した許可リスト（＋任意で既定リスト） |

4. **Allowed domains** に1行1ドメインで入力する
   （先頭の `*.` はサブドメイン全体にマッチする。apex ドメインは別行が必要）

   ```text
   genestate.co.jp
   *.genestate.co.jp
   ```

5. **「Also include default list of common package managers」に必ずチェックを入れる**
   外すと、ここに書いたドメイン以外がすべて不通になり npm / PyPI などが落ちる
6. 保存する。**設定はセッション起動時に適用されるため、実行中のセッションには反映されない。**
   保存後に新しいセッションを開始すること

補足：
- 環境はアカウント個人のもの。Owner が作成した共有環境は Owner しか編集できない
  （https://claude.ai/admin-settings の Cloud environments ページ）。
  その場合は自分用の環境を新規作成するのが早い
- GitHub 通信と MCP コネクタは別経路のため、この許可リストの影響を受けない
- `Full`（全ドメイン許可）でも動くが、必要なドメインだけを列挙する `Custom` を推奨

参考：https://code.claude.com/docs/en/cloud-environments

### 方法D：スクリーンショット

上記が難しい場合、トップページ・下層ページのスクリーンショットでも
**色の系統と余白感はかなり拾える**（ただし正確な HEX 値は取れない）。

---

## 採取した値の対応表

| 採取するもの | 差し替え先の変数 | 現在の暫定値 |
| --- | --- | --- |
| ブランドカラー | `--ng-c-brand` | `#0B3A6F` |
| ブランドカラーの暗色（ホバー用） | `--ng-c-brand-dark` | `#07284D` |
| ブランドカラーの淡色（背景用） | `--ng-c-brand-tint` | `#EAF0F7` |
| CTA・アクセント色 | `--ng-c-accent` | `#C8752B` |
| アクセントの暗色 | `--ng-c-accent-dark` | `#A65E1E` |
| 本文の文字色 | `--ng-c-fg` | `#16191D` |
| 補足文の文字色 | `--ng-c-fg-muted` | `#5C6672` |
| セクション交互の背景色 | `--ng-c-bg-subtle` | `#F5F7F9` |
| 罫線の色 | `--ng-c-line` / `--ng-c-line-strong` | `#DDE3E9` / `#B9C2CC` |
| 本文・見出しの `font-family` | `--ng-font` | `Noto Sans JP` ほか |
| 英字用の `font-family` | `--ng-font-en` | `Barlow` ほか |
| 本文の `line-height` | `--ng-lh-body` | `2` |
| 見出しの `letter-spacing` | `--ng-ls-head` | `0.04em` |
| 英字ラベルの `letter-spacing` | `--ng-ls-en` | `0.16em` |
| ボタンの `border-radius` | `--ng-radius` / `--ng-radius-lg` | `4px` / `8px` |
| コンテンツの最大幅 | `--ng-container` | `1120px` |
| セクションの上下余白 | `--ng-section-y` | `clamp(3.5rem, 9vw, 7.5rem)` |

---

## トークンでは吸収できない項目（別途、目視で確認したい）

CSS変数の差し替えだけでは揃わないため、既存サイトの実物を見て
コンポーネント側を寄せる必要がある。方法Dのスクリーンショットでも判断できる。

| # | 確認したいこと | 現在の実装 |
| --- | --- | --- |
| a | 見出しの上に**英字ラベル**（`RECRUIT` のような）を置いているか | 置いている（字間 `0.16em`） |
| b | 見出しの**罫線のあしらい**（下線／左の縦線／無し） | セクションにより下線と左縦線を併用 |
| c | ボタンの形（角丸／完全な角／ピル型）と**矢印の有無** | 角丸 `4px`・右向き矢印あり |
| d | リンクとボタンの**ホバー挙動**（色反転／下線／わずかな浮き） | 暗色へ変化＋わずかな浮き |
| e | 写真の**角丸の有無** | 角丸あり（`--ng-radius-lg`） |
| f | 数値（実績）の見せ方の作法 | 大きい数字＋単位を小さく添える |
