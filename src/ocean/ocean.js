// GPU FFT ocean (Tessendorf) in raw WGSL on the WebGPURenderer's device.
//
// Per frame: spectrum(t) -> IFFT rows -> IFFT columns -> assemble (+ Jacobian foam) -> mips -> caustics.
// Outputs, per cascade c (all rgba16float, 256x256, wrap):
//   disp[c]  = (Dx, Dy, Dz, dDx/dz)            displacement, choppiness already applied
//   deriv[c] = (dDy/dx, dDy/dz, dDx/dx, dDz/dz)  slopes, mipmapped
//   foam[c]  = (foam, jacobian, (dDy/dx)^2, (dDy/dz)^2)   second moments for LEAN-style specular AA, mipmapped
// The same textures are sampled by the water mesh (TSL), the post pass (WGSL, waterline test) and the
// async CPU readback (heightAt) - one wave function everywhere.
import { buildH0, significantHeight } from "./spectrum.js";
import { Caustics } from "./caustics.js";

export const N = 256;
export const CASCADES = [
  { L: 250, kMin: 0, kMax: (2 * Math.PI * 6) / 37 },
  { L: 37, kMin: (2 * Math.PI * 6) / 37, kMax: (2 * Math.PI * 6) / 7.3 },
  { L: 7.3, kMin: (2 * Math.PI * 6) / 7.3, kMax: 1e9 },
];
const NC = CASCADES.length;
const MIPS = Math.log2(N) + 1;

const COMMON = /* wgsl */ `
const N : u32 = ${N}u;
const PI : f32 = 3.14159265358979;
struct Params {
  time : f32, choppy : f32, dt : f32, foamDecay : f32,
  foamBias : f32, foamGain : f32, pad0 : f32, pad1 : f32,
  L : vec4f,
};
@group(0) @binding(0) var<uniform> P : Params;
fn cmul(a : vec2f, b : vec2f) -> vec2f { return vec2f(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
fn fieldIndex(c : u32, f : u32, x : u32, y : u32) -> u32 { return ((c * 4u + f) * N + y) * N + x; }
`;

const SPECTRUM = /* wgsl */ `${COMMON}
@group(0) @binding(1) var<storage, read> h0 : array<vec4f>;
@group(0) @binding(2) var<storage, read_write> spec : array<vec2f>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id : vec3u) {
  let x = id.x; let y = id.y; let c = id.z;
  let Lc = P.L[c];
  let k = vec2f(f32(i32(x) - i32(N / 2u)), f32(i32(y) - i32(N / 2u))) * (2.0 * PI / Lc);
  let kl = length(k);
  var f0 = vec2f(0.0); var f1 = vec2f(0.0); var f2 = vec2f(0.0); var f3 = vec2f(0.0);
  if (kl > 1e-6) {
    let H = h0[(c * N + y) * N + x];
    let w = sqrt(9.81 * kl);
    let ph = w * P.time;
    let e = vec2f(cos(ph), sin(ph));
    let h = cmul(H.xy, e) + cmul(H.zw, vec2f(e.x, -e.y));
    let ih = vec2f(-h.y, h.x);
    let dx = -(k.x / kl) * ih;      // Dx~
    let dz = -(k.y / kl) * ih;      // Dz~
    let dyx = k.x * ih;             // dDy/dx~
    let dyz = k.y * ih;             // dDy/dz~
    let dxx = -(k.x * k.x / kl) * h;
    let dzz = -(k.y * k.y / kl) * h;
    let dxz = -(k.x * k.y / kl) * h;
    // pack two real fields as A + iB
    f0 = vec2f(dx.x - dz.y, dx.y + dz.x);
    f1 = vec2f(h.x - dxz.y, h.y + dxz.x);
    f2 = vec2f(dyx.x - dyz.y, dyx.y + dyz.x);
    f3 = vec2f(dxx.x - dzz.y, dxx.y + dzz.x);
  }
  spec[fieldIndex(c, 0u, x, y)] = f0;
  spec[fieldIndex(c, 1u, x, y)] = f1;
  spec[fieldIndex(c, 2u, x, y)] = f2;
  spec[fieldIndex(c, 3u, x, y)] = f3;
}`;

