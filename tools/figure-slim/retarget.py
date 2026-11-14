# Put the baked Haraldur6 motion on ANOTHER character and write a GLB ImWeb can load.
#
#   Blender -b --python tools/figure-slim/retarget.py -- <character.fbx> <motion.txt> <out.glb> [--frames=N] [--tex=1024] [--creature [--seed=7]] [--faces=assets/Haraldur6-assignments.json [--face-gain=1.5]]
#
# <motion.txt> is what tools/figure-slim/export-motion.html returns (first line, JSON).
# Written for Daz Genesis 9 (assets/Laura.fbx); another skeleton needs its own MAP below.
#
# The motion is carried over as each joint's turn AWAY FROM ITS BIND POSE, in world space, so
# the two skeletons need not share joint axes, joint counts or a rest pose: Haraldur6 binds in a
# T, Genesis 9 with the arms lowered, and ALIGN (below) is the turn that takes one bind to the other.
import bpy, sys, json, base64, math, re
import numpy as np
from mathutils import Quaternion, Vector, Matrix

argv = sys.argv[sys.argv.index('--') + 1:]
SRC, MOTION, OUT = argv[:3]
opt = {a.split('=')[0]: a.split('=')[1] for a in argv[3:] if '=' in a}
MAXF = int(opt.get('--frames', 0)); TEX = int(opt.get('--tex', 1024))

# ── the character ───────────────────────────────────────────────────────────
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=SRC)
arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
if '--creature' in argv:
    # The character's body is not kept at all: its skeleton and proportions carry a creature
    # grown by creature.py, weighted to the same joints.
    import os; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import creature
    for o in [o for o in bpy.data.objects if o.type == 'MESH']: bpy.data.objects.remove(o, do_unlink=True)
    if '--plain-build' not in argv: creature.reshape(arm)          # taller, longer in the arm than the figure whose skeleton it is
    ob = creature.build(arm, seed=int(opt.get('--seed', 7)), thin=float(opt.get('--thin', 0.8)))
    bark = bpy.data.images.get('RootlingBark')                     # the bark on its own too, to lay on the figure in ImWeb (Texture = Image)
    if bark:
        import shutil; shutil.copy(bpy.path.abspath(bark.filepath), os.path.join(os.path.dirname(OUT), 'Rootling-bark.png'))
for o in list(bpy.data.objects):
    if o.type != 'MESH': continue
    # brows drawn as 57,000 triangles of single hairs, and a tear film: more than the body itself
    if 'EyebrowFibers' in o.name or 'Tear' in o.name: bpy.data.objects.remove(o, do_unlink=True); continue
    # the wet layer over each eye is a clear shell; untextured in a GLB it hides the eye
    wet = [i for i, s in enumerate(o.material_slots) if s.material and 'Moisture' in s.material.name]
    if wet:
        import bmesh
        bm = bmesh.new(); bm.from_mesh(o.data)
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.material_index in wet], context='FACES')
        bm.to_mesh(o.data); bm.free()
    mods = [m for m in o.modifiers if m.type == 'ARMATURE']
    if not mods:
        # Daz exports eyes, lashes and mouth each hung on a COPY of the skeleton ("head.001",
        # "l_eye.003" …) that nothing animates, so they stay behind when the head moves: the
        # teeth float beside the face. Move every weight to the real joint of the same name — or,
        # where the copy has joints the body lacks (the tongue), to the nearest one it does have.
        main = {b.name for b in arm.data.bones['hip'].children_recursive} | {'hip'}
        def real(bn):
            b = arm.data.bones.get(bn)
            while b:
                base = re.sub(r'\.\d+$', '', b.name)
                if base in main: return base
                b = b.parent
            return 'head'
        target = {g.index: real(g.name) for g in o.vertex_groups}
        w = {}
        for v in o.data.vertices:
            for ge in v.groups: w.setdefault(target[ge.group], {})[v.index] = w.get(target[ge.group], {}).get(v.index, 0) + ge.weight
        for g in list(o.vertex_groups): o.vertex_groups.remove(g)
        for name, vs in w.items():
            g = o.vertex_groups.new(name=name)
            for vi, wt in vs.items(): g.add([vi], wt, 'REPLACE')
        mw = o.matrix_world.copy(); o.parent = arm; o.parent_type = 'OBJECT'; o.parent_bone = ''; o.matrix_world = mw
        mods = [o.modifiers.new('Armature', 'ARMATURE')]
    for m in mods: m.object = arm
    missing = [g.name for g in o.vertex_groups if g.name not in arm.data.bones]
    print('MESH', o.name, len(o.data.polygons), 'faces, groups', len(o.vertex_groups), 'without a bone:', missing[:6])
