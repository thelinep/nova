#!/usr/bin/env python3
"""Measure stroke terminals of Brahmi letters from a font's outlines.

For each Brahmi vowel and consonant the glyph outline is read with fontTools,
filled at high resolution, thinned to a one-pixel skeleton (scikit-image), and
the skeleton's end points are taken as stroke terminals. Terminals in the lower
part of the letter are its *bottom terminals*. A letter with none (a closed
loop such as ṭha) gets its lowest skeleton point instead, and says so.

The magnet rule then gives a snap point:
  odd count   -> the middle terminal
  even count  -> x = (xA + xB) / 2 of the two inner terminals, y = the lower one
(The formulas in the HKDM drawings are corrected here: the midpoint is
(xA + xB) / 2, and with y growing downward the bottom of a circle is θ = π/2.)

The script also shapes each consonant with the vowel signs u and ū through
HarfBuzz and records where the font's own anchors put the sign, so the magnet
snap point can be compared with the font designer's placement.

Usage:  python3 brahmi_terminals.py NotoSansBrahmi-Regular.ttf out.json
Font:   Noto Sans Brahmi (SIL Open Font License 1.1). One way to get it:
        npm pack @expo-google-fonts/noto-sans-brahmi
"""
import json
import sys

import numpy as np
from fontTools.pens.basePen import BasePen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw
from skimage.morphology import skeletonize

SCALE = 0.4          # pixels per font unit (1000 upm -> 400 px em)
PAD = 20
LOWER = 0.6          # bottom terminals lie in the lower 40% of the ink box
SPUR = 0.09          # prune skeleton branches shorter than this share of the ink height

VOWELS = [(0x11005, 'a'), (0x11006, 'ā'), (0x11007, 'i'), (0x11008, 'ī'), (0x11009, 'u'), (0x1100A, 'ū'), (0x1100B, 'ṛ'),
          (0x1100C, 'ṝ'), (0x1100D, 'ḷ'), (0x1100E, 'ḹ'), (0x1100F, 'e'), (0x11010, 'ai'), (0x11011, 'o'), (0x11012, 'au')]
CONS = ['ka', 'kha', 'ga', 'gha', 'ṅa', 'ca', 'cha', 'ja', 'jha', 'ña', 'ṭa', 'ṭha', 'ḍa', 'ḍha', 'ṇa', 'ta', 'tha', 'da', 'dha', 'na',
        'pa', 'pha', 'ba', 'bha', 'ma', 'ya', 'ra', 'la', 'va', 'śa', 'ṣa', 'sa', 'ha', 'ḷa']
CONSONANTS = [(0x11013 + i, n) for i, n in enumerate(CONS)]
SIGN_U, SIGN_UU = 0x1103C, 0x1103D


class FlattenPen(BasePen):
    """Collects each contour as a list of points, curves sampled into short lines."""
    def __init__(self, glyphset, steps=16):
        super().__init__(glyphset)
        self.contours, self.cur, self.steps = [], [], steps
    def _moveTo(self, p): self.cur = [p]
    def _lineTo(self, p): self.cur.append(p)
    def _curveToOne(self, p1, p2, p3):
        p0 = self.cur[-1]
        for k in range(1, self.steps + 1):
            t = k / self.steps; u = 1 - t
            self.cur.append((u**3 * p0[0] + 3*u*u*t * p1[0] + 3*u*t*t * p2[0] + t**3 * p3[0],
                             u**3 * p0[1] + 3*u*u*t * p1[1] + 3*u*t*t * p2[1] + t**3 * p3[1]))
    def _qCurveToOne(self, p1, p2):
        p0 = self.cur[-1]
        for k in range(1, self.steps + 1):
            t = k / self.steps; u = 1 - t
            self.cur.append((u*u * p0[0] + 2*u*t * p1[0] + t*t * p2[0], u*u * p0[1] + 2*u*t * p1[1] + t*t * p2[1]))
    def _closePath(self):
        if self.cur: self.contours.append(self.cur)
        self.cur = []
    _endPath = _closePath


def neighbours(sk, y, x):
    h, w = sk.shape
    return [(y + dy, x + dx) for dy in (-1, 0, 1) for dx in (-1, 0, 1)
            if (dy or dx) and 0 <= y + dy < h and 0 <= x + dx < w and sk[y + dy, x + dx]]


def prune(sk, min_len):
    """Removes short spurs: branches from an end point to a junction shorter than min_len pixels."""
    sk = sk.copy()
    for _ in range(3):
        changed = False
        ends = [(y, x) for y, x in zip(*np.nonzero(sk)) if len(neighbours(sk, y, x)) == 1]
        for e in ends:
            path, prev, cur = [e], None, e
            while True:
                nb = [p for p in neighbours(sk, *cur) if p != prev and p not in path]
                if len(nb) != 1 or len(neighbours(sk, *cur)) > 2: break
                prev, cur = cur, nb[0]; path.append(cur)
                if len(path) > min_len: break
            if len(path) <= min_len and len(neighbours(sk, *cur)) > 2:
                for p in path[:-1]: sk[p] = False
                changed = True
        if not changed: break
    return sk


