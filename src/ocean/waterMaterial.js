// Water surface: camera-centred radial grid displaced by the FFT cascades, shaded for both sides.
//   front face (camera in air):  exact Fresnel, sky (PMREM) + sun GGX, screen-space refraction with the same
//                                absorption / single scattering as the underwater post pass, crest SSS, foam.
//   back face (camera in water): Snell's window (refracted sky/sun, radiance * n^2) + total internal reflection
//                                of the water's own in-scattered light. The post pass then fogs camera->surface.
import * as THREE from "three/webgpu";
import {
  Fn, float, vec2, vec3, vec4, uniform, texture, positionGeometry, positionWorld, cameraPosition, varying, normalize,
  dot, max, min, clamp, mix, sqrt, pow, exp, abs, smoothstep, saturate, length, reflect, refract, frontFacing,
  screenUV,
  cameraProjectionMatrix, cameraViewMatrix, pmremTexture, If, select, PI, sin, cos, fract, mx_noise_float, screenCoordinate, ivec2,
} from "three/tsl";

const SEGMENTS = 512;

export function makeRadialGrid(rMin = 0.008, rMax = 30000) {
  const g = 1 + (2 * Math.PI) / SEGMENTS;
  const rings = Math.ceil(Math.log(rMax / rMin) / Math.log(g)) + 1;
  const pos = new Float32Array((rings * SEGMENTS + 1) * 3);
  let o = 3;   // vertex 0 = centre
  for (let j = 0; j < rings; j++) {
    const r = rMin * Math.pow(g, j);
    for (let i = 0; i < SEGMENTS; i++) {
      const a = ((i + (j & 1) * 0.5) / SEGMENTS) * Math.PI * 2;
      pos[o++] = Math.cos(a) * r; pos[o++] = 0; pos[o++] = Math.sin(a) * r;
    }
  }
  const idx = new Uint32Array((SEGMENTS + (rings - 1) * SEGMENTS * 2) * 3);
  let k = 0;
  for (let i = 0; i < SEGMENTS; i++) { idx[k++] = 0; idx[k++] = 1 + ((i + 1) % SEGMENTS); idx[k++] = 1 + i; }
  for (let j = 0; j < rings - 1; j++) {
    const a = 1 + j * SEGMENTS, b = a + SEGMENTS;
    for (let i = 0; i < SEGMENTS; i++) {
      const i1 = (i + 1) % SEGMENTS;
      // staggered rings: pick the diagonal that matches the half-step offset
      if (j & 1) {
        idx[k++] = a + i; idx[k++] = b + i1; idx[k++] = b + i;
        idx[k++] = a + i; idx[k++] = a + i1; idx[k++] = b + i1;
      } else {
        idx[k++] = a + i; idx[k++] = a + i1; idx[k++] = b + i;
        idx[k++] = a + i1; idx[k++] = b + i1; idx[k++] = b + i;
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  return geo;
}

// exact unpolarised dielectric Fresnel reflectance; eta = n_transmitted / n_incident; returns 1 on TIR
const fresnel = (cosi, eta) => {
  const sint2 = float(1).sub(cosi.mul(cosi)).div(eta.mul(eta));
  const cost = sqrt(max(float(1).sub(sint2), 0));
  const rs = cosi.sub(eta.mul(cost)).div(cosi.add(eta.mul(cost)));
  const rp = eta.mul(cosi).sub(cost).div(eta.mul(cosi).add(cost));
  return select(sint2.greaterThanEqual(1), float(1), rs.mul(rs).add(rp.mul(rp)).mul(0.5));
};

const ggx = (NdotH, a) => {
  const a2 = a.mul(a);
  const d = NdotH.mul(NdotH).mul(a2.sub(1)).add(1);
  return a2.div(d.mul(d).mul(PI));
};

// backdrop: ExternalTexture over Post.backdrop (opaque scene colour, linear view depth in alpha), copied before each
// water side is drawn. nearS: ExternalTexture over Post.nearTex (r32float, signed height of the pixel's near-plane
// point above the water, computed before the scene render). Swap both with setBackdrop / setNearS after a resize.
export function makeWaterMaterial(O, env, params, backdrop, nearS) {
  const U = O.U;
  // drawn as two meshes, back faces first (main.js): the front faces refract a backdrop that already contains the
  // back faces, which gives crests their glassy look (this is what three.js's DoubleSide transparent path did)
  const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.FrontSide, transparent: true, depthWrite: true });
  const backdropTex = texture(backdrop);
  const nearSTex = texture(nearS);
  const W = {
    roughness: uniform(params.waterRoughness),
    sss: uniform(params.sss),
    refractStrength: uniform(params.refractStrength),
    sunAngularRadius: uniform(0.0047 * 2.5),
    debug: uniform(params.waterDebug || 0),
  };

  // --- vertex: camera-centred grid, cascades faded by local grid spacing
  const local = positionGeometry.xz;
  const r = length(local);
  const spacing = r.mul((2 * Math.PI) / SEGMENTS).add(0.002);
  const fade = O.L.map(L => saturate(float(2).sub(spacing.div(L.div(256).mul(2)))));
  const paramXZ = local.add(U.camXZ);
  const D = O.displacement(paramXZ, fade);
  mat.positionNode = vec3(paramXZ.x.add(D.x), U.seaLevel.add(D.y), paramXZ.y.add(D.z));
  const vParam = varying(paramXZ, "vParamXZ");
  const vDxz = varying(D.w, "vDxz");
  const vHeight = varying(D.y, "vHeight");

  mat.outputNode = Fn(() => {
    const camDist = length(cameraPosition.sub(positionWorld));
    const { S, F } = O.surface(vParam, smoothstep(4, 1.5, camDist));
    const Nw = O.normalFrom(S, vDxz).toVar();
    // LEAN-style slope variance from the mip chain -> roughness (kills distant sparkle aliasing)
    const varX = max(F.z.sub(S.x.mul(S.x)), 0), varZ = max(F.w.sub(S.y.mul(S.y)), 0);
    const rough = clamp(sqrt(W.roughness.mul(W.roughness).add(varX.add(varZ).mul(0.5))), 0.02, 0.5).toVar();
    // break the foam up with world-space noise (no texel-shaped blobs)
    const foamN = mx_noise_float(vec3(vParam.mul(1.7), U.time.mul(0.05))).mul(0.5).add(0.5);
    const foamAmt = saturate(F.x.mul(U.foamStrength).mul(foamN.mul(1.6)).sub(0.15)).toVar();

    const P = positionWorld;
    const toCam = cameraPosition.sub(P);
    const dist = length(toCam);
    const V = toCam.div(dist).toVar();
    const out = vec3(0).toVar();

    // screen-space helpers
    const fragViewZ = cameraViewMatrix.mul(vec4(P, 1)).z.negate();
    const sceneViewZ = (uv) => backdropTex.sample(uv).a;
    const project = (p) => {
      const c = cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4(p, 1)));
      const n = c.xy.div(c.w);
      return vec2(n.x.mul(0.5).add(0.5), n.y.mul(-0.5).add(0.5));
    };

    // which medium is the camera in for this pixel? The post passes read the same per-pixel near-plane test, so
    // the surface shading flips exactly at the waterline; frontFacing is unreliable on folded crests
    const camAbove = nearSTex.load(ivec2(screenCoordinate.xy)).x.greaterThanEqual(0);
    If(camAbove, () => {
      // ================= camera above water =================
      const N = Nw;
      const cosi = abs(dot(N, V)).max(1e-3);
      const Fr = fresnel(cosi, float(1.333));
      // reflection: sky + sun
      const R = reflect(V.negate(), N).toVar();
      R.y.assign(abs(R.y));
      const sky = pmremTexture(env, R, rough.mul(1.2)).rgb;
      const H = normalize(U.sunDir.add(V));
      const a = rough.mul(rough).max(W.sunAngularRadius);
      const sunSpec = U.sunColor.mul(ggx(saturate(dot(N, H)), a)).mul(fresnel(saturate(dot(H, V)), float(1.333))).mul(0.25).div(max(cosi, 0.08));
      // refraction: follow the refracted ray for the local water thickness, re-project, sample the backdrop
      const T = refract(V.negate(), N, float(1 / 1.333));
      const thick0 = clamp(sceneViewZ(screenUV).sub(fragViewZ), 0, 8);
      // bounded screen-space offset from the view-space normal (stable; the exact re-projection marbled)
      const Nv = cameraViewMatrix.mul(vec4(N, 0)).xyz;
      const uvR = screenUV.add(vec2(Nv.x, Nv.y.negate()).mul(W.refractStrength.mul(0.05)).mul(saturate(thick0.div(2.5))).div(max(fragViewZ.mul(0.15), 1))).toVar();
      const bdR = backdropTex.sample(uvR).toVar();
      // anything in front of the surface at the refracted uv -> fall back to the straight sample
      If(bdR.a.lessThan(fragViewZ), () => { bdR.assign(backdropTex.sample(screenUV)); });
      const thick = clamp(bdR.a.sub(fragViewZ), 0, 400);
      // path length inside water along the refracted ray (view-z difference scaled by the ray's slant)
      const pathLen = thick.div(max(abs(dot(T, U.camFwd)), 0.15)).min(300);
      const bed = bdR.rgb;
      const mu = dot(T.negate(), U.sunRefr);
      const seg = O.waterSegment(max(U.seaLevel.sub(P.y), 0), T.y, pathLen, mu);
      const under = bed.mul(seg.transmittance).add(seg.inscatter);
      // subsurface glow through thin crests, sun behind the wave
      const back = pow(saturate(dot(V, U.sunDir.mul(vec3(-1, 0, -1)).normalize())), 4);
      const crest = saturate(vHeight.mul(2).add(0.3));
      const sss = vec3(0.1, 0.55, 0.45).mul(U.sunColor).mul(back.mul(crest).mul(W.sss)).mul(float(1).sub(Fr));
      const water = mix(under, sky, Fr).add(sunSpec).add(sss);
      // foam: rough white layer lit by sun + sky
      const foamCol = U.sunColor.mul(saturate(dot(N, U.sunDir))).add(U.ambient.mul(PI)).mul(0.75).div(PI);
      out.assign(mix(water, foamCol, foamAmt));
    }).Else(() => {
      // ================= camera below water, looking up at the surface =================
      const N = Nw.negate();   // into the water
      const cosi = abs(dot(N, V)).max(1e-3);
      const Fr = fresnel(cosi, float(1 / 1.333));   // water -> air (TIR above 48.6 deg)
      const T = refract(V.negate(), N, float(1.333)).toVar();
      // Snell's window: refracted sky + sun disc, radiance gains n^2 entering the denser medium
      const sky = pmremTexture(env, T, rough.mul(0.6)).rgb;
      const sunDisc = U.sunColor.mul(ggx(saturate(dot(T, U.sunDir)), rough.mul(rough).max(W.sunAngularRadius).mul(1.5))).mul(0.05);
      const air = sky.add(sunDisc);
      const trans = air.mul(1.333 * 1.333).mul(float(1).sub(Fr));
      // TIR / reflection: the water body's own light seen along the reflected ray (infinite segment)
      const Rd = reflect(V.negate(), N);
      const deep = O.waterSegment(max(U.seaLevel.sub(P.y), 0), Rd.y, float(200), dot(Rd.negate(), U.sunRefr)).inscatter;
      const foamCol = U.ambient.mul(0.6).add(U.sunColor.mul(0.08));
      out.assign(mix(trans.add(deep.mul(Fr)), foamCol, foamAmt.mul(0.8)));
    });
    If(W.debug.greaterThan(0.5), () => {
      out.assign(vec3(dist.div(10), select(camAbove, float(1), float(0)), abs(dot(Nw, V))));
    });
    // keep it finite in the half-float target (Inf/NaN would smear through the bloom pyramid)
    return vec4(clamp(out, vec3(0), vec3(20000)), 1);
  })();

  const back = mat.clone();
  back.side = THREE.BackSide;
  return { material: mat, backMaterial: back, uniforms: W, setBackdrop: (t) => { backdropTex.value = t; }, setNearS: (t) => { nearSTex.value = t; } };
}
