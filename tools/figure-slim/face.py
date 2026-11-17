# Give the slimmed head a small face rig: 18 control joints under the head joint,
# their skin weights, and two plain rows of teeth.
#
#   python3 tools/figure-slim/face.py <slim.json> <out.json>
#
# Works on the JSON slim.py writes (bind space, Poser units, Y up, face toward +Z);
# splice.py turns the 'faceBones' it adds into joints. Pure Python, no Blender.
import json, math, sys, collections

src, dst = sys.argv[1:3]
d = json.load(open(src))
P, Nr = d['pos'], d['nrm']
nv = len(P) // 3
pos = lambda i: (P[3*i], P[3*i+1], P[3*i+2])

mat_of = collections.defaultdict(set)
for m, t in d['tris'].items():
    for v in t[0::2]: mat_of[v].add(m)
face = [i for i in range(nv) if 'faceroomSkin' in mat_of[i]]

# ---- landmarks --------------------------------------------------------------
# The lips' inner edge
# (where it meets the gums; or, with no mouth interior, its open border)
lip = sorted(v for v in face if 'Gums' in mat_of[v])
if len(lip) <= 10:
    allec = collections.Counter()
    for m, t in d['tris'].items():
        vs = t[0::2]
        for k in range(0, len(vs), 3):
            a, b, c = vs[k:k+3]
            for e in ((a, b), (b, c), (c, a)): allec[tuple(sorted(e))] += 1
    lip = sorted({v for e, n in allec.items() if n == 1 for v in e if 'faceroomSkin' in mat_of[v]
                  and abs(pos(v)[0]) < 0.02 and 0.655 < pos(v)[1] < 0.685 and pos(v)[2] > 0.035})
assert len(lip) > 10, 'lip edge not found'
lipset = set(lip)
mouthY = sum(pos(v)[1] for v in lip) / len(lip)
cornerX = max(abs(pos(v)[0]) for v in lip)
cornerZ = min(pos(v)[2] for v in lip if abs(pos(v)[0]) > cornerX - 0.001)
lipZ = max(pos(v)[2] for v in lip)

def surf(x, y, r=0.004):
    """Front of the face at (x, y)."""
    c = [pos(i)[2] for i in face if abs(pos(i)[0]-x) < r and abs(pos(i)[1]-y) < r]
    return max(c) if c else surf(x, y, r * 1.6)

EYE = 0.0127, 0.6963, 0.0452                     # eye joint (left), from the file
HINGE = (0.0, 0.684, 0.008)                      # jaw hinge, below the ear
bones = {'jaw': HINGE}
for s_, sx in (('L', 1), ('R', -1)):
    bones['corner'+s_] = (sx*cornerX, mouthY, cornerZ)
    bones['browIn'+s_] = (sx*0.008, 0.7065, surf(sx*0.008, 0.7065))
    bones['browOut'+s_] = (sx*0.022, 0.708, surf(sx*0.022, 0.708))
    bones['lidUp'+s_] = (sx*EYE[0], EYE[1], EYE[2])       # lids turn about the eyeball's centre
    bones['lidLo'+s_] = (sx*EYE[0], EYE[1], EYE[2])
    bones['cheek'+s_] = (sx*0.021, 0.683, surf(sx*0.021, 0.683))
bones['lipUp'] = (0.0, mouthY + 0.003, surf(0.0, mouthY + 0.003))
bones['nose'] = (0.0, 0.688, surf(0.0, 0.688))
bones['lipLo'] = (0.0, mouthY - 0.0035, surf(0.0, mouthY - 0.0035))
for s_, sx in (('L', 1), ('R', -1)): bones['nostril'+s_] = (sx*0.0085, 0.6805, surf(sx*0.0085, 0.6805, 0.003))
parents = {'lipLo': 'jaw'}          # the lower lip rides on the jaw

# ---- weights ----------------------------------------------------------------
smooth = lambda t: (lambda u: u*u*(3-2*u))(min(max(t, 0.0), 1.0))
def bump(i, c, R, sx=1.0, sy=1.0):
    p = pos(i)
    q = ((p[0]-c[0])*sx)**2 + ((p[1]-c[1])*sy)**2 + (p[2]-c[2])**2
    return (1 - q/(R*R))**2 if q < R*R else 0.0

