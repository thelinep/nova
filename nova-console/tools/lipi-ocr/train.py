"""Trains the Lipi Brahmi OCR model (CNN + BiLSTM + CTC) on synthetic shards and exports ONNX.

python3 train.py --data DIR --val DIR --out lipi-brahmi-ocr.onnx [--epochs 8] [--threads 2]
"""
import argparse
import glob
import json
import math
import os
import random
import sys
import time

import numpy as np
import torch
import torch.nn as nn

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from synth import CHARSET, HEIGHT  # noqa: E402

IDX = {c: i + 1 for i, c in enumerate(CHARSET)}   # 0 = CTC blank


class CRNN(nn.Module):
    def __init__(self, n_classes=len(CHARSET) + 1):
        super().__init__()
        def block(i, o, pool):
            layers = [nn.Conv2d(i, o, 3, padding=1), nn.BatchNorm2d(o), nn.ReLU(inplace=True)]
            if pool: layers.append(nn.MaxPool2d(pool))
            return layers
        self.cnn = nn.Sequential(
            *block(1, 32, (2, 2)),        # 20 x W/2
            *block(32, 64, (2, 2)),       # 10 x W/4
            *block(64, 128, None),
            *block(128, 128, (2, 1)),     # 5 x W/4
            *block(128, 192, None),
            nn.Conv2d(192, 256, (5, 1)), nn.BatchNorm2d(256), nn.ReLU(inplace=True),   # 1 x W/4
        )
        self.rnn = nn.LSTM(256, 160, num_layers=2, bidirectional=True, batch_first=True, dropout=0.15)
        self.fc = nn.Linear(320, n_classes)

    def forward(self, x):                 # x: N x 1 x 40 x W, values 0..1 (normalised per line)
        f = self.cnn(x).squeeze(2).permute(0, 2, 1)   # N x T x 256
        f, _ = self.rnn(f)
        return self.fc(f).log_softmax(-1)  # N x T x C


def normalise(a):
    a = a.astype(np.float32) / 255.0
    lo, hi = np.percentile(a, 2), np.percentile(a, 98)
    a = np.clip((a - lo) / max(hi - lo, 1e-3), 0, 1)
    # make the background dark and letters bright, whatever the source polarity
    if np.median(a) > 0.5: a = 1 - a
    return a


def load(dirname):
    items = []
    for f in sorted(glob.glob(os.path.join(dirname, '*.npz'))):
        z = np.load(f)
        pix, widths, labels = z['pixels'], z['widths'], z['labels']   # read each array once
        x = 0
        for w, lab in zip(widths, labels):
            items.append((pix[:, x:x + w], str(lab))); x += w
    return items


def batches(items, bs, shuffle=True):
    order = list(range(len(items)))
    if shuffle: random.shuffle(order)
    # bucket by width so padding stays small
    chunks = [order[i:i + bs * 50] for i in range(0, len(order), bs * 50)]
    for ch in chunks:
        ch.sort(key=lambda i: items[i][0].shape[1])
        bl = [ch[i:i + bs] for i in range(0, len(ch), bs)]
        if shuffle: random.shuffle(bl)
        for b in bl:
            W = max(items[i][0].shape[1] for i in b)
            W = int(math.ceil(W / 4) * 4)
            x = np.zeros((len(b), 1, HEIGHT, W), np.float32)
            tg, tl, il = [], [], []
            for k, i in enumerate(b):
                a = normalise(items[i][0]); x[k, 0, :, :a.shape[1]] = a
                t = [IDX[c] for c in items[i][1] if c in IDX]
                tg += t; tl.append(len(t)); il.append(a.shape[1] // 4)
            yield torch.from_numpy(x), torch.tensor(tg, dtype=torch.long), torch.tensor(tl), torch.tensor(il)


def greedy(logp, lengths):
    out = []
    best = logp.argmax(-1).numpy()
    for row, n in zip(best, lengths):
        s, prev = [], 0
        for k in row[:n]:
            if k != prev and k != 0: s.append(CHARSET[k - 1])
            prev = k
        out.append(''.join(s))
    return out


def cer(a, b):
    d = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        prev, d[0] = d[0], i
        for j, cb in enumerate(b, 1):
            prev, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, prev + (ca != cb))
    return d[len(b)] / max(1, len(b))


