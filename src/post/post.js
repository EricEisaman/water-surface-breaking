// Post stack in raw WGSL (same GPUDevice as three.js):
//   0 nearS       : (before the scene render) per-pixel signed height of the near-plane point above the water =
//                   the camera medium of every pixel. Read by the water material, underwater, lens sim and lens.
//   1 shafts      : half-res ray march of the caustic light shafts along underwater view rays
//     underwater  : closed-form single scattering x the shafts (depth-aware upsample) for underwater pixels
//   2 mips        : blur pyramid of (1) for the lens layer and auto exposure
//   3 lens sim    : half-res screen-space water film on the lens (drains after surfacing) + droplet heights
//   4 lens        : meniscus band at the waterline, film, droplets (refraction, dark rims, highlights)
//   5 bloom       : 13-tap down / tent up
//   6 exposure    : log-average luminance, adapted over time
//   7 output      : exposure, AgX, vignette, grain, sRGB -> canvas
import { CASCADES, N } from "../ocean/ocean.js";
import { CAUSTIC_WINDOW } from "../ocean/caustics.js";

const UNIFORM_SIZE = 416;
const MAX_DROPS = 256;
const A_MIPS = 7;
const BLOOM_LEVELS = 6;

const COMMON = /* wgsl */ `
struct Post {
  invViewProj : mat4x4f,
  viewProj : mat4x4f,
  camPos : vec3f, near : f32,
  camFwd : vec3f, far : f32,
  sunDir : vec3f, time : f32,
  sunColor : vec3f, seaLevel : f32,
  sunRefr : vec3f, causticDepth : f32,
  ambient : vec3f, msBoost : f32,
  sigmaA : vec3f, causticStrength : f32,
  sigmaS : vec3f, causticBlur : f32,
  kd : vec3f, godrays : f32,
  L : vec4f,
  causticOrigin : vec2f, size : vec2f,
  exposure : f32, autoExposure : f32, bloom : f32, frame : f32,
  lens : vec4f,     // band width (screen h), meniscus refraction, waterline darkness, highlight
  lens2 : vec4f,    // drop refraction, drop blur, rim darkness, film refraction
  misc : vec4f,     // dt, vignette, grain, drain speed
  down : vec2f, dropCount : f32, filmTau : f32,
  misc2 : vec4f,    // wetTau, bead density, bloom threshold-ish, godray steps
};
@group(0) @binding(0) var<uniform> u : Post;
@group(0) @binding(1) var sampWrap : sampler;
@group(0) @binding(2) var sampClamp : sampler;
const PI : f32 = 3.14159265358979;
fn unproject(uv : vec2f, z : f32) -> vec3f {
  let ndc = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, z, 1.0);
  let w = u.invViewProj * ndc;
  return w.xyz / w.w;
}
fn hash12(p : vec2f) -> f32 { var p3 = fract(vec3f(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
fn hash22(p : vec2f) -> vec2f { var p3 = fract(vec3f(p.xyx) * vec3f(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
fn luminance(c : vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
`;

// the GPU wave function for the waterline (only the nearS pass evaluates it per pixel)
const WAVES = /* wgsl */ `
@group(0) @binding(3) var disp0 : texture_2d<f32>;
@group(0) @binding(4) var disp1 : texture_2d<f32>;
@group(0) @binding(5) var disp2 : texture_2d<f32>;

// cubic B-spline from 4 bilinear taps (GPU Gems 2, ch. 20). Used for the ripple cascade so the waterline
// on the ~7 cm near plane is smooth (bilinear would give visible kinks every 2.85 cm texel).
// Must match bspline() in oceanNodes.js.
fn bsplineDisp(uv : vec2f) -> vec3f {
  let size = ${N}.0;
  let st = uv * size - 0.5;
  let f = fract(st);
  let f2 = f * f; let f3 = f2 * f;
  let w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
  let w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  let w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
  let w3 = f3 / 6.0;
  let g0 = w0 + w1; let g1 = w2 + w3;
  let h0 = (1.0 - w1 / g0 + f) / size;
  let h1 = (1.0 + w3 / g1 - f) / size;
  let a = textureSampleLevel(disp2, sampWrap, vec2f(uv.x - h0.x, uv.y - h0.y), 0.0).xyz;
  let b = textureSampleLevel(disp2, sampWrap, vec2f(uv.x + h1.x, uv.y - h0.y), 0.0).xyz;
  let c = textureSampleLevel(disp2, sampWrap, vec2f(uv.x - h0.x, uv.y + h1.y), 0.0).xyz;
  let d = textureSampleLevel(disp2, sampWrap, vec2f(uv.x + h1.x, uv.y + h1.y), 0.0).xyz;
  return g0.y * (g0.x * a + g1.x * b) + g1.y * (g0.x * c + g1.x * d);
}
// bilinear in f32 from 4 texel loads: hardware filtering keeps only ~8 bits of the sub-texel position, which on the
// 250 m cascade (1 m texels) is ~4 mm and shows up as small steps along the waterline. Must match bilinearExact() in
// oceanNodes.js.
fn bilinearExact(t : texture_2d<f32>, uv : vec2f) -> vec3f {
  let n = vec2i(textureDimensions(t));
  let st = uv * vec2f(n) - 0.5;
  let i = vec2i(floor(st));
  let f = st - floor(st);
  let a = textureLoad(t, (i % n + n) % n, 0).xyz;
  let b = textureLoad(t, ((i + vec2i(1, 0)) % n + n) % n, 0).xyz;
  let c = textureLoad(t, ((i + vec2i(0, 1)) % n + n) % n, 0).xyz;
  let d = textureLoad(t, ((i + vec2i(1, 1)) % n + n) % n, 0).xyz;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
fn dispAt(p : vec2f) -> vec3f {
  return bilinearExact(disp0, p / u.L.x) + bilinearExact(disp1, p / u.L.y) + bsplineDisp(p / u.L.z);
}
// identical to Ocean.heightAt (CPU): 6 damped fixed-point iterations, then the height
fn heightAt(xz : vec2f) -> f32 {
  var p = xz;
  for (var i = 0; i < 6; i++) { p = mix(p, xz - dispAt(p).xz, 0.85); }
  return dispAt(p).y + u.seaLevel;
}
// signed height of the near-plane point of this screen position above the water (metres)
fn nearS(uv : vec2f) -> f32 {
  let p = unproject(uv, 0.0);
  return p.y - heightAt(p.xz);
}
`;