# Which side of the mouth a vertex is on, by walking the skin: the lower lip is a short walk
# from the chin and a long one (round a corner) from under the nose; the upper lip the reverse.
import heapq
adj = collections.defaultdict(set)
ft = d['tris']['faceroomSkin'][0::2]
for k in range(0, len(ft), 3):
    a, b, c = ft[k:k+3]
    for u, v in ((a, b), (b, c), (c, a)): adj[u].add(v); adj[v].add(u)
dist3 = lambda a, b: math.dist(pos(a), pos(b))
def walk(seed):
    D = {seed: 0.0}; h = [(0.0, seed)]
    while h:
        dd, u = heapq.heappop(h)
        if dd > D[u]: continue
        for v in adj[u]:
            nd = dd + dist3(u, v)
            if nd < D.get(v, 1e9): D[v] = nd; heapq.heappush(h, (nd, v))
    return D
nearest = lambda p: min(face, key=lambda i: math.dist(pos(i), p))
chin = nearest((0.0, mouthY - 0.014, surf(0.0, mouthY - 0.014)))
philtrum = nearest((0.0, mouthY + 0.009, surf(0.0, mouthY + 0.009)))
dChin, dNose = walk(chin), walk(philtrum)

def jaw_w(i):
    return smooth((dNose.get(i, 1e9) - dChin.get(i, 1e9)) / 0.010 + 0.5)
def lower_side(i):
    return dChin.get(i, 1e9) < dNose.get(i, 1e9)

new_w = []
for i in range(nv):
    ws = dict(d['w'][i])
    mats = mat_of[i]
    f = {}
    if 'faceroomSkin' in mats:
        x, y, z = pos(i)
        head = ws.get('Head', 0.0)
        low = lower_side(i)
        f['jaw'] = jaw_w(i) * head
        for s_, sx in (('L', 1), ('R', -1)):
            f['corner'+s_] = 0.9 * bump(i, bones['corner'+s_], 0.015)
            if y > 0.7005:
                f['browIn'+s_] = 0.95 * bump(i, bones['browIn'+s_], 0.013, sy=0.8)
                f['browOut'+s_] = 0.95 * bump(i, bones['browOut'+s_], 0.014, sy=0.8)
            ex, ey = sx*EYE[0], EYE[1]
            if z > 0.043 and abs(x - ex) < 0.011:
                side = 1 - smooth(abs(x - ex) / 0.011)
                if y >= ey: f['lidUp'+s_] = side * (1 - smooth((y - ey - 0.0015) / 0.006))
                else:       f['lidLo'+s_] = side * (1 - smooth((ey - y - 0.0015) / 0.005))
            f['cheek'+s_] = 0.6 * bump(i, bones['cheek'+s_], 0.014)
        if not low: f['lipUp'] = 0.8 * bump(i, bones['lipUp'], 0.011, sx=0.75)
        else: f['lipLo'] = 0.8 * bump(i, bones['lipLo'], 0.011, sx=0.75)
        for s_ in 'LR': f['nostril'+s_] = 0.8 * bump(i, bones['nostril'+s_], 0.0065)
        f['nose'] = 0.6 * bump(i, bones['nose'], 0.011, sx=0.8)
    elif 'Tongue' in mats:
        f['jaw'] = 1.0
    elif 'Gums' in mats:
        # the inside of each lip follows that lip; deeper in, upper and lower part by height
        r = min(lip, key=lambda v: math.dist(pos(v), pos(i)))
        near = 1 - smooth(math.dist(pos(r), pos(i)) / 0.006)
        f['jaw'] = near * jaw_w(r) + (1 - near) * smooth((mouthY - 0.0008 - pos(i)[1]) / 0.002 + 0.5)
    f = {k: v for k, v in f.items() if v > 0.02}
    if f:
        jw = f.pop('jaw', 0.0)                    # the jaw carries; the small controls ride on top of it
        top = sorted(f.items(), key=lambda kv: -kv[1])[:2]
        tot = sum(v for _, v in top)
        if tot > 1: top = [(k, v/tot) for k, v in top]; tot = 1.0
        rest = 1 - tot
        ws = {k: v * rest * (1 - jw) for k, v in ws.items()}
        if jw > 0: ws['jaw'] = rest * jw
        for k, v in top: ws[k] = v
    ws = sorted(((k, v) for k, v in ws.items() if v > 1e-4), key=lambda kv: -kv[1])[:4]
    tot = sum(v for _, v in ws)
    new_w.append([[k, v / tot] for k, v in ws])
