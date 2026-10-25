"""Reads every Brahmi gallery image with the OCR model and writes lib/lipi-brahmi-ocr.json.

python3 run_gallery.py MODEL.onnx [OUT.json]

Also scores the model where a published reading is known (tools/lipi-ocr/eval-texts.json):
character error rate of each detected line against the closest reference line.
"""
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
from read import Reader  # noqa: E402

THRESHOLD = 0.8   # a line below this confidence is shown as not legible to the model
# Ashokan and related early forms were checked against a published reading (Lumbini). Later styles were
# learned only from synthetic letters drawn with fonts of the later scripts (Siddham, Bhaiksuki, Sharada,
# Nandinagari, Grantha, Kawi) and Kushan-style head marks: they may be read, but stay unverified.
CHECKED = {'early', 'ashokan', 'post', 'bhattiprolu', 'tamil', 'lanka'}
LEARNED = {'kushan', 'gupta', 'pallava', 'southeast', 'central'}
UNVERIFIED = ('The model learned {} letters only from synthetic examples and has not been checked against a published '
              'reading of this style, so treat the reading as a rough guess.')
NOTES = {'kushan': UNVERIFIED.format('Kushan'), 'gupta': UNVERIFIED.format('Gupta'), 'pallava': UNVERIFIED.format('Pallava, Kadamba and Grantha'),
         'southeast': UNVERIFIED.format('Southeast Asian (Pallava and Kawi)') + ' The language is usually Sanskrit or Old Malay, written here in Brahmi letters.',
         'central': UNVERIFIED.format('Central Asian') + ' Tocharian has extra letters the model does not know.',
         'decipher': 'A chart, not running text: the lines read here are rows of a table.'}


def cer(a, b):
    d = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        prev, d[0] = d[0], i
        for j, cb in enumerate(b, 1):
            prev, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, prev + (ca != cb))
    return d[len(b)] / max(1, len(b))


def main():
    model = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, 'lib', 'lipi-brahmi-ocr.json')
    gal = json.load(open(os.path.join(ROOT, 'lib', 'lipi-brahmi-gallery.json'), encoding='utf-8'))
    meta = json.load(open(os.path.splitext(model)[0] + '.json', encoding='utf-8'))
    evals = json.load(open(os.path.join(HERE, 'eval-texts.json'), encoding='utf-8'))
    r = Reader(model)
    items, t0 = {}, time.time()
    for it in gal['items']:
        res = r.read(os.path.join(ROOT, 'public', it['image'].lstrip('/')))
        for l in res['lines']: l['legible'] = l['conf'] >= THRESHOLD and len(l['text']) >= 4
        good = [l for l in res['lines'] if l['legible']]
        res['legible'] = (it['variant'] in CHECKED or it['variant'] in LEARNED) and sum(len(l['text']) for l in good) >= 8
        res['verified'] = it['variant'] in CHECKED
        res['legibleLines'] = len(good)
        if it['variant'] in NOTES: res['note'] = NOTES[it['variant']]
        items[it['id']] = res
        print(f"{it['id']:<20} lines {len(res['lines']):>2} conf {res['confidence']:.2f} {'legible' if res['legible'] else '-'}", flush=True)
    evaluation = {}
    for gid, ref in evals.items():
        got = items.get(gid, {}).get('lines', [])
        per = []
        for k, refline in enumerate(ref['lines']):
            best = min((cer(g['text'], refline) for g in got), default=1.0)
            per.append(round(best, 3))
        total = sum(c * len(l) for c, l in zip(per, ref['lines'])) / sum(len(l) for l in ref['lines'])
        evaluation[gid] = {'source': ref['source'], 'lineCER': per, 'CER': round(total, 3)}
    leg = [k for k, v in items.items() if v['legible']]
    summary = {'images': len(items), 'legible': len(leg), 'lines': sum(len(v['lines']) for v in items.values()),
               'characters': sum(len(l['text']) for v in items.values() for l in v['lines']), 'seconds': round(time.time() - t0, 1)}
    json.dump({'createdAt': time.strftime('%Y-%m-%d'), 'threshold': THRESHOLD,
               'model': {'valCER': meta.get('valCER'), 'trainedOn': meta.get('trainedOn'), 'created': meta.get('created')},
               'summary': summary, 'evaluation': evaluation, 'items': items}, open(out, 'w'), ensure_ascii=False, separators=(',', ':'))
    print(json.dumps({'summary': summary, 'evaluation': evaluation}, ensure_ascii=False))


if __name__ == '__main__':
    main()
