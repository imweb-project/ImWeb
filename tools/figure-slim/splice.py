import json, re, sys
src, js, dst = sys.argv[1:4]
s = open(src, encoding='utf-8').read()
d = json.load(open(js))
G = 'Figure_1_geometry'
nv = len(d['pos'])//3
f = lambda a: ' '.join(('%g' % x) for x in a)
def source(id, arr, stride, params, typ='float'):
    ps = ''.join(f'<param name="{p}" type="{typ}"/>' for p in params)
    return (f'<source id="{id}"><float_array id="{id}-array" count="{len(arr)}">{f(arr)}</float_array>'
            f'<technique_common><accessor count="{len(arr)//stride}" source="#{id}-array" stride="{stride}">{ps}</accessor></technique_common></source>\n')
geo = '<library_geometries>\n<geometry id="%s"><mesh>\n' % G
geo += source(G+'-positions', d['pos'], 3, 'XYZ') + source(G+'-normals', d['nrm'], 3, 'XYZ') + source(G+'-uvs', d['uv'], 2, 'ST')
geo += f'<vertices id="{G}-vertices"><input semantic="POSITION" source="#{G}-positions"/></vertices>\n'
for mat, t in d['tris'].items():
    p = []
    for i in range(0, len(t), 2): p += [t[i], t[i], t[i+1]]
    geo += (f'<triangles count="{len(t)//6}" material="material-{mat}">'
            f'<input offset="0" semantic="VERTEX" source="#{G}-vertices"/><input offset="1" semantic="NORMAL" source="#{G}-normals"/>'
            f'<input offset="2" semantic="TEXCOORD" source="#{G}-uvs" set="0"/><p>{" ".join(map(str,p))}</p></triangles>\n')
geo += '</mesh></geometry>\n</library_geometries>'
a = s.index('<library_geometries>'); b = s.index('</library_geometries>') + len('</library_geometries>')
s = s[:a] + geo + s[b:]

# face bones (from face.py): nodes under the head joint, and joints + bind poses in the skin
fb = d.get('faceBones', {})
if fb:
    hm = re.search(r'<Name_array id="Figure_1-skin-joints-array"[^>]*>([^<]*)<', s)
    jn = hm.group(1).split()
    bpm = re.search(r'(<float_array id="Figure_1-skin-bind_poses-array" count=")(\d+)(">)([^<]*)<', s)
    bp = bpm.group(4).split()
    hi = jn.index('Figure_1head_1_node')
    head = [-float(bp[hi*16+3]), -float(bp[hi*16+7]), -float(bp[hi*16+11])]
    par = d.get('faceParents', {})
    def node(n):
        p = fb[n]; o = fb[par[n]] if n in par else head
        nid = f'Figure_1{n}_1_node'
        kids = ''.join(node(c) for c in fb if par.get(c) == n)
        return (f'<node id="{nid}" name="{n}" sid="{nid}" type="JOINT"><translate sid="translate">{f([p[i]-o[i] for i in range(3)])}</translate>'
                f'<rotate sid="rotateZ">0 0 1 0</rotate><rotate sid="rotateY">0 1 0 0</rotate><rotate sid="rotateX">1 0 0 0</rotate>{kids}</node>\n')
    nodes = ''.join(node(n) for n in fb if n not in par)
    for n, p in fb.items():
        jn.append(f'Figure_1{n}_1_node'); bp += f([1,0,0,-p[0], 0,1,0,-p[1], 0,0,1,-p[2], 0,0,0,1]).split()
    a = s.index('<node id="Figure_1leftEye_1_node"')
    s = s[:a] + nodes + s[a:]
    n = len(jn)
    s = re.sub(r'<Name_array id="Figure_1-skin-joints-array" count="\d+">[^<]*<', f'<Name_array id="Figure_1-skin-joints-array" count="{n}">{" ".join(jn)}<', s)
    s = re.sub(r'(<accessor count=")\d+(" source="#Figure_1-skin-joints-array")', rf'\g<1>{n}\2', s)
    s = re.sub(r'<float_array id="Figure_1-skin-bind_poses-array" count="\d+">[^<]*<', f'<float_array id="Figure_1-skin-bind_poses-array" count="{n*16}">{" ".join(bp)}<', s)
    s = re.sub(r'(<accessor count=")\d+(" source="#Figure_1-skin-bind_poses-array")', rf'\g<1>{n}\2', s)

# skin: keep joints + bind poses, replace weights
joints = re.search(r'<Name_array id="Figure_1-skin-joints-array"[^>]*>([^<]*)<', s).group(1).split()
name2id = dict((m.group(2), m.group(1)) for m in re.finditer(r'<node id="([^"]+)" name="([^"]+)"[^>]*type="JOINT"', s))
jidx = {j: i for i, j in enumerate(joints)}
weights, vcount, v = [], [], []
for ws in d['w']:
    ws = [(jidx[name2id[n]], w) for n, w in ws]
    tot = sum(w for _, w in ws)
    vcount.append(len(ws))
    for j, w in ws:
        v += [j, len(weights)]; weights.append(round(w/tot, 6))
a = s.index('<source id="Figure_1-skin-weights">'); b = s.index('<joints>', a)
s = s[:a] + source('Figure_1-skin-weights', weights, 1, ['WEIGHT']) + s[b:]
a = s.index('<vertex_weights'); b = s.index('</vertex_weights>') + len('</vertex_weights>')
s = s[:a] + (f'<vertex_weights count="{nv}"><input offset="0" semantic="JOINT" source="#Figure_1-skin-joints"/>'
             f'<input offset="1" semantic="WEIGHT" source="#Figure_1-skin-weights"/><vcount>{" ".join(map(str,vcount))}</vcount>'
             f'<v>{" ".join(map(str,v))}</v></vertex_weights>') + s[b:]
# drop materials that no longer have faces from the binding
for m in ('TopEyelashes','BottomEyelashes'):
    s = re.sub(r'\s*<instance_material symbol="material-%s"[^>]*/>' % m, '', s)
open(dst, 'w', encoding='utf-8').write(s)
print('verts', nv, 'tris', sum(len(t)//6 for t in d['tris'].values()), 'weights', len(weights), 'bytes', len(s))
