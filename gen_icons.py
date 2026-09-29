#!/usr/bin/env python3
"""生成 launcher 图标 (PNG)，4 个密度。圆角蓝底 + 白色猫脸。"""
import struct
import zlib
import os

BG = (31, 111, 235)      # #1f6feb 品牌蓝
FACE = (255, 255, 255)
EYE = (31, 111, 235)
NOSE = (255, 120, 160)


def make_icon(size):
    r = round(size * 0.22)
    buf = bytearray()
    for y in range(size):
        row = bytearray(b'\x00')
        for x in range(size):
            inside = True
            if x < r and y < r:
                inside = (r - x) ** 2 + (r - y) ** 2 <= r * r
            elif x > size - 1 - r and y < r:
                inside = (size - 1 - r - x) ** 2 + (r - y) ** 2 <= r * r
            elif x < r and y > size - 1 - r:
                inside = (r - x) ** 2 + (size - 1 - r - y) ** 2 <= r * r
            elif x > size - 1 - r and y > size - 1 - r:
                inside = (size - 1 - r - x) ** 2 + (size - 1 - r - y) ** 2 <= r * r
            if not inside:
                row += bytes((0, 0, 0, 0))
                continue

            col = BG
            cxc = size / 2.0
            cyc = size * 0.52
            fr = size * 0.30
            if (x - cxc) ** 2 + (y - cyc) ** 2 <= fr * fr:
                col = FACE
                ey = cyc - fr * 0.35
                ex1 = cxc - fr * 0.45
                ex2 = cxc + fr * 0.45
                er = fr * 0.16
                if ((x - ex1) ** 2 + (y - ey) ** 2 <= er * er or
                        (x - ex2) ** 2 + (y - ey) ** 2 <= er * er):
                    col = EYE
                nz = cyc + fr * 0.18
                nr = fr * 0.13
                if (x - cxc) ** 2 + (y - nz) ** 2 <= nr * nr:
                    col = NOSE
            row += bytes((col[0], col[1], col[2], 255))
        buf += row

    def chunk(typ, data):
        c = struct.pack('>I', len(data)) + typ + data
        c += struct.pack('>I', zlib.crc32(typ + data) & 0xffffffff)
        return c

    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    idat = zlib.compress(bytes(buf), 9)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', idat) + chunk(b'IEND', b'')
    return png


SIZES = {
    'mipmap-hdpi': 72,
    'mipmap-xhdpi': 96,
    'mipmap-xxhdpi': 144,
    'mipmap-xxxhdpi': 192,
}

if __name__ == '__main__':
    base = os.path.join(os.path.dirname(__file__), 'app', 'src', 'main', 'res')
    for d, s in SIZES.items():
        outdir = os.path.join(base, d)
        os.makedirs(outdir, exist_ok=True)
        with open(os.path.join(outdir, 'ic_launcher.png'), 'wb') as f:
            f.write(make_icon(s))
    print('icons generated:', list(SIZES))
