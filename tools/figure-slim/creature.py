# A root creature grown on a skeleton: roots following every bone and grown together into one
# smooth skin, an open ribcage with a glowing core, a smooth wooden head with a face that can
# move, slender root fingers, and moss, ferns, fungi and hanging rootlets on top.
#
# Used by retarget.py (--creature): build(arm) makes ONE mesh, already weighted to the armature's
# own joints, so whatever motion the skeleton carries the creature performs. Written against the
# Daz Genesis 9 joint names (assets/Laura.fbx lends her skeleton, proportions and face joints).
#
# Two kinds of geometry:
#   WOOD   — tubes and blobs that are thrown away after a voxel remesh fuses them into one
#            surface, which is then smoothed and thinned. Their weights are carried onto the new
#            surface from the nearest piece of the old.
#   GROWTH — fingers, eyes, core, moss, ferns, fungi, rootlets: kept exactly as built.
#
# Everything is in the armature's own space and units (centimetres for a Daz figure). The shape
# comes from the numbers in build(): change them, or the seed, for a different individual.
import bpy, bmesh, math, random
from mathutils import Vector, noise, kdtree

MATS = [('Bark', (0.17, 0.14, 0.11), None), ('Moss', (0.22, 0.28, 0.08), None), ('Fungus', (0.55, 0.47, 0.36), None),
        ('Core', (0.01, 0.02, 0.18), (0.02, 0.06, 0.7, 1.5)), ('Ember', (0.9, 0.45, 0.05), (1.0, 0.45, 0.05, 6.0)),
        ('Hollow', (0.015, 0.012, 0.01), None)]
BARK, MOSS, FUNGUS, CORE, EMBER, HOLLOW = range(6)
VOXEL = 0.42          # cm: how finely the roots are fused. Thinner than about twice this disappears.
SMOOTH = 7            # rounds of smoothing after fusing: more melts the roots further into each other
TARGET_TRIS = 38000   # the fused wood is thinned to about this


class Geo:
    """A mesh being built, with joint weights per vertex."""
    def __init__(self):
        self.bm = bmesh.new(); self.il = self.bm.verts.layers.int.new('src')   # (a weight layer would clamp the index to 0..1)
        self.vuv, self.src = {}, []          # src: (position, weights) of every vertex, for carrying weights over
    def vert(self, p, w, uv=(0, 0)):
        v = self.bm.verts.new(p); self.vuv[v] = uv
        tot = sum(w.values()) or 1; w = {n: x / tot for n, x in w.items() if x > 0}
        self.src.append((Vector(p), w)); v[self.il] = len(self.src) - 1          # index into src, read back at the end
        return v
    def face(self, vs, mat, smooth=True):
        try: f = self.bm.faces.new(vs)
        except ValueError: return
        f.material_index = mat; f.smooth = smooth
    def tube(self, pts, radii, weights, mat=BARK, sides=6, smooth=True):
        n = len(pts)
        if n < 2: return
        tans = [(pts[min(i + 1, n - 1)] - pts[max(i - 1, 0)]).normalized() for i in range(n)]
        nrm = tans[0].orthogonal().normalized(); rings, dist = [], 0.0
        for i in range(n):
            if i: dist += (pts[i] - pts[i - 1]).length
            nrm = nrm - nrm.dot(tans[i]) * tans[i]; nrm = nrm.normalized() if nrm.length > 1e-6 else tans[i].orthogonal().normalized()
            bi = tans[i].cross(nrm); w = weights(i)
            rings.append([self.vert(pts[i] + radii[i] * (math.cos(a) * nrm + math.sin(a) * bi), w, (j / sides, dist / 20))
                          for j in range(sides + 1) for a in [2 * math.pi * j / sides]])
        for i in range(n - 1):
            for j in range(sides): self.face([rings[i][j], rings[i][j + 1], rings[i + 1][j + 1], rings[i + 1][j]], mat, smooth)
        for ring, i in ((rings[0], 0), (rings[-1], n - 1)):
            c = self.vert(pts[i], weights(i), (0.5, 0))
            for j in range(sides): self.face([ring[j], ring[j + 1], c], mat, smooth)
    def blob(self, centre, rx, ry, rz, axes, w, mat=BARK, seg=12, rings=8, rough=0.0):
        X, Y, Z = axes; rows = []
        top = self.vert(centre + Y * ry, w, (0.5, 1)); bot = self.vert(centre - Y * ry, w, (0.5, 0))
        for i in range(1, rings):
            th = math.pi * i / rings; row = []
            for j in range(seg):
                ph = 2 * math.pi * j / seg; d = Vector((math.sin(th) * math.cos(ph), math.cos(th), math.sin(th) * math.sin(ph)))
                k = 1 + rough * noise.noise(d * 2.1 + centre * 0.13)
                row.append(self.vert(centre + (X * d.x * rx + Y * d.y * ry + Z * d.z * rz) * k, w, (j / seg, 1 - i / rings)))
            rows.append(row)
        for j in range(seg):
            self.face([top, rows[0][j], rows[0][(j + 1) % seg]], mat); self.face([bot, rows[-1][(j + 1) % seg], rows[-1][j]], mat)
            for i in range(len(rows) - 1): self.face([rows[i][j], rows[i + 1][j], rows[i + 1][(j + 1) % seg], rows[i][(j + 1) % seg]], mat)


