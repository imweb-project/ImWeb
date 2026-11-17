import bpy, sys, json, math, bmesh
from mathutils import Vector, Matrix, kdtree
src, out = sys.argv[-2], sys.argv[-1]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.wm.collada_import(filepath=src)
ob = next(o for o in bpy.data.objects if o.type=='MESH')
arm = next(o for o in bpy.data.objects if o.type=='ARMATURE')
gen_pivot = Vector(arm.data.bones['genital'].head_local)
arm_head = tuple(arm.data.bones['Head'].head_local)
print("v0", tuple(ob.data.vertices[0].co), "pivot", tuple(gen_pivot))
for m in list(ob.modifiers): ob.modifiers.remove(m)
ob.parent = None
ob.matrix_world = Matrix.Rotation(math.radians(90), 4, 'X')
bpy.data.objects.remove(arm)
sc = bpy.context.scene
bpy.context.view_layer.objects.active = ob; ob.select_set(True)
for p in ob.data.polygons: p.use_smooth = True

# ---- render rig
cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); sc.collection.objects.link(cam); sc.camera = cam
cam.data.type = 'ORTHO'
sc.render.engine = 'BLENDER_WORKBENCH'
sc.display.shading.light = 'STUDIO'; sc.display.shading.color_type = 'SINGLE'; sc.display.shading.single_color = (0.78,0.66,0.58)
sc.display.shading.show_cavity = True
sc.render.film_transparent = False
sc.world = bpy.data.worlds.new('w'); sc.world.color = (0.12,0.12,0.13)
def shot(name, center, scale, yaw=0, res=(700,1000), wire=False):
    cam.data.ortho_scale = scale
    c = Vector(center)
    d = Vector((math.sin(math.radians(yaw)), -math.cos(math.radians(yaw)), 0))
    cam.location = c + d*5
    cam.rotation_euler = (math.radians(90), 0, math.radians(yaw))
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.filepath = f"{out}/{name}.png"
    bpy.ops.render.render(write_still=True)
def shots(tag):
    shot(tag+'_full', (0,0,0.37), 0.80)
    shot(tag+'_full34', (0,0,0.37), 0.80, yaw=40)
    shot(tag+'_face', (0,0,0.70), 0.13, res=(800,800))
    shot(tag+'_face34', (0,0,0.70), 0.13, yaw=35, res=(800,800))
    shot(tag+'_hips', (0,0,0.38), 0.22, yaw=30, res=(800,800))
    shot(tag+'_hand', (0.31,0,0.60), 0.12, yaw=0, res=(800,800))


me = ob.data
mats = [s.name for s in ob.material_slots]
idx = {n:i for i,n in enumerate(mats)}
REMOVE = ['TopEyelashes','BottomEyelashes','TeethTop','TeethBottom']   # gums and tongue stay, simplified (an open mouth needs them); face.py makes plain teeth
RATIO = {'Body':0.19,'faceroomSkin':0.30,'EyeSocket':0.12,'Pupil':0.5,'Iris':0.25,'Eyeball':0.10,'FingerNails':0.15,'ToeNails':0.15,'Genitals':0.10,
         'Gums':0.10,'Tongue':0.08}

bm = bmesh.new(); bm.from_mesh(me)
bmesh.ops.delete(bm, geom=[f for f in bm.faces if mats[f.material_index] in REMOVE], context='FACES')
# genitals: shrink toward base, eased in from the seam
dl = bm.verts.layers.deform.verify()
# The Poser export hangs the WHOLE head on the neck joint; only the eyeballs follow the
# head joint, so a nod leaves them behind. Hand the skull and jaw to the head joint,
# blended across a plane through the head joint that slopes down toward the chin.
hb = Vector(arm_head)
ni, hi = ob.vertex_groups['Neck'].index, ob.vertex_groups['Head'].index
moved = 0
for v in bm.verts:
    wn = v[dl].get(ni, 0.0)
    if wn <= 0: continue
    s_ = (v.co.y - hb.y) + 0.5 * (v.co.z - hb.z)
    t = min(max((s_ + 0.025) / 0.035, 0.0), 1.0); t = t*t*(3-2*t)
    if t <= 0: continue
    v[dl][hi] = v[dl].get(hi, 0.0) + wn * t
    if t >= 1: del v[dl][ni]
    else: v[dl][ni] = wn * (1 - t)
    moved += 1
print("head verts handed to the head joint", moved)
ggi = ob.vertex_groups['genital'].index
SH = 0.72; n = 0
for v in bm.verts:
    w = v[dl].get(ggi, 0.0)
    if w > 0:
        w = min(w/0.6, 1.0); w = w*w*(3-2*w); n += 1
        v.co = gen_pivot + (v.co-gen_pivot)*(1-(1-SH)*w)
print("genital verts moved", n)
bm.to_mesh(me); bm.free()

bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_mode(type='FACE')
for name, r in RATIO.items():
    bpy.ops.mesh.select_all(action='DESELECT')
    ob.active_material_index = idx[name]
    bpy.ops.object.material_slot_select()
    if name == 'Tongue': bpy.ops.mesh.remove_doubles(threshold=0.0003)   # never the gums: welding there can sew the closed lips together
    bpy.ops.mesh.decimate(ratio=r, use_symmetry=True, symmetry_axis='X')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.delete_loose()
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.quads_convert_to_tris()
bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.object.vertex_group_limit_total(group_select_mode='ALL', limit=4)
bpy.ops.object.vertex_group_normalize_all(group_select_mode='ALL', lock_active=False)
for p in me.polygons: p.use_smooth = True
me.update()
cnt = {}
for p in me.polygons: cnt[mats[p.material_index]] = cnt.get(mats[p.material_index],0)+1
print("AFTER verts", len(me.vertices), "tris", len(me.polygons), cnt)


# ---- dump
uvl = me.uv_layers.active.data
uvmap = {}; uvs = []
tris = {}
for p in me.polygons:
    row = tris.setdefault(mats[p.material_index], [])
    for li in p.loop_indices:
        u = uvl[li].uv; k = (round(u.x,5), round(u.y,5))
        j = uvmap.get(k)
        if j is None: j = uvmap[k] = len(uvs); uvs.append(k)
        row += [me.loops[li].vertex_index, j]
gn = [g.name for g in ob.vertex_groups]
W = []; unweighted = 0
for v in me.vertices:
    ws = [(gn[g.group], g.weight) for g in v.groups if g.weight > 1e-5]
    if not ws: unweighted += 1
    W.append(ws)
print("unweighted", unweighted)
json.dump({'pos':[round(c,6) for v in me.vertices for c in v.co],
           'nrm':[round(c,5) for v in me.vertices for c in v.normal],
           'uv':[c for u in uvs for c in u], 'tris':tris, 'w':W}, open(f"{out}/slim.json",'w'))
