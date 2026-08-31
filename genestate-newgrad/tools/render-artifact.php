<?php
/**
 * 社内共有用（Artifact）HTML の生成ツール
 *
 * claude.ai の Artifact として公開し、URL を配って社内でレビューしてもらうための
 * 1枚HTMLを書き出す。tools/render-preview.php と同じくテンプレートを実行するが、
 * 出力形式と前後の付属物が異なる。
 *
 *   render-preview.php  … ローカルで開く確認用。<!doctype> から始まる完全なHTML
 *   render-artifact.php … 社内共有用。Artifact 側が <head> を用意するため、
 *                         <title> / <style> / 本文だけを出す。
 *                         加えて、デザイン以外の人が見ても誤解しないよう、
 *                         冒頭に「これは何か」を説明するレビュー用の帯を足す。
 *
 * 使い方:
 *   php tools/render-artifact.php > preview/artifact.html
 *
 * 注意:
 *   採用ページ本体（.ng 配下）には一切手を入れていない。
 *   レビュー用の帯は .rv- 接頭辞で、本体とセレクタが衝突しないようにしている。
 *
 * @package GeneState_Newgrad
 */

define( 'ABSPATH', dirname( __DIR__ ) . '/' );
define( 'NG_PREVIEW', true );

$theme_dir = dirname( __DIR__ ) . '/theme';

/* WordPress 関数のスタブ（render-preview.php と共通） */
require_once __DIR__ . '/wp-stubs.php';

