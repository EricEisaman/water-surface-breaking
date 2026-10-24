// Scene: HDRI sky with the sun cut out into a matching directional light, procedural seabed / beach,
// Poly Haven scanned rocks. Every opaque material gets the same underwater lighting:
//   sun  * Fresnel transmission * exp(-Kd' depth) * caustics   (through receivedShadowNode)
//   sky  * exp(-Kd depth)                                       (albedo tint)
//   wet darkening in the splash band above the instantaneous waterline.
import * as THREE from "three/webgpu";
import {
  Fn, float, vec2, vec3, vec4, texture, positionWorld, normalMap, mix, smoothstep, saturate, max, min, clamp,
  materialColor, materialRoughness, mx_noise_float, mx_fractal_noise_float, uniform, exp, abs, dot, normalWorld, varying,
} from "three/tsl";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";

const ASSETS = "./assets/";
// layer of the shadow-only caster meshes (low-poly rocks / terrain): the shadow camera sees layers 0 and 1,
// the main camera only layer 0
export const SHADOW_LAYER = 1;
// switch rock LODs when the next level's simplification error stays below this many pixels
const LOD_PIXEL_ERROR = 0.75;
// the sky EXR stores radiance / HDRI_SCALE: the sun is brighter than half floats allow (tools/hdri_to_exr.py)
const HDRI_SCALE = 2;

// ---------------------------------------------------------------- sky + sun
export async function loadSky(name) {
  const loader = new EXRLoader().setDataType(THREE.FloatType);
  const tex = await loader.loadAsync(`${ASSETS}hdri/${name}.exr`);
  const { width: W, height: H, data } = tex.image;
  // EXRLoader returns the bottom row first: flip to top-first (as HDRLoader does, flipY = true) and unscale
  const row = W * 4, tmp = new Float32Array(row);
  for (let y = 0; y < H / 2; y++) {
    const a = y * row, b = (H - 1 - y) * row;
    tmp.set(data.subarray(a, a + row)); data.copyWithin(a, b, b + row); data.set(tmp, b);
  }
  for (let i = 0; i < data.length; i++) data[i] *= HDRI_SCALE;
  tex.flipY = true;
  // find the sun: brightest blob, integrate its radiance * solid angle -> irradiance, then clamp it out
  let maxL = 0;
  for (let i = 0; i < W * H; i++) maxL = Math.max(maxL, data[i * 4] * 0.2126 + data[i * 4 + 1] * 0.7152 + data[i * 4 + 2] * 0.0722);
  const thr = Math.max(maxL * 0.02, 50);
  const E = [0, 0, 0], dir = new THREE.Vector3();
  const skyIrr = [0, 0, 0];
  const lums = [];
  for (let y = 0; y < H; y++) {
    const theta = ((y + 0.5) / H) * Math.PI;   // from +Y
    const dOmega = (Math.PI / H) * ((2 * Math.PI) / W) * Math.sin(theta);
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const l = data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722;
      // three.js equirect: u = atan(dir.z, dir.x) / 2pi + 0.5, v = asin(dir.y)/pi + 0.5 (flipY)
      const phi = ((x + 0.5) / W - 0.5) * 2 * Math.PI;
      const dy = Math.cos(theta), r = Math.sin(theta);
      const dx = Math.cos(phi) * r, dz = Math.sin(phi) * r;
      if (l > thr) {
        for (let k = 0; k < 3; k++) E[k] += data[i + k] * dOmega;
        dir.x += dx * l * dOmega; dir.y += dy * l * dOmega; dir.z += dz * l * dOmega;
        lums.push(i);
      }
    }
  }
  dir.normalize();
  // replace the sun pixels with the surrounding sky level
  const ring = [];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const l = data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722;
      if (l > thr * 0.05 && l <= thr) ring.push(i);
    }
  const fill = [0, 0, 0];
  for (const i of ring) for (let k = 0; k < 3; k++) fill[k] += data[i + k] / ring.length;
  for (const i of lums) for (let k = 0; k < 3; k++) data[i + k] = fill[k];
  // sky irradiance on an up-facing surface (for the underwater ambient)
  for (let y = 0; y < H / 2; y++) {
    const theta = ((y + 0.5) / H) * Math.PI;
    const dOmega = (Math.PI / H) * ((2 * Math.PI) / W) * Math.sin(theta);
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      for (let k = 0; k < 3; k++) skyIrr[k] += data[i + k] * Math.cos(theta) * dOmega;
    }
  }
  tex.needsUpdate = true;
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  const sunE = new THREE.Color(E[0], E[1], E[2]);
  const ambient = new THREE.Color(skyIrr[0] / Math.PI, skyIrr[1] / Math.PI, skyIrr[2] / Math.PI);
  // the equirect -> direction convention of three.js flips x: verify via equirectUV: u = atan(z, x) / (2pi) + 0.5
  return { texture: tex, sun: { dir, color: sunE, ambient, baseColor: sunE.clone() } };
}