const NEAR_S = /* wgsl */ `${COMMON}${WAVES}
@group(0) @binding(9) var nearOut : texture_storage_2d<r32float, write>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id : vec3u) {
  let size = vec2u(u.size);
  if (id.x >= size.x || id.y >= size.y) { return; }
  textureStore(nearOut, id.xy, vec4f(nearS((vec2f(id.xy) + 0.5) / u.size), 0.0, 0.0, 0.0));
}`;

// underwater view-ray helpers shared by the shaft march and the composite
const VIEW_RAY = /* wgsl */ `
fn safeK(k : vec3f) -> vec3f { return max(abs(k), vec3f(1e-4)) * (step(vec3f(0.0), k) * 2.0 - 1.0); }
// camera-to-surface segment of the pixel through the near plane: origin, direction, length
struct Ray { o : vec3f, d : vec3f, len : f32 };
fn viewRay(px : vec2u) -> Ray {
  let uv = (vec2f(px) + 0.5) / u.size;
  var r : Ray;
  r.o = unproject(uv, 0.0);
  r.d = normalize(unproject(uv, 1.0) - r.o);
  let z = textureLoad(sceneDepth, px, 0);
  r.len = 400.0;
  if (z < 1.0) { r.len = length(unproject(uv, z) - r.o); }
  return r;
}
`;

// light shafts at half resolution: ray-marched caustic factor along the view ray (rgb) + the ray length (a, for
// the depth-aware upsample; -1 = pixel above water)
const SHAFTS = /* wgsl */ `${COMMON}
@group(0) @binding(6) var caustic : texture_2d<f32>;
@group(0) @binding(8) var sceneDepth : texture_depth_2d;
@group(0) @binding(9) var outS : texture_storage_2d<rgba16float, write>;
@group(0) @binding(10) var nearTex : texture_2d<f32>;
${VIEW_RAY}
fn causticAt(p : vec3f, d : f32, extraBlur : f32) -> vec3f {
  let shift = u.sunRefr.xz / max(-u.sunRefr.y, 0.2) * (u.causticDepth - d);
  let uvc = (p.xz + shift - u.causticOrigin) / ${CAUSTIC_WINDOW.toFixed(1)};
  let lod = clamp(abs(d - u.causticDepth) * u.causticBlur + 0.5 + extraBlur, 0.0, 7.0) + clamp(0.6 - d, 0.0, 1.0) * 3.0;
  let c = textureSampleLevel(caustic, sampClamp, uvc, lod).rgb;
  let edge = smoothstep(0.5, 0.42, max(abs(uvc.x - 0.5), abs(uvc.y - 0.5)));
  return mix(vec3f(1.0), c, edge);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id : vec3u) {
  let hsize = textureDimensions(outS);
  if (id.x >= hsize.x || id.y >= hsize.y) { return; }
  let px = min(id.xy * 2u, vec2u(u.size) - 1u);     // the full-res pixel this texel stands for
  if (textureLoad(nearTex, px, 0).r >= 0.0) { textureStore(outS, id.xy, vec4f(1.0, 1.0, 1.0, -1.0)); return; }
  let r = viewRay(px);
  let sigT = u.sigmaA + u.sigmaS;
  let kdSun = u.kd / max(-u.sunRefr.y, 0.2);
  let steps = i32(u.misc2.w);
  let tMax = min(r.len, 60.0);
  let jitter = fract(52.9829189 * fract(dot(vec2f(id.xy) + u.frame * vec2f(5.588238, 5.588238), vec2f(0.06711056, 0.00583715))));
  var acc = vec3f(0.0);
  var wsum = vec3f(0.0);
  for (var i = 0; i < steps; i++) {
    let t = tMax * (f32(i) + jitter) / f32(steps);
    let p = r.o + r.d * t;
    let d = u.seaLevel - p.y;
    let w = exp(-(sigT - kdSun * r.d.y) * t);
    let c = causticAt(p, max(d, 0.0), 0.6);
    acc += w * mix(vec3f(1.0), c, u.godrays);
    wsum += w;
  }
  // contrast of the shafts survives the averaging along the ray only partially: re-expand it
  let shafts = select(vec3f(1.0), max(vec3f(1.0) + (acc / max(wsum, vec3f(1e-5)) - 1.0) * 3.2, vec3f(0.1)), steps > 0);
  textureStore(outS, id.xy, vec4f(shafts, r.len));
}`;

