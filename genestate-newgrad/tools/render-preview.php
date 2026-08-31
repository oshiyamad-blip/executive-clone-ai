<?php
/**
 * 静的プレビュー生成ツール
 *
 * WordPress に設置する前に、page-newgrad.php の出来上がりを1枚のHTMLとして
 * 確認するためのもの。WordPress の関数を最小限スタブして、テンプレートを
 * そのまま実行し、CSS/JS をインライン化した単体HTMLを書き出す。
 *
 * 使い方:
 *   php tools/render-preview.php > preview/index.html
 *
 * 注意:
 *   ここで出力されるヘッダー・フッターは確認用の簡易版。
 *   本番では get_header() / get_footer() により親テーマの実物に置き換わる。
 *
 * @package GeneState_Newgrad
 */

define( 'ABSPATH', dirname( __DIR__ ) . '/' );
define( 'NG_PREVIEW', true );

$theme_dir = dirname( __DIR__ ) . '/theme';

/* -------------------------------------------------------------------------
 * WordPress 関数のスタブ
 * ------------------------------------------------------------------------- */
function esc_html( $t ) { return htmlspecialchars( (string) $t, ENT_QUOTES, 'UTF-8' ); }
function esc_attr( $t ) { return htmlspecialchars( (string) $t, ENT_QUOTES, 'UTF-8' ); }
function esc_url( $t )  { return htmlspecialchars( (string) $t, ENT_QUOTES, 'UTF-8' ); }
function home_url( $path = '' ) { return 'https://genestate.co.jp' . $path; }
function get_permalink() { return home_url( '/newgrad/' ); }
function get_the_title() { return '新卒採用'; }
function current_time( $format ) { return date( $format ); }
function get_stylesheet_directory() { return dirname( __DIR__ ) . '/theme'; }
function get_stylesheet_directory_uri() { return 'assets-base'; }
function is_page_template( $t ) { return 'page-newgrad.php' === $t; }
function add_action() {}
function wp_enqueue_style() {}
function wp_enqueue_script() {}

function get_header() {
	$css = file_get_contents( dirname( __DIR__ ) . '/theme/assets/css/newgrad.css' );
	echo "<!doctype html>\n<html lang=\"ja\">\n<head>\n";
	echo "<meta charset=\"utf-8\">\n";
	echo "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n";
	echo "<title>新卒採用｜株式会社ジーンステイト（プレビュー）</title>\n";
	echo "<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n";
	echo "<link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n";
	echo "<link href=\"https://fonts.googleapis.com/css2?family=Barlow:wght@600;700&family=Noto+Sans+JP:wght@400;500;700&display=swap\" rel=\"stylesheet\">\n";
	echo "<style>\n" . $css . "\n</style>\n";
	echo <<<'HEADCSS'
<style>
/* ---- プレビュー専用：親テーマのヘッダー/フッターの代役 ---- */
body { margin: 0; font-family: "Noto Sans JP", system-ui, sans-serif; }
.pv-note {
	padding: .75rem 1.25rem; background: #16191D; color: #fff;
	font-size: .8125rem; line-height: 1.7; text-align: center;
}
.pv-header {
	display: flex; align-items: center; justify-content: space-between; gap: 1rem;
	padding: 1rem 1.25rem; border-bottom: 1px solid #DDE3E9; background: #fff;
}
.pv-header__logo { font-weight: 700; letter-spacing: .04em; }
.pv-header__nav { display: flex; flex-wrap: wrap; gap: 1.25rem; font-size: .8125rem; color: #5C6672; }
.pv-footer {
	padding: 2.5rem 1.25rem; background: #16191D; color: #fff;
	font-size: .8125rem; line-height: 1.9; text-align: center;
}
</style>
HEADCSS;
	echo "\n</head>\n<body>\n";
	echo '<p class="pv-note">これは確認用の静的プレビューです。ヘッダーとフッターは仮のもので、本番では親テーマの実物が入ります（トンマナはそこで自動的に揃います）。</p>' . "\n";
	echo '<header class="pv-header"><span class="pv-header__logo">株式会社ジーンステイト</span><nav class="pv-header__nav"><span>ジーンステイトについて</span><span>事業紹介</span><span>会社情報</span><span>採用情報</span><span>お問い合わせ</span></nav></header>' . "\n";
}

function get_footer() {
	$js = file_get_contents( dirname( __DIR__ ) . '/theme/assets/js/newgrad.js' );
	echo '<footer class="pv-footer">株式会社ジーンステイト<br>東京都新宿区西新宿6-5-1 新宿アイランドタワー5階<br><small>（プレビュー用の仮フッター）</small></footer>' . "\n";
	echo "<script>\n" . $js . "\n</script>\n";
	echo "</body>\n</html>\n";
}

/* -------------------------------------------------------------------------
 * テンプレートを実行
 * ------------------------------------------------------------------------- */
require_once $theme_dir . '/inc/newgrad-functions.php';
require $theme_dir . '/page-newgrad.php';
