# Runs an exported texture-NCA JSON with plain numpy — no torch — exactly as
# the header of train_texture.py specifies. This is the reference the GLSL
# inference shader is checked against.
#   python render.py runs/x.json out.png [--size 192] [--iters 256] [--scale 3]
#   --snaps 96,500,5000  saves a strip of snapshots from one run instead
import argparse, json, numpy as np
from PIL import Image
ap = argparse.ArgumentParser()
ap.add_argument('model'); ap.add_argument('out')
ap.add_argument('--size', type=int, default=192)
ap.add_argument('--iters', type=int, default=256)
ap.add_argument('--scale', type=int, default=3)
ap.add_argument('--seed', type=int, default=0)
ap.add_argument('--torch', action='store_true', help='same maths in torch (CPU), ~10x faster for long runs')
ap.add_argument('--snaps', help='comma list of iteration counts -> one strip')
a = ap.parse_args()
m = json.load(open(a.model))
C, K = m['channels'], np.array(m['kernels'], np.float32)            # K: 4,3,3
W1, b1, W2 = (np.array(m[k], np.float32) for k in ('w1', 'b1', 'w2'))
rng = np.random.default_rng(a.seed)
x = np.zeros((a.size, a.size, C), np.float32)
def perceive(x):
    out = np.zeros(x.shape + (4,), np.float32)                       # [..., c, k] -> index c*4+k
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            s = np.roll(x, (-dy, -dx), (0, 1))                       # s[y,x] = x[y+dy, x+dx], wrapped
            out += s[..., None] * K[:, dy + 1, dx + 1]
    return out.reshape(*x.shape[:2], C * 4)
snaps = sorted(int(v) for v in a.snaps.split(',')) if a.snaps else [a.iters]
frames = []
def rgb_img():
    rgb = np.clip(x[..., :3] + 0.5, 0, 1)
    return Image.fromarray((rgb * 255).astype(np.uint8)).resize((a.size * a.scale,) * 2, Image.NEAREST)
if a.torch:                                   # identical ops, torch tensors
    import torch
    torch.manual_seed(a.seed)
    tK, tW1, tb1, tW2 = (torch.from_numpy(v) for v in (K, W1, b1, W2))
    tx = torch.from_numpy(x)
    def tstep():
        global tx
        p = torch.zeros(tx.shape + (4,))
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                p += torch.roll(tx, (-dy, -dx), (0, 1))[..., None] * tK[:, dy + 1, dx + 1]
        h = torch.relu(p.reshape(a.size, a.size, C * 4) @ tW1.T + tb1)
        tx = tx + (h @ tW2.T) * (torch.rand(a.size, a.size, 1) < m['fire_rate'])
for i in range(1, snaps[-1] + 1):
    if a.torch:
        tstep()
        if i in snaps: x = tx.numpy()
    else:
        h = np.maximum(perceive(x) @ W1.T + b1, 0)
        x += (h @ W2.T) * (rng.random((a.size, a.size, 1)) < m['fire_rate'])
    if i in snaps:
        frames.append(rgb_img())
        print(flush=True, *[f'  iter {i:5d}  state range {x.min():7.2f} {x.max():7.2f}  rgb mean {np.clip(x[..., :3] + 0.5, 0, 1).mean((0, 1)).round(2)}'])
W = frames[0].width
strip = Image.new('RGB', (len(frames) * (W + 6) - 6, W), 'white')
for k, f in enumerate(frames): strip.paste(f, (k * (W + 6), 0))
strip.save(a.out)
print('->', a.out)
