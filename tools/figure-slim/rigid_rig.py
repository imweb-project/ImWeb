# A rig for a figure that is a set of RIGID PIECES with Poser part names and no skeleton —
# an anatomical skeleton exported as OBJ (assets/skeletHa_9.obj): 111 groups, lThigh, t7, rIndex2 …
#
# Used by retarget.py when the character is an .obj: build(path) imports it, finds every joint as
# the place where two pieces MEET, makes an armature with Haraldur6's joint names, and binds each
# piece whole to its joint, so bones stay bones. The figure may be in any pose: that pose becomes
# the rest pose, and retarget.py turns it to Haraldur6's limb by limb.
import bpy, math
from mathutils import Vector, kdtree

FINGERS = ('Thumb', 'Index', 'Mid', 'Ring', 'Pinky')
TOES = ('BigToe', 'IndexToe', 'MidToe', 'RingToe', 'PinkyToe')
# The spine is many vertebrae on few joints: each vertebra moves whole, a share with each joint.
SPINE = {'l5': {'hip': .5, 'abdomen': .5}, 'l4': {'abdomen': 1}, 'l3': {'abdomen': 1}, 'l2': {'abdomen': .75, 'chest': .25},
         'l1': {'abdomen': .5, 'chest': .5}, 't12': {'abdomen': .25, 'chest': .75},
         'c7': {'chest': .6, 'neck': .4}, 'c6': {'chest': .2, 'neck': .8}, 'c5': {'neck': 1}, 'c4': {'neck': 1}, 'c3': {'neck': .8, 'head': .2},
         'c2': {'neck': .5, 'head': .5}, 'c1': {'neck': .25, 'head': .75}}


