"""Reads Brahmi from an image with the Lipi OCR model (local, ONNX Runtime).

python3 read.py MODEL.onnx IMAGE [IMAGE...]   → JSON lines: {file, lines:[{text, conf, box}], confidence, polarity, letterHeight}

Steps: enhance contrast, decide whether letters are darker or lighter than the surface, find text lines
from the horizontal ink profile (after straightening), cut each line, and decode it with CTC.
Photographs of weathered stone are hard; confidence says how sure the model is, line by line.
"""
import json
import os
import sys

import cv2
import numpy as np
import onnxruntime as ort

HERE = os.path.dirname(os.path.abspath(__file__))


class Reader:
    def __init__(self, model):
        meta = json.load(open(os.path.splitext(model)[0] + '.json', encoding='utf-8'))
        self.charset, self.height, self.stride = meta['charset'], meta['height'], meta['stride']
        so = ort.SessionOptions(); so.intra_op_num_threads = max(1, (os.cpu_count() or 2) - 0)
        self.sess = ort.InferenceSession(model, so, providers=['CPUExecutionProvider'])

    # --- line recognition -------------------------------------------------------------------
    def recognise(self, gray_line):
        h, w = gray_line.shape
        W = max(16, int(round(w * self.height / h / 4)) * 4)
        a = cv2.resize(gray_line, (W, self.height), interpolation=cv2.INTER_AREA).astype(np.float32) / 255
        lo, hi = np.percentile(a, 2), np.percentile(a, 98)
        a = np.clip((a - lo) / max(hi - lo, 1e-3), 0, 1)
        if np.median(a) > 0.5: a = 1 - a
        logp = self.sess.run(None, {'image': a[None, None]})[0][0]
        p = np.exp(logp); best = p.argmax(-1)
        text, confs, steps, prev = [], [], [], 0
        for t, k in enumerate(best):
            if k != prev and k != 0: text.append(self.charset[k - 1]); confs.append(float(p[t, k])); steps.append(t)
            prev = k
        # where each character fired, in crop pixels (centre of its CTC step)
        xs = [(t + 0.5) * self.stride * w / W for t in steps]
        self.last_positions = xs
        return ''.join(text), (float(np.mean(confs)) if confs else 0.0)

    MARKS = None
    def aksharas(self, text, xs, width):
        """Groups characters into aksharas and gives each an x-range in the line crop."""
        if Reader.MARKS is None:
            Reader.MARKS = {c for c in self.charset if 0x11000 <= ord(c) <= 0x11002 or 0x11038 <= ord(c) <= 0x11046}
        groups = []
        for ch, x in zip(text, xs):
            if groups and (ch in Reader.MARKS or groups[-1][0].endswith('\U00011046')):
                groups[-1][0] += ch; groups[-1][1].append(x)
            else: groups.append([ch, [x]])
        cents = [float(np.mean(g[1])) for g in groups]
        out = []
        for i, (g, c) in enumerate(zip(groups, cents)):
            half = ((cents[1] - cents[0]) / 2 if len(cents) > 1 else width / 2)
            x0 = (cents[i - 1] + c) / 2 if i else max(0.0, c - half)
            x1 = (c + cents[i + 1]) / 2 if i + 1 < len(cents) else min(float(width), c + half)
            out.append((g[0], x0, x1))
        return out

    # --- page layout ---------------------------------------------------------------------------
    def lines(self, gray):
        g = gray; self.scale = 1.0
        if max(g.shape) > 1600:
            s = 1600 / max(g.shape); g = cv2.resize(g, None, fx=s, fy=s, interpolation=cv2.INTER_AREA); self.scale = s
        self.M = np.array([[1, 0, 0], [0, 1, 0]], np.float64)
        clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8))
        e = clahe.apply(cv2.medianBlur(g, 3))
        best = None
        for pol in ('dark', 'light'):
            src = e if pol == 'dark' else 255 - e
            bw = cv2.adaptiveThreshold(src, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 31, 12)
            n, lab, st, _ = cv2.connectedComponentsWithStats(bw, 8)
            hs = st[1:, cv2.CC_STAT_HEIGHT]; ws = st[1:, cv2.CC_STAT_WIDTH]; ar = st[1:, cv2.CC_STAT_AREA]
            ok = (hs > 6) & (hs < g.shape[0] / 4) & (ws < g.shape[1] / 4) & (ar > 20)
            if ok.sum() < 3: continue
            # letter height: area-weighted median, so specks of grain do not set the scale
            hh, aa = hs[ok], ar[ok].astype(np.float64)
            o = np.argsort(hh); cum = np.cumsum(aa[o]); mh = float(hh[o][np.searchsorted(cum, cum[-1] / 2)])
            letterlike = ok & (hs > mh * 0.5) & (hs < mh * 2.2)
            # prefer the polarity with many similar-sized blobs covering little of the image
            score = letterlike.sum() / (1 + bw.mean() / 255 * 50)
            if best is None or score > best[0]:
                mask = np.isin(lab, np.where(letterlike)[0] + 1).astype(np.uint8) * 255
                best = (score, pol, mask, mh, src)
        if best is None: return [], None, None, e
        _, pol, mask, mh, src = best
        # straighten: the angle whose row profile is the most peaked
        angles = np.arange(-8, 8.5, 0.5); scores = []
        for ang in angles:
            M = cv2.getRotationMatrix2D((mask.shape[1] / 2, mask.shape[0] / 2), ang, 1)
            r = cv2.warpAffine(mask, M, (mask.shape[1], mask.shape[0]))
            scores.append(np.var(r.sum(1).astype(np.float64)))
        ang = float(angles[int(np.argmax(scores))])
        M = cv2.getRotationMatrix2D((mask.shape[1] / 2, mask.shape[0] / 2), ang, 1)
        self.M = M
        mask = cv2.warpAffine(mask, M, (mask.shape[1], mask.shape[0]))
        e_rot = cv2.warpAffine(e, M, (e.shape[1], e.shape[0]), borderMode=cv2.BORDER_REPLICATE)
        prof = mask.sum(1).astype(np.float64)
        k = max(3, int(mh * 0.5) | 1)
        prof = np.convolve(prof, np.ones(k) / k, mode='same')
        H = len(prof)
        # peaks of the row profile = line centres; cut halfway (at the minimum) between neighbours
        peaks = []
        order = np.argsort(-prof)
        for y in order:
            if prof[y] < prof.max() * 0.22: break
            if all(abs(y - q) >= mh * 1.1 for q in peaks): peaks.append(int(y))
        peaks.sort()
        out = []
        for i, pk in enumerate(peaks):
            lo = peaks[i - 1] if i else 0
            hi = peaks[i + 1] if i + 1 < len(peaks) else H - 1
            y0 = lo + int(np.argmin(prof[lo:pk + 1])) if i else max(0, int(pk - mh * 1.2))
            y1 = pk + int(np.argmin(prof[pk:hi + 1])) if i + 1 < len(peaks) else min(H, int(pk + mh * 1.2))
            # trim to where the band really has ink
            band = prof[y0:y1]
            if not len(band): continue
            keep = np.where(band > prof[pk] * 0.12)[0]
            if not len(keep): continue
            y0, y1 = max(0, y0 + keep[0] - int(mh * 0.3)), min(H, y0 + keep[-1] + int(mh * 0.3))
            if y1 - y0 < mh * 0.8: continue
            colsum = mask[y0:y1].sum(0) > 0
            cols = np.where(colsum)[0]
            if not len(cols): continue
            # split at wide horizontal gaps (columns, pillar faces, margins)
            segs, start, last = [], cols[0], cols[0]
            for c in cols[1:]:
                if c - last > mh * 2.0: segs.append((start, last)); start = c
                last = c
            segs.append((start, last))
            for (sx, ex) in segs:
                if ex - sx < mh * 1.5: continue
                out.append((max(0, int(sx - mh * 0.4)), int(y0), min(mask.shape[1], int(ex + mh * 0.4)), int(y1)))
        return out, pol, mh, e_rot

    def read(self, path):
        gray = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
        if gray is None: raise ValueError('cannot open ' + path)
        H0, W0 = gray.shape
        boxes, pol, mh, e = self.lines(gray)
        inv = cv2.invertAffineTransform(self.M)
        def poly(x0, y0, x1, y1):
            # rotated, scaled coordinates → original image, as fractions of width and height
            pts = np.array([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], np.float64)
            back = (inv[:, :2] @ pts.T).T + inv[:, 2]
            back /= self.scale
            return [[round(float(x) / W0, 4), round(float(y) / H0, 4)] for x, y in back]
        res = []
        for (x0, y0, x1, y1) in boxes[:40]:
            crop = e[y0:y1, x0:x1]
            if crop.size == 0 or crop.shape[1] < crop.shape[0]: continue
            text, conf = self.recognise(crop)
            if not text: continue
            # each akshara as [text, start, end], start/end as fractions along the line (the line's polygon gives the rest)
            cw = float(crop.shape[1])
            aks = [[t, round(a / cw, 4), round(b / cw, 4)] for t, a, b in self.aksharas(text, self.last_positions, crop.shape[1])]
            res.append({'text': text, 'conf': round(conf, 3), 'box': [int(x0), int(y0), int(x1), int(y1)], 'poly': poly(x0, y0, x1, y1), 'aksharas': aks})
        n = sum(len(r['text']) for r in res)
        confidence = round(sum(r['conf'] * len(r['text']) for r in res) / n, 3) if n else 0.0
        return {'lines': res, 'confidence': confidence, 'polarity': pol, 'letterHeight': mh}


if __name__ == '__main__':
    r = Reader(sys.argv[1])
    for f in sys.argv[2:]:
        try: out = r.read(f)
        except Exception as ex: out = {'error': str(ex)}
        out['file'] = f
        print(json.dumps(out, ensure_ascii=False), flush=True)
