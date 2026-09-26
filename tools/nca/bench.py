# Times one NCA training step (Mordvintsev-style: 16 ch, Sobel perception,
# 128-hidden 1x1 MLP, 64 unrolled steps) on each available device.
import time, torch, torch.nn.functional as F
C, H, B, STEPS, SZ = 16, 128, 8, 64, 64
def run(dev):
    torch.manual_seed(0)
    sob = torch.tensor([[-1,0,1],[-2,0,2],[-1,0,1]], dtype=torch.float32) / 8
    ker = torch.stack([torch.tensor([[0,0,0],[0,1,0],[0,0,0]],dtype=torch.float32), sob, sob.T])
    ker = ker.repeat(C,1,1)[:,None].to(dev)
    w1 = torch.nn.Conv2d(C*3, H, 1).to(dev); w2 = torch.nn.Conv2d(H, C, 1, bias=False).to(dev)
    torch.nn.init.zeros_(w2.weight)
    opt = torch.optim.Adam(list(w1.parameters()) + list(w2.parameters()), 2e-3)
    target = torch.rand(1, 4, SZ, SZ, device=dev)
    def step():
        x = torch.zeros(B, C, SZ, SZ, device=dev); x[:, 3:, SZ//2, SZ//2] = 1
        for _ in range(STEPS):
            p = F.conv2d(F.pad(x, (1,1,1,1), 'circular'), ker, groups=C)
            dx = w2(F.relu(w1(p)))
            m = (torch.rand(B,1,SZ,SZ, device=dev) < 0.5).float()
            x = x + dx * m
        loss = ((x[:, :4] - target) ** 2).mean()
        opt.zero_grad(); loss.backward(); opt.step()
        return loss.item()
    step()  # warm-up / kernel compile
    t = time.time(); n = 5
    for _ in range(n): step()
    return (time.time() - t) / n
print('torch', torch.__version__, 'mps available:', torch.backends.mps.is_available())
for dev in (['mps'] if torch.backends.mps.is_available() else []) + ['cpu']:
    try: print(f'{dev}: {run(dev)*1000:.0f} ms / training step')
    except Exception as e: print(dev, 'FAILED:', e)
