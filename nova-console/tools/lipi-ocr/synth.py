"""Synthetic Brahmi text lines for training the Lipi OCR model.

There are no transcribed photographs to learn from, so the model learns from text rendered with
Brahmi fonts and then aged to look like the three kinds of source in the gallery:
  * printed plates and line drawings (dark letters on paper),
  * rubbings / estampages (pale letters on a dark mottled sheet),
  * carved stone photographed in raking light (grooves on a grainy grey surface).

Each akshara (consonant cluster + vowel sign) is drawn on its own with a little random size,
tilt and spacing, so the letters vary the way hand-cut ones do.

make_sample(rng) -> (PIL.Image 'L', label string of Brahmi code points, no spaces)
"""
import math
import os
import random

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont, features

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
FONTS = [
    os.path.join(ROOT, 'tools', 'fonts-src', 'NotoSansBrahmi-Regular.ttf'),
    os.environ.get('LIPI_OCR_MAATAA_TTF', os.path.join(HERE, 'maataa-lipi-brahmi.ttf')),
]
HEIGHT = 40          # model input height in pixels
# Later members of the Brahmi family, drawn with their own fonts but labelled in Brahmi, so the model learns
# Gupta-period (Siddham, Bhaiksuki, Sharada, Nandinagari), Pallava (Grantha) and Southeast Asian (Kawi) shapes.
STYLE_FONTS = {
    'Sidd': 'noto-sans-siddham-siddham-400-normal', 'Bhks': 'noto-sans-bhaiksuki-bhaiksuki-400-normal',
    'Shrd': 'noto-sans-sharada-sharada-400-normal', 'Nand': 'noto-sans-nandinagari-nandinagari-400-normal',
    'Gran': 'noto-sans-grantha-grantha-400-normal', 'Kawi': 'noto-sans-kawi-kawi-400-normal',
}
STYLE_DIR = os.environ.get('LIPI_OCR_STYLE_FONTS', os.path.join(HERE, 'fonts'))
# share of samples per look: Brahmi fonts (plain, or with Kushan-style head marks) and the later shapes
STYLE_MIX = [('brahmi', 0.42), ('kushan', 0.10), ('Sidd', 0.09), ('Bhks', 0.07), ('Shrd', 0.06), ('Nand', 0.04), ('Gran', 0.10), ('Kawi', 0.12)]
_style_map = None
def style_map():
    global _style_map
    if _style_map is None:
        import json
        p = os.path.join(HERE, 'style-map.json')
        _style_map = json.load(open(p, encoding='utf-8')) if os.path.exists(p) else {}
    return _style_map


def style_font(code):
    """TTF for a later script (converted once from the woff2 the app ships)."""
    ttf = os.path.join(STYLE_DIR, STYLE_FONTS[code] + '.ttf')
    if not os.path.exists(ttf):
        woff = os.path.join(ROOT, 'public', 'fonts', 'lipi', STYLE_FONTS[code] + '.woff2')
        if not os.path.exists(woff): return None
        from fontTools.ttLib import TTFont
        os.makedirs(STYLE_DIR, exist_ok=True)
        f = TTFont(woff); f.flavor = None; f.save(ttf)
    return ttf


def restyle(cl, code):
    """Brahmi aksharas → the same aksharas in a later script, or None if a letter has no form there."""
    m = style_map().get(code)
    if not m: return None
    out = []
    for c in cl:
        parts = [m.get(ch) for ch in c]
        if any(p is None for p in parts): return None
        out.append(''.join(parts))
    return out

# --- the alphabet the model reads ------------------------------------------------------------
VOWELS = [chr(c) for c in range(0x11005, 0x11013)]                     # a … au
CONS = [chr(c) for c in range(0x11013, 0x11035)]                       # ka … lla
TAMIL = [chr(c) for c in (0x11035, 0x11036, 0x11037)]                  # Old Tamil ḻa, ṟa, ṉa
SIGNS = {'A': '\U00011038', 'i': '\U0001103A', 'I': '\U0001103B', 'u': '\U0001103C', 'U': '\U0001103D',
         'f': '\U0001103E', 'e': '\U00011042', 'E': '\U00011043', 'o': '\U00011044', 'O': '\U00011045'}
