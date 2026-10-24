// Build the web assets in public/assets/ from the Poly Haven originals in assets_src/ (tools/fetch_assets.py).
//
//   node tools/build_assets.mjs [--only coast_rocks_05,...]
//
// Models -> one .glb each: error-bounded LODs (meshoptimizer simplifier) plus a coarse shadow-caster mesh, meshopt
// compressed (EXT_meshopt_compression + KHR_mesh_quantization), textures re-encoded as WebP (resized per model).
// The absolute simplification error of every LOD is stored in the scene extras (extras.lodError, model units) so
// the loader can switch levels at a fixed screen-space error (src/scene/world.js).
// Terrain textures -> WebP; the HDRI -> half-float OpenEXR with DWAB compression (tools/hdri_to_exr.py, needs Python 3
// with `pip install OpenEXR numpy`).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { simplifyPrimitive, weld, prune, dedup, meshopt, textureCompress, getBounds } from "@gltf-transform/functions";
import { MeshoptSimplifier, MeshoptEncoder } from "meshoptimizer";
import { runPython } from "./python.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "assets_src");
const OUT = path.join(ROOT, "public", "assets");
const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : null;

// relative errors (fraction of the model extent) per LOD; shadow = the shadow-map caster
const ROCK = { lods: [0.0005, 0.0015, 0.005, 0.015], shadow: 0.002 };
export const MODELS = [
  { name: "coast_rocks_05", res: "2k", tex: 2048, ...ROCK },
  { name: "sand_rocks_small_01", res: "2k", tex: 2048, ...ROCK },
  { name: "coast_rocks_01", res: "2k", tex: 1024, ...ROCK },
  { name: "coast_rocks_02", res: "2k", tex: 1024, ...ROCK },
  { name: "coastal_cliff_02", res: "2k", tex: 1024, ...ROCK },
  { name: "lambis_shell", res: "1k", tex: 1024, lods: [0.001, 0.004], shadow: 0.004 },
];
const TEXTURES = [["coast_sand_01", "2k"], ["coast_sand_rocks_02", "2k"]];
const HDRIS = ["kloofendal_48d_partly_cloudy_puresky_4k"];
const WEBP = { quality: 90, smartSubsample: true, effort: 6 };

await MeshoptSimplifier.ready;
await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.encoder": MeshoptEncoder });
const mb = (n) => (n / 1048576).toFixed(2) + " MB";

function cloneDeep(prim) {
  const p = prim.clone();
  for (const s of prim.listSemantics()) p.setAttribute(s, prim.getAttribute(s).clone());
  p.setIndices(prim.getIndices().clone());
  return p;
}

async function buildModel(m) {
  const dir = path.join(SRC, "models", m.name);
  const doc = await io.read(path.join(dir, `${m.name}_${m.res}.gltf`));
  const root = doc.getRoot();
  const scene = root.listScenes()[0];
  const srcNode = root.listNodes().find(n => n.getMesh());
  const srcMesh = srcNode.getMesh();
  if (srcMesh.listPrimitives().length !== 1) throw new Error(`${m.name}: expected one primitive`);
  await doc.transform(weld());
  const prim = srcMesh.listPrimitives()[0];
  const b = getBounds(srcNode);
  const extent = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
  const tris0 = prim.getIndices().getCount() / 3;
  const levels = [...m.lods.map((e, i) => [`lod${i}`, e]), ["shadow", m.shadow]];
  const counts = [];
  for (const [label, err] of levels) {
    const p = cloneDeep(prim);
    simplifyPrimitive(p, { simplifier: MeshoptSimplifier, ratio: 0, error: err, lockBorder: false });
    if (label === "shadow") for (const s of p.listSemantics()) if (s !== "POSITION") p.setAttribute(s, null);
    const mesh = doc.createMesh(label).addPrimitive(p);
    const node = doc.createNode(label).setMesh(mesh)
      .setTranslation(srcNode.getTranslation()).setRotation(srcNode.getRotation()).setScale(srcNode.getScale());
    scene.addChild(node);
    counts.push(`${label} ${p.getIndices().getCount() / 3}`);
  }
  srcNode.dispose();
  srcMesh.dispose();
  // shadow caster has no material of its own (assigned at load)
  scene.setExtras({ lodError: m.lods.map(e => e * extent), extent });
  for (const mat of root.listMaterials()) {
    // closed scans resting on the sand: back faces are never visible, cull them
    mat.setDoubleSided(false);
  }
  await doc.transform(
    prune(), dedup(),
    textureCompress({ encoder: sharp, targetFormat: "webp", resize: [m.tex, m.tex], ...WEBP }),
    meshopt({ encoder: MeshoptEncoder, level: "medium" }),
  );
  const out = path.join(OUT, "models", `${m.name}.glb`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await io.write(out, doc);
  console.log(`${m.name}: ${tris0} tris -> ${counts.join(", ")}; extent ${extent.toFixed(2)}; ${mb(fs.statSync(out).size)}`);
}

async function buildTexture(name, res) {
  const dir = path.join(SRC, "textures", name);
  for (const f of fs.readdirSync(dir).filter(f => !f.includes("_disp_"))) {   // displacement maps are unused
    const out = path.join(OUT, "textures", name, f.replace(/\.(jpg|png)$/, ".webp"));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await sharp(path.join(dir, f)).webp(WEBP).toFile(out);
    console.log(`${f} -> ${path.basename(out)} ${mb(fs.statSync(out).size)}`);
  }
}

for (const m of MODELS) if (!only || only.includes(m.name)) await buildModel(m);
for (const [name, res] of TEXTURES) if (!only || only.includes(name)) await buildTexture(name, res);
for (const h of HDRIS) {
  if (only && !only.includes(h)) continue;
  const out = path.join(OUT, "hdri", `${h}.exr`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  runPython([path.join(ROOT, "tools", "hdri_to_exr.py"), path.join(SRC, "hdri", `${h}.hdr`), out]);
  console.log(`${h}.hdr -> ${path.basename(out)} ${mb(fs.statSync(out).size)}`);
}