def evaluate(model, val):
    model.eval(); tot = 0; n = 0; exact = 0
    with torch.no_grad():
        for x, tg, tl, il in batches(val, 64, shuffle=False):
            lp = model(x)
            preds = greedy(lp, il.tolist())
            # rebuild targets
            k = 0
            for p, L in zip(preds, tl.tolist()):
                t = ''.join(CHARSET[i - 1] for i in tg[k:k + L].tolist()); k += L
                c = cer(p, t); tot += c; n += 1; exact += (p == t)
    model.train()
    return tot / n, exact / n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', required=True); ap.add_argument('--val', required=True)
    ap.add_argument('--out', default='lipi-brahmi-ocr.onnx'); ap.add_argument('--epochs', type=int, default=8)
    ap.add_argument('--threads', type=int, default=os.cpu_count()); ap.add_argument('--bs', type=int, default=48)
    ap.add_argument('--resume', default='', help='start from these weights (.pt)')
    ap.add_argument('--max-lr', type=float, default=2e-3)
    a = ap.parse_args()
    torch.set_num_threads(a.threads); random.seed(1); torch.manual_seed(1)
    train, val = load(a.data), load(a.val)
    print(f'train {len(train)} val {len(val)} classes {len(CHARSET) + 1}', flush=True)
    model = CRNN()
    if a.resume and os.path.exists(a.resume): model.load_state_dict(torch.load(a.resume)); print('resumed', a.resume)
    print('params', sum(p.numel() for p in model.parameters()), flush=True)
    opt = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-4)
    steps = a.epochs * math.ceil(len(train) / a.bs)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=a.max_lr, total_steps=steps, pct_start=0.1)
    ctc = nn.CTCLoss(blank=0, zero_infinity=True)
    ckpt = os.path.splitext(a.out)[0] + '.pt'
    statef = os.path.splitext(a.out)[0] + '.state.pt'
    best = 9; step = 0; t0 = time.time(); start_ep = 0; skip = 0
    # the run survives a restart: full training state is saved every 500 steps and picked up again
    if os.path.exists(statef):
        st = torch.load(statef, weights_only=False)
        model.load_state_dict(st['model']); opt.load_state_dict(st['opt']); sched.load_state_dict(st['sched'])
        start_ep, skip, step, best = st['epoch'], st['batch'], st['step'], st['best']
        print(f'continuing from epoch {start_ep} batch {skip} (step {step})', flush=True)
    for ep in range(start_ep, a.epochs):
        run = 0
        random.seed(1000 + ep)
        for bi, (x, tg, tl, il) in enumerate(batches(train, a.bs)):
            if ep == start_ep and bi < skip: continue
            if bi and bi % 300 == 0:
                torch.save({'model': model.state_dict(), 'opt': opt.state_dict(), 'sched': sched.state_dict(),
                            'epoch': ep, 'batch': bi, 'step': step, 'best': best}, statef)
            lp = model(x).permute(1, 0, 2)
            loss = ctc(lp, tg, il, tl)
            opt.zero_grad(); loss.backward(); nn.utils.clip_grad_norm_(model.parameters(), 5); opt.step(); sched.step()
            run = 0.98 * run + 0.02 * loss.item() if step else loss.item(); step += 1
            if step % 200 == 0: print(f'ep {ep} step {step}/{steps} loss {run:.3f} {time.time() - t0:.0f}s', flush=True)
        c, ex = evaluate(model, val)
        print(f'== epoch {ep} val CER {c:.4f} exact {ex:.3f} ({time.time() - t0:.0f}s)', flush=True)
        if c < best: best = c; torch.save(model.state_dict(), ckpt)
        torch.save({'model': model.state_dict(), 'opt': opt.state_dict(), 'sched': sched.state_dict(),
                    'epoch': ep + 1, 'batch': 0, 'step': step, 'best': best}, statef)
    model.load_state_dict(torch.load(ckpt)); model.eval()
    dummy = torch.zeros(1, 1, HEIGHT, 200)
    torch.onnx.export(model, dummy, a.out, input_names=['image'], output_names=['logp'], opset_version=17,
                      dynamic_axes={'image': {0: 'n', 3: 'width'}, 'logp': {0: 'n', 1: 't'}}, dynamo=False)
    json.dump({'charset': CHARSET, 'height': HEIGHT, 'stride': 4, 'blank': 0, 'valCER': best,
               'trainedOn': f'{len(train)} synthetic lines', 'created': time.strftime('%Y-%m-%d')},
              open(os.path.splitext(a.out)[0] + '.json', 'w'), ensure_ascii=False, indent=1)
    os.remove(statef)
    print('exported', a.out, 'best val CER', best, flush=True)


if __name__ == '__main__':
    main()