ANUSVARA, VISARGA, VIRAMA = '\U00011001', '\U00011002', '\U00011046'
CHARSET = VOWELS + CONS + TAMIL + list(SIGNS.values()) + [ANUSVARA, VISARGA, VIRAMA]
MARKS = set(SIGNS.values()) | {ANUSVARA, VISARGA, VIRAMA}

# SLP1 → Brahmi, for the Paninian sutra texts in guru/data/panini (Sanskrit, with conjuncts)
SLP_V = dict(zip('aAiIuUfFxXeEoO', [chr(c) for c in range(0x11005, 0x11013)]))
SLP_C = dict(zip('kKgGNcCjJYwWqQRtTdDnpPbBmyrlvSzsh', [chr(c) for c in range(0x11013, 0x11034)]))
SLP_S = {'A': SIGNS['A'], 'i': SIGNS['i'], 'I': SIGNS['I'], 'u': SIGNS['u'], 'U': SIGNS['U'], 'f': SIGNS['f'],
         'F': '\U0001103F', 'x': '\U00011040', 'X': '\U00011041', 'e': SIGNS['e'], 'E': SIGNS['E'], 'o': SIGNS['o'], 'O': SIGNS['O']}
CHARSET += ['\U0001103F', '\U00011040', '\U00011041']


def slp1_to_brahmi(s):
    out, prev_c = [], False
    for ch in s:
        if ch in SLP_C:
            if prev_c: out.append(VIRAMA)
            out.append(SLP_C[ch]); prev_c = True
        elif ch in SLP_V:
            if prev_c:
                if ch != 'a': out.append(SLP_S[ch])
            else: out.append(SLP_V[ch])
            prev_c = False
        elif ch == 'M': out.append(ANUSVARA); prev_c = False
        elif ch == 'H': out.append(VISARGA); prev_c = False
        else:
            if prev_c: out.append(VIRAMA)
            prev_c = False
            if ch == ' ': out.append(' ')
    if prev_c: out.append(VIRAMA)
    return ''.join(out)


def load_sutras():
    lines = []
    for name in ('sutrapatha.tsv', 'dhatupatha.tsv', 'unadipatha.tsv', 'varttikas.tsv'):
        p = os.path.join(os.path.dirname(ROOT), 'guru', 'data', 'panini', name)
        if not os.path.exists(p): continue
        for row in open(p, encoding='utf-8').read().splitlines()[1:]:
            parts = row.split('\t')
            if len(parts) >= 2 and parts[-1].strip():
                lines.append(slp1_to_brahmi(parts[-1].strip()))
    return [l for l in lines if l.strip()]


SUTRAS = None
# Prakrit-like syllables: Ashokan Prakrit has few conjuncts and many open syllables
COMMON = 'kKgGcjYwqRtTdDnpbBmyrlvsh'
WEIGHTS = {'k': 6, 't': 8, 'n': 8, 'm': 6, 'p': 6, 'y': 6, 'v': 6, 's': 7, 'l': 6, 'd': 6, 'h': 4, 'c': 4, 'j': 4,
           'b': 3, 'B': 4, 'D': 4, 'g': 3, 'T': 2, 'K': 1, 'G': 1, 'Y': 1, 'w': 2, 'q': 2, 'R': 2, 'r': 2}
VW = [('a', 40), ('A', 16), ('i', 12), ('I', 4), ('u', 10), ('U', 3), ('e', 9), ('o', 4)]


def prakrit_word(rng):
    cons, wc = zip(*WEIGHTS.items())
    vs, vw = zip(*VW)
    out = []
    if rng.random() < 0.12: out.append(SLP_V[rng.choice('aAieuo')])
    for _ in range(rng.randint(2, 6)):
        out.append(SLP_C[rng.choices(cons, wc)[0]])
        if rng.random() < 0.07:
            out += [VIRAMA, SLP_C[rng.choices(cons, wc)[0]]]
        v = rng.choices(vs, vw)[0]
        if v != 'a': out.append(SIGNS[v])
        if rng.random() < 0.07: out.append(ANUSVARA)
    return ''.join(out)


