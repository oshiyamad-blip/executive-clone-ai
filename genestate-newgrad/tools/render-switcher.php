<?php
/**
 * 意匠の切替ページ生成ツール（社内共有用）
 *
 * 採用トップをそのまま出しつつ、上部のスイッチで意匠の案を切り替えられる
 * 1枚HTMLを書き出す。本番の見え方のまま案を比べられるようにするためのもの。
 *
 * 使い方:
 *   php tools/render-switcher.php > preview/switcher.html
 *
 * 仕組み:
 *   MV は案ごとに構造が違うため、NG_SWITCHER を立てて4案すべてを描画し、
 *   表示は data-mv 属性とCSSで1案に絞る。
 *   数字と育成はマークアップが同じでCSSだけが違うので、JSでクラスを付け替える。
 *   本番では page-newgrad.php が NG_MV / NG_NUMBERS / NG_GROWTH を見て
 *   選ばれた1案だけを描画するので、このページの切替結果がそのまま本番になる。
 *
 * @package GeneState_Newgrad
 */

define( 'ABSPATH', dirname( __DIR__ ) . '/' );
define( 'NG_PREVIEW', true );
/** 4案すべてを描画させる（このツールでのみ立てる） */
define( 'NG_SWITCHER', true );

$theme_dir = dirname( __DIR__ ) . '/theme';

require_once __DIR__ . '/wp-stubs.php';
/* 親テーマ代役のヘッダー/フッター（3つのツールで共通） */
require_once __DIR__ . '/chrome.php';