const UNDERWATER = /* wgsl */ `${COMMON}
@group(0) @binding(7) var sceneColor : texture_2d<f32>;
@group(0) @binding(8) var sceneDepth : texture_depth_2d;
@group(0) @binding(9) var outA : texture_storage_2d<rgba16float, write>;
@group(0) @binding(10) var nearTex : texture_2d<f32>;
@group(0) @binding(11) var shaftTex : texture_2d<f32>;
${VIEW_RAY}
fn hg(g : f32, mu : f32) -> f32 { return (1.0 - g * g) / (4.0 * PI * pow(1.0 + g * g - 2.0 * g * mu, 1.5)); }
fn phase(mu : f32) -> f32 { return 0.85 * hg(0.9, mu) + 0.15 * hg(0.2, mu); }

// joint-bilateral upsample of the half-res shafts: bilinear weights x ray-length similarity; texels of the other
// medium (a < 0) never contribute, so nothing bleeds across rock silhouettes or the waterline
fn shaftsAt(px : vec2u, len : f32) -> vec3f {
  let hmax = vec2i(textureDimensions(shaftTex)) - 1;
  let q = vec2f(px) * 0.5;                 // half-res texel i stands for full-res pixel 2i
  let b = vec2i(floor(q));
  let f = q - floor(q);
  var acc = vec3f(0.0);
  var wsum = 0.0;
  var best = vec3f(1.0);
  var bestD = 1e9;
  for (var j = 0; j < 2; j++) {
    for (var i = 0; i < 2; i++) {
      let t = textureLoad(shaftTex, clamp(b + vec2i(i, j), vec2i(0), hmax), 0);
      if (t.a < 0.0) { continue; }
      let dd = abs(t.a - len);
      let w = select(1.0 - f.x, f.x, i == 1) * select(1.0 - f.y, f.y, j == 1) * exp(-dd / (0.03 * len + 0.05)) + 1e-6;
      acc += t.rgb * w;
      wsum += w;
      if (dd < bestD) { bestD = dd; best = t.rgb; }
    }
  }
  return select(best, acc / wsum, wsum > 1e-3);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id : vec3u) {
  let size = vec2u(u.size);
  if (id.x >= size.x || id.y >= size.y) { return; }
  var col = textureLoad(sceneColor, id.xy, 0).rgb;
  // sanitize: NaN/Inf in the scene target would spread through mips and bloom
  if (!all(col == col) || any(abs(col) > vec3f(60000.0))) { col = vec3f(0.0); }
  col = clamp(col, vec3f(0.0), vec3f(20000.0));
  let s = textureLoad(nearTex, id.xy, 0).r;
  if (s >= 0.0) { textureStore(outA, id.xy, vec4f(col, 1.0)); return; }

  let r = viewRay(id.xy);
  let dir = r.d;
  let dist = r.len;
  let sigT = u.sigmaA + u.sigmaS;
  let depth0 = max(u.seaLevel - r.o.y, 0.0);
  let T = exp(-sigT * dist);
  // ambient (closed form)
  let kA = safeK(sigT - u.kd * dir.y);
  let amb = u.sigmaS * u.ambient * exp(-u.kd * depth0) * (1.0 - exp(-kA * dist)) / kA * u.msBoost * 0.25;
  // sun: closed form, modulated by the caustic shafts (half-res march)
  let cosR = max(-u.sunRefr.y, 0.2);
  let kdSun = u.kd / cosR;
  let mu = dot(-dir, u.sunRefr);   // light travels along sunRefr, scatters towards the camera (-dir)
  let ph = phase(mu);
  let kS = safeK(sigT - kdSun * dir.y);
  let sunClosed = u.sigmaS * ph * u.sunColor * exp(-kdSun * depth0) * (1.0 - exp(-kS * dist)) / kS;
  var L = col * T + amb + sunClosed * shaftsAt(id.xy, dist);
  if (u.misc2.z > 0.5) { L = mix(L, vec3f(2.0, 0.0, 0.0), 0.35); }
  textureStore(outA, id.xy, vec4f(L, 1.0));
}`

// backdrop for the water material (refraction): opaque scene colour + linear view depth in alpha. One copy
// per frame instead of three.js's viewport copies, which restart the scene pass for every sampling node.
const BACKDROP = /* wgsl */ `
@group(0) @binding(0) var<uniform> nf : vec4f;   // near, far
@group(0) @binding(1) var sceneColor : texture_2d<f32>;
@group(0) @binding(2) var sceneDepth : texture_depth_2d;
@group(0) @binding(3) var dst : texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id : vec3u) {
  let d = textureDimensions(dst);
  if (id.x >= d.x || id.y >= d.y) { return; }
  let z = textureLoad(sceneDepth, id.xy, 0);
  let viewZ = nf.x * nf.y / (nf.y - (nf.y - nf.x) * z);
  let c = clamp(textureLoad(sceneColor, id.xy, 0).rgb, vec3f(0.0), vec3f(60000.0));
  textureStore(dst, id.xy, vec4f(c, min(viewZ, 60000.0)));
}`;

const MIP = /* wgsl */ `
@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var dst : texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var samp : sampler;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id : vec3u) {
  let d = textureDimensions(dst);
  if (id.x >= d.x || id.y >= d.y) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(d);
  textureStore(dst, id.xy, textureSampleLevel(src, samp, uv, 0.0));
}`;

const LENS_SIM = /* wgsl */ `${COMMON}
@group(0) @binding(6) var stateIn : texture_2d<f32>;
@group(0) @binding(7) var stateOut : texture_storage_2d<rgba16float, write>;
@group(0) @binding(8) var<storage, read> drops : array<vec4f>;
@group(0) @binding(10) var nearTex : texture_2d<f32>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id : vec3u) {
  let size = textureDimensions(stateOut);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  let dt = u.misc.x;
  let prev = textureLoad(stateIn, id.xy, 0);
  let s = textureLoad(nearTex, min(id.xy * 2u, vec2u(u.size) - 1u), 0).r;
  var film = 0.0;
  var wet = prev.g;
  if (s < 0.0) {
    film = 1.0;
    wet = 1.0;
  } else {
    // gravity drains the film: semi-Lagrangian advection along screen-space "down", thick film flows faster;
    // per-column speed noise breaks the front into fingers
    let cx = uv.x * 38.0;
    let c0 = hash12(vec2f(floor(cx), 3.0)); let c1 = hash12(vec2f(floor(cx) + 1.0, 3.0));
    let colNoise = 0.6 + 0.8 * mix(c0, c1, smoothstep(0.0, 1.0, fract(cx)));
    let v = u.down * u.misc.w * (0.15 + prev.r * prev.r) * colNoise;
    let src = uv - v * dt;
    film = textureSampleLevel(stateIn, sampClamp, src, 0.0).r * exp(-dt / u.filmTau);
    if (src.y < 0.0 || src.y > 1.0) { film = 0.0; }
    wet = max(wet * exp(-dt / u.misc2.x), film);
  }
  // droplets (CPU-simulated list): spherical caps, normalised height
  let aspect = f32(size.x) / f32(size.y);
  var h = 0.0;
  let n = u32(u.dropCount);
  for (var i = 0u; i < n; i++) {
    let dr = drops[i];
    let dv = (uv - dr.xy) * vec2f(aspect, 1.0);
    let r = dr.z;
    let q = dot(dv, dv);
    if (q < r * r) { h = max(h, sqrt(r * r - q) * dr.w); }
  }
  textureStore(stateOut, id.xy, vec4f(film, wet, h, s));
}`;