function get_header() {
	$css = file_get_contents( dirname( __DIR__ ) . '/theme/assets/css/newgrad.css' );
	/* @charset は外部CSSの先頭でしか意味を持たない。インラインの <style> では
	   無効な記述になるため取り除く（文字コードは Artifact 側の meta が指定する）。 */
	$css = preg_replace( '/^@charset\s+"[^"]*";\s*/i', '', $css );

	/* Artifact 側の <head> には charset と viewport しか入らないため、
	   <title> と <style>、フォントの読み込みをここで出す。 */
	echo "<title>ジーンステイト 新卒採用サイト案</title>\n";
	echo "<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n";
	echo "<link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n";
	/* 実サイトが読み込んでいるものと同一の指定 */
	echo "<link href=\"https://fonts.googleapis.com/css2?family=Marcellus&family=Zen+Kaku+Gothic+New:wght@300;400;500;700&display=swap\" rel=\"stylesheet\">\n";

	echo "<style>\n" . $css . "\n</style>\n";

	$todo   = ng_count_todo();
	$photos = count( ng_photos() );

	echo <<<REVIEWCSS
<style>
/* ==========================================================================
   社内共有用のレビュー帯（.rv-）と、親テーマ代役のヘッダー/フッター（.pv-）

   採用ページ本体のトンマナには一切影響しない。色と書体は本体と同じ
   genestate のトークン（黒 #19110C / 金 #C7A52D / 地色 #F5F4EE）から取り、
   帯だけが浮いて見えないようにしている。
   ブランドが確定した明るい世界のページなので、閲覧者のテーマに関わらず
   同じ見え方になるよう、配色は固定して明示的に塗っている。
   ========================================================================== */
:root {
	--rv-ink:    #19110C;
	--rv-gold:   #C7A52D;
	--rv-bone:   #F5F4EE;
	--rv-line:   #DDDDDD;
	--rv-muted:  #756F6B;
	--rv-white:  #FFFFFF;
	color-scheme: light;
}
body {
	margin: 0;
	background: var(--rv-white);
	color: var(--rv-ink);
	font-family: "Zen Kaku Gothic New", sans-serif;
	font-size: 16px;
	line-height: 2;
}

/* --- レビュー帯 --------------------------------------------------------- */
.rv-bar {
	background: var(--rv-bone);
	border-bottom: 1px solid var(--rv-gold);
	padding: 28px 40px 26px;
}
.rv-bar__inner {
	max-width: 1120px;
	margin: 0 auto;
	display: grid;
	grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
	gap: 24px 48px;
	align-items: start;
}
.rv-eyebrow {
	font-family: "Marcellus", serif;
	font-size: 13px;
	letter-spacing: .18em;
	line-height: 1;
	color: var(--rv-muted);
	margin: 0 0 10px;
}
.rv-title {
	margin: 0;
	font-size: 22px;
	font-weight: 700;
	line-height: 1.5;
	letter-spacing: .04em;
	text-wrap: balance;
}
.rv-sub {
	margin: 8px 0 0;
	font-size: 14px;
	line-height: 1.9;
	color: var(--rv-muted);
	max-width: 46em;
}
.rv-facts {
	display: flex;
	flex-wrap: wrap;
	gap: 8px 10px;
	margin: 14px 0 0;
}
.rv-chip {
	display: inline-flex;
	align-items: baseline;
	gap: 6px;
	padding: 5px 14px;
	background: var(--rv-white);
	border: 1px solid var(--rv-line);
	border-radius: 50px;
	font-size: 13px;
	line-height: 1.6;
	white-space: nowrap;
}
.rv-chip b {
	font-weight: 700;
	font-variant-numeric: tabular-nums;
}
.rv-chip--draft {
	background: var(--rv-ink);
	border-color: var(--rv-ink);
	color: var(--rv-white);
}

/* 読み方の凡例。デザイン担当以外が見たときに誤解しやすい2点を先に説明する */
.rv-legend { margin: 0; }
.rv-legend__title {
	margin: 0 0 10px;
	font-size: 13px;
	font-weight: 700;
	letter-spacing: .08em;
}
.rv-legend__list {
	margin: 0;
	padding: 0;
	list-style: none;
	display: grid;
	gap: 10px;
}
.rv-legend__item {
	display: grid;
	grid-template-columns: 76px minmax(0, 1fr);
	gap: 12px;
	align-items: center;
	font-size: 13px;
	line-height: 1.75;
	color: var(--rv-muted);
}
/* 見本の要らない項目は1カラムで通す */
.rv-legend__item--plain { grid-template-columns: minmax(0, 1fr); }
.rv-swatch {
	height: 34px;
	border-radius: 4px;
	display: flex;
	align-items: center;
	justify-content: center;
}
.rv-swatch--photo {
	background: repeating-linear-gradient(-45deg, var(--rv-bone) 0 10px, #EBE9E0 10px 20px);
	border: 1px dashed #484231;
	font-family: "Marcellus", serif;
	font-size: 11px;
	color: var(--rv-gold);
}
.rv-swatch--todo {
	background: transparent;
	justify-content: flex-start;
}
.rv-swatch--todo span {
	display: inline-block;
	padding: .15em .6em;
	background: #FFF3CD;
	border: 1px solid #E0B44C;
	border-radius: 2px;
	color: #7A5300;
	font-size: 11px;
	font-weight: 700;
	letter-spacing: .06em;
	line-height: 1.6;
}

/* 本体が出す開発者向けの下書きバーは、上の帯と内容が重なるので隠す */
.ng-draftbar { display: none !important; }

@media (max-width: 767px) {
	.rv-bar { padding: 22px 20px; }
	.rv-bar__inner { grid-template-columns: minmax(0, 1fr); gap: 20px; }
	.rv-title { font-size: 19px; }
}

/* --- 親テーマ代役のヘッダー/フッター -------------------------------------
   本番では親テーマの実物が入る。ここでは採用ページが実サイトの
   ヘッダーとフッターに挟まれたときの見え方を確かめるための代役。
   ---------------------------------------------------------------------- */
.pv-header {
	display: flex; align-items: center; justify-content: space-between; gap: 16px;
	padding: 16px 40px; background: var(--rv-white);
}
.pv-header__logo { font-weight: 700; letter-spacing: .04em; }
.pv-header__right { display: flex; align-items: center; gap: 24px; }
.pv-header__nav { display: flex; flex-wrap: wrap; gap: 20px; font-size: 13px; }
.pv-header__cta { display: flex; gap: 8px; }
.pv-header__cta span {
	display: block; min-width: 100px; padding: 8px 22px; border-radius: 50px;
	border: 1px solid; text-align: center; color: var(--rv-white); font-size: 13px;
}
.pv-header__cta .is-recruit { background: var(--rv-ink); border-color: var(--rv-ink); }
.pv-header__cta .is-contact { background: var(--rv-gold); border-color: var(--rv-gold); }
.pv-footer {
	padding: 46px 40px 51px; background: var(--rv-ink); color: var(--rv-white);
	border-radius: 0 240px 0 0; font-size: 13px; line-height: 1.9;
}
.pv-footer small { color: rgba(255, 255, 255, .6); }
@media (max-width: 767px) {
	.pv-header { padding: 16px 20px; }
	.pv-header__nav, .pv-header__cta { display: none; }
	.pv-footer { padding: 30px 20px; border-radius: 0 120px 0 0; }
}

@media (prefers-reduced-motion: reduce) {
	* { animation-duration: .01ms !important; transition-duration: .01ms !important; }
}
</style>
REVIEWCSS;

	echo "\n";

	/* --- レビュー帯 --- */
	echo '<div class="rv-bar"><div class="rv-bar__inner">' . "\n";
	echo '<div>' . "\n";
	echo '<p class="rv-eyebrow">GENE STATE / NEWGRAD</p>' . "\n";
	echo '<h1 class="rv-title">新卒採用サイト <code>/newgrad/</code> 採用トップの案</h1>' . "\n";
	echo '<p class="rv-sub">初年度（一期生）の募集ページです。配色・書体・余白は'
		. 'コーポレートサイトの実CSSから採取した値をそのまま使っているため、'
		. '本番に載せたときの見え方とほぼ同じです。</p>' . "\n";
	echo '<p class="rv-facts">'
		. '<span class="rv-chip rv-chip--draft">下書き</span>'
		. '<span class="rv-chip">未確定の数値 <b>' . esc_html( $todo ) . '</b> 件</span>'
		. '<span class="rv-chip">写真 <b>' . esc_html( $photos ) . '</b> カット未入稿</span>'
		. '<span class="rv-chip">トンマナ 反映済み</span>'
		. '</p>' . "\n";
	echo '</div>' . "\n";

	echo '<div class="rv-legend">' . "\n";
	echo '<p class="rv-legend__title">見るときの注意</p>' . "\n";
	echo '<ul class="rv-legend__list">' . "\n";
	echo '<li class="rv-legend__item"><span class="rv-swatch rv-swatch--photo">P-00</span>'
		. '<span>斜線のボックスは<b>写真が入る位置</b>です。撮影がまだのため、'
		. 'どんなカットを入れるかの指示を出しています。</span></li>' . "\n";
	echo '<li class="rv-legend__item"><span class="rv-swatch rv-swatch--todo"><span>要確認</span></span>'
		. '<span>このバッジが付いた数値は<b>社内で確定が必要</b>な項目です。'
		. '仮の値が入っています。</span></li>' . "\n";
	echo '<li class="rv-legend__item rv-legend__item--plain">'
		. '<span>上下のヘッダーとフッターは<b>形だけの代役</b>です。'
		. '本番では既存サイトの実物がそのまま入ります。</span></li>' . "\n";
	echo '</ul>' . "\n";
	echo '</div>' . "\n";
	echo '</div></div>' . "\n";

	/* --- 親テーマ代役のヘッダー --- */
	echo '<header class="pv-header"><span class="pv-header__logo">株式会社ジーンステイト</span>'
		. '<span class="pv-header__right">'
		. '<nav class="pv-header__nav"><span>ジーンステイトについて</span><span>事業紹介</span><span>会社情報</span><span>採用情報</span></nav>'
		. '<span class="pv-header__cta"><span class="is-recruit">採用情報</span><span class="is-contact">お問い合わせ</span></span>'
		. '</span></header>' . "\n";
}

function get_footer() {
	$js = file_get_contents( dirname( __DIR__ ) . '/theme/assets/js/newgrad.js' );
	echo '<footer class="pv-footer">株式会社ジーンステイト<br>東京都新宿区西新宿1-26-2 新宿野村ビル39階'
		. '<br><small>（本番では既存サイトのフッターが入ります）</small></footer>' . "\n";
	echo "<script>\n" . $js . "\n</script>\n";
}

/* -------------------------------------------------------------------------
 * テンプレートを実行
 * ------------------------------------------------------------------------- */
require_once $theme_dir . '/inc/newgrad-functions.php';
require $theme_dir . '/page-newgrad.php';
