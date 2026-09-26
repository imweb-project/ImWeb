# Measures how far a model's texture travels per update: phase correlation
# between two snapshots `gap` updates apart. Same maths as render.py --torch.
#   python drift.py model.json [--size 128] [--warm 400] [--gap 100]
#   python drift.py model.json --gap 8 --write   averages 3 windows, stores
#     'drift': {'right': cells/update, 'down': cells/update} in the model JSON
#     (image axes: down = toward the bottom of the picture). ImWeb pans the
#     view by it so the texture holds still on screen.
# CAUTION (2026-09-26): for a fast-churning model (lichenB) these offline
# numbers are NOT reliable — windows disagreed by 50%+, and the stored value
# was 2.6x too small. The trustworthy calibration is in the engine: sweep a
# multiplier on the stored drift in runs/gltest/drift3.html until the
# on-screen drift crosses zero (lichenB: 0.047 down, 0.012 right).
import argparse, json, numpy as np, torch
from shiftfit import shift
ap = argparse.ArgumentParser(); ap.add_argument('model')
ap.add_argument('--size', type=int, default=128); ap.add_argument('--warm', type=int, default=400)
ap.add_argument('--gap', type=int, default=100); ap.add_argument('--fire', type=float)
ap.add_argument('--write', action='store_true')
a = ap.parse_args()
m = json.load(open(a.model)); C = m['channels']; S = a.size
K = torch.tensor(m['kernels']); W1, b1, W2 = (torch.tensor(m[k]) for k in ('w1', 'b1', 'w2'))
fire = a.fire if a.fire is not None else m['fire_rate']
def measure(warm, seed):
    torch.manual_seed(seed)
    x = torch.zeros(S, S, C)
    for _ in range(warm): x = step(x)
    f0 = x[..., :3].mean(-1).numpy()
    for _ in range(a.gap): x = step(x)
    f1 = x[..., :3].mean(-1).numpy()
    dy, dx = shift(f0, f1)                      # phase-slope fit: unbiased sub-cell
    r = np.array([np.corrcoef(f0.ravel(), f1.ravel())[0, 1]])
    return dy, dx, r.max()
def step(x):
    p = torch.zeros(S, S, C, 4)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            p += torch.roll(x, (-dy, -dx), (0, 1))[..., None] * K[:, dy + 1, dx + 1]
    h = torch.relu(p.reshape(S, S, C * 4) @ W1.T + b1)
    return x + (h @ W2.T) * (torch.rand(S, S, 1) < fire)
runs = [measure(a.warm, 0)] if not a.write else [measure(w, i) for i, w in enumerate((300, 700, 1100))]
for dy, dx, pk in runs:
    print(f'{a.model}: shift over {a.gap} updates = down {dy:+.2f}, right {dx:+.2f} cells   (frames correlate {pk:.2f})'
          f'   -> {dy / a.gap * 60:+.2f} cells/s down at 60 updates/s')
if a.write:
    down = float(np.mean([r[0] for r in runs]) / a.gap); right = float(np.mean([r[1] for r in runs]) / a.gap)
    m['drift'] = {'right': round(right, 5), 'down': round(down, 5)}
    json.dump(m, open(a.model, 'w'))
    print('wrote drift', m['drift'], '->', a.model)
