<?php
/**
 * 意匠のバリアント（案）の定義と、MV の描画
 *
 * 採用トップは、いくつかの箇所で意匠の案が複数ある。
 * どの案を使うかは子テーマの functions.php で定数として決める。
 *
 *   define( 'NG_MV',      'c' );  // MV        a=全面写真 / b=左右分割 / c=白ベース / d=タイポ主役
 *   define( 'NG_NUMBERS', 'b' );  // 数字      a=黒ベタ   / b=白ベース・細罫
 *   define( 'NG_GROWTH',  'b' );  // 育成      a=横4ステップ / b=縦タイムライン
 *   define( 'NG_TONE',    'b' );  // トンマナ  a=コーポレート準拠 / b=やわらかめ / c=ダーク
 *
 * 定義しなければ 'a'（現在の実装）になる。
 *
 * NUMBERS と GROWTH はマークアップが同じで CSS だけが違うため、
 * ここではクラス名を返すだけにしている。MV は案ごとに構造が違うので描画関数を持つ。
 *
 * @package GeneState_Newgrad
 */

/**
 * 指定した箇所で使う案の記号を返す。
 *
 * @param string $key 'mv' / 'numbers' / 'growth'。
 * @return string 案の記号（小文字1文字）。
 */
function ng_variant( $key ) {
	$map = array(
		'mv'      => array( 'const' => 'NG_MV',      'allow' => array( 'a', 'b', 'c', 'd' ) ),
		'numbers' => array( 'const' => 'NG_NUMBERS', 'allow' => array( 'a', 'b' ) ),
		'growth'  => array( 'const' => 'NG_GROWTH',  'allow' => array( 'a', 'b' ) ),
		'tone'    => array( 'const' => 'NG_TONE',    'allow' => array( 'a', 'b', 'c' ) ),
	);
	if ( ! isset( $map[ $key ] ) ) {
		return 'a';
	}
	$const = $map[ $key ]['const'];
	$value = defined( $const ) ? strtolower( (string) constant( $const ) ) : 'a';

	// 想定外の値が入っても壊れないよう、既定へ落とす
	return in_array( $value, $map[ $key ]['allow'], true ) ? $value : 'a';
}

/**
 * 数字セクションに付けるクラスを返す。
 *
 * a は黒地の面（--brand）、b は白地に細い罫線。
 *
 * @return string
 */
function ng_numbers_class() {
	return 'b' === ng_variant( 'numbers' )
		? 'ng-section ng-numbers--plain'
		: 'ng-section ng-section--brand';
}

/**
 * 育成セクションの年表に付けるクラスを返す。
 *
 * @return string
 */
function ng_growth_class() {
	return 'b' === ng_variant( 'growth' )
		? 'ng-growth__timeline ng-growth__timeline--vertical'
		: 'ng-growth__timeline';
}

/**
 * MV を描画する。
 *
 * 案ごとに構造が違うため、共通の文言を受け取って案別に組み立てる。
 * 切替ページでは4案すべてを描画し、表示はCSSで1つに絞る。
 *
 * @param string $variant 案の記号 a/b/c/d。
 * @param array  $hero    hero セクションの文言。
 * @param string $badge   バッジの文言（卒業年度を含む、組み立て済みのもの）。
 * @param string $entry   エントリー先のURL（エスケープ済み）。
 * @param array  $todo    バッジに添える「要確認」用のメタ。
 * @return void
 */