// radix-2 in-place DIT IFFT of one line (all 4 packed fields) in workgroup memory
const FFT = /* wgsl */ `${COMMON}
override HORIZONTAL : bool = true;
@group(0) @binding(1) var<storage, read_write> spec : array<vec2f>;
var<workgroup> buf : array<vec2f, ${4 * N}>;
fn addr(c : u32, f : u32, line : u32, e : u32) -> u32 {
  if (HORIZONTAL) { return fieldIndex(c, f, e, line); }
  return fieldIndex(c, f, line, e);
}
@compute @workgroup_size(${N / 2}, 1, 1)
fn main(@builtin(workgroup_id) wid : vec3u, @builtin(local_invocation_index) li : u32) {
  let line = wid.x; let c = wid.y;
  for (var f = 0u; f < 4u; f++) {
    for (var r = 0u; r < 2u; r++) {
      let e = li + r * ${N / 2}u;
      buf[f * N + (reverseBits(e) >> ${32 - Math.log2(N)}u)] = spec[addr(c, f, line, e)];
    }
  }
  workgroupBarrier();
  for (var s = 0u; s < ${Math.log2(N)}u; s++) {
    let half = 1u << s;
    let pos = li & (half - 1u);
    let i0 = ((li >> s) << (s + 1u)) + pos;
    let i1 = i0 + half;
    let ang = PI * f32(pos) / f32(half);
    let w = vec2f(cos(ang), sin(ang));
    for (var f = 0u; f < 4u; f++) {
      let a = buf[f * N + i0];
      let b = cmul(w, buf[f * N + i1]);
      buf[f * N + i0] = a + b;
      buf[f * N + i1] = a - b;
    }
    workgroupBarrier();
  }
  for (var f = 0u; f < 4u; f++) {
    for (var r = 0u; r < 2u; r++) {
      let e = li + r * ${N / 2}u;
      spec[addr(c, f, line, e)] = buf[f * N + e];
    }
  }
}`;

const ASSEMBLE = /* wgsl */ `${COMMON}
@group(0) @binding(1) var<storage, read> spec : array<vec2f>;
@group(0) @binding(2) var<storage, read_write> foamBuf : array<f32>;
@group(0) @binding(3) var dispOut : texture_storage_2d<rgba16float, write>;
@group(0) @binding(4) var derivOut : texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var foamOut : texture_storage_2d<rgba16float, write>;
@group(0) @binding(6) var<uniform> cascade : vec4u;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id : vec3u) {
  let x = id.x; let y = id.y; let c = cascade.x;
  let sgn = select(1.0, -1.0, ((x + y) & 1u) == 1u);
  let f0 = spec[fieldIndex(c, 0u, x, y)] * sgn;
  let f1 = spec[fieldIndex(c, 1u, x, y)] * sgn;
  let f2 = spec[fieldIndex(c, 2u, x, y)] * sgn;
  let f3 = spec[fieldIndex(c, 3u, x, y)] * sgn;
  let lam = P.choppy;
  let Dx = f0.x * lam; let Dz = f0.y * lam;
  let Dy = f1.x; let Dxz = f1.y * lam;
  let Dyx = f2.x; let Dyz = f2.y;
  let Dxx = f3.x * lam; let Dzz = f3.y * lam;
  let J = (1.0 + Dxx) * (1.0 + Dzz) - Dxz * Dxz;
  let fi = (c * N + y) * N + x;
  var foam = foamBuf[fi] * exp(-P.dt * P.foamDecay);
  foam = max(foam, clamp((P.foamBias - J) * P.foamGain, 0.0, 1.0));
  foamBuf[fi] = foam;
  // slopes of the displaced surface: d(height)/d(world x,z)
  textureStore(dispOut, vec2u(x, y), vec4f(Dx, Dy, Dz, Dxz));
  textureStore(derivOut, vec2u(x, y), vec4f(Dyx, Dyz, Dxx, Dzz));
  textureStore(foamOut, vec2u(x, y), vec4f(foam, J, Dyx * Dyx, Dyz * Dyz));
}`;

const MIP = /* wgsl */ `
@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var dst : texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id : vec3u) {
  let d = textureDimensions(dst);
  if (id.x >= d.x || id.y >= d.y) { return; }
  let p = vec2i(id.xy) * 2;
  let v = textureLoad(src, p, 0) + textureLoad(src, p + vec2i(1, 0), 0) + textureLoad(src, p + vec2i(0, 1), 0) + textureLoad(src, p + vec2i(1, 1), 0);
  textureStore(dst, id.xy, v * 0.25);
}`;

