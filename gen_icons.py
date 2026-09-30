#!/usr/bin/env python3
"""从 icon-src/ 下最新的图标源图缩放生成各密度 launcher 图标。"""
import os
from PIL import Image

SIZES = {
    'mipmap-mdpi': 48,
    'mipmap-hdpi': 72,
    'mipmap-xhdpi': 96,
    'mipmap-xxhdpi': 144,
    'mipmap-xxxhdpi': 192,
}

SOURCE_NAME = 'icon-src/source.png'


def load_source(root):
    """优先用约定的 source.png；否则退回按修改时间挑最新的图片。"""
    preferred = os.path.join(root, SOURCE_NAME)
    if os.path.isfile(preferred):
        return preferred
    srcdir = os.path.join(root, 'icon-src')
    candidates = [os.path.join(srcdir, n) for n in sorted(os.listdir(srcdir))
                  if n.lower().endswith(('.png', '.jpg', '.jpeg', '.webp'))]
    if not candidates:
        raise SystemExit('icon-src/ 下没有可用的图标源图')
    return max(candidates, key=os.path.getmtime)


if __name__ == '__main__':
    root = os.path.dirname(os.path.abspath(__file__))
    source = load_source(root)
    src = Image.open(source).convert('RGBA')
    # 居中裁成正方形并缩到 1024，保证各密度长宽一致不变形。
    side = min(src.size)
    left, top = (src.width - side) // 2, (src.height - side) // 2
    master = src.crop((left, top, left + side, top + side)).resize((1024, 1024), Image.LANCZOS)
    master.save(os.path.join(root, 'icon-src', 'source.png'), 'PNG')

    base = os.path.join(root, 'app', 'src', 'main', 'res')
    for d, s in SIZES.items():
        outdir = os.path.join(base, d)
        os.makedirs(outdir, exist_ok=True)
        master.resize((s, s), Image.LANCZOS).save(os.path.join(outdir, 'ic_launcher.png'), 'PNG')
    print('icons generated from:', os.path.basename(source), list(SIZES))