const LENS = /* wgsl */ `${COMMON}
@group(0) @binding(6) var colorA : texture_2d<f32>;
@group(0) @binding(7) var state : texture_2d<f32>;
@group(0) @binding(8) var outB : texture_storage_2d<rgba16float, write>;
@group(0) @binding(10) var nearTex : texture_2d<f32>;

// tiny static beads left on the lens by the drained film (procedural, fade with wetness)
fn beads(uv : vec2f, wet : f32, scale : f32, seed : f32) -> f32 {
  let aspect = u.size.x / u.size.y;
  let p = uv * vec2f(aspect, 1.0) * scale;
  let cell = floor(p);
  var h = 0.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let c = cell + vec2f(f32(i), f32(j));
      let present = hash12(c * 1.7 + seed);
      if (present > wet * u.misc2.y) { continue; }
      let rnd = hash22(c + seed);
      let center = c + 0.2 + 0.6 * rnd;
      let r = (0.12 + 0.3 * hash12(c + 11.0 + seed)) * sqrt(wet);
      let d = length(p - center);
      if (d < r) { h = max(h, sqrt(r * r - d * d) / scale); }
    }
  }
  return h;
}

// thickness of water on the lens (screen-height units); .x = total, .y = drop/bead part (lens-like)
fn lensHeight(uv : vec2f, sd : f32, band : f32) -> vec2f {
  let st = textureSampleLevel(state, sampClamp, uv, 0.0);
  var h = 0.0;
  var d = 0.0;
  if (sd > 0.0) {
    let m = band * 0.5 * exp(-sd / band);                       // meniscus climbing the lens
    h += m;
    h += st.r * 0.0008;                                          // thin draining sheet
    // beads are exactly zero on a dry lens (no cell present, zero radius): skip the 2 x 9 cells
    if (st.g > 0.0) { d += beads(uv, st.g, 60.0, 0.0) + beads(uv, st.g * 0.6, 130.0, 7.0); }
    d += st.b;                                                   // droplets
    h += d;
  }
  return vec2f(h, d);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id : vec3u) {
  let size = vec2u(u.size);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let px = 1.0 / u.size;
  let uv = (vec2f(id.xy) + 0.5) * px;
  // waterline: exact sign test + signed distance in screen-height units from the local gradient
  let s0 = textureLoad(nearTex, id.xy, 0).r;
  // wide central stencil: s is smooth across the screen (the near plane is ~7 cm wide) but tiny 1-px
  // differences drown in half-float noise
  let st = 0.02;
  let sx = textureSampleLevel(state, sampClamp, uv + vec2f(st, 0.0), 0.0).a - textureSampleLevel(state, sampClamp, uv - vec2f(st, 0.0), 0.0).a;
  let sy = textureSampleLevel(state, sampClamp, uv + vec2f(0.0, st), 0.0).a - textureSampleLevel(state, sampClamp, uv - vec2f(0.0, st), 0.0).a;
  let g = vec2f(sx * (u.size.x / u.size.y), sy) / (2.0 * st);
  let gl = max(length(g), 1e-6);
  let sd = s0 / gl;                       // >0 above the waterline, in screen-height units
  let band = u.lens.x;
  // lens water height and its gradient (neighbours use the linearised waterline distance)
  let e = px.y * 1.5;
  let H0 = lensHeight(uv, sd, band);
  let h0 = H0.x;
  let hx = lensHeight(uv + vec2f(e * u.size.y / u.size.x, 0.0), sd + g.x * e * (u.size.y / u.size.x) / gl, band).x;
  let hy = lensHeight(uv + vec2f(0.0, e), sd + g.y * e / gl, band).x;
  let grad = vec2f(hx - h0, hy - h0) / e;
  let steep = length(grad);
  let film = textureSampleLevel(state, sampClamp, uv, 0.0).r * step(0.0, sd);
  var col = textureSampleLevel(colorA, sampClamp, uv, 0.0).rgb;
  if (h0 > 1e-5 || abs(sd) < band * 3.0) {
    // refraction through the water on the lens (drops act as small lenses: strong, inverted, blurred)
    let dropness = saturate(H0.y * 300.0);
    let k = mix(u.lens2.w, u.lens2.x, dropness);
    let off = grad * k * vec2f(u.size.y / u.size.x, 1.0);
    let lod = min(H0.y * u.lens2.y * 250.0 + film * 0.8 + saturate(1.0 - sd / (band * 2.0)) * 1.2, 4.0);
    let r = textureSampleLevel(colorA, sampClamp, uv + off * 1.03, lod).r;
    let gg = textureSampleLevel(colorA, sampClamp, uv + off, lod).g;
    let b = textureSampleLevel(colorA, sampClamp, uv + off * 0.97, lod).b;
    col = vec3f(r, gg, b) * (1.0 + film * 0.05);
    // rims go dark (grazing refraction / total internal reflection), with a highlight on the upper edge
    let rim = smoothstep(0.25, 1.4, steep);
    col *= 1.0 - u.lens2.z * rim;
    let n = normalize(vec3f(-grad * 0.8, 1.0));
    let l = normalize(vec3f(-0.25, -0.75, 0.6));
    let spec = pow(max(dot(n, l), 0.0), 60.0) * saturate(steep * 3.0);
    col += spec * u.lens.w * (u.sunColor * 0.02 + vec3f(0.6));
  }
  // dark line where the water surface meets the lens (meniscus seen edge-on), slightly on the water side
  let lineD = (sd + band * 0.15) / (band * 0.22);
  col *= 1.0 - u.lens.z * exp(-lineD * lineD);
  textureStore(outB, id.xy, vec4f(col, 1.0));
}`;

