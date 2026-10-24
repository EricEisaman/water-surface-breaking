// TSL view of the ocean: wraps the raw GPU textures from ocean.js as three.js ExternalTextures and
// exposes the wave function + underwater optics as TSL nodes shared by every material.
import * as THREE from "three/webgpu";
import {
  Fn, float, vec2, vec3, vec4, uniform, texture, normalize, exp, max, min, clamp, mix, dot, sqrt, pow, abs,
  smoothstep, saturate, length, select, step, fract, floor, mod, ivec2, PI, mx_noise_float,
} from "three/tsl";
import { CASCADES } from "./ocean.js";
import { CAUSTIC_WINDOW } from "./caustics.js";

function wrap(gpuTexture, mips) {
  const t = new THREE.ExternalTexture(gpuTexture);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.type = THREE.HalfFloatType;
  t.anisotropy = mips ? 8 : 1;
  t.generateMipmaps = false;
  t.image = { width: gpuTexture.width, height: gpuTexture.height };
  return t;
}

export function makeOceanNodes(ocean, params) {
  const disp = ocean.disp.map(t => wrap(t, false));
  const deriv = ocean.deriv.map(t => wrap(t, true));
  const foam = ocean.foam.map(t => wrap(t, true));
  const causticTex = wrap(ocean.caustics.texture, true);
  causticTex.wrapS = causticTex.wrapT = THREE.ClampToEdgeWrapping;
  causticTex.anisotropy = 1;

  const U = {
    seaLevel: uniform(params.seaLevel),
    camXZ: uniform(new THREE.Vector2()),
    camFwd: uniform(new THREE.Vector3(0, 0, -1)),
    sunDir: uniform(new THREE.Vector3(0, 1, 0)),       // towards the sun
    sunColor: uniform(new THREE.Color(1, 1, 1)),       // sun irradiance (linear, already * intensity)
    sunRefr: uniform(new THREE.Vector3(0, -1, 0)),     // refracted sun direction under water (pointing down)
    ambient: uniform(new THREE.Color(0.3, 0.4, 0.5)),  // sky irradiance / pi (cosine-weighted radiance)
    sigmaA: uniform(new THREE.Vector3(...params.sigmaA)),
    sigmaS: uniform(new THREE.Vector3(...params.sigmaS)),
    kd: uniform(new THREE.Vector3()),
    causticOrigin: uniform(new THREE.Vector2()),
    causticDepth: uniform(params.causticDepth),
    causticStrength: uniform(params.causticStrength),
    causticBlur: uniform(params.causticBlur),
    msBoost: uniform(params.msBoost),
    foamStrength: uniform(params.foamStrength),
    time: uniform(0),
  };
  const L = CASCADES.map(c => float(c.L));

  // cubic B-spline from 4 bilinear taps (must match bsplineDisp() in post.js: the mesh and the waterline test use
  // the same wave function)
  const bspline = (tex, uv) => {
    const size = float(256);
    const st = uv.mul(size).sub(0.5);
    const f = fract(st), f2 = f.mul(f), f3 = f2.mul(f);
    const w0 = float(1).sub(f.mul(3)).add(f2.mul(3)).sub(f3).div(6);
    const w1 = float(4).sub(f2.mul(6)).add(f3.mul(3)).div(6);
    const w2 = float(1).add(f.mul(3)).add(f2.mul(3)).sub(f3.mul(3)).div(6);
    const w3 = f3.div(6);
    const g0 = w0.add(w1), g1 = w2.add(w3);
    const h0 = float(1).sub(w1.div(g0)).add(f).div(size);
    const h1 = float(1).add(w3.div(g1)).sub(f).div(size);
    const a = texture(tex, vec2(uv.x.sub(h0.x), uv.y.sub(h0.y))).level(0);
    const b = texture(tex, vec2(uv.x.add(h1.x), uv.y.sub(h0.y))).level(0);
    const c = texture(tex, vec2(uv.x.sub(h0.x), uv.y.add(h1.y))).level(0);
    const d = texture(tex, vec2(uv.x.add(h1.x), uv.y.add(h1.y))).level(0);
    return g0.y.mul(a.mul(g0.x).add(b.mul(g1.x))).add(g1.y.mul(c.mul(g0.x).add(d.mul(g1.x))));
  };

  // bilinear in f32 from 4 texel loads (must match bilinearExact() in post.js): hardware filtering keeps only ~8 bits
  // of the sub-texel position, ~4 mm on the 250 m cascade, which shows up as steps along the waterline
  const bilinearExact = (tex, uv) => {
    const n = float(256);
    const st = uv.mul(n).sub(0.5);
    const i = floor(st), f = st.sub(i);
    const at = (dx, dy) => texture(tex).load(ivec2(mod(i.add(vec2(dx, dy)), n)));
    return mix(mix(at(0, 0), at(1, 0), f.x), mix(at(0, 1), at(1, 1), f.x), f.y);
  };

  // displacement at param point xz (vertex stage: level 0). fade[c] lets the mesh drop cascades it cannot resolve.
  // The ripple cascade uses the B-spline (smooth waterline on the tiny near plane).
  const displacement = (xz, fade = [1, 1, 1]) => {
    const s0 = bilinearExact(disp[0], xz.div(L[0]));
    const s1 = bilinearExact(disp[1], xz.div(L[1]));
    const s2 = bspline(disp[2], xz.div(L[2]));
    return s0.mul(fade[0]).add(s1.mul(fade[1])).add(s2.mul(fade[2]));   // (Dx, Dy, Dz, Dxz)
  };
  // all-bilinear variant for lighting (water depth above a lit point): 3 taps instead of 6
  const displacementFast = (xz) => texture(disp[0], xz.div(L[0])).level(0).add(texture(disp[1], xz.div(L[1])).level(0)).add(texture(disp[2], xz.div(L[2])).level(0));

  // summed slopes / Jacobian terms and LEAN moments at param xz (fragment stage). The coarse cascades use the
  // B-spline (bilinear slopes make the Snell-window / TIR edge follow polygonal iso-lines); the ripple
  // cascade uses mipmapped trilinear for anti-aliasing.
  const surface = (xz, nearW = float(0)) => {
    // close to the lens the ripple texels are magnified: B-spline there, trilinear (mips) further away
    const uv2 = xz.div(L[2]);
    const S = bspline(deriv[0], xz.div(L[0])).add(bspline(deriv[1], xz.div(L[1]))).add(mix(texture(deriv[2], uv2), bspline(deriv[2], uv2), nearW));
    const f0 = bspline(foam[0], xz.div(L[0])), f1 = bspline(foam[1], xz.div(L[1])), f2 = texture(foam[2], uv2);
    // the 250 m cascade only contributes slope moments, not foam
    const F = f0.mul(vec4(0, 0, 1, 1)).add(f1).add(f2);
    return { S, F };
  };

  const normalFrom = (S, Dxz) => normalize(vec3(
    S.y.mul(Dxz).sub(S.w.add(1).mul(S.x)),
    S.w.add(1).mul(S.z.add(1)).sub(Dxz.mul(Dxz)),
    Dxz.mul(S.x).sub(S.y.mul(S.z.add(1)))));

  const sigmaT = U.sigmaA.add(U.sigmaS);

  // two-lobe Henyey-Greenstein (forward-peaked sea-water phase function)
  const hg = (g, mu) => float(1 - g * g).div(float(4).mul(PI).mul(pow(float(1 + g * g).sub(mu.mul(2 * g)), 1.5)));
  const phase = (mu) => hg(0.9, mu).mul(0.85).add(hg(0.2, mu).mul(0.15));

  // caustic focusing factor for a receiver at world position p (depth below sea level d)
  const caustic = Fn(([p, d]) => {
    const shift = U.sunRefr.xz.div(max(U.sunRefr.y.negate(), 0.2)).mul(U.causticDepth.sub(d));
    const uvc = p.xz.add(shift).sub(U.causticOrigin).div(CAUSTIC_WINDOW);
    const lod = clamp(abs(d.sub(U.causticDepth)).mul(U.causticBlur).add(0.5), 0, 6).add(clamp(float(0.6).sub(d), 0, 1).mul(3));
    const c = texture(causticTex, uvc).level(lod).rgb;
    const edge = smoothstep(0.5, 0.42, max(abs(uvc.x.sub(0.5)), abs(uvc.y.sub(0.5))));
    return mix(vec3(1), mix(vec3(1), c, U.causticStrength), edge.mul(smoothstep(-0.05, 0.3, d)));
  });

  // sun transmittance from the surface down to depth d along the refracted sun ray
  const sunTransmittance = (d) => exp(U.kd.negate().mul(max(d, 0)).div(max(U.sunRefr.y.negate(), 0.2)));
  // downwelling ambient transmittance
  const ambientTransmittance = (d) => exp(U.kd.negate().mul(max(d, 0)));

  /**
   * Single scattering along a view segment inside water (closed form, see docs/HOW_IT_WORKS.md "Underwater medium").
   * depth0: depth below sea level at the segment start, dirY: view direction y, dist: segment length,
   * mu: cos(angle between view direction and refracted sun direction).
   * Returns { inscatter, transmittance }.
   */
  const waterSegment = (depth0, dirY, dist, mu) => {
    const kdSun = U.kd.div(max(U.sunRefr.y.negate(), 0.2));
    const T = exp(sigmaT.negate().mul(dist));
    // sun: E(t) ~ exp(-kdSun * (depth0 - t*dirY)), integrand sigmaS * p * E * exp(-sigmaT t)
    const k = sigmaT.sub(kdSun.mul(dirY));
    const kSafe = max(abs(k), 1e-4).mul(step(0, k).mul(2).sub(1));
    const sunInt = float(1).sub(exp(kSafe.negate().mul(dist))).div(kSafe);
    const sunE = U.sunColor.mul(exp(kdSun.negate().mul(max(depth0, 0))));
    const sun = U.sigmaS.mul(phase(mu)).mul(sunE).mul(sunInt);
    // ambient (downwelling sky light, isotropic, multiple-scattering boost)
    const kA = sigmaT.sub(U.kd.mul(dirY));
    const kASafe = max(abs(kA), 1e-4).mul(step(0, kA).mul(2).sub(1));
    const ambInt = float(1).sub(exp(kASafe.negate().mul(dist))).div(kASafe);
    const amb = U.sigmaS.mul(U.ambient).mul(exp(U.kd.negate().mul(max(depth0, 0)))).mul(ambInt).mul(U.msBoost).mul(0.25);
    return { inscatter: sun.add(amb), transmittance: T };
  };

  return { disp, deriv, foam, causticTex, U, L, displacement, displacementFast, surface, normalFrom, caustic, sunTransmittance, ambientTransmittance, waterSegment, phase, sigmaT };
}

export function updateOceanUniforms(nodes, params, sun) {
  const U = nodes.U;
  U.sigmaA.value.set(...params.sigmaA);
  U.sigmaS.value.set(...params.sigmaS);
  // diffuse attenuation ~ absorption + backscatter-ish share of scattering
  U.kd.value.set(params.sigmaA[0] + 0.25 * params.sigmaS[0], params.sigmaA[1] + 0.25 * params.sigmaS[1], params.sigmaA[2] + 0.25 * params.sigmaS[2]);
  U.seaLevel.value = params.seaLevel;
  U.causticDepth.value = params.causticDepth;
  U.causticStrength.value = params.causticStrength;
  U.causticBlur.value = params.causticBlur;
  U.msBoost.value = params.msBoost;
  U.foamStrength.value = params.foamStrength;
  U.sunDir.value.copy(sun.dir);
  U.sunColor.value.copy(sun.color);
  const eta = 1 / 1.333, ci = Math.max(sun.dir.y, 0.05), k = 1 - eta * eta * (1 - ci * ci);
  U.sunRefr.value.set(-sun.dir.x * eta, -Math.sqrt(k), -sun.dir.z * eta).normalize();
  U.ambient.value.copy(sun.ambient);
}
