# Experiment: steer a trained texture NCA by ROTATING its perception — the
# Sobel x/y responses of every channel turned by an angle before the network
# sees them (after Niklasson et al., Distill 2021). No retraining.
# For each angle: stability (state range), drift direction (averaged
# correlation peak over many frame pairs — magnitude is biased low, see
# drift.py's CAUTION, but the DIRECTION is what this checks), and a snapshot.
#   python rot.py model.json out.png [--angles 0,45,90,180]
import argparse, json, math, numpy as np, torch
from PIL import Image, ImageDraw
ap = argparse.ArgumentParser(); ap.add_argument('model'); ap.add_argument('out')
ap.add_argument('--angles', default='0,45,90,180'); ap.add_argument('--size', type=int, default=128)
a = ap.parse_args(); S = a.size
m = json.load(open(a.model)); C = m['channels']
K = torch.tensor(m['kernels']); W1, b1, W2 = (torch.tensor(m[k]) for k in ('w1', 'b1', 'w2'))
def step(x, th):
    p = torch.zeros(S, S, C, 4)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            p += torch.roll(x, (-dy, -dx), (0, 1))[..., None] * K[:, dy + 1, dx + 1]
    c, s = math.cos(th), math.sin(th)
    gx, gy = p[..., 1].clone(), p[..., 2].clone()
    p[..., 1], p[..., 2] = c * gx + s * gy, -s * gx + c * gy   # the cell's frame turned by th
    h = torch.relu(p.reshape(S, S, C * 4) @ W1.T + b1)
    return x + (h @ W2.T) * (torch.rand(S, S, 1) < m['fire_rate'])
def corrmap(f0, f1):
    A = np.fft.fft2(f0 - f0.mean()); B = np.fft.fft2(f1 - f1.mean())
    return np.fft.ifft2(np.conj(A) * B).real
def peak(r):
    dy, dx = np.unravel_index(np.argmax(r), r.shape)
    sub = lambda c0, m_, p_: 0.0 if (m_ - 2 * c0 + p_) == 0 else 0.5 * (m_ - p_) / (m_ - 2 * c0 + p_)
    fy = sub(r[dy, dx], r[(dy - 1) % S, dx], r[(dy + 1) % S, dx]); fx = sub(r[dy, dx], r[dy, (dx - 1) % S], r[dy, (dx + 1) % S])
    return (dy - S if dy > S // 2 else dy) + fy, (dx - S if dx > S // 2 else dx) + fx
lum = lambda x: (x[..., :3] + 0.5).clamp(0, 1).mean(-1).numpy()
shots = []
for deg in [float(v) for v in a.angles.split(',')]:
    th = math.radians(deg); torch.manual_seed(0)
    x = torch.zeros(S, S, C)
    for _ in range(500): x = step(x, th)
    acc = 0
    for _ in range(20):
        f0 = lum(x)
        for _ in range(8): x = step(x, th)
        acc = acc + corrmap(f0, lum(x))
    dy, dx = peak(acc)
    ang = math.degrees(math.atan2(dy, dx))            # image axes: +y = down; 90° = straight down
    print(f'rot {deg:5.0f}°: state range {x.min():6.2f} {x.max():6.2f}   drift direction {ang:7.1f}° (90 = down)   |shift| {math.hypot(dx, dy):.2f} cells/8 upd')
    im = Image.fromarray(((x[..., :3] + 0.5).clamp(0, 1).numpy() * 255).astype(np.uint8)).resize((S * 2, S * 2), Image.NEAREST)
    ImageDraw.Draw(im).text((4, 4), f'{deg:.0f} deg', fill='white'); shots.append(im)
strip = Image.new('RGB', (len(shots) * (S * 2 + 6) - 6, S * 2), 'white')
for i, im in enumerate(shots): strip.paste(im, (i * (S * 2 + 6), 0))
strip.save(a.out); print('->', a.out)