const BLOOM_DOWN = /* wgsl */ `
@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var dst : texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var samp : sampler;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id : vec3u) {
  let d = textureDimensions(dst);
  if (id.x >= d.x || id.y >= d.y) { return; }
  let ts = 1.0 / vec2f(textureDimensions(src));
  let uv = (vec2f(id.xy) + 0.5) / vec2f(d);
  let a = textureSampleLevel(src, samp, uv + ts * vec2f(-2, -2), 0.0).rgb; let b = textureSampleLevel(src, samp, uv + ts * vec2f(0, -2), 0.0).rgb;
  let c = textureSampleLevel(src, samp, uv + ts * vec2f(2, -2), 0.0).rgb; let dd = textureSampleLevel(src, samp, uv + ts * vec2f(-2, 0), 0.0).rgb;
  let e = textureSampleLevel(src, samp, uv, 0.0).rgb; let f = textureSampleLevel(src, samp, uv + ts * vec2f(2, 0), 0.0).rgb;
  let g = textureSampleLevel(src, samp, uv + ts * vec2f(-2, 2), 0.0).rgb; let h = textureSampleLevel(src, samp, uv + ts * vec2f(0, 2), 0.0).rgb;
  let i = textureSampleLevel(src, samp, uv + ts * vec2f(2, 2), 0.0).rgb; let j = textureSampleLevel(src, samp, uv + ts * vec2f(-1, -1), 0.0).rgb;
  let k = textureSampleLevel(src, samp, uv + ts * vec2f(1, -1), 0.0).rgb; let l = textureSampleLevel(src, samp, uv + ts * vec2f(-1, 1), 0.0).rgb;
  let m = textureSampleLevel(src, samp, uv + ts * vec2f(1, 1), 0.0).rgb;
  var o = e * 0.125 + (a + c + g + i) * 0.03125 + (b + dd + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  o = min(o, vec3f(2000.0));
  textureStore(dst, id.xy, vec4f(o, 1.0));
}`;

const BLOOM_UP = /* wgsl */ `
@group(0) @binding(0) var low : texture_2d<f32>;
@group(0) @binding(1) var high : texture_2d<f32>;
@group(0) @binding(2) var dst : texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var samp : sampler;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id : vec3u) {
  let d = textureDimensions(dst);
  if (id.x >= d.x || id.y >= d.y) { return; }
  let ts = 1.0 / vec2f(textureDimensions(low));
  let uv = (vec2f(id.xy) + 0.5) / vec2f(d);
  var s = textureSampleLevel(low, samp, uv, 0.0).rgb * 4.0;
  s += (textureSampleLevel(low, samp, uv + vec2f(-ts.x, 0), 0.0).rgb + textureSampleLevel(low, samp, uv + vec2f(ts.x, 0), 0.0).rgb + textureSampleLevel(low, samp, uv + vec2f(0, -ts.y), 0.0).rgb + textureSampleLevel(low, samp, uv + vec2f(0, ts.y), 0.0).rgb) * 2.0;
  s += textureSampleLevel(low, samp, uv + ts, 0.0).rgb + textureSampleLevel(low, samp, uv - ts, 0.0).rgb + textureSampleLevel(low, samp, uv + vec2f(ts.x, -ts.y), 0.0).rgb + textureSampleLevel(low, samp, uv + vec2f(-ts.x, ts.y), 0.0).rgb;
  let o = textureLoad(high, id.xy, 0).rgb + s / 16.0;
  textureStore(dst, id.xy, vec4f(o, 1.0));
}`;

const EXPOSURE = /* wgsl */ `
struct E { value : f32, goal : f32, pad0 : f32, pad1 : f32 };
struct EU { dt : f32, speed : f32, key : f32, minEv : f32, maxEv : f32, manual : f32, enabled : f32, pad : f32 };
@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> ex : E;
@group(0) @binding(2) var<uniform> eu : EU;
var<workgroup> sums : array<f32, 256>;
var<workgroup> wts : array<f32, 256>;
@compute @workgroup_size(16, 16, 1)
fn main(@builtin(local_invocation_index) li : u32) {
  let d = textureDimensions(src);
  var s = 0.0;
  var n = 0.0;
  for (var y = li / 16u; y < d.y; y += 16u) {
    for (var x = li % 16u; x < d.x; x += 16u) {
      let c = textureLoad(src, vec2u(x, y), 0).rgb;
      // centre-weighted metering
      let uv = (vec2f(f32(x), f32(y)) + 0.5) / vec2f(d) - 0.5;
      let w = 1.0 - 0.6 * saturate(length(uv) * 1.6);
      s += log(max(dot(c, vec3f(0.2126, 0.7152, 0.0722)), 1e-4)) * w;
      n += w;
    }
  }
  sums[li] = s;
  wts[li] = n;
  workgroupBarrier();
  if (li == 0u) {
    var t = 0.0;
    var tw = 0.0;
    for (var i = 0u; i < 256u; i++) { t += sums[i]; tw += wts[i]; }
    let avg = exp(t / max(tw, 1e-6));
    let goal = clamp(eu.key / avg, exp2(eu.minEv), exp2(eu.maxEv));
    ex.goal = goal;
    if (eu.enabled < 0.5) { ex.value = eu.manual; return; }
    if (ex.value <= 0.0 || eu.dt <= 0.0) { ex.value = goal; return; }
    // adapt in log space
    let a = 1.0 - exp(-eu.dt * eu.speed);
    ex.value = exp(mix(log(ex.value), log(goal), a));
  }
}`;

