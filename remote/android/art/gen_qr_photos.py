#!/usr/bin/env python3
"""Simulated phone photos of the pairing code on a monitor, for QrDecodeTest (androidTest assets).

Encodes a short and a long pairing link for a placeholder relay (never a real one) with the `qrcode`
package from sidecar/node_modules, then renders each code as a screen photo: easy, far, tilted,
soft (blur) and glare (highlight + moiré), saved as JPEG. Run from anywhere:

    python3 remote/android/art/gen_qr_photos.py
"""
import json
import math
import os
import random
import subprocess

from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
OUT = os.path.join(ROOT, 'remote/android/app/src/androidTest/assets')
SECRET = 'OVHVZFEHPQKWQ7O6WTXUNUQR2V5ODUCYBO2K633PD4OFQ2YSG65Q'
HOST = 'void-relay.example.workers.dev'
CODES = {
    'short': f'VOIDPORTAL://P/{SECRET}/{HOST.upper()}',
    'long': 'voidportal://pair?v=1&r=wss%3A%2F%2F' + HOST + '&s=Ab3_-x9QzLm2Pq7RsT0uVwXyZ1a2b3c4d5e6f7g8h9i&n=WORKSTATION',
}
W, H = 1280, 960


def matrix(text):
    js = ("const q=require('qrcode');const c=q.create(process.argv[1],{errorCorrectionLevel:'M'});"
          "console.log(JSON.stringify({n:c.modules.size,d:Array.from(c.modules.data)}))")
    out = subprocess.run(['node', '-e', js, text], cwd=os.path.join(ROOT, 'sidecar'), check=True, capture_output=True, text=True).stdout
    m = json.loads(out)
    return m['n'], m['d']


def screen(text, px):
    """The code as the app shows it: light card with a quiet zone, on the dark window."""
    n, data = matrix(text)
    quiet = 4
    side = (n + 2 * quiet) * px
    img = Image.new('L', (side, side), 225)
    d = ImageDraw.Draw(img)
    for i, v in enumerate(data):
        if v:
            x, y = (i % n + quiet) * px, (i // n + quiet) * px
            d.rectangle([x, y, x + px - 1, y + px - 1], fill=22)
    pad = side // 6
    frame = Image.new('L', (side + 2 * pad, side + 2 * pad), 58)
    frame.paste(img, (pad, pad))
    return frame


def perspective(img, skew):
    w, h = img.size
    dx = int(w * skew)
    coeffs = find_coeffs([(dx, 0), (w, dx // 2), (w - dx // 2, h), (0, h - dx)], [(0, 0), (w, 0), (w, h), (0, h)])
    return img.transform((w, h), Image.PERSPECTIVE, coeffs, Image.BICUBIC, fillcolor=40)


def find_coeffs(dst, src):
    # Solve the 8 perspective coefficients mapping output (dst) to input (src) points.
    rows, rhs = [], []
    for (x, y), (u, v) in zip(dst, src):
        rows.append([x, y, 1, 0, 0, 0, -u * x, -u * y]); rhs.append(u)
        rows.append([0, 0, 0, x, y, 1, -v * x, -v * y]); rhs.append(v)
    n = 8
    a = [r + [b] for r, b in zip(rows, rhs)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(a[r][c]))
        a[c], a[p] = a[p], a[c]
        for r in range(n):
            if r != c:
                f = a[r][c] / a[c][c]
                a[r] = [x - f * y for x, y in zip(a[r], a[c])]
    return [a[i][n] / a[i][i] for i in range(n)]


def photo(text, case, rng):
    px = {'easy': 9, 'far': 4, 'tilted': 7, 'soft': 8, 'glare': 8}[case]
    code = screen(text, px)
    if case == 'tilted':
        code = perspective(code, 0.12).rotate(24, resample=Image.BICUBIC, expand=True, fillcolor=40)
    bg = Image.new('L', (W, H), 40)
    bg.paste(code, ((W - code.width) // 2 + rng.randint(-60, 60), (H - code.height) // 2 + rng.randint(-40, 40)))
    if case == 'soft':
        bg = bg.filter(ImageFilter.GaussianBlur(2.6))
    else:
        bg = bg.filter(ImageFilter.GaussianBlur(0.9))
    if case == 'glare':
        glow = Image.new('L', (W, H), 0)
        gd = ImageDraw.Draw(glow)
        cx, cy = W * 0.62, H * 0.38
        for r in range(380, 0, -8):
            gd.ellipse([cx - r, cy - r * 0.7, cx + r, cy + r * 0.7], fill=int(110 * (1 - r / 380)))
        glow = glow.filter(ImageFilter.GaussianBlur(30))
        moire = Image.new('L', (W, H))
        moire.putdata([int(12 + 12 * math.sin((x * 0.9 + y * 0.35) * 0.55)) for y in range(H) for x in range(W)])
        bg = Image.composite(Image.eval(bg, lambda v: min(255, v + 90)), bg, glow)  # highlight
        bg = Image.blend(bg, moire, 0.12)  # screen-door interference
    noise = Image.effect_noise((W, H), 9)
    bg = Image.blend(bg, noise, 0.06)
    return bg.convert('RGB')


def main():
    rng = random.Random(7)
    for kind, text in CODES.items():
        with open(os.path.join(OUT, f'expected_{kind}.txt'), 'w') as f:
            f.write(text + '\n')
        for case in ['easy', 'far', 'tilted', 'soft', 'glare']:
            photo(text, case, rng).save(os.path.join(OUT, f'{kind}_{case}.jpg'), quality=72)
    print('wrote', OUT)


if __name__ == '__main__':
    main()
