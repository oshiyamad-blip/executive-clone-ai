<?php
/**
 * Template Name: 新卒採用トップ
 *
 * 株式会社ジーンステイト 新卒採用サイト（/newgrad/）のトップページ。
 *
 * ヘッダー・フッターは get_header() / get_footer() で親テーマのものを
 * そのまま継承する。これによりグローバルナビ・ロゴ・フッター・
 * 共通CSSが物理的に同一になり、コーポレートサイトとのトンマナが保たれる。
 *
 * 掲載する文言・数値は inc/newgrad-content.php に、
 * 写真は inc/newgrad-photos.php に集約している。このファイルは触らずに
 * 内容を差し替えられる。
 *
 * @package GeneState_Newgrad
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

$ng_meta = ng_section( 'meta' );
$ng_entry_url = ng_url( $ng_meta['entry_url'] );

get_header();
?>

<main class="ng" id="newgrad" data-tone="<?php echo esc_attr( ng_variant( 'tone' ) ); ?>" data-shape="<?php echo esc_attr( ng_variant( 'shape' ) ); ?>">

	<?php if ( ng_is_draft() ) : ?>
		<div class="ng-draftbar">
			下書きモード：社内未確認の項目が <strong><?php echo esc_html( ng_count_todo() ); ?></strong> 件あります。
			確認が済んだら <code>NG_DRAFT_MODE</code> を <code>false</code> にしてください（このバーと noindex が外れます）。
		</div>
	<?php endif; ?>


	<?php /* ============================================================
	   1. MV
	   ============================================================ */ ?>
	<?php
	$hero      = ng_section( 'hero' );
	$ng_badge  = $ng_meta['grad_year']['value'] . '年卒 ' . $hero['badge'];

	/* 意匠の切替ページでは4案すべてを出し、表示はCSSで1案に絞る。
	   本番では NG_MV で選んだ1案だけを描画する。 */
	if ( defined( 'NG_SWITCHER' ) && NG_SWITCHER ) {
		foreach ( array( 'a', 'b', 'c', 'd' ) as $ng_v ) {
			ng_render_mv( $ng_v, $hero, $ng_badge, $ng_entry_url, $ng_meta['grad_year'] );
		}
	} else {
		ng_render_mv( ng_variant( 'mv' ), $hero, $ng_badge, $ng_entry_url, $ng_meta['grad_year'] );
	}
	?>

	<nav class="ng-anchors" aria-label="ページ内の目次">
		<div class="ng-container">
			<ul class="ng-anchors__list">
				<?php foreach ( $hero['anchors'] as $anchor ) : ?>
					<li><a href="<?php echo esc_attr( $anchor['href'] ); ?>"><?php echo esc_html( $anchor['label'] ); ?></a></li>
				<?php endforeach; ?>
			</ul>
		</div>
	</nav>


	<?php /* ============================================================
	   2. INTRODUCTION
	   ============================================================ */ ?>
	<?php $intro = ng_section( 'intro' ); ?>
	<section class="ng-section" id="intro" aria-labelledby="ng-intro-title">
		<div class="ng-container">
			<div class="ng-intro__grid">
				<div class="ng-intro__media ng-reveal"><?php ng_photo( $intro['photo'] ); ?></div>
				<div class="ng-intro__body ng-reveal">
					<p class="ng-head__en"><?php echo esc_html( $intro['en'] ); ?></p>
					<h2 class="ng-head__title" id="ng-intro-title"><?php echo esc_html( $intro['title'] ); ?></h2>
					<div style="margin-top:1.75em"><?php ng_paragraphs( $intro['body'] ); ?></div>
					<p class="ng-sectionfoot">
						<a class="ng-link" href="<?php echo ng_url( $intro['link']['href'] ); ?>"><?php echo esc_html( $intro['link']['label'] ); ?></a>
					</p>
				</div>
			</div>
		</div>
	</section>


	<?php /* ============================================================
	   3. MESSAGE
	   ============================================================ */ ?>
	<?php $message = ng_section( 'message' ); ?>
	<section class="ng-section ng-section--subtle" id="message" aria-labelledby="ng-message-title">
		<div class="ng-container">
			<div class="ng-message__grid">
				<div class="ng-message__media ng-reveal"><?php ng_photo( $message['photo'] ); ?></div>
				<div class="ng-reveal">
					<p class="ng-head__en"><?php echo esc_html( $message['en'] ); ?></p>
					<h2 class="ng-head__title" id="ng-message-title"><?php echo esc_html( $message['title'] ); ?></h2>
					<p class="ng-message__lead" style="margin-top:1.25em"><?php echo esc_html( $message['lead'] ); ?></p>
					<?php ng_paragraphs( $message['body'] ); ?>

					<div class="ng-message__sign">
						<span class="ng-message__pos"><?php echo esc_html( $message['position'] ); ?></span>
						<span class="ng-message__name"><?php echo esc_html( $message['name'] ); ?></span>
					</div>
					<p class="ng-sectionfoot">
						<a class="ng-link" href="<?php echo ng_url( $message['link']['href'] ); ?>"><?php echo esc_html( $message['link']['label'] ); ?></a>
					</p>
				</div>
			</div>
		</div>
	</section>


	<?php /* ============================================================
	   4. NUMBERS
	   ============================================================ */ ?>
	<?php $numbers = ng_section( 'numbers' ); ?>
	<section class="<?php echo esc_attr( ng_numbers_class() ); ?>" id="numbers" aria-labelledby="ng-numbers-title">
		<div class="ng-container">
			<div class="ng-head">
				<p class="ng-head__en"><?php echo esc_html( $numbers['en'] ); ?></p>
				<h2 class="ng-head__title" id="ng-numbers-title"><?php echo esc_html( $numbers['title'] ); ?></h2>
			</div>

			<ul class="ng-numbers__grid">
				<?php foreach ( $numbers['items'] as $item ) : ?>
					<li class="ng-numbers__item ng-reveal<?php echo empty( $item['key'] ) ? '' : ' ng-numbers__item--key'; ?>">
						<p class="ng-numbers__label"><?php echo esc_html( $item['label'] ); ?><?php ng_todo( $item ); ?></p>
						<p class="ng-numbers__value">
							<span><?php echo esc_html( $item['value'] ); ?></span>
							<span class="ng-numbers__unit"><?php echo esc_html( $item['unit'] ); ?></span>
						</p>
						<p class="ng-numbers__desc"><?php echo esc_html( $item['desc'] ); ?></p>
					</li>
				<?php endforeach; ?>
			</ul>

			<p class="ng-note"><?php echo esc_html( $numbers['note'] ); ?></p>
			<p class="ng-sectionfoot">
				<a class="ng-btn ng-btn--onbrand" href="<?php echo ng_url( $numbers['link']['href'] ); ?>"><?php echo esc_html( $numbers['link']['label'] ); ?></a>
			</p>
		</div>
	</section>


	<?php /* ============================================================
	   5. BUSINESS
	   ============================================================ */ ?>
	<?php $business = ng_section( 'business' ); ?>
	<section class="ng-section" id="business" aria-labelledby="ng-business-title">
		<div class="ng-container">
			<div class="ng-head ng-head--split">
				<div>
					<p class="ng-head__en"><?php echo esc_html( $business['en'] ); ?></p>
					<h2 class="ng-head__title" id="ng-business-title"><?php echo esc_html( $business['title'] ); ?></h2>
				</div>
				<p class="ng-head__lead"><?php echo esc_html( $business['lead'] ); ?></p>
			</div>

			<ul class="ng-biz__list">
				<?php foreach ( $business['items'] as $item ) : ?>
					<li class="ng-biz__item ng-reveal">
						<div class="ng-biz__media"><?php ng_photo( $item['photo'] ); ?></div>
						<div class="ng-biz__body">
							<span class="ng-biz__no"><?php echo esc_html( $item['no'] ); ?></span>
							<h3 class="ng-biz__name"><?php echo esc_html( $item['name'] ); ?></h3>
							<p class="ng-biz__catch"><?php echo esc_html( $item['catch'] ); ?></p>
							<p class="ng-biz__text"><?php echo esc_html( $item['body'] ); ?></p>
						</div>
					</li>
				<?php endforeach; ?>
			</ul>

			<p class="ng-sectionfoot">
				<a class="ng-link" href="<?php echo ng_url( $business['link']['href'] ); ?>"><?php echo esc_html( $business['link']['label'] ); ?></a>
			</p>
		</div>
	</section>


	<?php /* ============================================================
	   6. WORK
	   ============================================================ */ ?>
	<?php $work = ng_section( 'work' ); ?>
	<section class="ng-section ng-section--subtle" id="work" aria-labelledby="ng-work-title">
		<div class="ng-container">
			<div class="ng-head">
				<p class="ng-head__en"><?php echo esc_html( $work['en'] ); ?></p>
				<h2 class="ng-head__title" id="ng-work-title"><?php echo esc_html( $work['title'] ); ?></h2>
				<p class="ng-head__lead"><?php echo esc_html( $work['lead'] ); ?></p>
				<p class="ng-work__note"><?php echo esc_html( $work['note'] ); ?></p>
			</div>

			<ul class="ng-work__list">
				<?php foreach ( $work['items'] as $item ) : ?>
					<li class="ng-reveal">
						<a class="ng-work__item" href="<?php echo ng_url( $item['href'] ); ?>">
							<div class="ng-work__media"><?php ng_photo( $item['photo'] ); ?></div>
							<div class="ng-work__body">
								<h3 class="ng-work__name"><?php echo esc_html( $item['name'] ); ?></h3>
								<p class="ng-work__catch"><?php echo esc_html( $item['catch'] ); ?></p>
								<p class="ng-work__text"><?php echo esc_html( $item['body'] ); ?></p>
								<span class="ng-link ng-work__more">この仕事を知る</span>
							</div>
						</a>
					</li>
				<?php endforeach; ?>
			</ul>
		</div>
	</section>


	<?php /* ============================================================
	   7. GROWTH（最重要セクション）
	   ============================================================ */ ?>
	<?php $growth = ng_section( 'growth' ); ?>
	<section class="ng-section" id="growth" aria-labelledby="ng-growth-title">
		<div class="ng-container">
			<div class="ng-head ng-head--split">
				<div>
					<p class="ng-head__en"><?php echo esc_html( $growth['en'] ); ?></p>
					<h2 class="ng-head__title" id="ng-growth-title"><?php echo esc_html( $growth['title'] ); ?></h2>
				</div>
				<p class="ng-head__lead"><?php echo esc_html( $growth['lead'] ); ?></p>
			</div>

			<div class="ng-growth__media ng-reveal"><?php ng_photo( $growth['photo'] ); ?></div>

			<ol class="<?php echo esc_attr( ng_growth_class() ); ?>">
				<?php foreach ( $growth['timeline'] as $step ) : ?>
					<li class="ng-growth__step ng-reveal">
						<span class="ng-growth__term"><?php echo esc_html( $step['term'] ); ?></span>
						<h3 class="ng-growth__steptitle"><?php echo esc_html( $step['title'] ); ?></h3>
						<p class="ng-growth__steptext"><?php echo esc_html( $step['body'] ); ?></p>
					</li>
				<?php endforeach; ?>
			</ol>

			<ul class="ng-growth__features">
				<?php foreach ( $growth['features'] as $feature ) : ?>
					<li class="ng-growth__feature ng-reveal">
						<h3 class="ng-growth__featuretitle"><?php echo esc_html( $feature['title'] ); ?></h3>
						<p class="ng-growth__featuretext"><?php echo esc_html( $feature['body'] ); ?></p>
					</li>
				<?php endforeach; ?>
			</ul>

			<p class="ng-sectionfoot">
				<a class="ng-btn ng-btn--ghost" href="<?php echo ng_url( $growth['link']['href'] ); ?>"><?php echo esc_html( $growth['link']['label'] ); ?></a>
			</p>
		</div>
	</section>


	<?php /* ============================================================
	   8. PEOPLE
	   ============================================================ */ ?>
	<?php $people = ng_section( 'people' ); ?>
	<section class="ng-section ng-section--subtle" id="people" aria-labelledby="ng-people-title">
		<div class="ng-container">
			<div class="ng-head ng-head--split">
				<div>
					<p class="ng-head__en"><?php echo esc_html( $people['en'] ); ?></p>
					<h2 class="ng-head__title" id="ng-people-title"><?php echo esc_html( $people['title'] ); ?></h2>
				</div>
				<p class="ng-head__lead"><?php echo esc_html( $people['lead'] ); ?></p>
			</div>

			<ul class="ng-people__list">
				<?php foreach ( $people['items'] as $person ) : ?>
					<li class="ng-reveal">
						<a class="ng-people__item" href="<?php echo ng_url( '/newgrad/people/' . $person['slug'] . '/' ); ?>">
							<div class="ng-people__media"><?php ng_photo( $person['photo'] ); ?></div>
							<span class="ng-people__cat"><?php echo esc_html( $person['cat'] ); ?></span>
							<p class="ng-people__catch"><?php echo esc_html( $person['catch'] ); ?><?php ng_todo( $person ); ?></p>
							<p class="ng-people__prof"><?php echo esc_html( $person['name'] ); ?>／<?php echo esc_html( $person['prof'] ); ?></p>
						</a>
					</li>
				<?php endforeach; ?>
			</ul>

			<p class="ng-sectionfoot">
				<a class="ng-link" href="<?php echo ng_url( $people['link']['href'] ); ?>"><?php echo esc_html( $people['link']['label'] ); ?></a>
			</p>
		</div>
	</section>


	<?php /* ============================================================
	   9. CULTURE
	   ============================================================ */ ?>
	<?php $culture = ng_section( 'culture' ); ?>
	<section class="ng-section" id="culture" aria-labelledby="ng-culture-title">
		<div class="ng-container">
			<div class="ng-head ng-head--split">
				<div>
					<p class="ng-head__en"><?php echo esc_html( $culture['en'] ); ?></p>
					<h2 class="ng-head__title" id="ng-culture-title"><?php echo esc_html( $culture['title'] ); ?></h2>
				</div>
				<p class="ng-head__lead"><?php echo esc_html( $culture['lead'] ); ?></p>
			</div>

			<div class="ng-culture__gallery ng-reveal">
				<?php foreach ( $culture['photos'] as $photo_id ) : ?>
					<div><?php ng_photo( $photo_id ); ?></div>
				<?php endforeach; ?>
			</div>

			<ul class="ng-culture__list">
				<?php foreach ( $culture['items'] as $item ) : ?>
					<li class="ng-culture__item ng-reveal">
						<h3 class="ng-culture__itemtitle"><?php echo esc_html( $item['title'] ); ?><?php ng_todo( $item ); ?></h3>
						<p class="ng-culture__itemtext"><?php echo esc_html( $item['body'] ); ?></p>
					</li>
				<?php endforeach; ?>
			</ul>

			<p class="ng-sectionfoot">
				<a class="ng-link" href="<?php echo ng_url( $culture['link']['href'] ); ?>"><?php echo esc_html( $culture['link']['label'] ); ?></a>
			</p>
		</div>
	</section>


	<?php /* ============================================================
	   10. RECRUIT（募集要項サマリ ＋ 選考フロー）
	   ============================================================ */ ?>
	<?php $recruit = ng_section( 'recruit' ); ?>
	<section class="ng-section ng-section--subtle" id="recruit" aria-labelledby="ng-recruit-title">
		<div class="ng-container">
			<div class="ng-head">
				<p class="ng-head__en"><?php echo esc_html( $recruit['en'] ); ?></p>
				<h2 class="ng-head__title" id="ng-recruit-title"><?php echo esc_html( $recruit['title'] ); ?></h2>
			</div>

			<table class="ng-table">
				<caption class="ng-visually-hidden">新卒採用の募集要項</caption>
				<tbody>
					<?php foreach ( $recruit['rows'] as $row ) : ?>
						<tr>
							<th scope="row"><?php echo esc_html( $row['th'] ); ?></th>
							<td><?php echo esc_html( $row['td'] ); ?><?php ng_todo( $row ); ?></td>
						</tr>
					<?php endforeach; ?>
				</tbody>
			</table>

			<h3 class="ng-head__title" style="margin-top:3em;font-size:var(--ng-fs-h3)">選考フロー</h3>
			<ol class="ng-flow">
				<?php foreach ( $recruit['flow'] as $step ) : ?>
					<li class="ng-flow__item ng-reveal">
						<span class="ng-flow__step"><?php echo esc_html( $step['step'] ); ?></span>
						<h4 class="ng-flow__title"><?php echo esc_html( $step['title'] ); ?></h4>
						<p class="ng-flow__text"><?php echo esc_html( $step['body'] ); ?><?php ng_todo( $step ); ?></p>
					</li>
				<?php endforeach; ?>
			</ol>

			<p class="ng-sectionfoot">
				<?php foreach ( $recruit['links'] as $link ) : ?>
					<a class="ng-link" style="margin-right:2em" href="<?php echo ng_url( $link['href'] ); ?>"><?php echo esc_html( $link['label'] ); ?></a>
				<?php endforeach; ?>
			</p>
		</div>
	</section>


	<?php /* ============================================================
	   11. FAQ
	   ============================================================ */ ?>
	<?php $faq = ng_section( 'faq' ); ?>
	<section class="ng-section" id="faq" aria-labelledby="ng-faq-title">
		<div class="ng-container ng-container--narrow">
			<div class="ng-head">
				<p class="ng-head__en"><?php echo esc_html( $faq['en'] ); ?></p>
				<h2 class="ng-head__title" id="ng-faq-title"><?php echo esc_html( $faq['title'] ); ?></h2>
			</div>

			<div class="ng-faq" data-ng-faq>
				<?php foreach ( $faq['items'] as $index => $item ) : ?>
					<?php $faq_id = 'ng-faq-a-' . $index; ?>
					<div class="ng-faq__item">
						<h3>
							<button type="button" class="ng-faq__q" aria-expanded="false" aria-controls="<?php echo esc_attr( $faq_id ); ?>">
								<span class="ng-faq__mark" aria-hidden="true">Q</span>
								<span class="ng-faq__qtext"><?php echo esc_html( $item['q'] ); ?></span>
								<span class="ng-faq__icon" aria-hidden="true"></span>
							</button>
						</h3>
						<div class="ng-faq__a" id="<?php echo esc_attr( $faq_id ); ?>" data-open="false">
							<div class="ng-faq__ainner">
								<div class="ng-faq__abody">
									<span class="ng-faq__mark" aria-hidden="true">A</span>
									<span><?php echo esc_html( $item['a'] ); ?><?php ng_todo( $item ); ?></span>
								</div>
							</div>
						</div>
					</div>
				<?php endforeach; ?>
			</div>

			<p class="ng-sectionfoot">
				<a class="ng-link" href="<?php echo ng_url( $faq['link']['href'] ); ?>"><?php echo esc_html( $faq['link']['label'] ); ?></a>
			</p>
		</div>
	</section>


	<?php /* ============================================================
	   12. ENTRY CTA
	   ============================================================ */ ?>
	<?php $entry = ng_section( 'entry' ); ?>
	<section class="ng-cta" id="entry" aria-labelledby="ng-entry-title">
		<div class="ng-cta__media"><?php ng_photo( $entry['photo'] ); ?></div>
		<div class="ng-cta__scrim" aria-hidden="true"></div>

		<div class="ng-cta__inner ng-container">
			<p class="ng-head__en"><?php echo esc_html( $entry['en'] ); ?></p>
			<h2 class="ng-cta__title" id="ng-entry-title"><?php echo esc_html( $entry['title'] ); ?></h2>
			<p class="ng-cta__lead"><?php echo esc_html( $entry['lead'] ); ?></p>
			<p class="ng-cta__actions">
				<a class="ng-btn ng-btn--primary" href="<?php echo $ng_entry_url; ?>"><?php echo esc_html( $entry['button'] ); ?></a>
			</p>
			<p class="ng-cta__sub">
				中途採用をお探しの方は <a href="<?php echo ng_url( $ng_meta['mid_career_url'] ); ?>">こちら</a>
			</p>
		</div>
	</section>


	<?php /* モバイル用の固定エントリー導線 */ ?>
	<div class="ng-fixedcta" data-ng-fixedcta data-visible="false">
		<a class="ng-btn ng-btn--primary" href="<?php echo $ng_entry_url; ?>">エントリーする</a>
	</div>

</main>

<?php
get_footer();
