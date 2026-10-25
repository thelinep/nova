"""Character error rate of a model on each synthetic look: python3 eval_looks.py MODEL.pt DIR_WITH_<look>.npz"""
import glob, json, os, sys
import numpy as np, torch
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import train

def load_one(f):
    z = np.load(f); pix, w, lab = z['pixels'], z['widths'], z['labels']; x = 0; out = []
    for a, b in zip(w, lab): out.append((pix[:, x:x + a], str(b))); x += a
    return out

if __name__ == '__main__':
    torch.set_num_threads(2)
    m = train.CRNN(); sd = torch.load(sys.argv[1], weights_only=False); m.load_state_dict(sd.get('model', sd) if isinstance(sd, dict) and 'model' in sd else sd); m.eval()
    res = {}
    for f in sorted(glob.glob(os.path.join(sys.argv[2], '*.npz'))):
        c, ex = train.evaluate(m, load_one(f)); res[os.path.basename(f)[:-4]] = round(c, 4)
    print(json.dumps(res))
