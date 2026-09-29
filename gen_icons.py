#!/usr/bin/env python3
"""从 icon-src/gptcat_icon_1024.png 缩放生成各密度 launcher 图标。"""
import os
from PIL import Image

SIZES = {
    'mipmap-mdpi': 48,
    'mipmap-hdpi': 72,
    'mipmap-xhdpi': 96,
    'mipmap-xxhdpi': 144,
    'mipmap-xxxhdpi': 192,
}

if __name__ == '__main__':
    root = os.path.dirname(os.path.abspath(__file__))
    src = Image.open(os.path.join(root, 'icon-src', 'gptcat_icon_1024.png')).convert('RGBA')
    base = os.path.join(root, 'app', 'src', 'main', 'res')
    for d, s in SIZES.items():
        outdir = os.path.join(base, d)
        os.makedirs(outdir, exist_ok=True)
        icon = src.resize((s, s), Image.LANCZOS)
        icon.save(os.path.join(outdir, 'ic_launcher.png'), 'PNG')
    print('icons generated:', list(SIZES))
