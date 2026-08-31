<?php
/**
 * 新卒採用サイト（/newgrad/）用のヘルパー関数とアセット読み込み
 *
 * 子テーマの functions.php から一度だけ読み込む：
 *   require_once get_stylesheet_directory() . '/inc/newgrad-functions.php';
 *
 * @package GeneState_Newgrad
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * 下書きモード。
 *
 * true の間は、社内未確認の項目（'todo' => true）に警告バッジが表示され、
 * ページ上部に確認を促すバーが出る。
 * すべての項目の確認が取れたら、子テーマの functions.php 側で
 *   define( 'NG_DRAFT_MODE', false );
 * を、このファイルの require より前に書いて無効化する。
 */
if ( ! defined( 'NG_DRAFT_MODE' ) ) {
	define( 'NG_DRAFT_MODE', true );
}

/** アセットのキャッシュ破棄に使うバージョン。CSS/JS を更新したら上げる。 */
if ( ! defined( 'NG_ASSET_VER' ) ) {
	define( 'NG_ASSET_VER', '1.0.0' );
}


/* 意匠のバリアント（MV / 数字 / 育成の案）の定義と描画 */
require_once __DIR__ . '/newgrad-variants.php';


/* =========================================================================
 * コンテンツ取得
 * ========================================================================= */

/**
 * 掲載コンテンツ定義を取得する（初回のみ読み込む）。
 *
 * @return array
 */
function ng_content() {
	static $content = null;
	if ( null === $content ) {
		$content = require __DIR__ . '/newgrad-content.php';
	}
	return $content;
}

/**
 * 指定セクションのコンテンツを取得する。
 *
 * @param string $key セクションキー（hero / intro / message ...）。
 * @return array
 */
function ng_section( $key ) {
	$content = ng_content();
	return isset( $content[ $key ] ) ? $content[ $key ] : array();
}

/**
 * 写真定義を取得する。
 *
 * @return array
 */
function ng_photos() {
	static $photos = null;
	if ( null === $photos ) {
		$photos = require __DIR__ . '/newgrad-photos.php';
	}
	return $photos;
}


/* =========================================================================
 * 表示ヘルパー
 * ========================================================================= */

/**
 * サイト内リンクのURLを組み立てる。
 *
 * @param string $path ルート相対パス（例 '/newgrad/entry/'）。
 * @return string エスケープ済みURL。
 */
function ng_url( $path ) {
	return esc_url( home_url( $path ) );
}

/**
 * 下書きモードかどうか。
 *
 * @return bool
 */
function ng_is_draft() {
	return (bool) NG_DRAFT_MODE;
}

/**
 * 未確認項目のバッジを出力する。
 *
 * @param array $item 'todo' キーを持ちうる配列。
 * @return void
 */
function ng_todo( $item ) {
	if ( ng_is_draft() && ! empty( $item['todo'] ) ) {
		echo '<span class="ng-todo">要確認</span>';
	}
}

/**
 * コンテンツ定義に残っている未確認項目の数を数える。
 *
 * @param mixed $node 走査対象。省略時はコンテンツ全体。
 * @return int
 */
function ng_count_todo( $node = null ) {
	if ( null === $node ) {
		$node = ng_content();
	}
	if ( ! is_array( $node ) ) {
		return 0;
	}

	$count = 0;
	if ( ! empty( $node['todo'] ) ) {
		$count++;
	}
	foreach ( $node as $value ) {
		if ( is_array( $value ) ) {
			$count += ng_count_todo( $value );
		}
	}
	return $count;
}

/**
 * 写真IDに対応する実ファイルを子テーマ内から探す。
 *
 * assets/img/{ID}.{webp|jpg|jpeg|png} の順に探索する。
 *
 * @param string $id 写真ID（例 'P-01'）。
 * @return string|false 見つかればURL、無ければ false。
 */
function ng_photo_url( $id ) {
	static $cache = array();
	if ( isset( $cache[ $id ] ) ) {
		return $cache[ $id ];
	}

	$dir = get_stylesheet_directory() . '/assets/img/';
	$uri = get_stylesheet_directory_uri() . '/assets/img/';

	$cache[ $id ] = false;
	foreach ( array( 'webp', 'jpg', 'jpeg', 'png' ) as $ext ) {
		$file = $id . '.' . $ext;
		if ( file_exists( $dir . $file ) ) {
			$cache[ $id ] = $uri . $file;
			break;
		}
	}
	return $cache[ $id ];
}

/**
 * 写真を出力する。
 *
 * 実ファイルがあれば <img>、無ければ「どんな写真が入るか」を示す
 * プレースホルダを出力する。写真の入稿を待たずに関係者確認を進められる。
 *
 * @param string $id      写真ID（例 'P-01'）。
 * @param array  $args    lazy / class の指定。
 * @return void
 */