const OUTPUT = /* wgsl */ `${COMMON}
@group(0) @binding(6) var colorB : texture_2d<f32>;
@group(0) @binding(7) var bloomTex : texture_2d<f32>;
@group(0) @binding(8) var<storage, read> ex : vec4f;
struct VO { @builtin(position) pos : vec4f, @location(0) uv : vec2f };
@vertex fn vs(@builtin(vertex_index) i : u32) -> VO {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o : VO;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}
fn agxContrast(x : vec3f) -> vec3f {
  let x2 = x * x; let x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
fn agx(c0 : vec3f) -> vec3f {
  let toRec2020 = mat3x3f(vec3f(0.6274, 0.0691, 0.0164), vec3f(0.3293, 0.9195, 0.0880), vec3f(0.0433, 0.0113, 0.8956));
  let fromRec2020 = mat3x3f(vec3f(1.6605, -0.1246, -0.0182), vec3f(-0.5876, 1.1329, -0.1006), vec3f(-0.0728, -0.0083, 1.1187));
  let inset = mat3x3f(vec3f(0.856627153315983, 0.137318972929847, 0.11189821299995), vec3f(0.0951212405381588, 0.761241990602591, 0.0767994186031903), vec3f(0.0482516061458583, 0.101439036467562, 0.811302368396859));
  let outset = mat3x3f(vec3f(1.1271005818144368, -0.1413297634984383, -0.14132976349843826), vec3f(-0.11060664309660323, 1.157823702216272, -0.11060664309660294), vec3f(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
  var c = inset * (toRec2020 * c0);
  c = log2(max(c, vec3f(1e-10)));
  c = clamp((c + 12.47393) / (4.026069 + 12.47393), vec3f(0.0), vec3f(1.0));
  c = agxContrast(c);
  c = outset * c;
  c = pow(max(c, vec3f(0.0)), vec3f(2.2));
  return clamp(fromRec2020 * c, vec3f(0.0), vec3f(1.0));
}
fn toSrgb(c : vec3f) -> vec3f {
  return select(1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3f(0.0031308));
}
@fragment fn fs(i : VO) -> @location(0) vec4f {
  // the render target may be supersampled: 4 bilinear taps around the pixel centre
  let ts = 0.25 / vec2f(textureDimensions(colorB));
  var c = (textureSampleLevel(colorB, sampClamp, i.uv + vec2f(-ts.x, -ts.y), 0.0).rgb + textureSampleLevel(colorB, sampClamp, i.uv + vec2f(ts.x, -ts.y), 0.0).rgb
         + textureSampleLevel(colorB, sampClamp, i.uv + vec2f(-ts.x, ts.y), 0.0).rgb + textureSampleLevel(colorB, sampClamp, i.uv + vec2f(ts.x, ts.y), 0.0).rgb) * 0.25;
  let bl = textureSampleLevel(bloomTex, sampClamp, i.uv, 0.0).rgb;
  c = mix(c, bl, u.bloom);
  c *= ex.x * u.exposure;
  var o = agx(c);
  let v = i.uv - 0.5;
  o *= 1.0 - u.misc.y * dot(v, v) * 1.6;
  let n = hash12(i.pos.xy + fract(u.time * 13.7) * 571.0) - 0.5;
  o += n * u.misc.z;
  return vec4f(toSrgb(max(o, vec3f(0.0))), 1.0);
}`;