def measure(tt, glyphset, cp, name):
    gname = tt.getBestCmap()[cp]
    g = glyphset[gname]
    bp = BoundsPen(glyphset); g.draw(bp)
    xmin, ymin, xmax, ymax = bp.bounds
    fp = FlattenPen(glyphset); g.draw(fp)
    W = int((xmax - xmin) * SCALE) + 2 * PAD; H = int((ymax - ymin) * SCALE) + 2 * PAD
    to_px = lambda x, y: ((x - xmin) * SCALE + PAD, (ymax - y) * SCALE + PAD)
    img = Image.new('1', (W, H), 0)
    for c in fp.contours:  # even-odd fill: XOR each contour
        layer = Image.new('1', (W, H), 0); ImageDraw.Draw(layer).polygon([to_px(*p) for p in c], fill=1)
        img = Image.fromarray(np.logical_xor(np.array(img), np.array(layer)))
    ink = np.ascontiguousarray(np.array(img.convert('L')) > 0)
    sk = prune(skeletonize(ink), max(4, int(SPUR * (ymax - ymin) * SCALE)))
    to_units = lambda px, py: ((px - PAD) / SCALE + xmin, ymax - (py - PAD) / SCALE)
    ends = sorted(to_units(x, y) for y, x in zip(*np.nonzero(sk)) if len(neighbours(sk, y, x)) == 1)
    height = ymax - ymin
    cut = ymax - LOWER * height        # font units grow upward: lower part = y below cut
    bottom = [p for p in ends if p[1] <= cut]
    method = 'stroke-ends'
    if not bottom:                      # closed shape: lowest skeleton point
        ys, xs = np.nonzero(sk)
        low = ys.max(); xs_low = xs[ys >= low - 1]
        bottom = [to_units(float(xs_low.mean()), float(low))]
        method = 'lowest-point'
    bottom.sort()
    n = len(bottom)
    if n % 2 == 1:
        snap = bottom[n // 2]
    else:
        a, b = bottom[n // 2 - 1], bottom[n // 2]
        snap = ((a[0] + b[0]) / 2, min(a[1], b[1]))  # lower of the two (font y grows upward)
    sp = SVGPathPen(glyphset); g.draw(sp)
    r = lambda p: [round(p[0], 1), round(p[1], 1)]
    return {
        'cp': f'U+{cp:04X}', 'char': chr(cp), 'name': name, 'glyph': gname,
        'advance': tt['hmtx'][gname][0], 'bounds': [round(v, 1) for v in (xmin, ymin, xmax, ymax)],
        'strokeEnds': [r(p) for p in ends], 'bottomTerminals': [r(p) for p in bottom], 'method': method,
        'count': n if method == 'stroke-ends' else 0, 'parity': ('odd' if n % 2 else 'even') if method == 'stroke-ends' else 'none',
        'snap': r(snap), 'path': sp.getCommands(),
    }


def font_sign_placement(fontfile, tt, glyphset, cp, sign):
    """Where the font's anchors put a below-base vowel sign: its ink box after shaping, in the base glyph's units."""
    import uharfbuzz as hb
    face = hb.Face(hb.Blob.from_file_path(fontfile)); font = hb.Font(face)
    buf = hb.Buffer(); buf.add_str(chr(cp) + chr(sign)); buf.guess_segment_properties(); hb.shape(font, buf, {})
    order = tt.getGlyphOrder(); pen_x = 0; boxes = []
    for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
        gname = order[info.codepoint]; bp = BoundsPen(glyphset); glyphset[gname].draw(bp)
        if bp.bounds:
            x0, y0, x1, y1 = bp.bounds; ox, oy = pen_x + pos.x_offset, pos.y_offset
            boxes.append((gname, (x0 + ox, y0 + oy, x1 + ox, y1 + oy), (ox, oy)))
        pen_x += pos.x_advance
    if len(boxes) == 1:   # the font draws base + sign as one pre-composed glyph: no separate anchor to compare
        return {'ligature': boxes[0][0]}
    if len(boxes) < 2: return None
    gname, (x0, y0, x1, y1), (ox, oy) = boxes[-1]
    sp = SVGPathPen(glyphset); glyphset[gname].draw(sp)
    return {'glyph': gname, 'box': [round(v, 1) for v in (x0, y0, x1, y1)], 'topCenter': [round((x0 + x1) / 2, 1), round(y1, 1)],
            'leftEnd': round(x0, 1), 'offset': [ox, oy], 'path': sp.getCommands()}


def main(fontfile, out):
    tt = TTFont(fontfile); gs = tt.getGlyphSet()
    rows = []
    for kind, items in (('vowel', VOWELS), ('consonant', CONSONANTS)):
        for cp, name in items:
            m = measure(tt, gs, cp, name); m['kind'] = kind
            if kind == 'consonant':
                m['fontSigns'] = {}
                for label, sign in (('u', SIGN_U), ('ū', SIGN_UU)):
                    f = font_sign_placement(fontfile, tt, gs, cp, sign)
                    if f and 'ligature' not in f:
                        near = min(m['bottomTerminals'], key=lambda t: abs(t[0] - f['leftEnd']))
                        f['nearestTerminal'] = near                                 # the terminal the sign actually starts at
                        f['dx'] = round(f['topCenter'][0] - m['snap'][0], 1)       # sign centre vs snap point (+ = right)
                        f['dxLeft'] = round(f['leftEnd'] - m['snap'][0], 1)        # sign's left end vs snap point
                        f['dy'] = round(f['topCenter'][1] - m['snap'][1], 1)       # sign top vs snap point (+ = above)
                    if f: m['fontSigns'][label] = f
            rows.append(m)
            print(f"{m['char']} {name:4} ends={len(m['strokeEnds'])} bottom={m['count']} {m['parity']:5} {m['method']}")
    name = tt['name']
    meta = {'font': name.getDebugName(4), 'version': name.getDebugName(5), 'license': 'SIL Open Font License 1.1',
            'unitsPerEm': tt['head'].unitsPerEm, 'method': __doc__.split('\n\n')[1].strip(),
            'parameters': {'scalePxPerUnit': SCALE, 'lowerShare': 1 - LOWER, 'spurShare': SPUR}}
    json.dump({'meta': meta, 'glyphs': rows}, open(out, 'w'), ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main(*sys.argv[1:3])
