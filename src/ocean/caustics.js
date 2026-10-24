// Sun caustics computed from the actual FFT surface (Evan Wallace's area-ratio method, rasterised):
// a grid of surface points is refracted along the sun direction onto a horizontal plane at depth Df;
// each triangle deposits (source area / receiver area) with additive blending. One draw per colour
// channel with a slightly different IOR gives the faint dispersion fringes.
// Result: a camera-centred world-space window (rgba16float, mipmapped - mips = defocus blur away from Df).
import { N, CASCADES } from "./ocean.js";

export const CAUSTIC_RES = 1024;
export const CAUSTIC_WINDOW = 20;           // metres covered by the texture
const SRC_STEP = 2;                          // source grid spacing in receiver texels
const MARGIN = 2.0;                          // metres of extra source surface around the window
const MIPS = Math.log2(CAUSTIC_RES) + 1;

const SHADER = /* wgsl */ `
struct U {
  origin : vec2f, window : f32, depth : f32,        // receiver window (world xz of texel 0), size, plane depth
  srcOrigin : vec2f, srcStep : f32, gridN : f32,     // source grid
  sun : vec3f, choppy : f32,                         // direction TO the sun
  L : vec4f,
  seaLevel : f32, c2 : f32, c2lod : f32, pad2 : f32,
};
@group(0) @binding(0) var<uniform> u : U;
@group(0) @binding(1) var samp : sampler;
@group(0) @binding(2) var disp0 : texture_2d<f32>;
@group(0) @binding(3) var disp1 : texture_2d<f32>;
@group(0) @binding(4) var disp2 : texture_2d<f32>;
@group(0) @binding(5) var der0 : texture_2d<f32>;
@group(0) @binding(6) var der1 : texture_2d<f32>;
@group(0) @binding(7) var der2 : texture_2d<f32>;
override ETA : f32 = 1.333;

struct VO { @builtin(position) pos : vec4f, @location(0) src : vec2f, @location(1) trans : f32 };

fn fresnelT(cosi : f32, eta : f32) -> f32 {
  // exact dielectric Fresnel transmittance, air -> water
  let sint2 = (1.0 - cosi * cosi) / (eta * eta);
  let cost = sqrt(max(0.0, 1.0 - sint2));
  let rs = (cosi - eta * cost) / (cosi + eta * cost);
  let rp = (eta * cosi - cost) / (eta * cosi + cost);
  return 1.0 - 0.5 * (rs * rs + rp * rp);
}

// indexed grid: vertex_index = y * (gridN + 1) + x, so each grid point is transformed ~once
@vertex fn vs(@builtin(vertex_index) vi : u32) -> VO {
  let row = u32(u.gridN) + 1u;
  let g = vec2u(vi % row, vi / row);
  let src = u.srcOrigin + vec2f(g) * u.srcStep;
  var D = vec3f(0.0); var Dxz = 0.0;
  var S = vec4f(0.0);   // dDy/dx, dDy/dz, dDx/dx, dDz/dz
  let uv0 = src / u.L.x; let uv1 = src / u.L.y; let uv2 = src / u.L.z;
  let d0 = textureSampleLevel(disp0, samp, uv0, 0.0); let d1 = textureSampleLevel(disp1, samp, uv1, 0.0); let d2 = textureSampleLevel(disp2, samp, uv2, 0.0) * u.c2;
  D = d0.xyz + d1.xyz + d2.xyz; Dxz = d0.w + d1.w + d2.w;
  S = textureSampleLevel(der0, samp, uv0, 0.0) + textureSampleLevel(der1, samp, uv1, 0.0) + textureSampleLevel(der2, samp, uv2, u.c2lod) * u.c2;
  let nrm = normalize(vec3f(S.y * Dxz - (1.0 + S.w) * S.x, (1.0 + S.w) * (1.0 + S.z) - Dxz * Dxz, Dxz * S.x - S.y * (1.0 + S.z)));
  let I = -u.sun;
  let t = refract(I, nrm, 1.0 / ETA);
  let cosi = max(dot(u.sun, nrm), 0.0);
  // entry point (displaced), then down to the receiver plane at seaLevel - depth
  let entry = vec3f(src.x + D.x, u.seaLevel + D.y, src.y + D.z);
  let dist = (entry.y - (u.seaLevel - u.depth)) / max(-t.y, 0.05);
  let hit = entry.xz + t.xz * dist;
  let ndc = (hit - u.origin) / u.window * 2.0 - 1.0;
  var o : VO;
  o.pos = vec4f(ndc.x, -ndc.y, 0.0, 1.0);
  o.src = src;
  // transmittance relative to a flat surface, so the mean stays ~1
  let flatT = fresnelT(max(u.sun.y, 0.05), ETA);
  o.trans = select(0.0, fresnelT(cosi, ETA) / flatT, t.y < 0.0);
  return o;
}

@fragment fn fs(i : VO) -> @location(0) vec4f {
  let dx = dpdx(i.src); let dy = dpdy(i.src);
  let texel = u.window / ${CAUSTIC_RES}.0;
  let area = abs(dx.x * dy.y - dx.y * dy.x) / (texel * texel);
  let v = min(area * i.trans, 40.0);
  return vec4f(v, v, v, 1.0);
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

export class Caustics {
  constructor(device, ocean) {
    this.device = device;
    this.ocean = ocean;
    this.texture = device.createTexture({
      label: "caustics", size: [CAUSTIC_RES, CAUSTIC_RES], format: "rgba16float", mipLevelCount: MIPS,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    this.uniform = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.sampler = device.createSampler({ addressModeU: "repeat", addressModeV: "repeat", magFilter: "linear", minFilter: "linear", mipmapFilter: "linear" });
    const module = device.createShaderModule({ code: SHADER });
    const etas = [1.3310, 1.3335, 1.3370];
    const masks = [GPUColorWrite.RED, GPUColorWrite.GREEN, GPUColorWrite.BLUE];
    this.pipelines = etas.map((eta, i) => device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs", constants: { ETA: eta } },
      fragment: { module, entryPoint: "fs", targets: [{ format: "rgba16float", writeMask: masks[i], blend: { color: { srcFactor: "one", dstFactor: "one" }, alpha: { srcFactor: "one", dstFactor: "one" } } }] },
      primitive: { topology: "triangle-list" },
    }));
    const entries = [
      { binding: 0, resource: { buffer: this.uniform } }, { binding: 1, resource: this.sampler },
      ...ocean.disp.map((t, c) => ({ binding: 2 + c, resource: t.createView() })),
      ...ocean.deriv.map((t, c) => ({ binding: 5 + c, resource: t.createView() })),
    ];
    this.bindGroups = this.pipelines.map(p => device.createBindGroup({ layout: p.getBindGroupLayout(0), entries }));
    const mipPipe = device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code: MIP }), entryPoint: "main" } });
    this.mipPipe = mipPipe;
    this.mipJobs = [];
    for (let l = 1; l < MIPS; l++)
      this.mipJobs.push({ size: CAUSTIC_RES >> l, bg: device.createBindGroup({ layout: mipPipe.getBindGroupLayout(0), entries: [
        { binding: 0, resource: this.texture.createView({ baseMipLevel: l - 1, mipLevelCount: 1 }) },
        { binding: 1, resource: this.texture.createView({ baseMipLevel: l, mipLevelCount: 1 }) }] }) });
    this.view0 = this.texture.createView({ baseMipLevel: 0, mipLevelCount: 1 });
    this.origin = [0, 0];
    this.texel = CAUSTIC_WINDOW / CAUSTIC_RES;
    // the source grid size is fixed by the window, margin and step
    this.gridN = Math.ceil((CAUSTIC_WINDOW + 2 * MARGIN) / (this.texel * SRC_STEP));
    const n = this.gridN, row = n + 1, idx = new Uint32Array(n * n * 6);
    for (let y = 0, k = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const a = y * row + x;
        idx.set([a, a + 1, a + row, a + row, a + 1, a + row + 1], k);
        k += 6;
      }
    this.index = device.createBuffer({ size: idx.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.index, 0, idx);
  }

  update(encoder, cam, sun) {
    const p = this.ocean.params;
    const texel = this.texel, step = texel * SRC_STEP;
    // snap the window to the source step so the pattern does not swim when the camera moves
    const ox = Math.floor((cam.x - CAUSTIC_WINDOW / 2) / step) * step;
    const oz = Math.floor((cam.z - CAUSTIC_WINDOW / 2) / step) * step;
    this.origin = [ox, oz];
    // mean refracted sun direction -> horizontal shift of the pattern at the plane depth
    const eta = 1 / 1.333, ci = Math.max(sun.y, 0.05), k = 1 - eta * eta * (1 - ci * ci);
    const t = [-sun.x * eta, -Math.sqrt(k), -sun.z * eta];   // refract(-sun, up, 1/1.333)
    const shiftX = (t[0] / -t[1]) * p.causticDepth, shiftZ = (t[2] / -t[1]) * p.causticDepth;
    this.meanRefracted = t;
    const gridN = this.gridN;
    const sx = Math.floor((ox - MARGIN - shiftX) / step) * step, sz = Math.floor((oz - MARGIN - shiftZ) / step) * step;
    this.device.queue.writeBuffer(this.uniform, 0, new Float32Array([
      ox, oz, CAUSTIC_WINDOW, p.causticDepth,
      sx, sz, step, gridN,
      sun.x, sun.y, sun.z, p.choppiness,
      CASCADES[0].L, CASCADES[1].L, CASCADES[2].L, 0,
      p.seaLevel, p.causticRipples, 1.5, 0]));
    const pass = encoder.beginRenderPass({ label: "caustics", colorAttachments: [{ view: this.view0, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 0] }] });
    pass.setIndexBuffer(this.index, "uint32");
    for (let i = 0; i < 3; i++) {
      pass.setPipeline(this.pipelines[i]);
      pass.setBindGroup(0, this.bindGroups[i]);
      pass.drawIndexed(gridN * gridN * 6);
    }
    pass.end();
    const mp = encoder.beginComputePass({ label: "caustics mips" });
    mp.setPipeline(this.mipPipe);
    for (const j of this.mipJobs) {
      mp.setBindGroup(0, j.bg);
      mp.dispatchWorkgroups(Math.ceil(j.size / 8), Math.ceil(j.size / 8));
    }
    mp.end();
  }
}

