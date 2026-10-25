"""Writes synthetic training shards: python3 make_data.py OUT_DIR COUNT [WORKERS] [SEED]

Each shard is an .npz with the line images concatenated side by side (height 40) plus offsets and labels.
"""
import os
import random
import sys
from multiprocessing import Pool

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import synth  # noqa: E402

SHARD = 5000


def shard(args):
    out, idx, n, seed = args
    rng = random.Random(seed * 100003 + idx)
    np.random.seed((seed * 7919 + idx) % 2**32)
    imgs, labels = [], []
    for _ in range(n):
        im, lab = synth.make_sample(rng)
        imgs.append(np.asarray(im, np.uint8)); labels.append(lab)
    widths = np.array([a.shape[1] for a in imgs], np.int32)
    np.savez_compressed(os.path.join(out, f'shard-{seed}-{idx:04d}.npz'), pixels=np.concatenate(imgs, axis=1), widths=widths, labels=np.array(labels))
    return n


if __name__ == '__main__':
    out, count = sys.argv[1], int(sys.argv[2])
    workers = int(sys.argv[3]) if len(sys.argv) > 3 else os.cpu_count()
    seed = int(sys.argv[4]) if len(sys.argv) > 4 else 1
    os.makedirs(out, exist_ok=True)
    jobs = [(out, i, min(SHARD, count - i * SHARD), seed) for i in range((count + SHARD - 1) // SHARD)]
    with Pool(workers) as p:
        done = 0
        for n in p.imap_unordered(shard, jobs):
            done += n
            print(f'{done}/{count}', flush=True)
