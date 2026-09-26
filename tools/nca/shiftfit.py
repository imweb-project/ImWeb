# Sub-cell shift between two images from the SLOPE of the cross-power
# spectrum's phase at low frequencies (weighted least squares). Unbiased for
# small shifts, unlike a parabola through a phase-correlation peak, which is
# pulled toward whole cells. Returns (down, right) in cells: how far f1's
# content sits below/right of f0's.
import numpy as np
def shift(f0, f1, kmax=6):
    H, W = f0.shape
    C = np.conj(np.fft.fft2(f0 - f0.mean())) * np.fft.fft2(f1 - f1.mean())
    ky = np.fft.fftfreq(H) * H; kx = np.fft.fftfreq(W) * W
    KY, KX = np.meshgrid(ky, kx, indexing='ij')
    sel = (np.abs(KY) <= kmax) & (np.abs(KX) <= kmax) & ((KY != 0) | (KX != 0))
    ph = np.angle(C[sel]); w = np.abs(C[sel])
    A = np.stack([-2 * np.pi * KY[sel] / H, -2 * np.pi * KX[sel] / W], 1)
    sw = np.sqrt(w)
    d, *_ = np.linalg.lstsq(A * sw[:, None], ph * sw, rcond=None)
    return float(d[0]), float(d[1])
