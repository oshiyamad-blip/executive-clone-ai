#!/usr/bin/env python3
"""
社内共有用（Artifact）に埋め込む軽量コピーを作る。

Artifact は外部画像を読めないため写真を data URI で埋め込むが、
本番用の 2000px をそのまま base64 にすると1枚あたり4割増しになり、
切替ページは4案ぶんのMVを同時に持つので合計 6.5MB を超える。
確認用に原寸は要らないので、長辺 1400px・品質 76 の別コピーを用意する。
本番（theme/assets/img/）には手を触れない。
"""
import os, glob
from PIL import Image

src = os.path.join(os.path.dirname(__file__), '..', '..', 'theme', 'assets', 'img')
dst = os.path.join(os.path.dirname(__file__), '..', '..', 'preview', 'img-web')
src, dst = os.path.normpath(src), os.path.normpath(dst)
os.makedirs(dst, exist_ok=True)

before = after = 0
for f in sorted(glob.glob(src + '/P-*.jpg')):
    im = Image.open(f)
    w, h = im.size
    if max(w, h) > 1400:
        r = 1400 / max(w, h)
        im = im.resize((round(w * r), round(h * r)), Image.LANCZOS)
    out = os.path.join(dst, os.path.basename(f))
    im.save(out, 'JPEG', quality=76, optimize=True, progressive=True)
    before += os.path.getsize(f); after += os.path.getsize(out)

print(f'軽量コピー {len(glob.glob(dst + "/P-*.jpg"))} 件  '
      f'{before/1024/1024:.2f}MB → {after/1024/1024:.2f}MB')