def catmull(ctrl, n):
    """n+1 points along a smooth line through the control points, and where each lies (index, t)."""
    P = [ctrl[0]] + list(ctrl) + [ctrl[-1]]; out = []
    for i in range(n + 1):
        x = i / n * (len(ctrl) - 1); j = min(int(x), len(ctrl) - 2); t = x - j
        p0, p1, p2, p3 = P[j], P[j + 1], P[j + 2], P[j + 3]
        out.append((0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3), j, t))
    return out


def reshape(arm, legs=1.16, spine=1.08, neck=1.35, arms=1.32, hands=1.12):
    """Make the borrowed skeleton taller and longer in the arm: each named bone is drawn out
    along its own length and everything hanging from it moves along. Feet stay on the floor."""
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    E = arm.data.edit_bones
    floor = min(b.head.y for b in E)                          # Daz: y is up in the armature's own space
    def draw_out(name, k, to):
        b, c = E.get(name), E.get(to)
        if not b or not c or k == 1: return
        d = (c.head - b.head) * (k - 1)
        for ch in b.children_recursive: ch.head += d; ch.tail += d
        b.tail += d
    for s in ('l_', 'r_'):
        draw_out(s + 'thigh', legs, s + 'shin'); draw_out(s + 'shin', legs, s + 'foot')
        draw_out(s + 'upperarm', arms, s + 'forearm'); draw_out(s + 'forearm', arms, s + 'hand')
        for f in ('thumb', 'index', 'mid', 'ring', 'pinky'):
            for a, b2 in (('1', '2'), ('2', '3')): draw_out(s + f + a, hands, s + f + b2)
    for a, b2 in (('spine1', 'spine2'), ('spine2', 'spine3'), ('spine3', 'spine4'), ('spine4', 'neck1')): draw_out(a, spine, b2)
    draw_out('neck1', neck, 'neck2'); draw_out('neck2', neck, 'head')
    lift = floor - min(b.head.y for b in E)
    for b in E: b.head.y += lift; b.tail.y += lift
    height = max(b.tail.y for b in E) - floor
    bpy.ops.object.mode_set(mode='OBJECT')
    print('RESHAPED: legs x%.2f spine x%.2f neck x%.2f arms x%.2f, crown of the skeleton at %.0f cm' % (legs, spine, neck, arms, height))


def bark_maps(size=512, seed=3):
    """A tileable bark: long fibres running up, ridges and cracks. Returns (colour, normal) images."""
    import numpy as np
    rng = np.random.default_rng(seed)
    fv = np.fft.fftfreq(size)[:, None] * size; fu = np.fft.fftfreq(size)[None, :] * size       # rows run up the limb
    def field(stretch, power, cut=1.0):
        f = np.sqrt(fu ** 2 + (fv * stretch) ** 2); amp = 1 / (f ** power + cut); amp[0, 0] = 0
        h = np.real(np.fft.ifft2(np.fft.fft2(rng.standard_normal((size, size))) * amp))
        return (h - h.min()) / (h.max() - h.min())
    fibre = field(7.0, 1.5); ridged = 1 - np.abs(2 * field(5.0, 1.7) - 1); fine = field(1.0, 0.9, 6.0)
    h = 0.55 * fibre + 0.35 * ridged ** 1.5 + 0.10 * fine
    crack = np.clip((0.30 - fibre) / 0.10, 0, 1)                                              # the deep furrows
    h = np.clip(h - 0.35 * crack, 0, 1); h = (h - h.min()) / (h.max() - h.min())
    dark, light = np.array([0.085, 0.065, 0.05]), np.array([0.50, 0.43, 0.35])
    col = dark + (light - dark) * (h[..., None] ** 1.25); col *= (0.9 + 0.2 * fine[..., None])
    du = np.roll(h, -1, 1) - np.roll(h, 1, 1); dv = np.roll(h, -1, 0) - np.roll(h, 1, 0)
    n = np.dstack([-du * 9, -dv * 9, np.ones_like(h)]); n /= np.linalg.norm(n, axis=2, keepdims=True)
    out = []
    for name, rgb, space in (('RootlingBark', np.clip(col, 0, 1), 'sRGB'), ('RootlingBarkNormal', n * 0.5 + 0.5, 'Non-Color')):
        # written to a file and read back: a generated image that is only packed reaches the
        # exporter with no data
        import os
        img = bpy.data.images.new(name, size, size, alpha=False)
        img.pixels.foreach_set(np.dstack([rgb, np.ones((size, size))]).astype(np.float32).ravel())
        path = os.path.join(bpy.app.tempdir, name + '.png'); img.filepath_raw = path; img.file_format = 'PNG'; img.save()
        bpy.data.images.remove(img)
        img = bpy.data.images.load(path); img.name = name; img.colorspace_settings.name = space; out.append(img)
    return out