function ng_photo( $id, $args = array() ) {
	$photos = ng_photos();
	$meta   = isset( $photos[ $id ] ) ? $photos[ $id ] : array( 'alt' => '', 'note' => '' );
	$url    = ng_photo_url( $id );

	if ( $url ) {
		$lazy = isset( $args['lazy'] ) ? $args['lazy'] : true;
		printf(
			'<img src="%1$s" alt="%2$s" loading="%3$s" decoding="async">',
			esc_url( $url ),
			esc_attr( $meta['alt'] ),
			$lazy ? 'lazy' : 'eager'
		);
		return;
	}

	printf(
		'<div class="ng-ph" role="img" aria-label="%1$s"><span class="ng-ph__id">%2$s</span><span class="ng-ph__note">%3$s</span></div>',
		esc_attr( $meta['note'] ),
		esc_html( $id ),
		esc_html( $meta['note'] )
	);
}

/**
 * 段落配列を <p> として出力する。
 *
 * @param array $paragraphs 段落テキストの配列。
 * @return void
 */
function ng_paragraphs( $paragraphs ) {
	foreach ( (array) $paragraphs as $text ) {
		echo '<p>' . esc_html( $text ) . '</p>';
	}
}


/* =========================================================================
 * アセット読み込み
 * ========================================================================= */

/**
 * 新卒採用ページでのみ、専用のCSS/JSを読み込む。
 *
 * 全ページで読み込むと親テーマの表示速度に影響するため、
 * テンプレートが page-newgrad.php のときだけに限定する。
 *
 * @return void
 */
function ng_enqueue_assets() {
	if ( ! is_page_template( 'page-newgrad.php' ) ) {
		return;
	}

	wp_enqueue_style(
		'genestate-newgrad',
		get_stylesheet_directory_uri() . '/assets/css/newgrad.css',
		array(), // 親テーマのスタイルの後に読ませたい場合は、ここに親のハンドル名を入れる。
		NG_ASSET_VER
	);

	wp_enqueue_script(
		'genestate-newgrad',
		get_stylesheet_directory_uri() . '/assets/js/newgrad.js',
		array(),
		NG_ASSET_VER,
		true
	);
}
add_action( 'wp_enqueue_scripts', 'ng_enqueue_assets' );

/**
 * 新卒採用ページの <head> に meta description と OGP を出力する。
 *
 * SEOプラグイン（Yoast / SEO SIMPLE PACK 等）を導入済みの場合は
 * 重複するため、この add_action を削除してプラグイン側で設定すること。
 *
 * @return void
 */
function ng_head_meta() {
	if ( ! is_page_template( 'page-newgrad.php' ) ) {
		return;
	}

	$meta  = ng_section( 'meta' );
	$desc  = isset( $meta['description'] ) ? $meta['description'] : '';
	$title = get_the_title() . ' | 株式会社ジーンステイト';
	$image = ng_photo_url( 'P-01' );

	echo "\n<!-- newgrad meta -->\n";
	printf( '<meta name="description" content="%s">' . "\n", esc_attr( $desc ) );
	printf( '<meta property="og:type" content="website">' . "\n" );
	printf( '<meta property="og:title" content="%s">' . "\n", esc_attr( $title ) );
	printf( '<meta property="og:description" content="%s">' . "\n", esc_attr( $desc ) );
	printf( '<meta property="og:url" content="%s">' . "\n", esc_url( get_permalink() ) );
	if ( $image ) {
		printf( '<meta property="og:image" content="%s">' . "\n", esc_url( $image ) );
		printf( '<meta name="twitter:card" content="summary_large_image">' . "\n" );
	}
}
add_action( 'wp_head', 'ng_head_meta', 5 );

/**
 * 下書き中のページを検索エンジンに拾わせない。
 *
 * 公開前の確認用URLがインデックスされる事故を防ぐ。
 * NG_DRAFT_MODE を false にすると自動的に外れる。
 *
 * meta と HTTPヘッダの両方で出しているのは、
 * meta はHTMLを解釈するクローラにしか効かないため。
 * ヘッダなら PDF や画像への直リンクにも効き、HTMLを読まない収集にも届く。
 *
 * 併記している値の意味
 *   noindex   検索結果に出さない
 *   nofollow  ページ内のリンクを辿らせない
 *   noarchive キャッシュ（保存版）を持たせない
 *   nosnippet 検索結果に本文の抜粋を出させない
 *
 * @return void
 */
function ng_noindex_while_draft() {
	if ( ng_is_draft() && is_page_template( 'page-newgrad.php' ) ) {
		echo '<meta name="robots" content="noindex,nofollow,noarchive,nosnippet">' . "\n";
	}
}
add_action( 'wp_head', 'ng_noindex_while_draft', 1 );

/**
 * 同じ指示を HTTP ヘッダ（X-Robots-Tag）でも送る。
 *
 * @return void
 */
function ng_noindex_header() {
	if ( headers_sent() ) {
		return;
	}
	if ( ng_is_draft() && is_page_template( 'page-newgrad.php' ) ) {
		header( 'X-Robots-Tag: noindex, nofollow, noarchive, nosnippet', true );
	}
}
add_action( 'template_redirect', 'ng_noindex_header', 1 );
