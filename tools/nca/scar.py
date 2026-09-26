# Where does a wiped band's disturbance spread? Two runs with the SAME random
# stream: control, and one whose rows [r0, r1) are wiped (state = 0) every
# update for `hold` updates, like a held pen stroke. Prints how far past each
# edge of the band the runs differ. Rows are image rows: row 0 = TOP.
import argparse, json, numpy as np, torch
ap = argparse.ArgumentParser(); ap.add_argument('model')
ap.add_argument('--size', type=int, default=128); ap.add_argument('--hold', type=int, default=120)
ap.add_argument('--after', type=int, default=240); ap.add_argument('--save')
ap.add_argument('--cols', action='store_true', help='vertical band instead')
a = ap.parse_args()
m = json.load(open(a.model)); C = m['channels']; S = a.size
K = torch.tensor(m['kernels']); W1, b1, W2 = (torch.tensor(m[k]) for k in ('w1', 'b1', 'w2'))
def step(x, mask):
    p = torch.zeros(S, S, C, 4)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            p += torch.roll(x, (-dy, -dx), (0, 1))[..., None] * K[:, dy + 1, dx + 1]
    h = torch.relu(p.reshape(S, S, C * 4) @ W1.T + b1)
    return x + (h @ W2.T) * mask
g = torch.Generator().manual_seed(0)
x = torch.zeros(S, S, C)
for _ in range(400): x = step(x, (torch.rand(S, S, 1, generator=g) < 0.5).float())
r0, r1 = S // 2 - 4, S // 2 + 4
xc, xw = x.clone(), x.clone()
def band(t):
    if a.cols: t[:, r0:r1] = 0
    else: t[r0:r1] = 0
def extent(t):
    # VISIBLE scar: cells still near the empty state they were wiped to.
    # Control's own fraction of such cells is the floor, so the texture's
    # normal dark/flat spots do not count as damage.
    # VISIBLE flatness, as the GPU probe measures it: per-row std of luma.
    lum = (xw[..., :3] + 0.5).clamp(0, 1).mean(-1)
    prof = (lum.std(1) if not a.cols else lum.std(0)).numpy()
    hit = np.where(prof < 0.02)[0]
    if not len(hit): return 'healed'
    lo, hi = hit.min(), hit.max()
    return f'scar {"rows" if not a.cols else "cols"} {lo}..{hi}:  {r0 - lo:3d} beyond {"top" if not a.cols else "left"} edge, {hi - (r1 - 1):3d} beyond {"bottom" if not a.cols else "right"} edge'
for i in range(1, a.hold + a.after + 1):
    mk = (torch.rand(S, S, 1, generator=g) < 0.5).float()
    xc = step(xc, mk); xw = step(xw, mk)
    if i <= a.hold: band(xw)
    if i in (30, 120, 240, 360):
        print(f'  update {i:4d} ({"held" if i <= a.hold else "released"}): {extent(i)}')
if a.save:
    from PIL import Image
    im = lambda t: Image.fromarray(((t[..., :3] + 0.5).clamp(0, 1).numpy() * 255).astype(np.uint8))
    both = Image.new('RGB', (S * 2 + 4, S), 'white'); both.paste(im(xc), (0, 0)); both.paste(im(xw), (S + 4, 0))
    both.resize(((S * 2 + 4) * 2, S * 2), Image.NEAREST).save(a.save)
