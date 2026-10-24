// CPU droplet simulation for the lens after surfacing (screen space, uv units, radius in screen heights).
// Large drops slide down along screen-space gravity with stick-slip, leaving small trail beads; small drops
// stay and evaporate. Drops that end up below the waterline are absorbed. Spawned where the near-plane
// sample grid flips from underwater to air (i.e. exactly where water just left the lens).
const GX = 32, GY = 18;
const MAX = 256;

// seedable (mulberry32) so captures and before / after comparisons are reproducible
let random = Math.random;
export function seedDrops(seed) {
  let a = seed >>> 0;
  random = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function rand(a, b) { return a + random() * (b - a); }
function powerLaw(min, max, k) { const u = random(); return min * Math.pow(max / min, Math.pow(u, k)); }

export class LensDrops {
  constructor() {
    this.drops = [];
    this.prev = new Uint8Array(GX * GY);
    this.hasPrev = false;
    this.buf = new Float32Array(MAX * 4);
    this.seed = 1;
  }

  reset() { this.drops.length = 0; this.hasPrev = false; }

  /**
   * submergedAt(u, v) -> true if the near-plane point of screen uv is under water.
   * down = [dx, dy] screen-space gravity (uv). aspect = w/h.
   */
  update(dt, submergedAt, down, aspect, P) {
    const cur = new Uint8Array(GX * GY);
    for (let j = 0; j < GY; j++)
      for (let i = 0; i < GX; i++) cur[j * GX + i] = submergedAt((i + 0.5) / GX, (j + 0.5) / GY) ? 1 : 0;
    if (this.hasPrev && P.drops > 0) {
      for (let j = 0; j < GY; j++)
        for (let i = 0; i < GX; i++) {
          const k = j * GX + i;
          if (this.prev[k] && !cur[k]) {
            // water just left this patch of lens: a few drops at most (stochastic, capped)
            let n = 0;
            for (let q = P.drops * rand(0.5, 1.5); q > 0; q--) if (random() < Math.min(q, 1)) n++;
            if (this.drops.length >= P.maxDrops) n = 0;
            for (let m = 0; m < n && this.drops.length < MAX; m++) {
              const r = powerLaw(0.0018, 0.022, 2.2) * P.dropSize;
              this.drops.push({ x: (i + random()) / GX, y: (j + random()) / GY, r, stick: rand(0.2, 1.5), wob: rand(0, 6.28), trail: 0, age: 0 });
            }
          }
        }
    }
    this.prev = cur;
    this.hasPrev = true;

    const out = [];
    const slideR = 0.0085 * P.dropSize;
    for (const d of this.drops) {
      d.age += dt;
      if (submergedAt(d.x, d.y)) continue;   // back in the water
      // evaporation
      d.r *= Math.exp(-dt / P.evaporate);
      if (d.r < 0.0012) continue;
      if (d.r > slideR) {
        d.stick -= dt;
        if (d.stick <= 0) {
          const v = (d.r - slideR) * 9.0 * P.slideSpeed * (0.6 + 0.4 * Math.sin(d.age * 3 + d.wob));
          const lat = Math.sin(d.age * 2.3 + d.wob) * 0.25;
          const sx = (down[0] - down[1] * lat) / aspect, sy = down[1] + down[0] * lat;
          d.x += sx * v * dt;
          d.y += sy * v * dt;
          d.trail += v * dt;
          // shed a little bead every so often and lose that water
          if (d.trail > d.r * 1.6 && this.drops.length + out.length < MAX) {
            d.trail = 0;
            const br = d.r * rand(0.18, 0.38);
            out.push({ x: d.x - sx * d.r * 1.2, y: d.y - sy * d.r * 1.2, r: br, stick: 1e9, wob: 0, trail: 0, age: 0 });
            d.r = Math.sqrt(Math.max(d.r * d.r - br * br * 0.5, 0));
          }
          if (random() < dt * 0.6) d.stick = rand(0.05, 0.4);   // stick-slip
        }
      }
      if (d.y > 1.05 || d.y < -0.05 || d.x < -0.05 || d.x > 1.05) continue;
      out.push(d);
    }
    // merge overlapping drops (bigger one absorbs the smaller)
    out.sort((a, b) => b.r - a.r);
    for (let i = 0; i < out.length; i++) {
      const a = out[i];
      if (!a) continue;
      for (let j = i + 1; j < out.length; j++) {
        const b = out[j];
        if (!b) continue;
        const dx = (a.x - b.x) * aspect, dy = a.y - b.y;
        if (dx * dx + dy * dy < (a.r + b.r) * (a.r + b.r) * 0.5) {
          a.r = Math.cbrt(a.r ** 3 + b.r ** 3);
          out[j] = null;
        }
      }
    }
    this.drops = out.filter(Boolean).slice(0, MAX);
    for (let i = 0; i < this.drops.length; i++) {
      const d = this.drops[i];
      this.buf[i * 4] = d.x; this.buf[i * 4 + 1] = d.y; this.buf[i * 4 + 2] = d.r; this.buf[i * 4 + 3] = 0.55;
    }
    return this.drops.length;
  }
}