def build(arm, seed=7, thin=0.8):
    rnd = random.Random(seed)
    B = arm.data.bones
    H = lambda n: B[n].head_local.copy()
    T = lambda n: B[n].tail_local.copy()
    up = (H('head') - H('hip')).normalized()
    left = (H('l_upperarm') - H('r_upperarm')).normalized()
    front = left.cross(up).normalized()
    if (H('l_toes') - H('l_foot')).dot(front) < 0: front.negate()
    AX = (left, up, front)
    wood, growth = Geo(), Geo()

    def wob(p, amp, freq=0.09, off=0.0):
        q = p * freq + Vector((off, off * 1.7, off * 0.3))
        return Vector((noise.noise(q), noise.noise(q + Vector((31.4, 0, 0))), noise.noise(q + Vector((0, 47.1, 0))))) * amp
    lerpw = lambda a, b, t: {k: a.get(k, 0) * (1 - t) + b.get(k, 0) * t for k in set(a) | set(b)}
    # A smooth strand through control points, each with its own thickness and joint.
    def strand(g, ctrl, radii, bones, n=14, mat=BARK, sides=6, amp=0.0):
        ws = [b if isinstance(b, dict) else {b: 1.0} for b in bones]
        pts, rad, wl = [], [], []
        for p, j, t in catmull(ctrl, n):
            pts.append(p + (wob(p, amp, 0.2) if amp else Vector())); rad.append(radii[j] + (radii[j + 1] - radii[j]) * t); wl.append(lerpw(ws[j], ws[j + 1], t))
        g.tube(pts, rad, lambda i: wl[i], mat=mat, sides=sides)

    # A chain of joints as a centre line with a frame, and the weights at each place along it.
    class Chain:
        def __init__(self, bones, pts):
            self.bones, self.pts = bones, pts
            self.len = [(pts[i + 1] - pts[i]).length for i in range(len(pts) - 1)]
            self.total = sum(self.len)
        def at(self, s):                                    # s 0..1 along the whole chain
            d = max(0.0, min(1.0, s)) * self.total
            for j, L in enumerate(self.len):
                if d <= L or j == len(self.len) - 1: break
                d -= L
            t = d / max(self.len[j], 1e-6)
            dirj = (self.pts[j + 1] - self.pts[j]).normalized(); tan = dirj
            if t < 0.2 and j > 0: tan = (dirj.lerp((self.pts[j] - self.pts[j - 1]).normalized(), 0.5 * (1 - t / 0.2))).normalized()
            if t > 0.8 and j < len(self.len) - 1: tan = (dirj.lerp((self.pts[j + 2] - self.pts[j + 1]).normalized(), 0.5 * (t - 0.8) / 0.2)).normalized()
            w = {self.bones[j]: 1.0}
            if t < 0.18 and j > 0: w = {self.bones[j]: 0.5 + 0.5 * t / 0.18, self.bones[j - 1]: 0.5 - 0.5 * t / 0.18}
            if t > 0.82 and j < len(self.bones) - 1: w = {self.bones[j]: 1 - 0.5 * (t - 0.82) / 0.18, self.bones[j + 1]: 0.5 * (t - 0.82) / 0.18}
            return self.pts[j].lerp(self.pts[j + 1], t), tan, w, j, t
        def frame(self, tan, ref):
            u = ref - ref.dot(tan) * tan
            u = u.normalized() if u.length > 1e-4 else tan.orthogonal().normalized()
            return u, tan.cross(u)
        def surface(self, s, ang, R, ref):                  # a place ON the limb, and the way out from it
            c, tan, w, j, t = self.at(s); u, v = self.frame(tan, ref); out = math.cos(ang) * u + math.sin(ang) * v
            return c + out * R(j, t), out, max(w, key=w.get)

    # Roots wound round a chain. R(j, t): how far from the bone, per segment; r: root thickness.
    def bundle(chain, R, count, r, ref, twist=0.35, steps=26, core=0.6, wander=1.0, lift=(0.72, 1.0)):
        if core:
            pts, rad, ws = [], [], []
            for i in range(steps + 1):
                c, tan, w, j, t = chain.at(i / steps)
                pts.append(c + wob(c, 0.4)); rad.append(max(0.5, R(j, t) * core)); ws.append(w)
            wood.tube(pts, rad, lambda i: ws[i], sides=7)
        for k in range(count):
            a0 = 2 * math.pi * (k + rnd.random() * 0.6) / count
            tw = twist * rnd.uniform(-1, 1) * 2 * math.pi
            rk = r * rnd.uniform(0.6, 1.3); off = rnd.random() * 50; lf = rnd.uniform(*lift)
            pts, rad, ws = [], [], []
            for i in range(steps + 1):
                s = i / steps; c, tan, w, j, t = chain.at(s); u, v = chain.frame(tan, ref); a = a0 + tw * s
                p = c + R(j, t) * lf * (math.cos(a) * u + math.sin(a) * v)
                pts.append(p + wob(p, wander, 0.07, off)); ws.append(w)
                rad.append(max(0.5, rk * (0.75 + 0.45 * noise.noise(p * 0.16 + Vector((off, 0, 0))))))
            wood.tube(pts, rad, lambda i: ws[i])

    prof = lambda ends, bulge: (lambda j, t: thin * (ends[min(j, len(ends) - 2)] + (ends[min(j, len(ends) - 2) + 1] - ends[min(j, len(ends) - 2)]) * t + bulge[min(j, len(bulge) - 1)] * math.sin(math.pi * t)))
    limbs = []                                                # (chain, profile, ref) — where growth can take hold

    # ── legs, arms, feet ──
    for s in ('l_', 'r_'):
        leg = Chain([s + 'thigh', s + 'shin', s + 'foot', s + 'toes'], [H(s + 'thigh'), H(s + 'shin'), H(s + 'foot'), H(s + 'toes'), T(s + 'toes')])
        lp = prof([5.4, 3.3, 2.5, 2.3, 1.0], [0.9, 1.0, 0.2, 0.0])
        bundle(leg, lp, 9, 1.25, front, steps=34, twist=0.45)
        bundle(leg, prof([5.6, 3.5, 2.7, 2.4, 1.0], [1.0, 1.1, 0.2, 0.0]), 6, 0.6, front, steps=34, twist=1.1, core=0, wander=1.6, lift=(0.95, 1.05))   # veins over the thick roots
        limbs.append((leg, lp, front))
        armc = Chain([s + 'upperarm', s + 'forearm', s + 'hand'], [H(s + 'upperarm'), H(s + 'forearm'), H(s + 'hand'), H(s + 'mid1')])
        ap = prof([3.2, 2.4, 1.8, 2.0], [0.6, 0.5, 0.2])
        bundle(armc, ap, 7, 0.95, up, steps=28, twist=0.45, wander=0.8)
        bundle(armc, prof([3.3, 2.5, 1.9, 2.0], [0.7, 0.6, 0.2]), 4, 0.55, up, steps=28, twist=1.1, core=0, wander=1.2, lift=(0.95, 1.05))
        limbs.append((armc, ap, up))
        for toe in ('bigtoe', 'indextoe', 'midtoe', 'ringtoe', 'pinkytoe'):                       # root toes, grown into the foot
            a, b, c = H(s + toe + '1'), H(s + toe + '2'), T(s + toe + '2')
            strand(wood, [H(s + 'foot').lerp(a, 0.5) + up * 1.0, a, b, c, c + (c - b) * 1.2 - up * 0.5], [1.2, 1.1, 0.9, 0.7, 0.5],
                   [s + 'foot', s + toe + '1', s + toe + '2', s + toe + '2', s + toe + '2'], n=12)
        # the palm, for the fingers to grow out of
        wood.blob(H(s + 'hand').lerp(H(s + 'mid1'), 0.55), 2.0, 1.0, 2.6, ((H(s + 'pinky1') - H(s + 'index1')).normalized(), up.copy(), (H(s + 'mid1') - H(s + 'hand')).normalized()), {s + 'hand': 1})
        # fingers: slender, smooth, drawn out fine — kept as built, not fused
        for f, r0 in (('thumb', 0.62), ('index', 0.55), ('mid', 0.58), ('ring', 0.52), ('pinky', 0.45)):
            a, b, c, d = H(s + f + '1'), H(s + f + '2'), H(s + f + '3'), T(s + f + '3')
            e = d + (d - c) * 0.9
            strand(growth, [H(s + 'hand').lerp(a, 0.55), a, b, c, d, e], [r0 * 1.15, r0, r0 * 0.82, r0 * 0.62, r0 * 0.36, 0.05],
                   [s + 'hand', s + f + '1', s + f + '2', s + f + '3', s + f + '3', s + f + '3'], n=26, sides=8)

    # ── spine and neck ──
    spine_b = ['hip', 'spine1', 'spine2', 'spine3', 'spine4', 'neck1', 'neck2']
    spine = Chain(spine_b, [H(b) for b in spine_b] + [H('head')])
    bundle(spine, lambda j, t: (2.3 if j < 5 else 2.2), 6, 0.95, front, twist=0.6, steps=40, core=0.85)
    hip_y = H('hip').dot(up); top_y = H('neck1').dot(up); span = top_y - hip_y
    def spine_at_height(y):
        best = None
        for i in range(81):
            c, tan, w, j, t = spine.at(i / 80); d = abs(c.dot(up) - y)
            if best is None or d < best[0]: best = (d, c, w)
        return best[1], best[2]

    # ── ribcage: open, the core showing through ──
    NR = 10; cage = []
    for i in range(NR):
        f = i / (NR - 1)
        y = hip_y + span * (0.93 - 0.50 * f)
        sp, w = spine_at_height(y)
        a = (9.5 + 4.5 * math.sin(math.pi * (0.25 + 0.6 * f)) - 2.0 * f) * (0.5 + 0.5 * thin)
        b = (6.0 + 2.6 * math.sin(math.pi * (0.2 + 0.6 * f))) * (0.5 + 0.5 * thin)
        centre = sp + front * (b - 1.0); cage.append((centre, a, b, w, y))
        reach = 1.0 if i < 7 else 0.78 - 0.12 * (i - 7)
        for sg in (1, -1):
            pts, rad = [], []
            for k in range(17):
                u = reach * k / 16; th = math.pi * (1 - u)
                pts.append(centre + left * (sg * a * math.sin(th)) + front * (b * math.cos(th)) - up * (5.5 * u) + wob(centre + left * sg * k, 0.3, 0.3))
                rad.append(0.95 - 0.3 * u)
            wood.tube(pts, rad, lambda k, w=w: w)
    st = [c + front * b - up * 5.5 + wob(c, 0.3) for c, a, b, w, y in cage[:7]]
    wood.tube(st, [1.7 - 0.1 * i for i in range(len(st))], lambda i: cage[i][3])
    mid = [cage[i][0] - front * 1.5 - up * 3 for i in range(1, 9)]
    growth.tube([p + wob(p, 0.8, 0.2) for p in mid], [2.0 + 2.4 * math.sin(math.pi * (i + 0.5) / len(mid)) for i in range(len(mid))], lambda i: cage[i + 1][3], mat=CORE, sides=10)
    for i in range(9):
        c, a, b, w, y = cage[rnd.randint(2, 8)]
        p = c - front * 1.5 - up * 3 + front * rnd.uniform(1.5, 4.0) + left * rnd.uniform(-2.5, 2.5) + up * rnd.uniform(-2, 2)
        growth.tube([p - up * rnd.uniform(0.8, 1.8), p, p + up * rnd.uniform(0.8, 1.8)], [0.15, rnd.uniform(0.5, 0.9), 0.15], lambda i, w=w: w, mat=EMBER, sides=6)

    # ── belly and pelvis ──
    lowc, lowa, lowb, loww, lowy = cage[-1]; hipc = H('hip')
    for k in range(10):
        a0 = 2 * math.pi * (k + rnd.random() * 0.5) / 10; sw = rnd.uniform(-0.7, 0.7); pts, ws = [], []
        for i in range(13):
            f = i / 12; a = a0 + sw * f
            bot = hipc + left * (9.5 * thin * math.sin(a)) + front * (6.5 * thin * math.cos(a) + 1) + up * 2
            topp = lowc + left * (lowa * 0.8 * math.sin(a)) + front * (lowb * 0.8 * math.cos(a)) - up * 4
            c0 = hipc.lerp(lowc, f); p = c0 + (bot.lerp(topp, f) - c0) * (1 - 0.28 * math.sin(math.pi * f))
            pts.append(p + wob(p, 0.6, 0.15, k)); ws.append({'spine1': 1 - f, 'spine2': f} if f > 0.3 else {'pelvis': 1 - f / 0.3, 'spine1': f / 0.3})
        wood.tube(pts, [0.95 + 0.3 * math.sin(math.pi * i / 12) for i in range(13)], lambda i: ws[i])
    wood.blob(hipc + up * 0.5 + front * 1, 9.6 * thin, 4.6, 6.6 * thin, AX, {'pelvis': 1}, rough=0.12)                      # a knot of wood for the hips
    for s, sg in (('l_', 1), ('r_', -1)):
        wood.blob(H(s + 'thigh').lerp(hipc, 0.25) + up * 1.5, 5.6 * thin, 6.5, 5.4 * thin, AX, {'pelvis': 0.5, s + 'thigh': 0.5}, rough=0.12)     # the hip joint: pelvis and thigh grown together
        for k in range(4):
            a = hipc + left * sg * rnd.uniform(2, 9) + front * rnd.uniform(-5, 7) + up * 2
            b2 = H(s + 'thigh') + left * sg * rnd.uniform(-2, 3) + front * rnd.uniform(-3, 3) - up * rnd.uniform(4, 9)
            strand(wood, [a, a.lerp(b2, 0.5) + left * sg * 2, b2], [1.3, 1.6, 1.1], ['pelvis', {'pelvis': 0.6, s + 'thigh': 0.4}, s + 'thigh'], n=8)
        top = cage[0][0] + front * cage[0][2] - up * 2; sh = H(s + 'upperarm')
        strand(wood, [top, top.lerp(sh, 0.5) + up * 1.5 + front * 1.5, sh + up * 1.0], [1.3, 1.1, 1.6], ['spine4', {'spine4': 0.5, s + 'shoulder': 0.5}, s + 'shoulder'], n=10)
        wood.blob(sh + up * 0.3, 3.6 * thin, 3.2 * thin, 3.4 * thin, AX, {s + 'shoulder': 0.6, s + 'upperarm': 0.4}, rough=0.15)
        for k in range(4):                                    # shoulder blade
            a = sh - front * 3 + up * (1 - k * 0.5)
            b2 = cage[3 + k][0] - front * (cage[3 + k][2] + 1.0) + left * sg * (5 - k)
            strand(wood, [a, a.lerp(b2, 0.5) - front * 1.5, b2], [1.7, 2.1, 1.0], [s + 'shoulder', {s + 'shoulder': 0.8, 'spine4': 0.2}, {s + 'shoulder': 0.4, 'spine3': 0.6}], n=8)

    # ── head: smooth wood, with a face on the figure's own face joints ──
    hb = H('head')
    P = lambda x, y, z: hb + left * x + up * y + front * z
    J = lambda n: H(n)
    wood.blob(P(0, 7.5, 0.8), 7.0, 8.6, 8.4, AX, {'head': 1}, seg=16, rings=10)                              # cranium
    wood.blob(P(0, 13.5, -1.8), 5.6, 8.0, 6.6, AX, {'head': 1}, seg=14, rings=8)                             # drawn up and back
    wood.blob(P(0, 2.0, 5.6), 4.5, 2.6, 4.6, AX, {'head': 1})                                                # upper jaw
    wood.blob(P(0, -4.0, 5.0), 4.2, 1.5, 4.6, AX, {'lowerjaw': 1})                                           # lower jaw: a real gap between
    wood.blob(J('chin') - front * 1.0, 1.9, 1.5, 1.6, AX, {'chin': 0.5, 'lowerjaw': 0.5})
    for sg, s in ((1, 'l_'), (-1, 'r_')):
        M = lambda x, y, z: P(sg * x, y, z)
        strand(wood, [M(6.3, 7.2, 7.2), J(s + 'browouter') + front * 0.5, J(s + 'browinner') + front * 0.6, J('centerbrow') + front * 0.3], [0.8, 1.05, 1.1, 1.0],
               [s + 'browouter', s + 'browouter', s + 'browinner', 'centerbrow'], n=12)                      # brow ridge
        strand(wood, [M(1.5, 5.9, 9.3), M(3.2, 7.1, 9.9), M(4.9, 6.0, 9.0)], [0.5, 0.55, 0.5], [s + 'eyelidupper'] * 3, n=8)
        strand(wood, [M(1.5, 5.6, 9.3), M(3.2, 4.8, 9.7), M(4.9, 5.7, 9.0)], [0.5, 0.5, 0.5], [s + 'eyelidlower'] * 3, n=8)
        strand(wood, [M(1.6, 4.0, 9.7), M(3.2, 3.5, 9.7), M(5.0, 4.1, 8.7)], [0.6, 0.7, 0.6], [s + 'squint', s + 'squint', s + 'cheek'], n=8)
        strand(wood, [M(6.3, 6.5, 5.8), J(s + 'cheek') + front * 0.2, J(s + 'cheeklower') + front * 1.0, M(5.0, -3.0, 3.5)], [1.2, 1.35, 1.2, 1.1],
               ['head', s + 'cheek', s + 'cheeklower', 'lowerjaw'], n=12)                                    # cheek, closing the side of the mouth
        strand(wood, [J('chin') - front * 0.6, M(3.5, -4.2, 6.6), M(5.2, -2.8, 2.6), M(5.9, 1.5, 0.4)], [1.2, 1.2, 1.15, 1.1], ['chin', 'lowerjaw', 'lowerjaw', 'head'], n=12)
        wood.blob(J(s + 'nostril') + left * sg * 0.3 - front * 0.2, 0.85, 0.75, 0.9, AX, {s + 'nostril': 1})
        growth.blob(M(3.2, 5.9, 8.75), 1.15, 1.15, 1.15, AX, {s + 'eye': 1}, mat=EMBER, seg=10, rings=7)     # an ember for an eye
    strand(wood, [J('centerbrow') - front * 0.2, P(0, 5.0, 11.2), P(0, 3.0, 12.5), P(0, 2.0, 11.5)], [1.0, 0.85, 1.15, 0.8], ['centerbrow', 'head', 'head', 'head'], n=10)   # nose
    strand(wood, [J('l_lipcorner'), J('l_lipupper'), J('lipuppermiddle'), J('r_lipupper'), J('r_lipcorner')], [0.5, 0.6, 0.62, 0.6, 0.5],
           ['l_lipcorner', 'l_lipupper', 'lipuppermiddle', 'r_lipupper', 'r_lipcorner'], n=14)
    dn = up * -0.75                                           # the lower lip sits a little open, so the mouth stays a mouth when fused
    strand(wood, [J('l_lipcorner') + dn * 0.5, J('l_liplower') + dn, J('liplowermiddle') + dn, J('r_liplower') + dn, J('r_lipcorner') + dn * 0.5], [0.5, 0.62, 0.66, 0.62, 0.5],
           ['l_lipcorner', 'l_liplower', 'liplowermiddle', 'r_liplower', 'r_lipcorner'], n=14)
    growth.blob(P(0, -1.5, 5.4), 3.5, 1.5, 3.9, AX, {'head': 0.5, 'lowerjaw': 0.5}, mat=HOLLOW)              # the dark of the mouth
    for k in range(9):                                        # roots sweeping up and back from the crown
        a = rnd.uniform(-2.6, 2.6); h = rnd.uniform(0.3, 1.0); out = left * math.sin(a) - front * abs(math.cos(a)) * 0.9
        base = P(0, 13 + 4 * h, -1.5) + out * (4.5 - 1.5 * h); L = rnd.uniform(7, 15)
        strand(wood, [base - up * 2 - out, base, base + (up * 0.9 + out * 0.5) * L * 0.5, base + (up * 0.7 + out * 1.0) * L + wob(base, 1.5, 0.3)], [1.9, 1.7, 1.1, 0.5], ['head'] * 4, n=12)

    # ── growth ──
    def bracket(centre, out, r, bone):                        # a shelf fungus
        side = up.cross(out).normalized(); n = 11; g = growth
        ang = [math.pi * i / (n - 1) for i in range(n)]
        rim_t = [g.vert(centre + (math.cos(a) * side + math.sin(a) * out) * r + up * 0.2, {bone: 1}, (0.5 + 0.5 * math.cos(a), math.sin(a))) for a in ang]
        rim_m = [g.vert(centre + (math.cos(a) * side + math.sin(a) * out) * r * 1.04 - up * 0.15, {bone: 1}, (0.5 + 0.5 * math.cos(a), math.sin(a))) for a in ang]
        rim_b = [g.vert(centre + (math.cos(a) * side + math.sin(a) * out) * r * 0.85 - up * 0.5, {bone: 1}, (0.5 + 0.5 * math.cos(a), math.sin(a))) for a in ang]
        ct = g.vert(centre + up * 1.1 - out * 0.4, {bone: 1}, (0.5, 0)); cb = g.vert(centre - up * 1.5 - out * 0.4, {bone: 1}, (0.5, 0))
        for i in range(n - 1):
            g.face([ct, rim_t[i], rim_t[i + 1]], FUNGUS); g.face([cb, rim_b[i + 1], rim_b[i]], FUNGUS)
            g.face([rim_t[i], rim_m[i], rim_m[i + 1], rim_t[i + 1]], FUNGUS); g.face([rim_m[i], rim_b[i], rim_b[i + 1], rim_m[i + 1]], FUNGUS)
    def moss(centre, out, r, bone):                           # a low cushion lying on the wood
        side = out.orthogonal().normalized(); growth.blob(centre + out * r * 0.15, r, r * 0.45, r * rnd.uniform(0.8, 1.3), (side, out, out.cross(side)), {bone: 1}, mat=MOSS, seg=9, rings=6, rough=0.3)
    def fern(base, direction, length, bone):
        d = direction.normalized(); side = d.cross(up).normalized() if abs(d.dot(up)) < 0.95 else left.copy(); n = 10; prev = None
        for i in range(n + 1):
            p = base + d * length * i / n - up * 2.4 * (i / n) ** 2
            wdt = length * 0.2 * math.sin(math.pi * (i + 0.6) / (n + 1.2))
            row = [growth.vert(p - side * wdt + d * wdt * 0.5, {bone: 1}, (0, i / n)), growth.vert(p, {bone: 1}, (0.5, i / n)), growth.vert(p + side * wdt + d * wdt * 0.5, {bone: 1}, (1, i / n))]
            if prev: growth.face([prev[1], row[1], row[0]], MOSS, False); growth.face([prev[1], row[2], row[1]], MOSS, False)
            prev = row
    def rootlet(base, out, length, bone):                     # a fine root hanging down, curling at the end
        sway = out * rnd.uniform(0.5, 2.0); curl = left * rnd.uniform(-1.5, 1.5) + front * rnd.uniform(-1.5, 1.5)
        strand(growth, [base - out * 0.5, base + sway * 0.6 - up * length * 0.25, base + sway - up * length * 0.7, base + sway + curl - up * length], [0.3, 0.24, 0.15, 0.04], [bone] * 4, n=12, sides=5)
    def mushroom(base, out, h, bone):
        topp = base + out * h * 0.5 + up * h
        strand(growth, [base, base + out * h * 0.5 + up * h * 0.5, topp], [0.22, 0.17, 0.2], [bone] * 3, n=5, sides=5, mat=FUNGUS)
        growth.blob(topp + up * 0.1, h * 0.42, h * 0.22, h * 0.42, AX, {bone: 1}, mat=FUNGUS, seg=8, rings=5)

    for sg, s in ((1, 'l_'), (-1, 'r_')):                     # ears of shelf fungus, and more up the head
        bracket(P(sg * 6.6, 4.6, 0.6), left * sg, 3.6, 'head'); bracket(P(sg * 6.2, 10.5, -1.0), (left * sg - front * 0.4).normalized(), 3.0, 'head')
    bracket(P(0, 13, -7.6), -front, 4.2, 'head')
    for chain, pr, ref in limbs:
        isleg = 'thigh' in chain.bones[0]
        for k in range(7 if isleg else 5):                    # moss cushions, ferns out of some of them
            p, out, bone = chain.surface(rnd.uniform(0.05, 0.92), rnd.uniform(0, 6.28), pr, ref)
            moss(p, out, rnd.uniform(1.4, 2.6), bone)
            if rnd.random() < 0.45: fern(p, out + up * rnd.uniform(0.2, 0.9), rnd.uniform(7, 12), bone)
        for k in range(4 if isleg else 5):
            p, out, bone = chain.surface(rnd.uniform(0.1, 0.95), rnd.uniform(0, 6.28), pr, ref)
            rootlet(p, out, rnd.uniform(6, 18) if not isleg else rnd.uniform(4, 9), bone)
        for k in range(3):
            p, out, bone = chain.surface(rnd.uniform(0.1, 0.9), rnd.uniform(0, 6.28), pr, ref)
            for m in range(rnd.randint(2, 4)): mushroom(p + Vector((rnd.uniform(-1, 1), rnd.uniform(-1, 1), rnd.uniform(-1, 1))), out, rnd.uniform(1.4, 2.8), bone)
        if isleg:
            p, out, bone = chain.surface(rnd.uniform(0.1, 0.4), rnd.choice([0.5, 2.6, 4.0]), pr, ref); bracket(p - out * 0.5, out, rnd.uniform(2.6, 4.0), bone)
    for s, sg in (('l_', 1), ('r_', -1)):
        sh = H(s + 'upperarm')
        moss(sh + up * 3.2, up, 3.6, s + 'shoulder'); moss(sh + up * 2.2 - front * 3 + left * sg * 2, (up - front).normalized(), 2.8, s + 'shoulder')
        for k in range(4): fern(sh + up * 3.2, left * sg * rnd.uniform(0.3, 1) + up * rnd.uniform(0.4, 1) + front * rnd.uniform(-0.8, 0.8), rnd.uniform(9, 16), s + 'shoulder')
        bracket(sh - front * 3.4 + up * 0.5, (-front + left * sg * 0.5).normalized(), 3.4, s + 'shoulder')
    for i in range(1, 10):                                    # down the back, and rootlets from the ribs
        c, a, b, w, y = cage[i]; bone = max(w, key=w.get)
        if i % 2: moss(c - front * (b + 1.6) + left * rnd.uniform(-2, 2), -front, rnd.uniform(2.2, 3.4), bone)
        for sg in (1, -1):
            if rnd.random() < 0.6: rootlet(c + left * sg * a * 0.9 - up * 3, left * sg, rnd.uniform(5, 14), bone)
    for k in range(6): rootlet(hipc + left * rnd.uniform(-8, 8) + front * rnd.uniform(-5, 6) - up * 3, front * rnd.uniform(-1, 1), rnd.uniform(6, 14), 'pelvis')
    moss(hipc + left * 9.4 + up * 2, left, 2.8, 'pelvis'); moss(hipc - left * 8.6 - front * 3 + up * 3, (-left - front).normalized(), 2.4, 'pelvis')
    for k in range(5): rootlet(P(rnd.uniform(-4, 4), rnd.uniform(-5, -3), rnd.uniform(2, 7)), front * 0.3, rnd.uniform(4, 10), 'lowerjaw')     # a beard of fine roots

    # ── fuse the wood into one skin ──
    def to_object(g, name):
        me = bpy.data.meshes.new(name); bmesh.ops.recalc_face_normals(g.bm, faces=g.bm.faces[:])
        uvl = g.bm.loops.layers.uv.new('UVMap')
        for f in g.bm.faces:
            for lp in f.loops: lp[uvl].uv = g.vuv.get(lp.vert, (0, 0))
        ids = [v[g.il] for v in g.bm.verts]
        g.bm.to_mesh(me); g.bm.free()
        ob = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(ob)
        return ob, ids
    def apply(ob, kind, **kw):
        m = ob.modifiers.new(kind, kind)
        for k, v in kw.items(): setattr(m, k, v)
        bpy.context.view_layer.objects.active = ob
        with bpy.context.temp_override(object=ob, active_object=ob, selected_objects=[ob]): bpy.ops.object.modifier_apply(modifier=m.name)
    def weigh(ob, lookup):
        vg = {}
        for i, w in lookup:
            for n, x in w.items():
                if n not in vg: vg[n] = ob.vertex_groups.new(name=n)
                vg[n].add([i], x, 'REPLACE')

    wood_src = wood.src
    wob_, _ = to_object(wood, 'Rootling')
    apply(wob_, 'REMESH', mode='VOXEL', voxel_size=VOXEL, adaptivity=0.0, use_smooth_shade=True)
    bm = bmesh.new(); bm.from_mesh(wob_.data)
    for _ in range(SMOOTH): bmesh.ops.smooth_vert(bm, verts=bm.verts, factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
    bm.to_mesh(wob_.data); bm.free()
    tris = sum(len(p.vertices) - 2 for p in wob_.data.polygons)
    if tris > TARGET_TRIS: apply(wob_, 'DECIMATE', ratio=TARGET_TRIS / tris)
    me = wob_.data
    kd = kdtree.KDTree(len(wood_src))
    for i, (p, w) in enumerate(wood_src): kd.insert(p, i)
    kd.balance(); look = []
    for v in me.vertices:                                     # weights from the nearest pieces of the wood it was fused from
        acc = {}
        for co, i, d in kd.find_n(v.co, 5):
            k = 1 / (d + 0.25) ** 2
            for n, x in wood_src[i][1].items(): acc[n] = acc.get(n, 0) + x * k
        top4 = sorted(acc.items(), key=lambda kv: -kv[1])[:4]; tot = sum(x for _, x in top4)
        look.append((v.index, {n: x / tot for n, x in top4}))
    weigh(wob_, look)
    uv = me.uv_layers.new(name='UVMap') if not me.uv_layers else me.uv_layers[0]
    # Bark runs ALONG a limb. Each face is laid out round the bone that holds it most: across by
    # the angle round that bone, up by the distance along it. A face is unrolled as a whole, so
    # nothing smears; where two bones meet the pattern simply starts again, lost in the fibres.
    LIMB = ('thigh', 'shin', 'foot', 'toe', 'upperarm', 'forearm', 'hand')
    frames = {}
    def frame_of(bn):
        if bn not in frames:
            b = B[bn]
            if any(k in bn for k in LIMB): o, ax, rep_u = b.head_local.copy(), (b.tail_local - b.head_local).normalized(), 2
            else: o, ax, rep_u = (H('head') if B[bn] == B['head'] or 'head' in [p.name for p in B[bn].parent_recursive] else hipc), up.copy(), 4
            r0 = front - front.dot(ax) * ax; r0 = r0.normalized() if r0.length > 1e-3 else left.copy()
            frames[bn] = (o, ax, r0, ax.cross(r0), rep_u)
        return frames[bn]
    wmap = {i: w for i, w in look}
    for poly in me.polygons:
        acc = {}
        for vi in poly.vertices:
            for n, x in wmap[vi].items(): acc[n] = acc.get(n, 0) + x
        o, ax, r0, r1, rep_u = frame_of(max(acc, key=acc.get)); a0 = None
        for li in poly.loop_indices:
            d = me.vertices[me.loops[li].vertex_index].co - o; a = math.atan2(d.dot(r1), d.dot(r0))
            if a0 is None: a0 = a
            while a - a0 > math.pi: a -= 2 * math.pi
            while a - a0 < -math.pi: a += 2 * math.pi
            uv.data[li].uv = (a / (2 * math.pi) * rep_u, d.dot(ax) / 16)
    for p in me.polygons: p.use_smooth = True; p.material_index = BARK

    growth_src = growth.src
    gob, ids = to_object(growth, 'Growth')
    weigh(gob, [(i, growth_src[ids[i]][1]) for i in range(len(ids))])
    for ob in (wob_, gob):
        for name, col, glow in MATS:
            m = bpy.data.materials.get(name)
            if not m:
                m = bpy.data.materials.new(name); m.use_nodes = True
                bsdf = m.node_tree.nodes['Principled BSDF']
                bsdf.inputs['Base Color'].default_value = (*col, 1); bsdf.inputs['Roughness'].default_value = 0.85
                if glow: bsdf.inputs['Emission Color'].default_value = (*glow[:3], 1); bsdf.inputs['Emission Strength'].default_value = glow[3]
                if name == 'Bark':
                    colour, normal = bark_maps(seed=seed); nt = m.node_tree
                    t1 = nt.nodes.new('ShaderNodeTexImage'); t1.image = colour; nt.links.new(t1.outputs['Color'], bsdf.inputs['Base Color'])
                    t2 = nt.nodes.new('ShaderNodeTexImage'); t2.image = normal; nm = nt.nodes.new('ShaderNodeNormalMap'); nm.inputs['Strength'].default_value = 1.2
                    nt.links.new(t2.outputs['Color'], nm.inputs['Color']); nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
            ob.data.materials.append(m)
    bpy.context.view_layer.objects.active = wob_
    with bpy.context.temp_override(object=wob_, active_object=wob_, selected_objects=[wob_, gob], selected_editable_objects=[wob_, gob]): bpy.ops.object.join()
    wob_.parent = arm
    wob_.modifiers.new('Armature', 'ARMATURE').object = arm
    print('CREATURE', len(wob_.data.vertices), 'verts', sum(len(p.vertices) - 2 for p in wob_.data.polygons), 'triangles (wood fused from', tris, '),', len(wob_.vertex_groups), 'joints used')
    return wob_