def build(path, scale=2.62, tris=60000):
    bpy.ops.wm.obj_import(filepath=path, import_vertex_groups=True, global_scale=scale, forward_axis='NEGATIVE_Z', up_axis='Y')
    ob = next(o for o in bpy.context.selected_objects if o.type == 'MESH')
    bpy.context.view_layer.objects.active = ob
    with bpy.context.temp_override(object=ob, active_object=ob, selected_objects=[ob], selected_editable_objects=[ob]):
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    me = ob.data
    now = sum(len(p.vertices) - 2 for p in me.polygons)
    if now > tris:                                             # thinned first: the pieces keep their groups
        m = ob.modifiers.new('D', 'DECIMATE'); m.ratio = tris / now
        with bpy.context.temp_override(object=ob, active_object=ob, selected_objects=[ob]): bpy.ops.object.modifier_apply(modifier=m.name)
        me = ob.data
    gname = [g.name for g in ob.vertex_groups]
    piece = {}                                                 # part name → its vertices' positions
    owner = [None] * len(me.vertices)
    for v in me.vertices:
        if v.groups:
            n = gname[max(v.groups, key=lambda g: g.weight).group]; owner[v.index] = n; piece.setdefault(n, []).append(v.co.copy())
    P = lambda *names: [p for n in names for p in piece.get(n, [])]
    cen = lambda pts: sum(pts, Vector()) / len(pts)
    def meet(a, b):                                            # where two sets of pieces touch
        if not a or not b: return None
        kd = kdtree.KDTree(len(b))
        for i, p in enumerate(b): kd.insert(p, i)
        kd.balance()
        near = sorted(((kd.find(p)[2], p, kd.find(p)[0]) for p in a), key=lambda x: x[0])[:max(8, len(a) // 30)]
        return cen([(p + q) / 2 for d, p, q in near])
    far = lambda pts, o: max(pts, key=lambda p: (p - o).length)

    J = {'hip': cen(P('hip'))}
    J['abdomen'] = meet(P('l5'), P('hip')); J['chest'] = meet(P('t12'), P('l1')); J['neck'] = meet(P('c7'), P('t1'))
    J['head'] = meet(P('c1'), P('head', 'jaw')); J['lowerjaw'] = meet(P('jaw'), P('head'))
    thorax = P(*['t%d' % i for i in range(1, 13)])
    for S in 'lr':
        J[S + 'Collar'] = meet(P(S + 'Cla', S + 'Collar'), thorax)
        J[S + 'Shldr'] = meet(P(S + 'Shldr'), P(S + 'Collar', S + 'Cla'))
        J[S + 'ForeArm'] = meet(P(S + 'ForeArm'), P(S + 'Shldr'))
        palm = P(S + 'Hand', *[S + f + '0' for f in FINGERS])
        J[S + 'Hand'] = meet(palm, P(S + 'ForeArm'))
        for f in FINGERS:
            J[S + f + '1'] = meet(P(S + f + '1'), P(S + f + '0') or P(S + 'Hand'))
            J[S + f + '2'] = meet(P(S + f + '2'), P(S + f + '1')); J[S + f + '3'] = meet(P(S + f + '3'), P(S + f + '2'))
        J[S + 'Thigh'] = meet(P(S + 'Thigh'), P('hip')); J[S + 'Shin'] = meet(P(S + 'Shin'), P(S + 'Thigh')); J[S + 'Foot'] = meet(P(S + 'Foot'), P(S + 'Shin'))
        tj = [meet(P(S + t + '1'), P(S + t + '0')) for t in TOES]; tj = [x for x in tj if x]
        J[S + 'Toe'] = cen(tj) if tj else None
    J = {k: v for k, v in J.items() if v is not None}

    parent = {'abdomen': 'hip', 'chest': 'abdomen', 'neck': 'chest', 'head': 'neck', 'lowerjaw': 'head'}
    tail_to = {'hip': 'abdomen', 'abdomen': 'chest', 'chest': 'neck', 'neck': 'head'}
    ends = {'head': P('head'), 'lowerjaw': P('jaw')}
    for S in 'lr':
        parent.update({S + 'Collar': 'chest', S + 'Shldr': S + 'Collar', S + 'ForeArm': S + 'Shldr', S + 'Hand': S + 'ForeArm',
                       S + 'Thigh': 'hip', S + 'Shin': S + 'Thigh', S + 'Foot': S + 'Shin', S + 'Toe': S + 'Foot'})
        tail_to.update({S + 'Collar': S + 'Shldr', S + 'Shldr': S + 'ForeArm', S + 'ForeArm': S + 'Hand', S + 'Hand': S + 'Mid1',
                        S + 'Thigh': S + 'Shin', S + 'Shin': S + 'Foot', S + 'Foot': S + 'Toe'})
        ends[S + 'Toe'] = P(*[S + t + k for t in TOES for k in '12'])
        for f in FINGERS:
            parent.update({S + f + '1': S + 'Hand', S + f + '2': S + f + '1', S + f + '3': S + f + '2'})
            tail_to.update({S + f + '1': S + f + '2', S + f + '2': S + f + '3'}); ends[S + f + '3'] = P(S + f + '3')

    ad = bpy.data.armatures.new('Skeleton'); arm = bpy.data.objects.new('Skeleton', ad); bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm; bpy.ops.object.mode_set(mode='EDIT')
    def depth(n):
        d = 0
        while n in parent: n = parent[n]; d += 1
        return d
    order = sorted(J, key=depth)                                # parents before children
    for n in order:
        if n != 'hip' and parent.get(n) not in J: continue
        b = ad.edit_bones.new(n); b.head = J[n]
        t = J.get(tail_to.get(n)) if tail_to.get(n) in J else (far(ends[n], J[n]) if ends.get(n) else J[n] + Vector((0, 0, 0.05 * scale)))
        if (t - J[n]).length < 1e-4: t = J[n] + Vector((0, 0, 0.02 * scale))
        b.tail = t
        if n != 'hip': b.parent = ad.edit_bones[parent[n]]
    made = {b.name for b in ad.edit_bones}
    bpy.ops.object.mode_set(mode='OBJECT')

    def bone_of(n):                                            # which joint(s) a piece hangs on
        if n in SPINE: return SPINE[n]
        if n[0] == 't' and n[1:].isdigit(): return {'chest': 1}
        if n in ('head',): return {'head': 1}
        if n == 'jaw': return {'lowerjaw': 1}
        S, r = n[0], n[1:]
        if r in ('Cla', 'Collar'): return {S + 'Collar': 1}
        if r[:-1] in FINGERS: return {S + 'Hand': 1} if r[-1] == '0' else {S + r: 1}
        if r[:-1] in TOES: return {S + 'Foot': 1} if r[-1] == '0' else {S + 'Toe': 1}
        return {n: 1}
    for g in list(ob.vertex_groups): ob.vertex_groups.remove(g)
    vg, lost = {}, set()
    for i, n in enumerate(owner):
        w = {b: x for b, x in bone_of(n).items() if b in made} if n else {}
        if not w: lost.add(n); w = {'hip': 1}
        for b, x in w.items():
            if b not in vg: vg[b] = ob.vertex_groups.new(name=b)
            vg[b].add([i], x, 'REPLACE')
    mat = bpy.data.materials.new('Bone'); mat.use_nodes = True
    bsdf = mat.node_tree.nodes['Principled BSDF']; bsdf.inputs['Base Color'].default_value = (0.78, 0.72, 0.6, 1); bsdf.inputs['Roughness'].default_value = 0.6
    me.materials.clear(); me.materials.append(mat)
    for p in me.polygons: p.use_smooth = True; p.material_index = 0
    ob.parent = arm; ob.modifiers.new('Armature', 'ARMATURE').object = arm
    print('RIGID RIG', len(piece), 'pieces on', len(made), 'joints;', sum(len(p.vertices) - 2 for p in me.polygons), 'triangles; pieces with no joint:', sorted(x for x in lost if x))
    return arm