function ng_render_mv( $variant, $hero, $badge, $entry, $todo = null ) {
	$classes = 'ng-hero ng-hero--' . $variant;
	?>
	<section class="<?php echo esc_attr( $classes ); ?>" data-mv="<?php echo esc_attr( $variant ); ?>" aria-labelledby="ng-hero-catch-<?php echo esc_attr( $variant ); ?>">

		<?php if ( 'a' === $variant ) : ?>
			<?php /* A 全面写真：写真を敷き、可読性のためのスクリムを重ねて下部にコピーを置く */ ?>
			<div class="ng-hero__media"><?php ng_photo( $hero['photo'], array( 'lazy' => false ) ); ?></div>
			<div class="ng-hero__scrim" aria-hidden="true"></div>
			<div class="ng-hero__inner ng-container">
				<?php ng_mv_copy( $variant, $hero, $badge, $entry, $todo ); ?>
			</div>

		<?php elseif ( 'b' === $variant ) : ?>
			<?php /* B 左右分割：左にコピー面、右に写真。写真の明るさに文字が左右されない */ ?>
			<div class="ng-hero__col ng-hero__col--text">
				<div class="ng-hero__inner">
					<?php ng_mv_copy( $variant, $hero, $badge, $entry, $todo ); ?>
				</div>
			</div>
			<div class="ng-hero__col ng-hero__col--media"><?php ng_photo( $hero['photo'], array( 'lazy' => false ) ); ?></div>

		<?php elseif ( 'c' === $variant ) : ?>
			<?php /* C 白ベース：言葉を主役にし、写真は下の帯で見せる */ ?>
			<div class="ng-hero__inner ng-container">
				<p class="ng-hero__meta">
					<span class="ng-hero__metaen">NEW GRADUATE RECRUITING</span>
					<span class="ng-hero__metarule" aria-hidden="true"></span>
					<span class="ng-hero__metatag"><?php echo esc_html( $hero['badge'] ); ?></span>
				</p>
				<?php ng_mv_copy( $variant, $hero, $badge, $entry, $todo ); ?>
			</div>
			<div class="ng-hero__band"><?php ng_photo( $hero['photo'], array( 'lazy' => false ) ); ?></div>

		<?php else : ?>
			<?php /* D タイポ主役：左にコピー、右に写真を3枚。写真の枚数が最も多い案 */ ?>
			<div class="ng-hero__inner ng-container">
				<div class="ng-hero__col ng-hero__col--text">
					<?php ng_mv_copy( $variant, $hero, $badge, $entry, $todo ); ?>
				</div>
				<div class="ng-hero__grid">
					<div class="ng-hero__cell ng-hero__cell--1"><?php ng_photo( $hero['photo'], array( 'lazy' => false ) ); ?></div>
					<div class="ng-hero__cell ng-hero__cell--2"><?php ng_photo( 'P-02' ); ?></div>
					<div class="ng-hero__cell ng-hero__cell--3"><?php ng_photo( 'P-09' ); ?></div>
				</div>
			</div>
		<?php endif; ?>

	</section>
	<?php
}

/**
 * MV のコピー部分（バッジ・キャッチ・リード・ボタン）。4案で共通。
 *
 * @param string $variant 案の記号。
 * @param array  $hero    hero セクションの文言。
 * @param string $badge   バッジの文言。
 * @param string $entry   エントリー先のURL。
 * @param array  $todo    「要確認」用のメタ。
 * @return void
 */
function ng_mv_copy( $variant, $hero, $badge, $entry, $todo = null ) {
	// C だけはバッジを上のメタ行に出しているので、ここでは省く
	if ( 'c' !== $variant ) :
		?>
		<p class="ng-hero__badge">
			<?php echo esc_html( $badge ); ?>
			<?php if ( $todo ) { ng_todo( $todo ); } ?>
		</p>
		<?php
	endif;
	?>
	<h1 class="ng-hero__catch" id="ng-hero-catch-<?php echo esc_attr( $variant ); ?>">
		<?php foreach ( (array) $hero['catch'] as $line ) : ?>
			<span class="ng-hero__catchline"><?php echo esc_html( $line ); ?></span>
		<?php endforeach; ?>
	</h1>
	<?php /* B だけ、キャッチと本文のあいだに金の短い罫を入れて面を締める */ ?>
	<?php if ( 'b' === $variant ) : ?>
		<span class="ng-hero__rule" aria-hidden="true"></span>
	<?php endif; ?>
	<p class="ng-hero__sub"><?php echo esc_html( $hero['sub'] ); ?></p>
	<p class="ng-hero__actions">
		<a class="ng-btn ng-btn--primary" href="<?php echo $entry; ?>">エントリーする</a>
	</p>
	<?php
}
