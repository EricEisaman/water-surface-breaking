// Per-pass GPU timing with WebGPU timestamp queries, for our own WGSL passes AND the passes three.js encodes.
// GPUCommandEncoder.beginRenderPass / beginComputePass are wrapped so every pass of a profiled frame gets
// timestampWrites; passes are named "<phase>.<label>" where the phase is set by the frame code
// (profiler.phase = "scene"). three.js passes carry no useful label, so they are classified by their
// attachments: the first pass drawing into the HDR scene target (profiler.mainTarget) is "<phase>", any other pass
// with a depth attachment is the shadow map, anything else (mip generation, copies) is "<phase>.other".
// Results are resolved asynchronously a few frames later.
//
// Chrome quantises timestamps to 100 us unless it runs with --enable-webgpu-developer-features
// (tools/capture.mjs passes it); the per-pass numbers are only meaningful with that flag.
const MAX_PASSES = 128;
const RING = 6;

export class GpuProfiler {
  constructor(device) {
    this.device = device;
    this.supported = device.features.has("timestamp-query");
    this.enabled = false;
    this.phase = "";
    this.history = [];          // last N resolved frames: { names[], ms[], span }
    this.historyLen = 240;
    this.mainTarget = null;     // GPUTexture of the HDR scene colour target
    this.trace = null;          // set to [] to record the passes (+ call sites) of the next frames
    this.cur = null;
    if (!this.supported) return;
    this.slots = Array.from({ length: RING }, () => ({
      qs: device.createQuerySet({ type: "timestamp", count: MAX_PASSES * 2 }),
      resolve: device.createBuffer({ size: MAX_PASSES * 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
      read: device.createBuffer({ size: MAX_PASSES * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
      busy: false, names: [],
    }));
    this._install();
  }

  _install() {
    const self = this;
    // remember which texture a view belongs to (to classify three.js passes)
    const createView = GPUTexture.prototype.createView;
    GPUTexture.prototype.createView = function (d) { const v = createView.call(this, d); v.__tex = this; return v; };
    const proto = GPUCommandEncoder.prototype;
    const wrap = (orig) => function (desc = {}) {
      const s = self.cur;
      if (!s || s.names.length >= MAX_PASSES || desc.timestampWrites) return orig.call(this, desc);
      const i = s.names.length;
      s.names.push(self._name(desc));
      if (self.trace) self.trace.push({ name: s.names[i], stack: new Error().stack.split("\n").slice(2, 6).map(l => l.trim().split(" ")[1]).join(" < ") });
      return orig.call(this, { ...desc, timestampWrites: { querySet: s.qs, beginningOfPassWriteIndex: i * 2, endOfPassWriteIndex: i * 2 + 1 } });
    };
    proto.beginRenderPass = wrap(proto.beginRenderPass);
    proto.beginComputePass = wrap(proto.beginComputePass);
  }

  _name(desc) {
    if (desc.label) return `${this.phase}.${desc.label}`;
    const c = desc.colorAttachments && desc.colorAttachments[0];
    const tex = c && c.view && c.view.__tex;
    // three.js restarts the scene pass after every viewport copy (refraction / depth sampling materials)
    if (tex && tex === this.mainTarget) return (this.mainPasses[this.phase] = (this.mainPasses[this.phase] || 0) + 1) === 1 ? this.phase : `${this.phase}.after copy`;
    if (desc.depthStencilAttachment) return "scene.shadow";
    return `${this.phase}.other`;
  }

  beginFrame() {
    this.cur = null;
    if (!this.supported || !this.enabled) return;
    const s = this.slots.find(x => !x.busy);
    if (!s) return;               // all readbacks in flight: skip this frame
    s.names = [];
    this.cur = s;
    this.mainPasses = {};
  }

  /** after the frame's last submit */
  endFrame() {
    const s = this.cur;
    this.cur = null;
    this.phase = "";
    if (!s || !s.names.length) return;
    const n = s.names.length;
    const enc = this.device.createCommandEncoder({ label: "profiler.resolve" });
    enc.resolveQuerySet(s.qs, 0, n * 2, s.resolve, 0);
    enc.copyBufferToBuffer(s.resolve, 0, s.read, 0, n * 16);
    this.device.queue.submit([enc.finish()]);
    s.busy = true;
    const names = s.names.slice();
    s.read.mapAsync(GPUMapMode.READ, 0, n * 16).then(() => {
      const t = new BigUint64Array(s.read.getMappedRange(0, n * 16).slice(0));
      s.read.unmap();
      s.busy = false;
      const ms = [];
      // a pass whose encoder was never submitted resolves to 0: ignore it for the span
      let lo = 0n, hi = 0n;
      for (let i = 0; i < n; i++) {
        const a = t[i * 2], b = t[i * 2 + 1];
        ms.push(a > 0n && b > a ? Number(b - a) / 1e6 : 0);
        if (a > 0n && (lo === 0n || a < lo)) lo = a;
        if (b > hi) hi = b;
      }
      this.history.push({ names, ms, span: lo > 0n && hi > lo ? Number(hi - lo) / 1e6 : 0 });
      if (this.history.length > this.historyLen) this.history.shift();
    }).catch(() => { s.busy = false; });
  }

  reset() { this.history = []; }

  /** average ms per pass name (passes with the same name in one frame are summed), plus total and span */
  stats(last = this.historyLen) {
    const h = this.history.slice(-last);
    const sum = new Map();
    let span = 0;
    for (const f of h) {
      f.names.forEach((nm, i) => sum.set(nm, (sum.get(nm) || 0) + f.ms[i]));
      span += f.span;
    }
    const passes = {};
    let total = 0;
    for (const [nm, v] of sum) { passes[nm] = v / Math.max(h.length, 1); total += passes[nm]; }
    return { frames: h.length, passes, total, span: span / Math.max(h.length, 1) };
  }
}