d['w'] = new_w

# ---- teeth: two plain arches ------------------------------------------------
TEETH_FRONT = 0.0515      # where the figure's own front teeth stood
def arch(name, y0, y1, joint):
    rx, rz, n = cornerX * 1.02, 0.0195, 14
    zc = TEETH_FRONT - rz
    base = len(d['pos']) // 3
    ring = []
    for k in range(n + 1):
        a = math.radians(-82 + 164 * k / n)
        ring.append((rx * math.sin(a), zc + rz * math.cos(a), math.sin(a), math.cos(a)))
    for depth in (0.0, 0.0022):                   # front face and back face of the band
        for (x, z, nx, nz) in ring:
            s = 1 - depth / rz
            for y in (y0, y1):
                d['pos'] += [x * s, y, zc + (z - zc) * s]
                d['nrm'] += [nx if depth == 0 else -nx, 0, nz if depth == 0 else -nz]
                d['w'].append([[joint, 1.0]])
    uv = len(d['uv']) // 2; d['uv'] += [0.5, 0.5]
    t = d['tris'].setdefault(name, [])
    def quad(a, b, c, e):
        for v in (a, b, c, a, c, e): t.extend([v, uv])
    m = 2 * (n + 1)
    t0 = len(t)
    for k in range(n):
        f0, f1 = base + 2*k, base + 2*k + 2
        quad(f0, f1, f1 + 1, f0 + 1)                              # front
        quad(f1 + m, f0 + m, f0 + m + 1, f1 + m + 1)              # back
        e = 1 if y1 > y0 else 0                                    # biting edge
        quad(f0 + (1 if y1 > y0 else 0), f1 + (1 if y1 > y0 else 0), f1 + m + (1 if y1 > y0 else 0), f0 + m + (1 if y1 > y0 else 0))
    # wind every triangle to face the way its normals point
    for k in range(t0, len(t), 6):
        a, b, c = t[k], t[k+2], t[k+4]
        pa, pb, pc = (d['pos'][3*v:3*v+3] for v in (a, b, c))
        u = [pb[j]-pa[j] for j in range(3)]; w = [pc[j]-pa[j] for j in range(3)]
        g = [u[1]*w[2]-u[2]*w[1], u[2]*w[0]-u[0]*w[2], u[0]*w[1]-u[1]*w[0]]
        nn = [sum(d['nrm'][3*v+j] for v in (a, b, c)) for j in range(3)]
        if abs(nn[1]) < 1e-6 and abs(pa[1]-pb[1]) < 1e-9 and abs(pa[1]-pc[1]) < 1e-9: nn = [0, -1 if y1 < y0 else 1, 0]   # biting edge
        if sum(g[j]*nn[j] for j in range(3)) < 0: t[k+2], t[k+4] = c, b
# upper teeth hang from the head, lower teeth stand on the jaw; they meet just below the lip line
arch('TeethTop', mouthY + 0.0060, mouthY - 0.0012, 'Head')
arch('TeethBottom', mouthY - 0.0062, mouthY - 0.0012, 'jaw')

gt = d['tris']['Gums']; keep = []
for k in range(0, len(gt), 6):
    vs = [gt[k], gt[k+2], gt[k+4]]
    c = [sum(pos(v)[j] for v in vs) / 3 for j in range(3)]
    front = c[2] > TEETH_FRONT - 0.006 and abs(c[1] - mouthY) < 0.0075 and not any(v in lipset for v in vs)
    if not front: keep += gt[k:k+6]
d['tris']['Gums'] = keep
d['faceBones'] = {k: [round(c, 6) for c in v] for k, v in bones.items()}
d['faceParents'] = parents
json.dump(d, open(dst, 'w'))
used = collections.Counter(k for ws in d['w'] for k, _ in ws if k in bones)
print('lip edge', len(lip), 'mouthY %.4f cornerX %.4f cornerZ %.4f' % (mouthY, cornerX, cornerZ))
print('verts per face joint', dict(used))