// ---------------------------------------------------------------- terrain
export function terrainHeight(x, z) {
  // shore runs along x; land toward +z. Origin sits over ~3.5 m of water.
  let h;
  if (z > 46) h = Math.min((z - 46) * 0.11, 3.2) + Math.max(0, z - 75) * 0.25;
  else if (z > 0) h = -3.6 + 3.6 * smooth(0, 46, z) ** 1.3;
  else h = -3.6 + z * 0.09 - Math.max(0, -z - 40) * 0.12;
  h = Math.max(h, -28);
  // dunes / sand bars and a lumpy reef shelf
  const n = fbm(x * 0.045, z * 0.045) * 0.9 + fbm(x * 0.18 + 7, z * 0.18 - 3) * 0.18;
  const reef = Math.exp(-((x - 9) ** 2 + (z + 7) ** 2) / 140) * 0.9;
  return h + n + reef;
}
function smooth(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
function hash(x, y) { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); }
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 2 - 1;
}
function fbm(x, y) { let s = 0, a = 0.5, f = 1; for (let i = 0; i < 4; i++) { s += a * vnoise(x * f, y * f); a *= 0.5; f *= 2.03; } return s; }

function loadTex(loader, url, srgb, repeat = true) {
  const t = loader.load(url);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

// ---------------------------------------------------------------- underwater lighting for any lit node material
export function underwaterize(mat, O, opts = {}) {
  const U = O.U;
  const p = positionWorld;
  // instantaneous water height above this point (one inverse-displacement step is plenty for lighting)
  const D0 = O.displacementFast(p.xz);
  const waterH = O.displacementFast(p.xz.sub(D0.xz)).y.add(U.seaLevel);
  const depth = waterH.sub(p.y);
  const under = smoothstep(-0.02, 0.06, depth);
  const Tamb = O.ambientTransmittance(depth);
  // wet band above the water: darker, glossier, fades out ~0.7 m up with some noise
  const wetN = mx_noise_float(p.mul(vec3(1.3, 6, 1.3))).mul(0.25);
  const wet = smoothstep(0.75, 0.0, depth.negate().add(wetN)).mul(float(1).sub(under));
  const baseColor = opts.colorNode || materialColor;
  mat.colorNode = baseColor.mul(mix(vec3(1), Tamb, under)).mul(mix(1, 0.55, wet));
  const baseRough = opts.roughnessNode || materialRoughness;
  mat.roughnessNode = mix(baseRough, baseRough.mul(0.35), wet);
  // direct sun: everything below the water gets the refracted, attenuated, caustic-focused sun
  const sunFactor = Fn(() => {
    const d = max(depth, 0);
    const ratio = O.sunTransmittance(d).div(max(Tamb, vec3(1e-4))).mul(0.97);
    const c = O.caustic(p, d);
    return mix(vec3(1), ratio.mul(c), under);
  })();
  mat.receivedShadowNode = (shadow) => shadow.mul(sunFactor);
  return mat;
}

const casterMaterial = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
function shadowCaster(geometry, transformFrom = null) {
  const m = new THREE.Mesh(geometry, casterMaterial);
  if (transformFrom) { m.position.copy(transformFrom.position); m.quaternion.copy(transformFrom.quaternion); m.scale.copy(transformFrom.scale); }
  m.castShadow = true;
  m.layers.set(SHADOW_LAYER);
  return m;
}

function toNodeMaterial(m) {
  const n = new THREE.MeshStandardNodeMaterial();
  for (const k of ["map", "normalMap", "roughnessMap", "metalnessMap", "aoMap", "roughness", "metalness", "color", "normalScale", "side"]) if (m[k] !== undefined) n[k] = m[k];
  n.envMapIntensity = 1;
  return n;
}

export async function buildWorld(scene, O, sky, params) {
  const tl = new THREE.TextureLoader();
  // ---------------- seabed / beach
  const SIZE = 420, SEG = 640, CX = 0, CZ = 20;
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + CX, z = pos.getZ(i) + CZ;
    pos.setXYZ(i, x, terrainHeight(x, z), z);
  }
  geo.computeVertexNormals();
  const sand = "coast_sand_01", sr = "coast_sand_rocks_02";
  const T = (name, tag, srgb) => loadTex(tl, `${ASSETS}textures/${name}/${name}_${tag}_2k.webp`, srgb);
  const sandD = T(sand, "diff", true), sandN = T(sand, "nor_gl", false), sandA = T(sand, "arm", false);
  const rockD = T(sr, "diff", true), rockN = T(sr, "nor_gl", false), rockA = T(sr, "arm", false);
  const tm = new THREE.MeshStandardNodeMaterial();
  const uvS = positionWorld.xz.div(3.2);
  const uvR = positionWorld.xz.div(5.5);
  // macro blend: rocky sand on the reef shelf and in patches, clean sand elsewhere
  const patch = saturate(mx_fractal_noise_float(vec3(positionWorld.xz.mul(0.06), 1.7), 3).mul(1.4).add(0.15)
    .add(exp(positionWorld.x.sub(9).pow(2).add(positionWorld.z.add(7).pow(2)).negate().div(90)).mul(0.9)));
  // both vary over tens of metres: evaluated per vertex (0.66 m grid) and interpolated, not per pixel
  const blend = varying(smoothstep(0.35, 0.65, patch), "vTerrainBlend");
  const macro = varying(mx_noise_float(vec3(positionWorld.xz.mul(0.015), 3.1)).mul(0.12).add(1), "vTerrainMacro");
  tm.colorNode = mix(texture(sandD, uvS).rgb, texture(rockD, uvR).rgb, blend).mul(macro);
  const armS = texture(sandA, uvS), armR = texture(rockA, uvR);
  tm.roughnessNode = mix(armS.g, armR.g, blend);
  tm.metalnessNode = float(0);
  tm.aoNode = mix(armS.r, armR.r, blend);
  tm.normalNode = normalMap(mix(texture(sandN, uvS), texture(rockN, uvR), blend), vec2(1.2));
  underwaterize(tm, O, { colorNode: tm.colorNode, roughnessNode: tm.roughnessNode });
  const terrain = new THREE.Mesh(geo, tm);
  terrain.receiveShadow = true;
  scene.add(terrain);
  // the dunes only shadow themselves faintly: a 4x coarser copy casts the shadow
  const sgeo = new THREE.PlaneGeometry(SIZE, SIZE, SEG / 4, SEG / 4);
  sgeo.rotateX(-Math.PI / 2);
  const sp = sgeo.attributes.position;
  // sunk by the largest deviation of the coarse surface from the fine one (~0.2 m of small-scale noise), so it
  // never pokes above the rendered terrain and shadows it in blotches
  for (let i = 0; i < sp.count; i++) { const x = sp.getX(i) + CX, z = sp.getZ(i) + CZ; sp.setXYZ(i, x, terrainHeight(x, z) - 0.2, z); }
  scene.add(shadowCaster(sgeo));

  // ---------------- rocks
  // models (tools/build_assets.mjs): meshes lod0..n + "shadow", extras.lodError = absolute error per LOD
  const gl = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const load = async (name) => {
    const g = await gl.loadAsync(`${ASSETS}models/${name}.glb`);
    const lods = [], { lodError } = g.scene.userData;
    let shadow = null, material = null;
    g.scene.traverse(o => {
      if (!o.isMesh) return;
      if (o.name === "shadow") shadow = o;
      else lods[+o.name.slice(3)] = o;
    });
    for (const o of lods) { material = material || underwaterize(toNodeMaterial(o.material), O); o.material = material; }
    return { lods, lodError, shadow };
  };
  // level i is good enough once its error projects below LOD_PIXEL_ERROR; distances follow the internal render
  // height and fov (updateLods, called on resize / fov change)
  const lodList = [];
  const updateLods = (heightPx, fov) => {
    const focal = heightPx / (2 * Math.tan((fov * Math.PI) / 360));
    for (const { lod, errors } of lodList) lod.levels.forEach((l, i) => { l.distance = (errors[i] * focal) / LOD_PIXEL_ERROR; });
  };
  const place = (src, x, z, yOff, rotY, sx, sy = sx, sz = sx) => {
    const lod = new THREE.LOD();
    const s = Math.max(sx, sy, sz);
    const errors = src.lods.map((m, i) => (i === 0 ? 0 : src.lodError[i] * s));
    src.lods.forEach((m, i) => {
      const c = m.clone();
      c.receiveShadow = true;
      lod.addLevel(c, i);   // placeholder distance (ascending), set by updateLods
    });
    lodList.push({ lod, errors });
    // meshes keep their node transform (it carries the meshopt dequantisation), so wrap them
    const caster = new THREE.Group().add(shadowCaster(src.shadow.geometry, src.shadow));
    for (const o of [lod, caster]) {
      o.position.set(x, terrainHeight(x, z) + yOff, z);
      o.rotation.y = rotY;
      o.scale.set(sx, sy, sz);
      scene.add(o);
    }
    return lod;
  };
  const [boulder, smallRocks, shelf1, shelf2, cliff, shell] = await Promise.all(
    ["coast_rocks_05", "sand_rocks_small_01", "coast_rocks_01", "coast_rocks_02", "coastal_cliff_02", "lambis_shell"].map(load));
  // hero: a boulder breaking the surface ~6 m in front of the over/under camera (camera path z ~ 13-17)
  place(boulder, 2.6, 22.5, -0.5, 0.5, 2.3, 3.1, 2.1);
  place(boulder, -4.6, 25.0, -0.6, 2.3, 1.7, 2.4, 1.6);
  // underwater set dressing around the path
  place(boulder, 4.5, 15.5, -1.0, 4.0, 1.3);
  place(boulder, -5.5, 12.0, -0.9, 2.1, 1.5);
  place(boulder, 8.0, 6.0, -0.8, 5.0, 1.8);
  place(boulder, -9.0, 19.0, -0.8, 1.0, 1.4);
  place(smallRocks, -1.8, 17.5, -0.2, 0.3, 1.1);
  place(smallRocks, 2.2, 13.0, -0.2, 2.0, 1.3);
  place(smallRocks, 6.0, 19.5, -0.2, 4.4, 1.5);
  place(smallRocks, -3.5, 8.0, -0.2, 1.1, 1.4);
  place(shell, 0.4, 15.2, 0.0, 1.0, 1.6);
  // shoreline rock platforms and cliffs behind the beach (staggered, not a flat wall)
  place(shelf1, -40, 44, -1.2, 0.35, 1.0);
  place(shelf2, 34, 42, -1.4, -0.5, 1.0);
  // sunk well into the dunes so they read as outcrops, not blocks standing on the sand
  place(cliff, -20, 112, -5.5, Math.PI * 1.08, 1.9);
  place(cliff, -66, 104, -6.0, Math.PI * 0.86, 2.1);
  place(cliff, 34, 116, -6.0, Math.PI * 1.15, 2.0);
  place(cliff, 86, 100, -5.0, Math.PI * 1.28, 2.2);
  updateLods(1080 * params.renderScale, params.fov);
  return { terrain, updateLods };
}
