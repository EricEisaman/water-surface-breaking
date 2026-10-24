// All tunables in one place (lil-gui edits this object; ?key=value in the URL overrides numbers).
export const params = {
  // ocean spectrum (rebuild on change)
  windSpeed: 5.0, fetch: 20, windDir: 100, swellHeight: 0.22, swellLength: 55, swellDir: 120,
  choppiness: 0.75, foamDecay: 0.6, foamBias: 0.35, foamGain: 1.6, foamStrength: 0.7,
  seaLevel: 0,
  // water optics (clear tropical; see docs/HOW_IT_WORKS.md "Underwater medium")
  sigmaA: [0.42, 0.065, 0.025],
  sigmaS: [0.02, 0.03, 0.045],
  msBoost: 2.0,
  waterRoughness: 0.03, sss: 0.6, refractStrength: 0.6,
  // caustics / shafts
  causticDepth: 3.2, causticRipples: 0.3, causticStrength: 1.0, causticBlur: 0.55, godrays: 0.9, godraySteps: 40,
  // lens
  bandWidth: 0.008, meniscusRefract: 0.07, waterlineDark: 0.55, highlight: 1.0,
  dropRefract: 1.4, dropBlur: 1.0, rimDark: 0.55, filmRefract: 0.35,
  drainSpeed: 0.9, filmTau: 0.9, wetTau: 5.0, beadDensity: 0.06,
  drops: 0.14, dropSize: 1.35, maxDrops: 60, slideSpeed: 1.0, evaporate: 9.0,
  // camera / image
  exposure: 1.0, autoExposure: true, exposureKey: 0.13, adaptSpeed: 1.6, bloom: 0.035,
  vignette: 0.25, grain: 0.012,
  quality: "high",            // preset (QUALITY below), applied before the other URL overrides
  renderScale: 1.25, fov: 55, floatLag: 0.35, floatFollow: 0.85,
  hdri: "kloofendal_48d_partly_cloudy_puresky_4k",
  sunScale: 1.0,
  debugMask: false,
  waterDebug: 0,
};

// quality presets (docs/PERFORMANCE.md): high = the reference look (1.25x supersampling),
// medium = no supersampling, low = 0.8x internal resolution and fewer shaft steps
export const QUALITY = {
  high: { renderScale: 1.25, godraySteps: 40 },
  medium: { renderScale: 1.0, godraySteps: 40 },
  low: { renderScale: 0.8, godraySteps: 24 },
};

export function applyUrl(p) {
  const q = new URLSearchParams(location.search);
  if (QUALITY[q.get("quality")]) { p.quality = q.get("quality"); Object.assign(p, QUALITY[p.quality]); }
  for (const [k, v] of q) {
    if (k === "quality") continue;
    if (!(k in p)) continue;
    if (typeof p[k] === "number") p[k] = +v;
    else if (typeof p[k] === "boolean") p[k] = v === "1" || v === "true";
    else if (typeof p[k] === "string") p[k] = v;
  }
  return q;
}