function get_header() {
	$css = file_get_contents( dirname( __DIR__ ) . '/theme/assets/css/newgrad.css' );
	/* @charset はインラインの <style> では無効な記述になるため取り除く */
	$css = preg_replace( '/^@charset\s+"[^"]*";\s*/i', '', $css );

	echo "<title>新卒採用トップ 意匠の切替</title>\n";
	echo ng_fonts_link();
	/* PC用（本番と同じCSS）と、SP用（メディアクエリを展開したもの）を2枚出し、
	   スイッチで有効・無効を入れ替える。SP用は確認ページの中だけで使う。 */
	echo "<style id=\"ng-css-pc\">\n" . $css . "\n</style>\n";
	echo "<style id=\"ng-chrome-pc\">\n" . ng_chrome_css() . "\n</style>\n";
	echo "<style id=\"ng-css-sp\" media=\"not all\">\n"
		. ng_sp_css( $css ) . "\n"
		. ng_sp_css( ng_chrome_css() ) . "\n</style>\n";

	echo <<<'SWCSS'
<style>
/* ==========================================================================
   意匠の切替バー（.sw-）

   採用ページ本体（.ng 配下）には一切影響しない。
   色と書体は本体と同じ genestate のトークンから取り、浮かないようにしている。
   ブランドが確定した明るい世界のページなので、閲覧者のテーマに関わらず
   同じ見え方になるよう配色は固定して明示的に塗っている。
   ========================================================================== */
:root {
	--sw-ink:   #19110C;
	--sw-gold:  #C7A52D;
	--sw-bone:  #F5F4EE;
	--sw-line:  #DDDDDD;
	--sw-muted: #756F6B;
	--sw-white: #FFFFFF;
	color-scheme: light;
}
body {
	margin: 0;
	background: var(--sw-white);
	color: var(--sw-ink);
	font-family: "Zen Kaku Gothic New", sans-serif;
	font-size: 16px;
	line-height: 2;
}

/* --- 切替バー --- */
.sw-bar {
	position: sticky;
	top: 0;
	z-index: 50;
	background: var(--sw-bone);
	border-bottom: 1px solid var(--sw-gold);
	padding: 14px 40px;
}
.sw-bar__inner {
	max-width: 1220px;
	margin: 0 auto;
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 12px 28px;
}
.sw-lead {
	font-size: 13px;
	font-weight: 700;
	letter-spacing: .08em;
	line-height: 1.6;
	white-space: nowrap;
}
.sw-lead small {
	display: block;
	font-size: 11px;
	font-weight: 400;
	letter-spacing: 0;
	color: var(--sw-muted);
}
.sw-group { display: flex; align-items: center; gap: 8px; }
.sw-group__label {
	font-size: 12px;
	font-weight: 700;
	letter-spacing: .08em;
	color: var(--sw-muted);
	white-space: nowrap;
}
.sw-seg {
	display: flex;
	background: var(--sw-white);
	border: 1px solid var(--sw-line);
	border-radius: 50px;
	padding: 3px;
	gap: 2px;
}
.sw-seg button {
	appearance: none;
	border: 0;
	background: transparent;
	border-radius: 50px;
	padding: 5px 13px;
	font-family: inherit;
	font-size: 12px;
	font-weight: 700;
	line-height: 1.6;
	color: var(--sw-ink);
	cursor: pointer;
	white-space: nowrap;
	transition: background-color .2s ease, color .2s ease;
}
.sw-seg button:hover { background: var(--sw-bone); }
.sw-seg button[aria-pressed="true"] {
	background: var(--sw-gold);
	color: var(--sw-white);
}
.sw-seg button:focus-visible {
	outline: 2px solid var(--sw-ink);
	outline-offset: 2px;
}
.sw-now {
	margin-left: auto;
	display: inline-flex;
	align-items: center;
	gap: 8px;
	padding: 6px 16px;
	background: var(--sw-ink);
	border-radius: 50px;
	color: var(--sw-white);
	font-size: 12px;
	font-weight: 700;
	letter-spacing: .04em;
	line-height: 1.6;
	white-space: nowrap;
}
.sw-note {
	padding: 10px 40px;
	background: var(--sw-white);
	border-bottom: 1px solid var(--sw-line);
	color: var(--sw-muted);
	font-size: 12px;
	line-height: 1.8;
	text-align: center;
}

/* --- MV の出し分け ---------------------------------------------------------
   4案すべてがHTMLに入っていて、選ばれていない案を隠している。
   本番では選ばれた1案だけが描画されるので、この指定は要らなくなる。
   -------------------------------------------------------------------------- */
:root[data-mv="a"] .ng-hero:not(.ng-hero--a),
:root[data-mv="b"] .ng-hero:not(.ng-hero--b),
:root[data-mv="c"] .ng-hero:not(.ng-hero--c),
:root[data-mv="d"] .ng-hero:not(.ng-hero--d) { display: none !important; }

/* --- 表示の切替（PC / スマホ） -----------------------------------------------
   画面を実際に狭くしないとメディアクエリは効かないため、
   SP用に組み替えたCSSを別の <style> で持ち、JSで有効・無効を入れ替えている。
   ここでは、本体を端末幅の枠に収める見た目だけを受け持つ。
   -------------------------------------------------------------------------- */
:root[data-view="sp"] body { background: var(--sw-bone); }
:root[data-view="sp"] .sw-stage {
	width: 375px;
	margin: 32px auto 56px;
	background: var(--sw-white);
	border: 1px solid var(--sw-line);
	border-radius: 20px;
	overflow: hidden;
	box-shadow: 0 8px 32px rgba(25, 17, 12, .12);
}

/* 固定CTAは position:fixed のため、そのままだと枠の外いっぱいに広がってしまう。
   確認しやすいよう、端末の幅に合わせて中央に置く（本番の指定には手を入れない） */
:root[data-view="sp"] .ng-fixedcta {
	left: 50%;
	right: auto;
	width: 375px;
	transform: translateX(-50%);
}

/* --- 構成パネル ---------------------------------------------------------
   パートごとの並べ方は数が多いので、上のバーには置かず折りたたむ。
   -------------------------------------------------------------------------- */
.sw-more {
	appearance: none;
	display: inline-flex;
	align-items: center;
	gap: 6px;
	padding: 6px 16px;
	border: 1px solid var(--sw-line);
	border-radius: 50px;
	background: var(--sw-white);
	font-family: inherit;
	font-size: 12px;
	font-weight: 700;
	line-height: 1.6;
	color: var(--sw-ink);
	cursor: pointer;
}
.sw-more:hover { background: var(--sw-bone); }
.sw-more[aria-expanded="true"] { background: var(--sw-ink); border-color: var(--sw-ink); color: var(--sw-white); }
.sw-more[aria-expanded="true"] span { transform: rotate(180deg); }
.sw-more span { display: inline-block; transition: transform .2s ease; }
.sw-more:focus-visible { outline: 2px solid var(--sw-ink); outline-offset: 2px; }

.sw-panel {
	background: var(--sw-white);
	border-bottom: 1px solid var(--sw-line);
	padding: 20px 40px 24px;
}
.sw-panel__lead {
	max-width: 1220px;
	margin: 0 auto 16px;
	font-size: 12px;
	line-height: 1.8;
	color: var(--sw-muted);
}
.sw-panel__grid {
	max-width: 1220px;
	margin: 0 auto;
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
	gap: 10px 32px;
}
.sw-row { display: flex; align-items: center; gap: 12px; }
.sw-row__name {
	flex: 0 0 7em;
	font-size: 12px;
	font-weight: 700;
	letter-spacing: .04em;
}
.sw-row .sw-seg { flex: 1; }
.sw-row .sw-seg button { flex: 1; padding: 5px 10px; }

@media (max-width: 900px) {
	.sw-panel { padding: 16px 20px 20px; }
	.sw-panel__grid { grid-template-columns: minmax(0, 1fr); }
	.sw-row__name { flex-basis: 6em; }
}

/* --- 切替UIの開閉 -------------------------------------------------------
   意匠だけを素の状態で見たいときのため、バーとパネルごと引っ込められる。
   PC・スマホどちらの表示でも同じように効かせたいので、
   :root の属性で切り替えている（表示の切替とは独立した軸）。
   -------------------------------------------------------------------------- */
.sw-hide {
	appearance: none;
	display: inline-flex;
	align-items: center;
	gap: 6px;
	padding: 6px 14px;
	border: 1px solid var(--sw-line);
	border-radius: 50px;
	background: var(--sw-white);
	font-family: inherit;
	font-size: 12px;
	font-weight: 700;
	line-height: 1.6;
	color: var(--sw-muted);
	cursor: pointer;
}
.sw-hide:hover { background: var(--sw-bone); color: var(--sw-ink); }
.sw-hide:focus-visible { outline: 2px solid var(--sw-ink); outline-offset: 2px; }

/* 引っ込めたあとの戻し口。右下に固定する。
   上辺はヘッダーの「お問い合わせ」ボタンと重なるため避けている。
   下辺は本体の固定CTAとぶつかりうるので、出る条件のときだけ持ち上げる。 */
.sw-show {
	position: fixed;
	bottom: 14px;
	right: 14px;
	z-index: 60;
	appearance: none;
	display: inline-flex;
	align-items: center;
	gap: 6px;
	padding: 8px 18px;
	border: 0;
	border-radius: 50px;
	background: var(--sw-ink);
	box-shadow: 0 4px 16px rgba(25, 17, 12, .28);
	font-family: inherit;
	font-size: 12px;
	font-weight: 700;
	line-height: 1.6;
	color: var(--sw-white);
	cursor: pointer;
	opacity: .5;
	transition: opacity .2s ease;
}
/* 意匠の邪魔をしないよう薄く置き、近づいたときだけはっきり出す */
.sw-show:hover,
.sw-show:focus-visible { opacity: 1; }
.sw-show:focus-visible { outline: 2px solid var(--sw-gold); outline-offset: 2px; }

/* 本体の固定CTAが下辺に出る条件では、その上へ逃がす。
   スマホ表示のときと、PC表示でも窓が狭いときの2通りある。 */
:root[data-view="sp"] .sw-show { bottom: 84px; }
@media (max-width: 47.99em) {
	.sw-show { bottom: 84px; }
}

:root[data-chrome="off"] .sw-bar,
:root[data-chrome="off"] .sw-panel,
:root[data-chrome="off"] .sw-note { display: none; }
:root:not([data-chrome="off"]) .sw-show { display: none; }

/* --- チームで決める（共有パネル） -----------------------------------------
   ここだけが端末内ではなく、閲覧者全員で共有される領域。
   db が使えない環境（未ログイン・権限なし・読み込み失敗）では
   ボタンごと出さないので、素の切替ページとして成立する。
   -------------------------------------------------------------------------- */
.sw-team-btn { display: none; }          /* db が生きたときだけ JS が出す */
.sw-teampanel {
	background: var(--sw-white);
	border-bottom: 1px solid var(--sw-line);
	padding: 20px 40px 24px;
}
.sw-teampanel__grid {
	max-width: 1220px;
	margin: 0 auto;
	display: grid;
	grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr);
	gap: 28px 40px;
	align-items: start;
}
.sw-tm__h {
	margin: 0 0 10px;
	font-size: 12px;
	font-weight: 700;
	letter-spacing: .08em;
}
.sw-tm__note { margin: 0 0 12px; font-size: 11px; line-height: 1.8; color: var(--sw-muted); }
.sw-tm__cur {
	display: block;
	padding: 10px 14px;
	background: var(--sw-bone);
	border-radius: 8px;
	font-size: 12px;
	line-height: 1.7;
	margin-bottom: 10px;
}
.sw-tm__cur b { font-weight: 700; }
.sw-tm__row { display: flex; flex-wrap: wrap; gap: 8px; }
.sw-tm__btn {
	appearance: none;
	padding: 7px 16px;
	border: 1px solid var(--sw-line);
	border-radius: 50px;
	background: var(--sw-white);
	font-family: inherit;
	font-size: 12px;
	font-weight: 700;
	color: var(--sw-ink);
	cursor: pointer;
}
.sw-tm__btn:hover:not(:disabled) { background: var(--sw-bone); }
.sw-tm__btn:disabled { opacity: .45; cursor: default; }
.sw-tm__btn--fill { background: var(--sw-ink); border-color: var(--sw-ink); color: var(--sw-white); }
.sw-tm__btn--fill:hover:not(:disabled) { background: #2b1f17; }
.sw-tm__form { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.sw-tm__form input {
	flex: 1 1 8em;
	min-width: 0;
	padding: 7px 12px;
	border: 1px solid var(--sw-line);
	border-radius: 8px;
	font-family: inherit;
	font-size: 12px;
	color: var(--sw-ink);
	background: var(--sw-white);
}
.sw-tm__form input:focus-visible { outline: 2px solid var(--sw-gold); outline-offset: 1px; }
.sw-tm__form input.is-name { flex: 0 0 7em; }
.sw-tm__list { margin: 0; padding: 0; list-style: none; display: grid; gap: 8px; max-height: 220px; overflow-y: auto; }
.sw-tm__item { border-top: 1px solid var(--sw-line); padding-top: 8px; font-size: 12px; line-height: 1.7; }
.sw-tm__who { font-weight: 700; }
.sw-tm__combo { color: var(--sw-muted); font-size: 11px; }
.sw-tm__cmt { margin: 2px 0 0; }
.sw-tm__empty { font-size: 11px; color: var(--sw-muted); }
.sw-tm__msg { margin: 8px 0 0; font-size: 11px; color: var(--sw-muted); min-height: 1.6em; }

@media (max-width: 900px) {
	.sw-teampanel { padding: 16px 20px 20px; }
	.sw-teampanel__grid { grid-template-columns: minmax(0, 1fr); gap: 20px; }
}
@media (max-width: 640px) {
	.sw-teampanel { padding: 12px 12px 16px; }
}
:root[data-chrome="off"] .sw-teampanel { display: none; }

/* 本体が出す開発者向けの下書きバーは、切替バーと役割が重なるので隠す */
.ng-draftbar { display: none !important; }

@media (max-width: 900px) {
	.sw-bar { padding: 12px 20px; }
	.sw-now { margin-left: 0; }
	.sw-note { padding: 10px 20px; }
}

/* --- 実機のスマートフォンで開いたとき -----------------------------------
   切替バーは横に長い部品が多く、そのままだとページ全体が横スクロールし、
   バーだけで画面の半分近くを占めてしまう。狭い画面では折り返して詰める。
   -------------------------------------------------------------------------- */
@media (max-width: 640px) {
	.sw-bar { padding: 10px 12px; }
	.sw-bar__inner { gap: 8px 12px; }
	.sw-lead { white-space: normal; font-size: 12px; }
	.sw-lead small { display: none; }
	.sw-group { flex-wrap: wrap; gap: 6px; }
	.sw-seg { flex-wrap: wrap; }
	.sw-seg button { padding: 5px 10px; font-size: 11px; }
	/* 選択中の組み合わせは1行に収まらず横幅を押し広げてしまう。
	   同じ内容は各ボタンの選択状態で読み取れるので、狭い画面では省く */
	.sw-now { display: none; }
	.sw-panel { padding: 12px 12px 16px; }
	.sw-panel__lead { font-size: 11px; margin-bottom: 12px; }
	.sw-row { flex-wrap: wrap; gap: 4px 10px; }
	.sw-row__name { flex-basis: auto; }
	.sw-note { padding: 10px 12px; font-size: 11px; }
}

/* 端末の枠を模した見せ方は、実機で見るときは意味がないうえに
   375px 固定だと画面からはみ出す。枠を外して幅いっぱいに使う。 */
@media (max-width: 430px) {
	:root[data-view="sp"] body { background: var(--sw-white); }
	:root[data-view="sp"] .sw-stage {
		width: auto;
		margin: 0;
		border: 0;
		border-radius: 0;
		box-shadow: none;
	}
	:root[data-view="sp"] .ng-fixedcta {
		left: 0;
		right: 0;
		width: auto;
		transform: none;
	}
}
@media (prefers-reduced-motion: reduce) {
	* { animation-duration: .01ms !important; transition-duration: .01ms !important; }
}
</style>
SWCSS;

	echo "\n";

	/* --- 切替バー --- */
	echo <<<'SWBAR'
<div class="sw-bar">
	<div class="sw-bar__inner">
		<p class="sw-lead">意匠を切り替えて確認<small>選んだ組み合わせが、そのまま本番の見え方です</small></p>

		<div class="sw-group">
			<span class="sw-group__label" id="sw-l-mv">MV</span>
			<div class="sw-seg" role="group" aria-labelledby="sw-l-mv">
				<button type="button" data-part="mv" data-value="a" aria-pressed="true">A 全面写真</button>
				<button type="button" data-part="mv" data-value="b" aria-pressed="false">B 左右分割</button>
				<button type="button" data-part="mv" data-value="c" aria-pressed="false">C 白ベース</button>
				<button type="button" data-part="mv" data-value="d" aria-pressed="false">D タイポ主役</button>
			</div>
		</div>

		<div class="sw-group">
			<span class="sw-group__label" id="sw-l-tone">トンマナ<br><small style="font-weight:400;letter-spacing:0">F・Gは新色</small></span>
			<div class="sw-seg" role="group" aria-labelledby="sw-l-tone">
				<button type="button" data-part="tone" data-value="a" aria-pressed="true">A 準拠</button>
				<button type="button" data-part="tone" data-value="b" aria-pressed="false">B 生成り＋金</button>
				<button type="button" data-part="tone" data-value="c" aria-pressed="false">C ダーク</button>
				<button type="button" data-part="tone" data-value="d" aria-pressed="false">D 明朝</button>
				<button type="button" data-part="tone" data-value="e" aria-pressed="false">E 丸ゴシック</button>
				<button type="button" data-part="tone" data-value="f" aria-pressed="false">F 紺×ライム</button>
				<button type="button" data-part="tone" data-value="g" aria-pressed="false">G 白と朱</button>
			</div>
		</div>

		<div class="sw-group">
			<span class="sw-group__label" id="sw-l-shape">形</span>
			<div class="sw-seg" role="group" aria-labelledby="sw-l-shape">
				<button type="button" data-part="shape" data-value="a" aria-pressed="true">A 片角</button>
				<button type="button" data-part="shape" data-value="b" aria-pressed="false">B 四隅丸</button>
				<button type="button" data-part="shape" data-value="c" aria-pressed="false">C 直線</button>
				<button type="button" data-part="shape" data-value="d" aria-pressed="false">D 斜め</button>
				<button type="button" data-part="shape" data-value="e" aria-pressed="false">E アーチ</button>
			</div>
		</div>

		<div class="sw-group">
			<span class="sw-group__label" id="sw-l-view">表示</span>
			<div class="sw-seg" role="group" aria-labelledby="sw-l-view">
				<button type="button" data-part="view" data-value="pc" aria-pressed="true">PC</button>
				<button type="button" data-part="view" data-value="sp" aria-pressed="false">スマホ</button>
			</div>
		</div>

		<button type="button" class="sw-more" id="sw-more" aria-expanded="false" aria-controls="sw-panel">構成を変える<span aria-hidden="true">▾</span></button>

		<p class="sw-now">いまの組み合わせ <span id="sw-now-text">MV-A ／ 数字-A ／ 育成-A</span></p>

		<button type="button" class="sw-team-btn sw-more" id="sw-team-btn" aria-expanded="false" aria-controls="sw-teampanel">チームで決める<span aria-hidden="true">▾</span></button>

		<button type="button" class="sw-hide" id="sw-hide" title="Esc キーでも引っ込められます">引っ込める<span aria-hidden="true">▴</span></button>
	</div>
</div>
<div class="sw-teampanel" id="sw-teampanel" hidden>
	<div class="sw-teampanel__grid">
		<div>
			<p class="sw-tm__h">チーム案</p>
			<p class="sw-tm__note">この欄だけは全員で共有されます。誰かが更新すると、開いている人の画面にすぐ反映されます。</p>
			<span class="sw-tm__cur" id="sw-tm-cur">まだ決まっていません</span>
			<div class="sw-tm__row">
				<button type="button" class="sw-tm__btn sw-tm__btn--fill" id="sw-tm-save">いまの組み合わせをチーム案にする</button>
				<button type="button" class="sw-tm__btn" id="sw-tm-apply" disabled>チーム案を表示に反映</button>
			</div>
			<p class="sw-tm__msg" id="sw-tm-msg"></p>
		</div>
		<div>
			<p class="sw-tm__h">みんなの意見</p>
			<p class="sw-tm__note">いま見ている組み合わせが、そのまま記録されます。</p>
			<div class="sw-tm__form">
				<input type="text" id="sw-tm-name" class="is-name" placeholder="お名前" maxlength="20" autocomplete="off">
				<input type="text" id="sw-tm-cmt" placeholder="コメント（任意）" maxlength="120" autocomplete="off">
				<button type="button" class="sw-tm__btn" id="sw-tm-add">登録</button>
			</div>
			<ul class="sw-tm__list" id="sw-tm-list"><li class="sw-tm__empty">まだ意見はありません。</li></ul>
		</div>
	</div>
</div>
<button type="button" class="sw-show" id="sw-show">意匠を切り替える<span aria-hidden="true">▾</span></button>
<div class="sw-panel" id="sw-panel" hidden>
	<p class="sw-panel__lead">パートごとに並べ方を切り替えます。<b>どちらが正しいというより、載せる分量と写真の枚数で決まります。</b></p>
	<div class="sw-panel__grid">
		<div class="sw-row">
			<span class="sw-row__name" id="sw-c-intro">イントロ</span>
			<div class="sw-seg" role="group" aria-labelledby="sw-c-intro">
				<button type="button" data-part="intro" data-value="a" aria-pressed="true">A 写真左・文章右</button>
				<button type="button" data-part="intro" data-value="b" aria-pressed="false">B 写真を全幅の帯に</button>
			</div>
		</div>
		<div class="sw-row">
			<span class="sw-row__name" id="sw-c-message">代表メッセージ</span>
			<div class="sw-seg" role="group" aria-labelledby="sw-c-message">
				<button type="button" data-part="message" data-value="a" aria-pressed="true">A 写真左・文章右</button>
				<button type="button" data-part="message" data-value="b" aria-pressed="false">B 写真を上に大きく</button>
			</div>
		</div>
		<div class="sw-row">
			<span class="sw-row__name" id="sw-c-numbers">数字</span>
			<div class="sw-seg" role="group" aria-labelledby="sw-c-numbers">
				<button type="button" data-part="numbers" data-value="a" aria-pressed="true">A 黒ベタ</button>
				<button type="button" data-part="numbers" data-value="b" aria-pressed="false">B 白ベース・細罫</button>
			</div>
		</div>
		<div class="sw-row">
			<span class="sw-row__name" id="sw-c-business">事業</span>
			<div class="sw-seg" role="group" aria-labelledby="sw-c-business">
				<button type="button" data-part="business" data-value="a" aria-pressed="true">A 3枚のカード横並び</button>
				<button type="button" data-part="business" data-value="b" aria-pressed="false">B 縦に積んで左右交互</button>
			</div>
		</div>
		<div class="sw-row">
			<span class="sw-row__name" id="sw-c-work">仕事</span>
			<div class="sw-seg" role="group" aria-labelledby="sw-c-work">
				<button type="button" data-part="work" data-value="a" aria-pressed="true">A 2枚のカード</button>
				<button type="button" data-part="work" data-value="b" aria-pressed="false">B 大きく1列・左右に</button>
			</div>
		</div>
		<div class="sw-row">
			<span class="sw-row__name" id="sw-c-growth">育成</span>
			<div class="sw-seg" role="group" aria-labelledby="sw-c-growth">
				<button type="button" data-part="growth" data-value="a" aria-pressed="true">A 横4ステップ</button>
				<button type="button" data-part="growth" data-value="b" aria-pressed="false">B 縦タイムライン</button>
			</div>
		</div>
		<div class="sw-row">
			<span class="sw-row__name" id="sw-c-people">人</span>
			<div class="sw-seg" role="group" aria-labelledby="sw-c-people">
				<button type="button" data-part="people" data-value="a" aria-pressed="true">A 4枚のカード</button>
				<button type="button" data-part="people" data-value="b" aria-pressed="false">B 横スクロール</button>
			</div>
		</div>
		<div class="sw-row">
			<span class="sw-row__name" id="sw-c-culture">はたらく環境</span>
			<div class="sw-seg" role="group" aria-labelledby="sw-c-culture">
				<button type="button" data-part="culture" data-value="a" aria-pressed="true">A 写真4枚を均等に</button>
				<button type="button" data-part="culture" data-value="b" aria-pressed="false">B 1枚を大きくモザイク</button>
			</div>
		</div>
		<div class="sw-row">
			<span class="sw-row__name" id="sw-c-recruit">募集要項</span>
			<div class="sw-seg" role="group" aria-labelledby="sw-c-recruit">
				<button type="button" data-part="recruit" data-value="a" aria-pressed="true">A 表</button>
				<button type="button" data-part="recruit" data-value="b" aria-pressed="false">B カードの積み重ね</button>
			</div>
		</div>
		<div class="sw-row">
			<span class="sw-row__name" id="sw-c-faq">FAQ</span>
			<div class="sw-seg" role="group" aria-labelledby="sw-c-faq">
				<button type="button" data-part="faq" data-value="a" aria-pressed="true">A アコーディオン</button>
				<button type="button" data-part="faq" data-value="b" aria-pressed="false">B 全文を出して2段組み</button>
			</div>
		</div>
		<div class="sw-row">
			<span class="sw-row__name" id="sw-c-cta">エントリー</span>
			<div class="sw-seg" role="group" aria-labelledby="sw-c-cta">
				<button type="button" data-part="cta" data-value="a" aria-pressed="true">A 中央寄せ</button>
				<button type="button" data-part="cta" data-value="b" aria-pressed="false">B 左右分割</button>
			</div>
		</div>
	</div>
</div>
<p class="sw-note">斜線のボックスは写真が入る位置です（撮影がまだのため、指示文を表示しています）。黄色の「要確認」は社内で数値の確定が必要な箇所です。上下のヘッダーとフッターは形だけの代役で、本番では既存サイトの実物が入ります。</p>
SWBAR;

	echo "\n<div class=\"sw-stage\">\n";
	echo ng_chrome_header();
}

function get_footer() {
	$js = file_get_contents( dirname( __DIR__ ) . '/theme/assets/js/newgrad.js' );
	echo ng_chrome_footer();
	echo "</div>\n"; // .sw-stage
	echo "<script>\n" . $js . "\n</script>\n";

	echo <<<'SWJS'
<script>
/* 意匠の切替。
   MV は data-mv 属性でCSSが出し分ける。
   数字と育成はマークアップが同じなので、クラスを付け替えるだけでよい。
   選んだ内容は端末に覚えさせ、開き直しても保たれるようにしている。 */
(function () {
	var STORE = 'ng-switcher';
	var COMP = ['intro', 'message', 'business', 'work', 'people', 'culture', 'recruit', 'faq', 'cta'];
	var state = { mv: 'a', numbers: 'a', growth: 'a', tone: 'a', shape: 'a', view: 'pc', chrome: 'on' };
	COMP.forEach(function (k) { state[k] = 'a'; });

	var chromeChosen = false;
	try {
		var saved = JSON.parse(localStorage.getItem(STORE) || '{}');
		['mv', 'numbers', 'growth', 'tone', 'shape', 'view', 'chrome'].concat(COMP).forEach(function (k) {
			if (saved[k]) { state[k] = saved[k]; }
		});
		chromeChosen = !!saved.chrome;
	} catch (e) { /* 保存が使えない環境でも既定値で動く */ }

	/* 実機のスマートフォンで開くと、切替バーだけで画面の半分近くを占めてしまい、
	   肝心の意匠がほとんど見えない。狭い画面では最初から引っ込めておき、
	   右下の戻し口から出してもらう。一度でも自分で開閉した端末では、
	   その選択を優先する。 */
	if (!chromeChosen && window.matchMedia('(max-width: 640px)').matches) {
		state.chrome = 'off';
	}

	var root = document.documentElement;

	function applyNumbers(v) {
		var sec = document.getElementById('numbers');
		if (!sec) { return; }
		sec.classList.toggle('ng-section--brand', v === 'a');
		sec.classList.toggle('ng-numbers--plain', v === 'b');
	}

	function applyGrowth(v) {
		var list = document.querySelector('.ng-growth__timeline');
		if (!list) { return; }
		list.classList.toggle('ng-growth__timeline--vertical', v === 'b');
	}

	/* PC用とSP用のCSSを入れ替える。SP用はメディアクエリを展開してあるので、
	   画面幅に関係なくスマートフォンのときの見た目になる。 */
	function applyView(v) {
		var isSp = v === 'sp';
		['ng-css-pc', 'ng-chrome-pc'].forEach(function (id) {
			var el = document.getElementById(id);
			if (el) { el.media = isSp ? 'not all' : 'all'; }
		});
		var sp = document.getElementById('ng-css-sp');
		if (sp) { sp.media = isSp ? 'all' : 'not all'; }
	}

	/* いま画面の上端にいちばん近いセクションを返す。
	   表示やトンマナを切り替えても、その要素を同じ高さに保つために使う。 */
	function currentAnchor() {
		var els  = document.querySelectorAll('.ng-section, .ng-cta');
		var best = null;
		var bestTop = -Infinity;
		for (var i = 0; i < els.length; i++) {
			var t = els[i].getBoundingClientRect().top;
			if (t <= 120 && t > bestTop) { bestTop = t; best = els[i]; }
		}
		return best;
	}

	function label() {
		return 'MV-' + state.mv.toUpperCase()
			+ ' ／ 数字-' + state.numbers.toUpperCase()
			+ ' ／ 育成-' + state.growth.toUpperCase()
			+ ' ／ トンマナ-' + state.tone.toUpperCase()
			+ ' ／ 形-' + state.shape.toUpperCase()
			+ ' ／ 構成' + (function () {
				var n = COMP.concat(['numbers', 'growth']).filter(function (k) { return state[k] !== 'a'; }).length;
				return n ? '-B×' + n : '-既定';
			})();
	}

	function render() {
		root.setAttribute('data-mv', state.mv);
		root.setAttribute('data-view', state.view);
		root.setAttribute('data-chrome', state.chrome);
		applyNumbers(state.numbers);
		applyGrowth(state.growth);
		applyView(state.view);
		var main = document.getElementById('newgrad');
		if (main) {
			main.setAttribute('data-tone', state.tone);
			main.setAttribute('data-shape', state.shape);
			COMP.forEach(function (k) { main.setAttribute('data-comp-' + k, state[k]); });
		}

		document.querySelectorAll('.sw-seg button').forEach(function (b) {
			var on = state[b.dataset.part] === b.dataset.value;
			b.setAttribute('aria-pressed', on ? 'true' : 'false');
		});

		var now = document.getElementById('sw-now-text');
		if (now) { now.textContent = label(); }

		try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (e) {}
	}

	document.querySelectorAll('.sw-seg button').forEach(function (b) {
		b.addEventListener('click', function () {
			/* MV は画面の一番上にあるので、切り替えたら見える位置まで戻す。
			   表示（PC/スマホ）とトンマナは、ページのどこを見ていても
			   同じ場所のまま比べたいので、見ていた位置を保つ。 */
			var toTop  = b.dataset.part === 'mv';
			var anchor = toTop ? null : currentAnchor();
			var before = anchor ? anchor.getBoundingClientRect().top : 0;

			state[b.dataset.part] = b.dataset.value;
			render();

			if (toTop) {
				var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
				window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
			} else if (anchor) {
				/* 組み替え後にレイアウトが確定してから、同じ要素が
				   同じ高さに来るようにスクロール量を補正する */
				requestAnimationFrame(function () {
					if (!document.contains(anchor)) { return; }
					window.scrollBy({ top: anchor.getBoundingClientRect().top - before, behavior: 'auto' });
				});
			}
		});
	});

	/* 構成パネルの開閉 */
	var more  = document.getElementById('sw-more');
	var panel = document.getElementById('sw-panel');
	if (more && panel) {
		more.addEventListener('click', function () {
			var open = more.getAttribute('aria-expanded') === 'true';
			more.setAttribute('aria-expanded', String(!open));
			panel.hidden = open;
		});
	}

	/* 切替UI全体の開閉。
	   バーは sticky で場所を取っているため、消すとページがその分せり上がる。
	   見ていた位置がずれないよう、表示の切替と同じやり方で補正する。 */
	function setChrome(v, focusEl) {
		var anchor = currentAnchor();
		var before = anchor ? anchor.getBoundingClientRect().top : 0;

		state.chrome = v;
		render();

		if (anchor) {
			requestAnimationFrame(function () {
				if (!document.contains(anchor)) { return; }
				window.scrollBy({ top: anchor.getBoundingClientRect().top - before, behavior: 'auto' });
				if (focusEl) { focusEl.focus(); }
			});
		} else if (focusEl) {
			focusEl.focus();
		}
	}

	var hideBtn = document.getElementById('sw-hide');
	var showBtn = document.getElementById('sw-show');
	if (hideBtn && showBtn) {
		hideBtn.addEventListener('click', function () { setChrome('off', showBtn); });
		showBtn.addEventListener('click', function () { setChrome('on', hideBtn); });

		/* Esc でも引っ込められる。文字入力中は横取りしない */
		document.addEventListener('keydown', function (e) {
			if (e.key !== 'Escape' || state.chrome === 'off') { return; }
			var t = e.target;
			if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) { return; }
			setChrome('off', showBtn);
		});
	}

	render();

	/* ======================================================================
	   チームで決める（閲覧者どうしで共有される部分）

	   ここだけが端末内ではなく、Artifact の共有ストア（db）に載る。
	   claude.use は「あとから」解決し、使えない場合は null が返る
	   （未提供・権限なし・読み込み失敗の区別はつかない仕様）。
	   そのため画面は db 無しで完成した状態で描き、
	   使えたときにだけボタンを出して機能を足す。
	   ====================================================================== */
	var KEYS = ['mv', 'numbers', 'growth', 'tone', 'shape'].concat(COMP);

	function currentCombo() {
		var o = {};
		KEYS.forEach(function (k) { o[k] = state[k]; });
		return o;
	}

	function comboLabel(c) {
		if (!c) { return 'まだ決まっていません'; }
		var n = KEYS.filter(function (k) { return k !== 'mv' && k !== 'tone' && k !== 'shape' && c[k] !== 'a'; }).length;
		return 'MV-' + String(c.mv || 'a').toUpperCase()
			+ ' ／ トンマナ-' + String(c.tone || 'a').toUpperCase()
			+ ' ／ 形-' + String(c.shape || 'a').toUpperCase()
			+ ' ／ 構成' + (n ? '-B×' + n : '-既定');
	}

	function applyCombo(c) {
		if (!c) { return; }
		KEYS.forEach(function (k) { if (c[k]) { state[k] = c[k]; } });
		render();
	}

	function esc(t) {
		return String(t == null ? '' : t).replace(/[&<>"]/g, function (ch) {
			return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch];
		});
	}

	(async function team() {
		var db = null;
		try { db = await claude.use('db'); } catch (e) { db = null; }
		if (!db) { return; }   /* 使えない環境では、この機能ごと出さない */

		var btn   = document.getElementById('sw-team-btn');
		var panel = document.getElementById('sw-teampanel');
		var curEl = document.getElementById('sw-tm-cur');
		var msgEl = document.getElementById('sw-tm-msg');
		var listEl = document.getElementById('sw-tm-list');
		var saveBtn = document.getElementById('sw-tm-save');
		var applyBtn = document.getElementById('sw-tm-apply');
		var addBtn = document.getElementById('sw-tm-add');
		var nameEl = document.getElementById('sw-tm-name');
		var cmtEl  = document.getElementById('sw-tm-cmt');
		if (!btn || !panel) { return; }

		btn.style.display = 'inline-flex';
		btn.addEventListener('click', function () {
			var open = btn.getAttribute('aria-expanded') === 'true';
			btn.setAttribute('aria-expanded', String(!open));
			panel.hidden = open;
		});

		/* 名前は本人の端末に覚えさせる。共有側には都度書き込む */
		try { nameEl.value = localStorage.getItem('ng-team-name') || ''; } catch (e) {}

		function say(t) { msgEl.textContent = t || ''; }

		/* 書き込みが拒否されたら、以後は読み取り専用として振る舞う */
		function readOnly(e) {
			var code = e && e.code;
			if (code === 'permission_denied' || code === 'not_writer' || code === 'not_granted') {
				saveBtn.disabled = true; addBtn.disabled = true;
				say('この画面は閲覧のみです（編集の権限がありません）。');
				return true;
			}
			say('保存できませんでした。時間をおいて試してください。');
			return false;
		}

		/* --- チーム案 --- */
		var teamDoc = db.doc('team/current');
		var latest = null;

		teamDoc.onSnapshot(function (snap) {
			var d = snap.exists ? snap.data() : null;
			latest = d && d.combo ? d.combo : null;
			curEl.innerHTML = latest
				? '<b>' + esc(comboLabel(latest)) + '</b>'
					+ (d.by ? '<br>' + esc(d.by) + ' が設定' : '')
				: 'まだ決まっていません';
			applyBtn.disabled = !latest;
		}, function () { say('共有の受信が止まりました。再読み込みしてください。'); });

		saveBtn.addEventListener('click', async function () {
			saveBtn.disabled = true; say('保存しています…');
			try {
				await teamDoc.set({
					combo: currentCombo(),
					by: (nameEl.value || '').trim() || '名前未記入',
					at: new Date().toISOString()
				});
				say('チーム案を更新しました。開いている全員に反映されます。');
			} catch (e) { readOnly(e); }
			saveBtn.disabled = false;
		});

		applyBtn.addEventListener('click', function () {
			applyCombo(latest);
			say('チーム案を表示に反映しました。');
		});

		/* --- みんなの意見 --- */
		var opinions = db.collection('opinions');

		opinions.orderBy('at', 'desc').limit(30).onSnapshot(function (snap) {
			if (snap.empty) {
				listEl.innerHTML = '<li class="sw-tm__empty">まだ意見はありません。</li>';
				return;
			}
			listEl.innerHTML = snap.docs.map(function (d) {
				var o = d.data() || {};
				return '<li class="sw-tm__item">'
					+ '<span class="sw-tm__who">' + esc(o.name || '名前未記入') + '</span> '
					+ '<span class="sw-tm__combo">' + esc(comboLabel(o.combo)) + '</span>'
					+ (o.comment ? '<p class="sw-tm__cmt">' + esc(o.comment) + '</p>' : '')
					+ '</li>';
			}).join('');
		}, function () { /* 受信が止まっても、いま出ている一覧はそのまま残す */ });

		addBtn.addEventListener('click', async function () {
			var name = (nameEl.value || '').trim();
			if (!name) { nameEl.focus(); say('お名前を入れてください。'); return; }
			try { localStorage.setItem('ng-team-name', name); } catch (e) {}
			addBtn.disabled = true; say('登録しています…');
			try {
				await opinions.add({
					name: name,
					comment: (cmtEl.value || '').trim(),
					combo: currentCombo(),
					at: new Date().toISOString()
				});
				cmtEl.value = '';
				say('登録しました。');
			} catch (e) { readOnly(e); }
			addBtn.disabled = false;
		});
	})();
})();
</script>
SWJS;
	echo "\n";
}

/* -------------------------------------------------------------------------
 * テンプレートを実行
 * ------------------------------------------------------------------------- */
require_once $theme_dir . '/inc/newgrad-functions.php';

/* 写真は data URI にして埋め込む（Artifact は外部画像を読めない） */
ob_start();
require $theme_dir . '/page-newgrad.php';
echo ng_inline_photos( ob_get_clean() );