def random_text(rng):
    global SUTRAS
    r = rng.random()
    if r < 0.5:
        return ''.join(prakrit_word(rng) for _ in range(rng.randint(1, 4)))
    if r < 0.8:
        if SUTRAS is None: SUTRAS = load_sutras() or ['']
        s = rng.choice(SUTRAS).replace(' ', '')
        if len(s) > 26:
            a = rng.randint(0, len(s) - 20); s = s[a:a + rng.randint(10, 24)]
        return s
    # uniform coverage of every letter, vowel sign and rare form
    out = []
    for _ in range(rng.randint(3, 10)):
        if rng.random() < 0.2: out.append(rng.choice(VOWELS + TAMIL))
        else:
            out.append(rng.choice(CONS + TAMIL))
            if rng.random() < 0.6: out.append(rng.choice(list(SIGNS.values()) + ['\U0001103F', '\U00011040']))
            if rng.random() < 0.1: out.append(rng.choice([ANUSVARA, VISARGA]))
    return ''.join(out)


def clusters(text):
    """Split into aksharas: a letter starts a cluster unless it follows a virama; marks attach."""
    out = []
    for ch in text:
        if ch == ' ': continue
        if out and (ch in MARKS or out[-1].endswith(VIRAMA)): out[-1] += ch
        else: out.append(ch)
    # a cluster must not start with a mark (fixes bad cuts from substrings)
    while out and out[0][0] in MARKS: out.pop(0)
    return out


def clean_label(text):
    return ''.join(clusters(text))


_font_cache = {}
def font(path, size):
    k = (path, size)
    if k not in _font_cache:
        _font_cache[k] = ImageFont.truetype(path, size, layout_engine=ImageFont.Layout.RAQM if features.check('raqm') else ImageFont.Layout.BASIC)
    return _font_cache[k]


