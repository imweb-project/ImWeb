# Texture NCA trainer — after Niklasson, Mordvintsev et al., "Self-Organising
# Textures" (Distill 2021). Learns a local update rule whose steady state has
# the texture statistics (VGG16 Gram matrices) of one photo. Runs the same on
# this Mac (slow, CPU) and on Colab (GPU). No Python at ImWeb runtime: the
# exported JSON is read by a GLSL inference shader.
#
#   python train_texture.py --image lichen.jpg --out lichen.json
#   python train_texture.py --smoke          # pipeline check, no downloads
#   python train_texture.py --image lichen.jpg --still 20 --out lichen_still.json
#                                            # a texture that grows, then holds still
#
# Update rule, per cell — the GLSL port must match this exactly:
#   state x: CH floats, RGB = x[0:3] + 0.5
#   perception = [x, sobel_x(x), sobel_y(x), laplacian(x)]   (4*CH, wrap edges)
#   dx = W2 · relu(W1 · perception + b1)                     (no b2)
#   x += dx * (rand < FIRE_RATE)
import argparse, json, time
import numpy as np, torch, torch.nn.functional as F
from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument('--image')
ap.add_argument('--out', default='texture_nca.json')
ap.add_argument('--size', type=int, default=128, help='training grid / target size')
ap.add_argument('--steps', type=int, default=2000, help='optimiser iterations')
ap.add_argument('--ch', type=int, default=12, help='state channels (multiple of 4 for RGBA textures)')
ap.add_argument('--hidden', type=int, default=96)
ap.add_argument('--batch', type=int, default=4)
ap.add_argument('--pool', type=int, default=1024)
ap.add_argument('--fire', type=float, default=0.5)
ap.add_argument('--device', default='cuda' if torch.cuda.is_available() else 'cpu')
ap.add_argument('--save-every', type=int, default=250)
ap.add_argument('--smoke', action='store_true', help='random VGG + tiny run, checks the pipeline only')
# Stillness: after each rollout, run --still-steps more updates and penalise
# how much the PICTURE changed, relative to the photo's own variance (so one
# weight means the same for any photo). lichenB, trained without it, changes
# 0.43 of its variance in 8 updates: its discs drift and "drip" (owner:
# "raindrops"). 0 = off, the original trainer. Try 20, then 60 if it still moves.
ap.add_argument('--still', type=float, default=0.0, help='weight of the stillness loss (0 = off)')
ap.add_argument('--still-steps', type=int, default=8, help='updates the picture must hold still over')
a = ap.parse_args()
dev = torch.device(a.device)
if a.smoke:
    a.size, a.steps, a.pool = 32, 3, 8
assert a.ch % 4 == 0

# ---- target -------------------------------------------------------------
if a.image:
    img = Image.open(a.image).convert('RGB')
    k = a.size / min(img.size)             # short side -> size, keep the whole frame:
    img = img.resize((round(img.width * k), round(img.height * k)), Image.LANCZOS)  # Gram stats are spatial averages
    target = torch.tensor(np.asarray(img), dtype=torch.float32).permute(2, 0, 1)[None] / 255
else:
    assert a.smoke, '--image is required'
    target = torch.rand(1, 3, a.size, a.size)
target = target.to(dev)

# ---- style loss: VGG16 Gram matrices -----------------------------------
import torchvision
vgg = torchvision.models.vgg16(weights=None if a.smoke else 'IMAGENET1K_V1').features[:26].to(dev).eval()
for p in vgg.parameters(): p.requires_grad_(False)
STYLE = {1, 6, 11, 18, 25}                 # relu1_1, 2_1, 3_1, 4_1, 5_1
MEAN = torch.tensor([0.485, 0.456, 0.406], device=dev)[:, None, None]
STD = torch.tensor([0.229, 0.224, 0.225], device=dev)[:, None, None]

def grams(x):
    x = (x - MEAN) / STD
    out = []
    for i, layer in enumerate(vgg):
        x = layer(x)
        if i in STYLE:
            b, c, h, w = x.shape
            f = x.reshape(b, c, h * w)
            out.append(f @ f.transpose(1, 2) / (h * w))
    return out

with torch.no_grad():
    tg = grams(target)
    tvar = target.var().item()                # picture change is measured against this

def style_loss(img):
    return sum(((g - t) ** 2).mean() for g, t in zip(grams(img), tg))

# ---- the NCA ------------------------------------------------------------
sob = torch.tensor([[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]], dtype=torch.float32) / 8
lap = torch.tensor([[1, 2, 1], [2, -12, 2], [1, 2, 1]], dtype=torch.float32) / 16
ident = torch.tensor([[0, 0, 0], [0, 1, 0], [0, 0, 0]], dtype=torch.float32)
KER = torch.stack([ident, sob, sob.T, lap])            # 4 filters, order matters for export
PK = KER.repeat(a.ch, 1, 1)[:, None].to(dev)           # depthwise: ch0·[id,sx,sy,lap], ch1·...