export class Post {
  constructor(device, ocean, canvasFormat) {
    this.device = device;
    this.ocean = ocean;
    this.format = canvasFormat;
    this.uniform = device.createBuffer({ size: UNIFORM_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.uData = new Float32Array(UNIFORM_SIZE / 4);
    this.sampWrap = device.createSampler({ addressModeU: "repeat", addressModeV: "repeat", magFilter: "linear", minFilter: "linear" });
    this.sampClamp = device.createSampler({ addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", magFilter: "linear", minFilter: "linear", mipmapFilter: "linear" });
    this.drops = device.createBuffer({ size: MAX_DROPS * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.exposureBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    this.exposureU = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const cp = (code, label) => device.createComputePipeline({ label, layout: "auto", compute: { module: device.createShaderModule({ label, code }), entryPoint: "main" } });
    this.pUnder = cp(UNDERWATER, "underwater");
    this.pShafts = cp(SHAFTS, "shafts");
    this.pNearS = cp(NEAR_S, "nearS");
    this.pBackdrop = cp(BACKDROP, "backdrop");
    this.backdropU = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.pMip = cp(MIP, "mip");
    this.pLensSim = cp(LENS_SIM, "lensSim");
    this.pLens = cp(LENS, "lens");
    this.pDown = cp(BLOOM_DOWN, "bloomDown");
    this.pUp = cp(BLOOM_UP, "bloomUp");
    this.pExposure = cp(EXPOSURE, "exposure");
    const om = device.createShaderModule({ label: "output", code: OUTPUT });
    this.pOut = device.createRenderPipeline({ label: "output", layout: "auto", vertex: { module: om, entryPoint: "vs" }, fragment: { module: om, entryPoint: "fs", targets: [{ format: canvasFormat }] }, primitive: { topology: "triangle-list" } });
    this.frame = 0;
    this.width = 0;
    this.height = 0;
    this.stateFlip = 0;
  }

  /** owned targets for a w x h scene; call bindScene() once the scene colour / depth GPU textures exist */
  resize(w, h) {
    const d = this.device;
    this.width = w; this.height = h;
    const U = GPUTextureUsage;
    const tex = (label, ww, hh, mips = 1) => d.createTexture({ label, size: [ww, hh], format: "rgba16float", mipLevelCount: mips, usage: U.TEXTURE_BINDING | U.STORAGE_BINDING | U.COPY_SRC });
    for (const t of this.owned || []) t.destroy();
    this.texA = tex("post.A", w, h, A_MIPS);
    this.texB = tex("post.B", w, h);
    this.backdrop = tex("water.backdrop", w, h);
    this.nearTex = d.createTexture({ label: "nearS", size: [w, h], format: "r32float", usage: U.TEXTURE_BINDING | U.STORAGE_BINDING | U.COPY_SRC });
    const hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1);
    this.state = [tex("lens.state0", hw, hh), tex("lens.state1", hw, hh)];
    this.shafts = tex("shafts", hw, hh);
    this.bloomDown = [];
    this.bloomUp = [];
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const bw = Math.max(1, w >> (i + 1)), bh = Math.max(1, h >> (i + 1));
      this.bloomDown.push(tex(`bloom.down${i}`, bw, bh));
      this.bloomUp.push(tex(`bloom.up${i}`, bw, bh));
    }
    this.owned = [this.texA, this.texB, this.backdrop, this.nearTex, this.shafts, ...this.state, ...this.bloomDown, ...this.bloomUp];

    // uniform + clamp sampler + the nearS texture (layout "auto" only has the bindings a shader uses)
    const base = [{ binding: 0, resource: { buffer: this.uniform } }, { binding: 2, resource: this.sampClamp }, { binding: 10, resource: this.nearTex.createView() }];
    const bg = (p, extra, skip = []) => d.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [...base.filter(e => !skip.includes(e.binding)), ...extra] });
    this.bg = bg;
    this.bgNearS = d.createBindGroup({ layout: this.pNearS.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.uniform } }, { binding: 1, resource: this.sampWrap },
      ...this.ocean.disp.map((t, c) => ({ binding: 3 + c, resource: t.createView() })),
      { binding: 9, resource: this.nearTex.createView() }] });
    this.mipJobs = [];
    for (let l = 1; l < A_MIPS; l++)
      this.mipJobs.push({ w: Math.max(1, w >> l), h: Math.max(1, h >> l), bg: d.createBindGroup({ layout: this.pMip.getBindGroupLayout(0), entries: [
        { binding: 0, resource: this.texA.createView({ baseMipLevel: l - 1, mipLevelCount: 1 }) },
        { binding: 1, resource: this.texA.createView({ baseMipLevel: l, mipLevelCount: 1 }) },
        { binding: 2, resource: this.sampClamp }] }) });
    this.bgLensSim = [0, 1].map(i => bg(this.pLensSim, [
      { binding: 6, resource: this.state[i].createView() },
      { binding: 7, resource: this.state[1 - i].createView() },
      { binding: 8, resource: { buffer: this.drops } }]));
    this.bgLens = [0, 1].map(i => bg(this.pLens, [
      { binding: 6, resource: this.texA.createView() },
      { binding: 7, resource: this.state[1 - i].createView() },
      { binding: 8, resource: this.texB.createView() }]));
    this.bloomJobs = [];
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const src = i === 0 ? this.texB : this.bloomDown[i - 1];
      this.bloomJobs.push({ p: this.pDown, w: this.bloomDown[i].width, h: this.bloomDown[i].height, bg: d.createBindGroup({ layout: this.pDown.getBindGroupLayout(0), entries: [
        { binding: 0, resource: src.createView() }, { binding: 1, resource: this.bloomDown[i].createView() }, { binding: 2, resource: this.sampClamp }] }) });
    }
    for (let i = BLOOM_LEVELS - 2; i >= 0; i--) {
      const low = i === BLOOM_LEVELS - 2 ? this.bloomDown[BLOOM_LEVELS - 1] : this.bloomUp[i + 1];
      this.bloomJobs.push({ p: this.pUp, w: this.bloomUp[i].width, h: this.bloomUp[i].height, bg: d.createBindGroup({ layout: this.pUp.getBindGroupLayout(0), entries: [
        { binding: 0, resource: low.createView() }, { binding: 1, resource: this.bloomDown[i].createView() }, { binding: 2, resource: this.bloomUp[i].createView() }, { binding: 3, resource: this.sampClamp }] }) });
    }
    this.bgExposure = d.createBindGroup({ layout: this.pExposure.getBindGroupLayout(0), entries: [
      { binding: 0, resource: this.bloomDown[4].createView() }, { binding: 1, resource: { buffer: this.exposureBuf } }, { binding: 2, resource: { buffer: this.exposureU } }] });
    this.bgOut = d.createBindGroup({ layout: this.pOut.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.uniform } }, { binding: 2, resource: this.sampClamp },
      { binding: 6, resource: this.texB.createView() }, { binding: 7, resource: this.bloomUp[0].createView() }, { binding: 8, resource: { buffer: this.exposureBuf } }] });
    d.queue.writeBuffer(this.exposureBuf, 0, new Float32Array([0, 0, 0, 0]));
    this.bgUnder = this.bgBackdrop = null;
  }

  /** bind the three.js scene colour + depth (after the first render into a new target) */
  bindScene(sceneColorGPU, sceneDepthGPU) {
    const d = this.device;
    this.bgShafts = this.bg(this.pShafts, [
      { binding: 6, resource: this.ocean.caustics.texture.createView() },
      { binding: 8, resource: sceneDepthGPU.createView({ aspect: "depth-only" }) },
      { binding: 9, resource: this.shafts.createView() }]);
    this.bgUnder = this.bg(this.pUnder, [
      { binding: 7, resource: sceneColorGPU.createView() },
      { binding: 8, resource: sceneDepthGPU.createView({ aspect: "depth-only" }) },
      { binding: 9, resource: this.texA.createView({ baseMipLevel: 0, mipLevelCount: 1 }) },
      { binding: 11, resource: this.shafts.createView() }], [2]);
    this.bgBackdrop = d.createBindGroup({ layout: this.pBackdrop.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.backdropU } },
      { binding: 1, resource: sceneColorGPU.createView() },
      { binding: 2, resource: sceneDepthGPU.createView({ aspect: "depth-only" }) },
      { binding: 3, resource: this.backdrop.createView() }] });
  }

  /** copy the opaque scene (colour + linear depth) for the water material; between the scene and water renders */
  copyBackdrop(encoder, camera) {
    this.device.queue.writeBuffer(this.backdropU, 0, new Float32Array([camera.near, camera.far, 0, 0]));
    const pass = encoder.beginComputePass({ label: "copy" });
    pass.setPipeline(this.pBackdrop);
    pass.setBindGroup(0, this.bgBackdrop);
    pass.dispatchWorkgroups(Math.ceil(this.width / 8), Math.ceil(this.height / 8));
    pass.end();
  }

  setDrops(arr, count) {
    this.dropCount = Math.min(count, MAX_DROPS);
    if (this.dropCount) this.device.queue.writeBuffer(this.drops, 0, arr, 0, this.dropCount * 4);
  }

  writeUniforms(camera, P, sun, oceanUniforms, dt, time) {
    const f = this.uData;
    camera.updateMatrixWorld();
    const vp = camera.projectionMatrix.clone().multiply(camera.matrixWorldInverse);
    const ivp = vp.clone().invert();
    f.set(ivp.elements, 0);
    f.set(vp.elements, 16);
    const fwd = camera.getWorldDirection(camera.position.clone());
    const U = oceanUniforms;
    const put = (o, v3, w) => { f[o] = v3.x ?? v3.r; f[o + 1] = v3.y ?? v3.g; f[o + 2] = v3.z ?? v3.b; f[o + 3] = w; };
    put(32, camera.position, camera.near);
    put(36, fwd, camera.far);
    put(40, sun.dir, time);
    put(44, sun.color, P.seaLevel);
    put(48, U.sunRefr.value, P.causticDepth);
    put(52, sun.ambient, P.msBoost);
    put(56, { x: P.sigmaA[0], y: P.sigmaA[1], z: P.sigmaA[2] }, P.causticStrength);
    put(60, { x: P.sigmaS[0], y: P.sigmaS[1], z: P.sigmaS[2] }, P.causticBlur);
    put(64, U.kd.value, P.godrays);
    f.set([CASCADES[0].L, CASCADES[1].L, CASCADES[2].L, 0], 68);
    f.set([...this.ocean.caustics.origin, this.width, this.height], 72);
    f.set([P.exposure, P.autoExposure ? 1 : 0, P.bloom, this.frame], 76);
    f.set([P.bandWidth, P.meniscusRefract, P.waterlineDark, P.highlight], 80);
    f.set([P.dropRefract, P.dropBlur, P.rimDark, P.filmRefract], 84);
    f.set([dt, P.vignette, P.grain, P.drainSpeed], 88);
    f.set([this.down[0], this.down[1], this.dropCount || 0, P.filmTau], 92);
    f.set([P.wetTau, P.beadDensity, P.debugMask ? 1 : 0, P.godraySteps], 96);
    this.device.queue.writeBuffer(this.uniform, 0, f);
    this.device.queue.writeBuffer(this.exposureU, 0, new Float32Array([dt, P.adaptSpeed, P.exposureKey, -6, 6, 1, P.autoExposure ? 1 : 0, 0]));
  }

  /** screen-space gravity: world down projected at the screen centre (the lens drops need it before prepare()) */
  updateDown(camera) {
    const c = camera.position.clone().add(camera.getWorldDirection(camera.position.clone()).multiplyScalar(2));
    const a = c.clone().project(camera), b = c.clone().setY(c.y - 0.2).project(camera);
    const dx = b.x - a.x, dy = -(b.y - a.y), l = Math.hypot(dx, dy) || 1;
    this.down = [dx / l, dy / l];
  }

  /** per-frame uniforms + the nearS pass, before the scene render (the water material reads nearTex) */
  prepare(encoder, camera, P, sun, oceanUniforms, dt, time) {
    this.writeUniforms(camera, P, sun, oceanUniforms, dt, time);
    const pass = encoder.beginComputePass({ label: "nearS" });
    pass.setPipeline(this.pNearS);
    pass.setBindGroup(0, this.bgNearS);
    pass.dispatchWorkgroups(Math.ceil(this.width / 8), Math.ceil(this.height / 8));
    pass.end();
  }

  render(encoder, canvasView) {
    const W = this.width, H = this.height;
    const g8 = (n) => Math.ceil(n / 8);
    let pass = encoder.beginComputePass({ label: "shafts" });
    pass.setPipeline(this.pShafts);
    pass.setBindGroup(0, this.bgShafts);
    pass.dispatchWorkgroups(g8(this.shafts.width), g8(this.shafts.height));
    pass.end();
    pass = encoder.beginComputePass({ label: "underwater" });
    pass.setPipeline(this.pUnder);
    pass.setBindGroup(0, this.bgUnder);
    pass.dispatchWorkgroups(g8(W), g8(H));
    pass.end();
    pass = encoder.beginComputePass({ label: "mips" });
    pass.setPipeline(this.pMip);
    for (const j of this.mipJobs) { pass.setBindGroup(0, j.bg); pass.dispatchWorkgroups(g8(j.w), g8(j.h)); }
    pass.end();
    const i = this.stateFlip;
    pass = encoder.beginComputePass({ label: "lens sim" });
    pass.setPipeline(this.pLensSim);
    pass.setBindGroup(0, this.bgLensSim[i]);
    pass.dispatchWorkgroups(g8(this.state[0].width), g8(this.state[0].height));
    pass.end();
    pass = encoder.beginComputePass({ label: "lens" });
    pass.setPipeline(this.pLens);
    pass.setBindGroup(0, this.bgLens[i]);
    pass.dispatchWorkgroups(g8(W), g8(H));
    pass.end();
    this.stateFlip = 1 - i;
    pass = encoder.beginComputePass({ label: "bloom+exposure" });
    for (const j of this.bloomJobs) { pass.setPipeline(j.p); pass.setBindGroup(0, j.bg); pass.dispatchWorkgroups(g8(j.w), g8(j.h)); }
    pass.setPipeline(this.pExposure);
    pass.setBindGroup(0, this.bgExposure);
    pass.dispatchWorkgroups(1);
    pass.end();
    const rp = encoder.beginRenderPass({ label: "output", colorAttachments: [{ view: canvasView, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }] });
    rp.setPipeline(this.pOut);
    rp.setBindGroup(0, this.bgOut);
    rp.draw(3);
    rp.end();
    this.frame++;
  }
}