export class Ocean {
  constructor(device, params) {
    this.device = device;
    this.params = params;
    this.time = 0;
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC;
    const mk = (label, mips) => device.createTexture({ label, size: [N, N], format: "rgba16float", usage, mipLevelCount: mips });
    this.disp = CASCADES.map((_, c) => mk(`ocean.disp${c}`, 1));
    this.deriv = CASCADES.map((_, c) => mk(`ocean.deriv${c}`, MIPS));
    this.foam = CASCADES.map((_, c) => mk(`ocean.foam${c}`, MIPS));

    this.uniform = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.h0 = device.createBuffer({ size: NC * N * N * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.spec = device.createBuffer({ size: NC * 4 * N * N * 8, usage: GPUBufferUsage.STORAGE });
    this.foamBuf = device.createBuffer({ size: NC * N * N * 4, usage: GPUBufferUsage.STORAGE });
    this.cascadeUniforms = CASCADES.map((_, c) => {
      const b = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(b, 0, new Uint32Array([c, 0, 0, 0]));
      return b;
    });

    const pipe = (code, constants) => device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code }), entryPoint: "main", constants } });
    this.pSpectrum = pipe(SPECTRUM);
    this.pFftH = pipe(FFT, { HORIZONTAL: 1 });
    this.pFftV = pipe(FFT, { HORIZONTAL: 0 });
    this.pAssemble = pipe(ASSEMBLE);
    this.pMip = pipe(MIP);

    const U = { binding: 0, resource: { buffer: this.uniform } };
    this.bgSpectrum = device.createBindGroup({ layout: this.pSpectrum.getBindGroupLayout(0), entries: [U, { binding: 1, resource: { buffer: this.h0 } }, { binding: 2, resource: { buffer: this.spec } }] });
    this.bgFftH = device.createBindGroup({ layout: this.pFftH.getBindGroupLayout(0), entries: [{ binding: 1, resource: { buffer: this.spec } }] });
    this.bgFftV = device.createBindGroup({ layout: this.pFftV.getBindGroupLayout(0), entries: [{ binding: 1, resource: { buffer: this.spec } }] });
    this.bgAssemble = CASCADES.map((_, c) => device.createBindGroup({
      layout: this.pAssemble.getBindGroupLayout(0), entries: [U,
        { binding: 1, resource: { buffer: this.spec } }, { binding: 2, resource: { buffer: this.foamBuf } },
        { binding: 3, resource: this.disp[c].createView() },
        { binding: 4, resource: this.deriv[c].createView({ baseMipLevel: 0, mipLevelCount: 1 }) },
        { binding: 5, resource: this.foam[c].createView({ baseMipLevel: 0, mipLevelCount: 1 }) },
        { binding: 6, resource: { buffer: this.cascadeUniforms[c] } }],
    }));
    this.mipJobs = [];
    for (const tex of [...this.deriv, ...this.foam])
      for (let l = 1; l < MIPS; l++)
        this.mipJobs.push({
          size: Math.max(1, N >> l),
          bg: device.createBindGroup({ layout: this.pMip.getBindGroupLayout(0), entries: [
            { binding: 0, resource: tex.createView({ baseMipLevel: l - 1, mipLevelCount: 1 }) },
            { binding: 1, resource: tex.createView({ baseMipLevel: l, mipLevelCount: 1 }) }] }),
        });

    // CPU readback of the displacement maps (async, a couple of frames behind) for heightAt()
    this.readback = [0, 1].map(() => device.createBuffer({ size: NC * N * N * 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }));
    this.readbackBusy = [false, false];
    this.readbackFrame = 0;
    this.cpuDisp = null;   // Uint16Array (half floats) per cascade

    this.caustics = new Caustics(device, this);
    this.rebuildSpectrum();
  }

  rebuildSpectrum() {
    const p = this.params;
    const sp = { windSpeed: p.windSpeed, fetch: p.fetch * 1000, windDir: (p.windDir * Math.PI) / 180, swellHeight: p.swellHeight, swellLength: p.swellLength, swellDir: (p.swellDir * Math.PI) / 180, amplitude: 1 };
    this.device.queue.writeBuffer(this.h0, 0, buildH0(N, CASCADES, sp));
    this.hs = significantHeight(N, CASCADES, sp);
  }

  update(dt, encoder, cameraPos, sunDir) {
    this.time += dt;
    const p = this.params;
    this.device.queue.writeBuffer(this.uniform, 0, new Float32Array([
      this.time, p.choppiness, Math.min(dt, 0.1), p.foamDecay, p.foamBias, p.foamGain, 0, 0,
      CASCADES[0].L, CASCADES[1].L, CASCADES[2].L, 0]));
    let pass = encoder.beginComputePass({ label: "fft" });
    pass.setPipeline(this.pSpectrum);
    pass.setBindGroup(0, this.bgSpectrum);
    pass.dispatchWorkgroups(N / 8, N / 8, NC);
    pass.setPipeline(this.pFftH);
    pass.setBindGroup(0, this.bgFftH);
    pass.dispatchWorkgroups(N, NC);
    pass.setPipeline(this.pFftV);
    pass.setBindGroup(0, this.bgFftV);
    pass.dispatchWorkgroups(N, NC);
    pass.end();
    pass = encoder.beginComputePass({ label: "assemble+mips" });
    pass.setPipeline(this.pAssemble);
    for (let c = 0; c < NC; c++) {
      pass.setBindGroup(0, this.bgAssemble[c]);
      pass.dispatchWorkgroups(N / 8, N / 8);
    }
    pass.setPipeline(this.pMip);
    for (const j of this.mipJobs) {
      pass.setBindGroup(0, j.bg);
      pass.dispatchWorkgroups(Math.ceil(j.size / 8), Math.ceil(j.size / 8));
    }
    pass.end();
    this.caustics.update(encoder, cameraPos, sunDir);
    this._queueReadback(encoder);
  }

  _queueReadback(encoder) {
    const i = this.readbackFrame++ & 1;
    if (this.readbackBusy[i]) return;
    const buf = this.readback[i];
    for (let c = 0; c < NC; c++)
      encoder.copyTextureToBuffer({ texture: this.disp[c] }, { buffer: buf, offset: c * N * N * 8, bytesPerRow: N * 8 }, [N, N]);
    this.readbackBusy[i] = true;
    this._pendingMap = this._pendingMap || [];
    this._pendingMap.push(i);
  }

  /** call after queue.submit() of the encoder passed to update() */
  afterSubmit() {
    for (const i of this._pendingMap || []) {
      const buf = this.readback[i];
      buf.mapAsync(GPUMapMode.READ).then(() => {
        this.cpuDisp = new Uint16Array(buf.getMappedRange().slice(0));
        buf.unmap();
        this.readbackBusy[i] = false;
      }).catch(() => { this.readbackBusy[i] = false; });
    }
    this._pendingMap = [];
  }

  // --- CPU mirror of the GPU wave function (bilinear, wrap), used for logic only (camera state, droplets)
  _sampleDisp(c, x, z, out) {
    const L = CASCADES[c].L, d = this.cpuDisp, base = c * N * N * 4;
    const u = (x / L) * N - 0.5, v = (z / L) * N - 0.5;
    const x0 = Math.floor(u), y0 = Math.floor(v), fx = u - x0, fy = v - y0;
    for (let k = 0; k < 3; k++) out[k] = 0;
    for (let j = 0; j < 2; j++)
      for (let i = 0; i < 2; i++) {
        const w = (i ? fx : 1 - fx) * (j ? fy : 1 - fy);
        const xi = (((x0 + i) % N) + N) % N, yi = (((y0 + j) % N) + N) % N;
        const o = base + (yi * N + xi) * 4;
        for (let k = 0; k < 3; k++) out[k] += w * half(d[o + k]);
      }
  }

  displacementAt(x, z, out = [0, 0, 0]) {
    const t = [0, 0, 0];
    out[0] = out[1] = out[2] = 0;
    if (!this.cpuDisp) return out;
    for (let c = 0; c < NC; c++) {
      this._sampleDisp(c, x, z, t);
      out[0] += t[0]; out[1] += t[1]; out[2] += t[2];
    }
    return out;
  }

  /** water surface height at world (x, z): undo the horizontal displacement with fixed-point iterations */
  heightAt(x, z) {
    const d = [0, 0, 0];
    let px = x, pz = z;
    for (let i = 0; i < 6; i++) {
      this.displacementAt(px, pz, d);
      px += (x - d[0] - px) * 0.85;
      pz += (z - d[2] - pz) * 0.85;
    }
    return this.displacementAt(px, pz, d)[1] + this.params.seaLevel;
  }
}

// half-float -> float
const _f32 = new Float32Array(1), _u32 = new Uint32Array(_f32.buffer);
export function half(h) {
  const s = (h & 0x8000) << 16, e = (h >> 10) & 0x1f, m = h & 0x3ff;
  if (e === 0) return (s ? -1 : 1) * m * 5.960464477539063e-8;
  if (e === 31) return m ? NaN : s ? -Infinity : Infinity;
  _u32[0] = s | ((e + 112) << 23) | (m << 13);
  return _f32[0];
}