class NCA(torch.nn.Module):
    def __init__(s):
        super().__init__()
        s.w1 = torch.nn.Conv2d(a.ch * 4, a.hidden, 1)
        s.w2 = torch.nn.Conv2d(a.hidden, a.ch, 1, bias=False)
        torch.nn.init.zeros_(s.w2.weight)               # starts as the identity rule
    def forward(s, x):
        p = F.conv2d(F.pad(x, (1, 1, 1, 1), 'circular'), PK, groups=a.ch)
        dx = s.w2(F.relu(s.w1(p)))
        m = (torch.rand(x.shape[0], 1, *x.shape[2:], device=dev) < a.fire).float()
        return x + dx * m

nca = NCA().to(dev)
opt = torch.optim.Adam(nca.parameters(), 1e-3)
sched = torch.optim.lr_scheduler.MultiStepLR(opt, [a.steps // 2, a.steps * 3 // 4], 0.3)

def seed(n):
    return torch.zeros(n, a.ch, a.size, a.size, device=dev)

with torch.no_grad():
    pool = seed(a.pool)

# ---- export -------------------------------------------------------------
# w1: [hidden][4*ch], perception index = c*4 + k with k in (id, sobel_x,
# sobel_y, laplacian); w2: [ch][hidden]. Row-major, float32.
def export(path, it):
    w1 = nca.w1.weight.detach().cpu()[:, :, 0, 0]
    json.dump({
        'kind': 'texture-nca', 'version': 1,
        'channels': a.ch, 'hidden': a.hidden, 'fire_rate': a.fire,
        'perception': ['identity', 'sobel_x', 'sobel_y', 'laplacian'],
        'kernels': KER.tolist(), 'perception_index': 'c*4+k',
        'rgb': 'x[0:3] + 0.5',
        'w1': w1.tolist(), 'b1': nca.w1.bias.detach().cpu().tolist(),
        'w2': nca.w2.weight.detach().cpu()[:, :, 0, 0].tolist(),
        'train': {**{k: v for k, v in vars(a).items() if k not in ('device',)}, 'iteration': it},
    }, open(path, 'w'))
    torch.save(nca.state_dict(), path.replace('.json', '.pt'))
    print('wrote', path, flush=True)

t0 = time.time()
for it in range(a.steps):
    with torch.no_grad():
        idx = torch.randint(a.pool, (a.batch,))
        x = pool[idx]
        if it % 8 == 0:
            x[:1] = seed(1)                                  # keep learning to start from nothing
    for _ in range(int(torch.randint(32, 97, ()))):
        x = nca(x)
    rgb = x[:, :3] + 0.5
    overflow = (x - x.clamp(-1, 1)).abs().mean()
    loss = style_loss(rgb) + overflow
    still = torch.zeros(())
    if a.still > 0:
        y = x
        for _ in range(a.still_steps):
            y = nca(y)
        d = ((y[:, :3] - x[:, :3]) ** 2).mean(dim=(1, 2, 3)) / tvar
        # Not the sample just reseeded from empty: it is still GROWING, and
        # stillness there would teach the texture not to form.
        keep = torch.ones_like(d)
        if it % 8 == 0:
            keep[0] = 0
        still = (d * keep).sum() / keep.sum()
        loss = loss + a.still * still + (y - y.clamp(-1, 1)).abs().mean()
        x = y                                 # the pool carries on from the later state
    opt.zero_grad()
    loss.backward()
    for p in nca.parameters():                               # per-tensor grad normalisation
        p.grad /= p.grad.norm() + 1e-8
    opt.step(); sched.step()
    with torch.no_grad():
        pool[idx] = x.detach()
    if it % 50 == 0 or it == a.steps - 1:
        el = time.time() - t0
        print(f'{it:5d}  loss {loss.item():.4f}  still {still.item():.3f}  {el / (it + 1):.2f} s/it  eta {el / (it + 1) * (a.steps - it - 1) / 60:.1f} min', flush=True)
        if a.image:
            Image.fromarray((rgb[0].detach().clamp(0, 1).permute(1, 2, 0).cpu().numpy() * 255).astype(np.uint8)).save(a.out.replace('.json', '_preview.png'))
    if a.save_every and it and it % a.save_every == 0:
        export(a.out.replace('.json', f'_{it:05d}.json'), it)   # checkpoints: a dropped session keeps these

export(a.out, a.steps)
