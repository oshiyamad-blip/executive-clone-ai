#!/usr/bin/env python3
"""
入稿写真を採用ページ用に整えて theme/assets/img/ へ配置する。

  python3 tools/import/build-photos.py <入稿フォルダ>

やること
  1. マッピング表（下の MAP）に従って元ファイルを見つける
  2. HEIC は JPEG へ変換。EXIF の向き情報を実際の画素に適用する
     （スマートフォンの写真は回転情報だけ持っていることが多く、
       そのまま使うと横倒しで表示される）
  3. 長辺 2000px へ縮小し、品質 82 の JPEG で書き出す
     （原寸は 3〜10MB あり、そのままではページが重すぎる）
  4. P-xx.jpg として theme/assets/img/ に置く
"""
import sys, os, re, glob
from PIL import Image, ImageOps
try:
    import pillow_heif; pillow_heif.register_heif_opener()
except ImportError:
    pass

# 写真スロット → 元ファイル名（拡張子なし・部分一致）
MAP = {
    'P-01': 'DSC03955',
    'P-02': 'DSC03843',
    'P-03': 'ジョブ_0040',   # 指定は「0044」。該当が無く、番号違いとして本人確認済み
    'P-04': 'DSC03882',
    'P-05': 'DSC03760',
    'P-06': 'DSC03820',
    'P-07': 'DSC03239',
    'P-08': 'DSC03803',
    'P-09': 'IMG_0731',
    'P-10': 'DSC04122',
    'P-11': 'DSC04074',
    'P-12': 'DSC04014',
    'P-13': 'DSC03973',
    'P-14': 'IMG_0547',
    'P-15': 'IMG_0550',      # 執務室。IMG_0724 は「使わない方が良いかも」との但し書きあり
    'P-16': 'DSC03914',      # 指定は「DSC03918」。該当が無く、番号違いとして本人確認済み
    'P-17': 'ジョブ_0123',
    'P-18': None,            # 指定なし
}

MAXSIDE, QUALITY = 2000, 82

def find(src, stem):
    for p in sorted(glob.glob(os.path.join(src, '**', '*'), recursive=True)):
        if os.path.isfile(p) and stem.lower() in os.path.basename(p).lower():
            return p
    return None

def main():
    if len(sys.argv) < 2:
        sys.exit('使い方: build-photos.py <入稿フォルダ>')
    src = sys.argv[1]
    dst = os.path.join(os.path.dirname(__file__), '..', '..', 'theme', 'assets', 'img')
    dst = os.path.normpath(dst)
    os.makedirs(dst, exist_ok=True)

    done, missing, skipped = [], [], []
    for slot, stem in MAP.items():
        if stem is None:
            skipped.append(slot); continue
        f = find(src, stem)
        if not f:
            missing.append((slot, stem)); continue
        im = Image.open(f)
        im = ImageOps.exif_transpose(im)          # 回転情報を画素へ反映
        im = im.convert('RGB')
        w, h = im.size
        if max(w, h) > MAXSIDE:
            r = MAXSIDE / max(w, h)
            im = im.resize((round(w * r), round(h * r)), Image.LANCZOS)
        out = os.path.join(dst, slot + '.jpg')
        im.save(out, 'JPEG', quality=QUALITY, optimize=True, progressive=True)
        done.append((slot, os.path.basename(f), f'{w}x{h}', f'{im.size[0]}x{im.size[1]}',
                     f'{os.path.getsize(out)/1024:.0f}KB'))

    print(f'配置 {len(done)} 件')
    for d in done:
        print('  {:<5} {:<28} {:>11} → {:>10}  {:>7}'.format(*d))
    if missing:
        print('\n元ファイルが見つからない:')
        for slot, stem in missing: print(f'  {slot}  「{stem}」')
    if skipped:
        print('\n割当未確定（そのままプレースホルダ表示）: ' + ' '.join(skipped))

main()