def render_mask(cl, rng, fpath, size, weight, heads=False):
    """Black-on-white mask (0..255, 255 = ink) of one line, akshara by akshara.
    heads: add the small wedges or bars that Kushan and early Gupta carvers put on top of letters."""
    pieces = []
    for c in cl:
        s = max(12, int(size * rng.uniform(0.88, 1.12)))
        f = font(fpath, s)
        l, t, r, b = f.getbbox(c)
        w, h = max(1, r - l), max(1, b - t)
        im = Image.new('L', (w + 16, int(size * 2.2)), 0)
        d = ImageDraw.Draw(im)
        d.text((8 - l, int(size * 0.55)), c, font=f, fill=255, stroke_width=weight, stroke_fill=255)
        if heads:
            bb = im.getbbox()
            if bb:
                a = np.asarray(im)
                # tops of the strokes: for each column, the first ink pixel; mark the highest ones
                cols = [x for x in range(bb[0], bb[2]) if a[:, x].any()]
                if cols:
                    tops = {x: int(np.argmax(a[:, x] > 0)) for x in cols}
                    ymin = min(tops.values()); th = max(2, int(s * rng.uniform(0.05, 0.09)))
                    for x, y in tops.items():
                        if y <= ymin + s * 0.12:
                            d.rectangle([x - th // 2, y - th // 2, x + th // 2, y + th // 3], fill=255)
                    if rng.random() < 0.5:   # a flat bar over the whole letter (Gupta box-head)
                        d.rectangle([bb[0], ymin - th // 2, bb[2], ymin + th // 3], fill=255)
        ang = rng.gauss(0, 3.0)
        im = im.rotate(ang, resample=Image.BILINEAR, expand=False)
        pieces.append((im, int(rng.gauss(0, size * 0.04))))
    gap = lambda: int(size * rng.uniform(0.02, 0.28))
    W = sum(p.width for p, _ in pieces) + sum(gap() for _ in pieces) + 20
    H = int(size * 2.4)
    line = Image.new('L', (W, H), 0)
    x = 10
    for p, dy in pieces:
        line.paste(p, (x, max(0, dy + int(size * 0.1))), p)
        x += p.width - 12 + gap()
    bb = line.getbbox()
    if not bb: return None
    l, t, r, b = bb
    m = int(size * rng.uniform(0.15, 0.5))
    return line.crop((max(0, l - m), max(0, t - m // 2), min(W, r + m), min(H, b + m // 2)))


def noise_field(w, h, rng, scale):
    """Smooth random texture in 0..1 (several octaves of upsampled noise)."""
    acc = np.zeros((h, w), np.float32); amp = 1.0; tot = 0
    for o in range(4):
        sw, sh = max(2, int(w / (scale / 2 ** o))), max(2, int(h / (scale / 2 ** o)))
        n = Image.fromarray((np.random.default_rng(rng.randint(0, 2**31)).random((sh, sw)) * 255).astype(np.uint8)).resize((w, h), Image.BICUBIC)
        acc += amp * np.asarray(n, np.float32) / 255; tot += amp; amp *= 0.5
    return acc / tot


def elastic(arr, rng, alpha, sigma):
    h, w = arr.shape
    dx = np.asarray(Image.fromarray(((np.random.default_rng(rng.randint(0, 2**31)).random((h, w)) * 255).astype(np.uint8))).filter(ImageFilter.GaussianBlur(sigma)), np.float32) / 255 - 0.5
    dy = np.asarray(Image.fromarray(((np.random.default_rng(rng.randint(0, 2**31)).random((h, w)) * 255).astype(np.uint8))).filter(ImageFilter.GaussianBlur(sigma)), np.float32) / 255 - 0.5
    std = max(dx.std(), 1e-3)
    dx, dy = dx / std * alpha, dy / std * alpha
    yy, xx = np.mgrid[0:h, 0:w]
    xs = np.clip(xx + dx, 0, w - 1).astype(np.int32); ys = np.clip(yy + dy, 0, h - 1).astype(np.int32)
    return arr[ys, xs]


def style(mask, rng):
    """Turns an ink mask into one of the gallery's looks. Returns grayscale uint8."""
    m = np.asarray(mask, np.float32) / 255
    h, w = m.shape
    if rng.random() < 0.6: m = elastic(m, rng, alpha=rng.uniform(0.5, 2.0), sigma=rng.uniform(3, 6))
    # erosion: knock holes into strokes (weathering)
    if rng.random() < 0.6:
        holes = noise_field(w, h, rng, rng.uniform(4, 14)) < rng.uniform(0.15, 0.4)
        m = m * np.where(holes, rng.uniform(0.0, 0.6), 1.0)
    kind = rng.choices(['plate', 'rubbing', 'stone', 'photo-plate'], [0.22, 0.28, 0.38, 0.12])[0]
    tex = noise_field(w, h, rng, rng.uniform(6, 40))
    grain = np.random.default_rng(rng.randint(0, 2**31)).normal(0, 1, (h, w)).astype(np.float32)
    if kind == 'plate':
        bg = rng.uniform(0.75, 1.0) - 0.15 * tex * rng.random()
        ink = rng.uniform(0.0, 0.3)
        out = bg * (1 - m) + ink * m
    elif kind == 'photo-plate':
        bg = rng.uniform(0.55, 0.85) - 0.3 * tex
        out = bg * (1 - m) + rng.uniform(0.0, 0.25) * m
    elif kind == 'rubbing':
        bg = rng.uniform(0.05, 0.3) + 0.25 * tex * rng.random()
        blot = noise_field(w, h, rng, rng.uniform(3, 8)) * rng.uniform(0, 0.3)
        out = (bg + blot) * (1 - m) + rng.uniform(0.6, 0.95) * m
    else:  # carved stone, raking light: a groove is dark on one side and light on the other
        bg = rng.uniform(0.35, 0.75) + (tex - 0.5) * rng.uniform(0.2, 0.6)
        groove = np.asarray(Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(rng.uniform(0.6, 1.6))), np.float32) / 255
        dx = int(rng.choice([-1, 1]) * rng.uniform(1, 3)); dy = int(rng.choice([-1, 1]) * rng.uniform(0, 2))
        shifted = np.roll(np.roll(groove, dx, axis=1), dy, axis=0)
        contrast = rng.uniform(0.12, 0.45)
        out = bg - contrast * groove + contrast * 0.8 * shifted * rng.random() - rng.uniform(0, 0.15) * m
    out = out + grain * rng.uniform(0.01, 0.08)
    if rng.random() < 0.15: out = 1 - out
    out = np.clip(out, 0, 1)
    im = Image.fromarray((out * 255).astype(np.uint8))
    if rng.random() < 0.7: im = im.filter(ImageFilter.GaussianBlur(rng.uniform(0.2, 1.3)))
    return im


def to_input(im, rng=None):
    """Scale to model height, keep aspect; light normalisation is done by the model input step."""
    w = max(8, round(im.width * HEIGHT / im.height))
    if rng is not None: w = max(8, int(w * rng.uniform(0.85, 1.15)))
    return im.resize((w, HEIGHT), Image.BILINEAR)


def make_sample(rng):
    while True:
        text = random_text(rng)
        cl = clusters(text)
        if 2 <= len(cl) <= 22: break
    label = ''.join(cl)
    looks, weights = zip(*STYLE_MIX)
    look = os.environ.get('LIPI_OCR_LOOK') or rng.choices(looks, weights)[0]   # LIPI_OCR_LOOK fixes one look (for per-look tests)
    draw, fpath, heads = cl, None, look == 'kushan'
    if look in STYLE_FONTS:
        alt, ttf = restyle(cl, look), style_font(look)
        if alt and ttf: draw, fpath = alt, ttf
    if fpath is None: fpath = rng.choice([f for f in FONTS if os.path.exists(f)])
    size = rng.randint(30, 56)
    mask = render_mask(draw, rng, fpath, size, weight=rng.choice([0, 0, 0, 1, 1, 2]), heads=heads)
    if mask is None: return make_sample(rng)
    if rng.random() < 0.35:  # parts of the lines above and below, as a real line cut from a page has
        H = mask.height; extra = []
        for _ in range(2):
            ncl = clusters(random_text(rng))[:14] or ['\U00011013']
            if look in STYLE_FONTS and fpath not in FONTS: ncl = restyle(ncl, look) or ['\U00011013']
            n = render_mask(ncl, rng, fpath, size, 0)
            extra.append(n)
        cut_t, cut_b = int(H * rng.uniform(0.1, 0.35)), int(H * rng.uniform(0.1, 0.35))
        canvas = Image.new('L', (mask.width, H + cut_t + cut_b), 0)
        if extra[0] is not None and rng.random() < 0.8:
            e = extra[0]; canvas.paste(e.crop((0, max(0, e.height - cut_t), min(e.width, mask.width), e.height)), (0, 0))
        if extra[1] is not None and rng.random() < 0.8:
            e = extra[1]; canvas.paste(e.crop((0, 0, min(e.width, mask.width), cut_b)), (0, H + cut_t))
        canvas.paste(mask, (0, cut_t), mask)
        mask = canvas
    if rng.random() < 0.5 or look in ('Sidd', 'Bhks'):   # shear; slanted like Turkestani (Central Asian) Brahmi
        sh = rng.uniform(-0.15, 0.15) if look not in ('Sidd', 'Bhks') or rng.random() < 0.5 else rng.uniform(0.15, 0.4)
        mask = mask.transform(mask.size, Image.AFFINE, (1, sh, -sh * mask.height / 2, 0, 1, 0), resample=Image.BILINEAR)
    im = style(mask, rng)
    if rng.random() < 0.5:   # JPEG artefacts
        import io
        b = io.BytesIO(); im.save(b, 'JPEG', quality=rng.randint(25, 85)); im = Image.open(io.BytesIO(b.getvalue())).convert('L')
    return to_input(im, rng), label


if __name__ == '__main__':
    import sys
    rng = random.Random(int(sys.argv[1]) if len(sys.argv) > 1 else 1)
    rows = []
    for i in range(24):
        im, lab = make_sample(rng)
        rows.append(im)
    W = max(r.width for r in rows)
    sheet = Image.new('L', (W, sum(r.height + 4 for r in rows)), 128)
    y = 0
    for r in rows: sheet.paste(r, (0, y)); y += r.height + 4
    sheet.save(sys.argv[2] if len(sys.argv) > 2 else 'synth-preview.png')
    print(len(CHARSET), 'characters')
