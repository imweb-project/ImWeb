/**
 * Triplanar ("Seamless") texture projection — ONE formula for every material
 * that offers it: the 3D scene's own material (SceneManager._setupMaterial)
 * and the Hypercube instancer's. Moved out of SceneManager verbatim so the
 * instancer could share it instead of carrying a copy that drifts.
 *
 * Every texture slot that shows the picture must be projected: three's
 * <emissivemap_fragment> samples its own vEmissiveMapUv, so replacing only
 * <map_fragment> lays a UV-mapped copy over the seamless one (LEARNED
 * 2026-09-01). Both replacements below are needed, and need vObjPos/vObjNormal.
 */
export const TRIPLANAR_GLSL = `
      uniform float uTriSharp;
      vec3 _triWeights(vec3 n) {
        // uTriSharp decides how abruptly the three projections hand over.
        // Higher = narrower blend zone: crisper detail, but a sharper crease
        // where planes meet — and in DISPLACEMENT a crease is a physical ridge,
        // not a soft edge, which is why this needed to be playable rather than
        // fixed at 6. Measured on a sphere: pow 6 leaves 30.7% of the surface
        // in a blend zone, pow 3 leaves 55.8%, pow 2 leaves 72.9%. Wider is
        // smoother but flatter, since it averages three samples over more of
        // the surface. There is no free setting; that is the point of a knob.
        vec3 w = pow(abs(normalize(n)), vec3(uTriSharp));
        return w / (w.x + w.y + w.z);
      }
      vec4 _triSample(sampler2D tex, vec3 pos, vec3 nrm, float scale) {
        vec3 w = _triWeights(nrm);
        vec3 p = pos * scale * 0.5 + 0.5;
        return textureLod(tex, p.yz, 0.0) * w.x
             + textureLod(tex, p.xz, 0.0) * w.y
             + textureLod(tex, p.xy, 0.0) * w.z;
      }
    `;

/** Replacement for three's '#include <map_fragment>'. */
export const TRI_MAP_FRAGMENT = `
        #ifdef USE_MAP
          #ifdef USE_TRIPLANAR
            vec4 sampledDiffuseColor = _triSample(map, vObjPos, vObjNormal, 1.0);
            diffuseColor *= sampledDiffuseColor;
          #else
            vec4 sampledDiffuseColor = textureLod(map, vMapUv, 0.0);
            diffuseColor *= sampledDiffuseColor;
          #endif
        #endif
`;

/** Replacement for three's '#include <emissivemap_fragment>'. */
export const TRI_EMISSIVEMAP_FRAGMENT = `
        #ifdef USE_EMISSIVEMAP
          #ifdef USE_TRIPLANAR
            vec4 emissiveColor = _triSample(emissiveMap, vObjPos, vObjNormal, 1.0);
          #else
            vec4 emissiveColor = texture2D(emissiveMap, vEmissiveMapUv);
          #endif
          totalEmissiveRadiance *= emissiveColor.rgb;
        #endif
`;