# Daz skin arrives part metal and glossy, which reads as dark bronze under plain lights.
for m in ([] if '--creature' in argv else bpy.data.materials):
    bsdf = m.node_tree.nodes.get('Principled BSDF') if m.use_nodes else None
    if bsdf: bsdf.inputs['Metallic'].default_value = 0; bsdf.inputs['Roughness'].default_value = 0.6
for img in bpy.data.images:
    big = max(img.size)
    lim = TEX * 2 if any(k in img.name for k in ('Head', 'Body')) else TEX
    if big > lim: img.scale(max(1, img.size[0] * lim // big), max(1, img.size[1] * lim // big))

# ── the motion ──────────────────────────────────────────────────────────────
mo = json.loads(open(MOTION).readline())
names = mo['names']; NB = len(names); N = mo['frames'] if not MAXF else min(MAXF, mo['frames'])
rot = np.frombuffer(base64.b64decode(mo['rot']), dtype=np.float32).reshape(mo['frames'], NB, 4)   # x y z w
hip = np.frombuffer(base64.b64decode(mo['hip']), dtype=np.float32).reshape(mo['frames'], 3)
si = {n: i for i, n in enumerate(names)}
# source space (Y up, facing +Z) → Blender world (Z up) → the armature's own space
C = arm.matrix_world.to_quaternion().inverted() @ Quaternion((1, 0, 0), math.radians(90))
Ci = C.inverted()
qsrc = lambda v: C @ Quaternion((float(v[3]), float(v[0]), float(v[1]), float(v[2]))) @ Ci
vsrc = lambda v: C @ Vector((float(v[0]), float(v[1]), float(v[2])))
s_rest_q = {n: qsrc(mo['rest'][i][3:7]) for n, i in si.items()}
s_rest_p = {n: vsrc(mo['rest'][i][0:3]) for n, i in si.items()}

B = arm.data.bones
MAP = {'hip': 'hip', 'abdomen': 'spine2', 'chest': 'spine4', 'neck': 'neck1', 'head': 'head'}
BLEND = {'spine1': ('hip', 'abdomen'), 'spine3': ('abdomen', 'chest'), 'neck2': ('neck', 'head')}   # joints Haraldur6 lacks: halfway between two it has
AIM = {}                                                                                              # source joint → the joint its bone points at
for S, s in (('l', 'l_'), ('r', 'r_')):
    for a, b in (('Collar', 'shoulder'), ('Shldr', 'upperarm'), ('ForeArm', 'forearm'), ('Hand', 'hand'), ('Thigh', 'thigh'), ('Shin', 'shin'), ('Foot', 'foot'), ('Toe', 'toes')):
        MAP[S + a] = s + b
    for f, g in (('Thumb', 'thumb'), ('Index', 'index'), ('Mid', 'mid'), ('Ring', 'ring'), ('Pinky', 'pinky')):
        for k in '123': MAP[f'{S}{f}{k}'] = f'{s}{g}{k}'
        AIM[f'{S}{f}1'] = f'{S}{f}2'; AIM[f'{S}{f}2'] = f'{S}{f}3'
    AIM.update({S + 'Collar': S + 'Shldr', S + 'Shldr': S + 'ForeArm', S + 'ForeArm': S + 'Hand', S + 'Hand': S + 'Mid1',
                S + 'Thigh': S + 'Shin', S + 'Shin': S + 'Foot', S + 'Foot': S + 'Toe'})
MAP = {a: b for a, b in MAP.items() if a in si and b in B}
print('mapped', len(MAP), 'of', NB, 'source joints; not mapped:', [n for n in names if n not in MAP])
t_q = {b.name: b.matrix_local.to_quaternion() for b in B}
t_p = {b.name: b.head_local.copy() for b in B}

# ALIGN[source joint]: the turn that brings the character's bind pose to Haraldur6's, limb by limb
# down each chain, so a twist set at the shoulder is not set again at the elbow.
ALIGN = {}
def s_parent(n):
    chain = {'Shldr': 'Collar', 'ForeArm': 'Shldr', 'Hand': 'ForeArm', 'Shin': 'Thigh', 'Foot': 'Shin', 'Toe': 'Foot'}
    side, rest = n[0], n[1:]
    if rest in chain: return side + chain[rest]
    if rest[-1] in '23' and rest[:-1] in ('Thumb', 'Index', 'Mid', 'Ring', 'Pinky'): return side + rest[:-1] + str(int(rest[-1]) - 1)
    if rest[-1] == '1' and rest[:-1] in ('Thumb', 'Index', 'Mid', 'Ring', 'Pinky'): return side + 'Hand'
    return None
def align(n):
    if n in ALIGN: return ALIGN[n]
    p = s_parent(n) if n[0] in 'lr' and n[1:2].isupper() else None
    A = align(p).copy() if p else Quaternion()
    if n in AIM and AIM[n] in MAP:
        ds = (s_rest_p[AIM[n]] - s_rest_p[n]).normalized(); dt = A @ (t_p[MAP[AIM[n]]] - t_p[MAP[n]]).normalized()
        A = dt.rotation_difference(ds) @ A
        if n[1:] == 'Hand':        # the palm too: across the knuckles, index to pinky
            ks = (s_rest_p[n[0] + 'Pinky1'] - s_rest_p[n[0] + 'Index1']); kt = A @ (t_p[MAP[n[0] + 'Pinky1']] - t_p[MAP[n[0] + 'Index1']])
            ks = (ks - ks.dot(ds) * ds).normalized(); kt = (kt - kt.dot(ds) * ds).normalized()
            A = kt.rotation_difference(ks) @ A
    ALIGN[n] = A; return A
for n in MAP: align(n)
for n in ('lShldr', 'lForeArm', 'lHand', 'lThigh', 'lIndex1'):
    if n in ALIGN: print('align', n, round(math.degrees(ALIGN[n].angle)), 'deg')
print('left is left:', s_rest_p['lHand'].dot(t_p[MAP['lHand']] - t_p['hip']) > 0, '| src hip rest', tuple(round(x, 3) for x in mo['rest'][si['hip']][:3]), 'frame 0', tuple(round(float(x), 3) for x in hip[0]))

leg = lambda P, a, b, c: (P[b] - P[a]).length + (P[c] - P[b]).length
SCALE = leg(t_p, 'l_thigh', 'l_shin', 'l_foot') / leg(s_rest_p, 'lThigh', 'lShin', 'lFoot')
print('size ratio', round(SCALE, 2))

tgt_of = {b: a for a, b in MAP.items()}
need = set()
for bn in list(tgt_of) + list(BLEND):
    b = B[bn]
    while b: need.add(b.name); b = b.parent
order = [b.name for b in B if b.name in need]            # armature bones come parents first
keyed = [bn for bn in order if bn in tgt_of or bn in BLEND]
out = {bn: np.zeros((N, 4), dtype=np.float32) for bn in keyed}
loc = np.zeros((N, 3), dtype=np.float32)
# Measured from where the figure STANDS (frame 0), not from the bind pose: Haraldur6's hip is
# bound 13 cm lower than it stands, which would lift the character off the floor.
hip_rest = C @ Vector([float(x) for x in hip[0]]); Mhip_i = t_q['hip'].inverted()
rest_inv = {n: s_rest_q[n].inverted() for n in MAP}
for k in range(N):
    D = {n: qsrc(rot[k, si[n]]) @ rest_inv[n] for n in MAP}
    P = {}
    for bn in order:
        b = B[bn]; par = b.parent.name if b.parent else None
        free = (P[par] @ t_q[par].inverted() @ t_q[bn]) if par else t_q[bn].copy()     # where it is with no turn of its own
        if bn in tgt_of: n = tgt_of[bn]; P[bn] = D[n] @ ALIGN[n] @ t_q[bn]
        elif bn in BLEND: a, c = BLEND[bn]; P[bn] = D[a].slerp(D[c], 0.5) @ t_q[bn]
        else: P[bn] = free; continue
        q = free.inverted() @ P[bn]
        o = out[bn]
        if k and (o[k - 1, 0] * q.w + o[k - 1, 1] * q.x + o[k - 1, 2] * q.y + o[k - 1, 3] * q.z) < 0: q.negate()
        o[k] = (q.w, q.x, q.y, q.z)
    loc[k] = Mhip_i @ ((C @ Vector([float(x) for x in hip[k]]) - hip_rest) * SCALE)
    if k % 2000 == 0: print('frame', k, flush=True)

act = bpy.data.actions.new('Loops')
frames = np.arange(N, dtype=np.float32)
def curve(path, idx, grp, vals):
    fc = act.fcurves.new(data_path=path, index=idx, action_group=grp)
    fc.keyframe_points.add(N)
    co = np.empty(N * 2, dtype=np.float32); co[0::2] = frames; co[1::2] = vals
    fc.keyframe_points.foreach_set('co', co)
    fc.keyframe_points.foreach_set('interpolation', np.full(N, 1, dtype=np.int32))    # LINEAR
    fc.update()
for bn in keyed:
    arm.pose.bones[bn].rotation_mode = 'QUATERNION'
    for i in range(4): curve(f'pose.bones["{bn}"].rotation_quaternion', i, bn, out[bn][:, i])
for i in range(3): curve('pose.bones["hip"].location', i, 'hip', loc[:, i])

# ── faces: the nine rasas, one held through each take (--faces=<assignments.json>) ──
# The same table as tools/figure-slim/rasas.mjs, put on Genesis 9's own face joints. Their axes
# are the figure's (x to its left, y up, z forward), so an offset is simply centimetres.
if '--faces' in opt and mo.get('takes') and 'lowerjaw' in B:
    RASAS = {
        'Shringara': dict(jaw=2, corner=(2.0, 3.3), browIn=(0, 1.1), browOut=2.0, lidUp=8, lidLo=8, cheek=1.8, gaze=(10, 4)),
        'Hasya':     dict(jaw=7, corner=(4.2, 5.4), lipLo=2.4, browIn=(0, 1.4), browOut=2.0, lidUp=12, lidLo=16, cheek=3.6),
        'Karuna':    dict(jaw=3, corner=(-0.4, -3.6), browIn=(1.3, 4.8), browOut=-2.0, lidUp=12, lidLo=4, gaze=(0, 16)),
        'Raudra':    dict(jaw=1, corner=(1.4, -1.2), lipUp=2.6, lipLo=-2.0, browIn=(3.0, -5.2), browOut=1.2, lidUp=-6, lidLo=12, nose=2.2, nostril=1.2),
        'Veera':     dict(jaw=0, corner=(1.2, 0.5), browIn=(0, 1.8), browOut=2.8, lidUp=-8, nostril=1.0),
        'Bhayanaka': dict(jaw=8, corner=(2.2, -1.6), lipLo=-0.8, browIn=(2.4, 6.2), browOut=2.4, lidUp=-16, lidLo=-5),
        'Bibhatsa':  dict(jaw=3, corner=(0.4, -2.7), browIn=(1.6, -3.6), lidUp=10, lidLo=12, cheek=1.6, lipUp=2.8, nose=3.2),
        'Adbhuta':   dict(jaw=9, corner=(-2.2, 0.2), lipUp=0.5, browIn=(0, 4.6), browOut=5.2, lidUp=-12),
        'Shanta':    dict(jaw=0, corner=(0.7, 1.4), lidUp=12, gaze=(0, 8)),
    }
    GAIN = float(opt.get('--face-gain', 1.0)); u = 0.26 * GAIN          # one rasa unit is 2.6 mm on the figure
    X = Vector((1, 0, 0)); Yv = Vector((0, 1, 0))
    def face_pose(r):                                                    # joint → ('loc', Vector cm) or ('rot', Quaternion)
        m = {}; g = lambda k, d=0: r.get(k, d)
        m['lowerjaw'] = ('rot', Quaternion(X, math.radians(g('jaw') * GAIN)))            # + about x swings the chin down
        for b in ('lipuppermiddle', 'l_lipupper', 'r_lipupper'): m[b] = ('loc', Vector((0, g('lipUp') * u, 0)))
        for b in ('liplowermiddle', 'l_liplower', 'r_liplower'): m[b] = ('loc', Vector((0, g('lipLo') * u, 0)))
        co, cu = g('corner', (0, 0)); bt, bu = g('browIn', (0, 0)); gy, gp = g('gaze', (0, 0))
        m['centerbrow'] = ('loc', Vector((0, bu * 0.7 * u, 0)))
        for sd, sx in (('l_', 1), ('r_', -1)):
            m[sd + 'lipcorner'] = ('loc', Vector((sx * co, cu, -0.5 * max(co, 0))) * u)
            m[sd + 'browinner'] = ('loc', Vector((-sx * bt, bu, 0)) * u)
            m[sd + 'browouter'] = ('loc', Vector((0, g('browOut'), 0)) * u)
            m[sd + 'cheek'] = ('loc', Vector((0, g('cheek'), 0.3 * g('cheek'))) * u)
            m[sd + 'squint'] = ('loc', Vector((0, 0.6 * g('cheek') + 0.08 * g('lidLo'), 0)) * u)
            m[sd + 'nostril'] = ('loc', Vector((sx * g('nostril'), g('nose') + 0.3 * g('nostril'), 0)) * u)
            m[sd + 'eyelidupper'] = ('rot', Quaternion(X, math.radians(g('lidUp') * GAIN)))
            m[sd + 'eyelidlower'] = ('rot', Quaternion(X, math.radians(-g('lidLo') * GAIN)))
            m[sd + 'eye'] = ('rot', Quaternion(X, math.radians(gp)) @ Quaternion(Yv, math.radians(-gy)))
        return {b: v for b, v in m.items() if b in B}
    assign = json.load(open(opt['--faces']))['loops']
    keys = {}                                                            # joint → kind, [(frame, value)]
    for ti, (t0, t1) in enumerate(mo['takes']):
        f0, f1 = round(t0 * mo['fps']), min(round(t1 * mo['fps']), N - 1)
        if f0 >= N or ti >= len(assign): break
        for b, (kind, val) in face_pose(RASAS.get(assign[ti].get('rasa'), {})).items():
            keys.setdefault(b, (kind, []))[1].extend([(f0, val), (f1, val)])    # held through the take; the cut to the next is one frame
    for b, (kind, ks) in keys.items():
        pb = arm.pose.bones[b]; pb.rotation_mode = 'QUATERNION'
        path = f'pose.bones["{b}"].' + ('location' if kind == 'loc' else 'rotation_quaternion')
        for i in range(3 if kind == 'loc' else 4):
            fc = act.fcurves.new(data_path=path, index=i, action_group=b); fc.keyframe_points.add(len(ks))
            co = np.empty(len(ks) * 2, dtype=np.float32); co[0::2] = [k[0] for k in ks]; co[1::2] = [k[1][i] for k in ks]
            fc.keyframe_points.foreach_set('co', co); fc.keyframe_points.foreach_set('interpolation', np.full(len(ks), 1, dtype=np.int32)); fc.update()
    print('faces on', len(keys), 'joints, gain', GAIN)
# Hand the action over only now: one made empty and assigned at once is left without a slot in
# Blender 4.4+, and the exporter then writes no animation at all, without a word.
arm.animation_data_create(); arm.animation_data.action = act
if getattr(act, 'slots', None) and not arm.animation_data.action_slot: arm.animation_data.action_slot = act.slots[0]
print('action slot', getattr(arm.animation_data, 'action_slot', 'n/a'))
sc = bpy.context.scene; sc.render.fps = mo['fps']; sc.frame_start = 0; sc.frame_end = N - 1
# The takes, for ImWeb: start and end seconds, as the DAE carries them in <imweb_takes>.
if mo.get('takes'): sc['imweb_takes'] = [float(x) for t in mo['takes'] for x in t if t[0] * mo['fps'] < N]

bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', export_animations=True, export_skins=True, export_yup=True,
    export_image_format='AUTO', export_jpeg_quality=82, export_extras=True, export_force_sampling=True,
    export_optimize_animation_size=True, export_optimize_animation_keep_anim_armature=False, export_morph=False,
    export_cameras=False, export_lights=False, export_animation_mode='ACTIVE_ACTIONS')
print('WROTE', OUT)
