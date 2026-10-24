// CPU side of the FFT ocean: builds the initial spectrum h0(k) for every cascade.
// Spectrum: fetch-limited JONSWAP wind sea + a long, narrow swell, with a Donelan-Banner style
// directional spread (Horvath 2015, "Empirical directional wave spectra for computer graphics").

const G = 9.81;

// mulberry32 - deterministic so the sea looks the same on every load
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rand) {
  const u = Math.max(1e-7, rand()), v = rand();
  const r = Math.sqrt(-2 * Math.log(u));
  return [r * Math.cos(2 * Math.PI * v), r * Math.sin(2 * Math.PI * v)];
}

// JONSWAP S(omega), fetch-limited (Hasselmann 1973)
function jonswap(omega, windSpeed, fetch, gamma) {
  const alpha = 0.076 * Math.pow((windSpeed * windSpeed) / (fetch * G), 0.22);
  const wp = 22 * Math.pow((G * G) / (windSpeed * fetch), 1 / 3);
  const sigma = omega <= wp ? 0.07 : 0.09;
  const r = Math.exp(-((omega - wp) ** 2) / (2 * sigma * sigma * wp * wp));
  return ((alpha * G * G) / omega ** 5) * Math.exp(-1.25 * (wp / omega) ** 4) * Math.pow(gamma, r);
}

// Donelan-Banner spreading; returns normalised D(theta) for the given omega
function spread(theta, omega, wp, extraS) {
  const ratio = omega / wp;
  let beta;
  if (ratio < 0.95) beta = 2.61 * Math.pow(ratio, 1.3);
  else if (ratio < 1.6) beta = 2.28 * Math.pow(ratio, -1.3);
  else beta = Math.pow(10, -0.4 + 0.8393 * Math.exp(-0.567 * Math.log(ratio * ratio)));
  beta = Math.max(beta, 0.1);
  // mix in a cos^2s lobe to tighten the swell
  const sech = 1 / Math.cosh(beta * theta);
  const db = (beta / (2 * Math.tanh(beta * Math.PI))) * sech * sech;
  if (!extraS) return db;
  const s = extraS;
  // normalisation of cos^{2s}(theta/2): Gamma(s+1)^2 / (2 sqrt(pi) Gamma(s+0.5)) ... approximated
  const norm = Math.sqrt(s / Math.PI) * 0.5 * (1 + 1 / (8 * s));
  return norm * Math.pow(Math.abs(Math.cos(theta / 2)), 2 * s);
}

function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/**
 * Directional energy spectrum S(kx, kz) in m^4 (per unit wavenumber area).
 */
function spectrumK(kx, kz, p) {
  const k = Math.hypot(kx, kz);
  if (k < 1e-6) return 0;
  const omega = Math.sqrt(G * k);
  const dOmegaDk = G / (2 * omega);
  const theta = Math.atan2(kz, kx);
  let S = 0;
  // wind sea
  {
    const wp = 22 * Math.pow((G * G) / (p.windSpeed * p.fetch), 1 / 3);
    const s = jonswap(omega, p.windSpeed, p.fetch, 3.3);
    const d = spread(angleDiff(theta, p.windDir), omega, wp, 0);
    S += s * d;
  }
  // swell: long, narrow, from a slightly different direction
  if (p.swellHeight > 0) {
    const wp = (2 * Math.PI) / Math.sqrt((2 * Math.PI * p.swellLength) / G);
    // shape like a narrow JONSWAP scaled to the requested significant height
    const sigma = omega <= wp ? 0.07 : 0.09;
    const shape = Math.exp(-1.25 * (wp / omega) ** 4) * Math.pow(6, Math.exp(-((omega - wp) ** 2) / (2 * sigma * sigma * wp * wp))) / omega ** 5;
    // m0 of the un-scaled shape, approximated numerically once per call site (cached)
    const m0 = swellM0(wp);
    const scale = (p.swellHeight * p.swellHeight) / 16 / m0;
    const d = spread(angleDiff(theta, p.swellDir), omega, wp, 24);
    S += scale * shape * d;
  }
  // short-wave damping (capillary cutoff) - keeps the smallest cascade from fizzing
  const l = 0.004;
  S *= Math.exp(-k * k * l * l);
  // omega -> k : S(k) dk = S(omega) d(omega), 2D polar -> cartesian divide by k
  return (S * dOmegaDk) / k;
}

const _m0 = new Map();
function swellM0(wp) {
  if (_m0.has(wp)) return _m0.get(wp);
  let m = 0;
  for (let w = 0.05; w < 12; w += 0.002) {
    const sigma = w <= wp ? 0.07 : 0.09;
    m += (Math.exp(-1.25 * (wp / w) ** 4) * Math.pow(6, Math.exp(-((w - wp) ** 2) / (2 * sigma * sigma * wp * wp))) / w ** 5) * 0.002;
  }
  _m0.set(wp, m);
  return m;
}

/**
 * Build the h0 buffer: per cascade, per texel vec4(h0(k), conj(h0(-k))).
 * Cascade c holds |k| in [cut[c], cut[c+1]).
 */
export function buildH0(N, cascades, params, seed = 1337) {
  const out = new Float32Array(cascades.length * N * N * 4);
  const rand = rng(seed);
  for (let c = 0; c < cascades.length; c++) {
    const { L, kMin, kMax } = cascades[c];
    const dk = (2 * Math.PI) / L;
    // random numbers first so h0(-k) can be looked up
    const xi = new Float32Array(N * N * 2);
    for (let i = 0; i < N * N; i++) {
      const [a, b] = gauss(rand);
      xi[i * 2] = a;
      xi[i * 2 + 1] = b;
    }
    const amp = new Float32Array(N * N);
    for (let z = 0; z < N; z++)
      for (let x = 0; x < N; x++) {
        const kx = (x - N / 2) * dk, kz = (z - N / 2) * dk;
        const k = Math.hypot(kx, kz);
        if (k < kMin || k >= kMax || k === 0) continue;
        amp[z * N + x] = Math.sqrt(2 * spectrumK(kx, kz, params) * dk * dk) * params.amplitude;
      }
    const base = c * N * N * 4;
    for (let z = 0; z < N; z++)
      for (let x = 0; x < N; x++) {
        const i = z * N + x;
        const mx = (N - x) % N, mz = (N - z) % N;   // index of -k
        const j = mz * N + mx;
        const a = amp[i] / Math.SQRT2, b = amp[j] / Math.SQRT2;
        out[base + i * 4 + 0] = xi[i * 2] * a;
        out[base + i * 4 + 1] = xi[i * 2 + 1] * a;
        out[base + i * 4 + 2] = xi[j * 2] * b;      // conj(h0(-k))
        out[base + i * 4 + 3] = -xi[j * 2 + 1] * b;
      }
  }
  return out;
}

export function significantHeight(N, cascades, params) {
  // 4 sqrt(m0) summed over all cascades (for the UI)
  let m0 = 0;
  for (const { L, kMin, kMax } of cascades) {
    const dk = (2 * Math.PI) / L;
    for (let z = 0; z < N; z++)
      for (let x = 0; x < N; x++) {
        const kx = (x - N / 2) * dk, kz = (z - N / 2) * dk, k = Math.hypot(kx, kz);
        if (k < kMin || k >= kMax || k === 0) continue;
        m0 += spectrumK(kx, kz, params) * dk * dk * params.amplitude * params.amplitude;
      }
  }
  return 4 * Math.sqrt(m0);
}
