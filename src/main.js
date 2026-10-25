import * as THREE from "three/webgpu";
import { GUI } from "three/addons/libs/lil-gui.module.min.js";
import { params, applyUrl, QUALITY } from "./params.js";
import { Ocean, half as halfToF } from "./ocean/ocean.js";
import { makeOceanNodes, updateOceanUniforms } from "./ocean/oceanNodes.js";
import { makeWaterMaterial, makeRadialGrid } from "./ocean/waterMaterial.js";
import { loadSky, buildWorld, SHADOW_LAYER } from "./scene/world.js";
import { makeParticles } from "./scene/particles.js";
import { Post } from "./post/post.js";
import { LensDrops, seedDrops } from "./post/lensDrops.js";
import { Sequence } from "./sequence.js";
import { VIEWS, BENCH_VIEWS } from "./views.js";
import { GpuProfiler } from "./perf/gpuProfiler.js";

const query = applyUrl(params);
const CAPTURE = query.has("capture");
if (CAPTURE || query.has("seed")) seedDrops(+(query.get("seed") || 1));
const status = document.getElementById("status");
const say = (t) => { if (status) status.textContent = t; };

async function main() {
  if (!navigator.gpu) { say("WebGPU が使えません / WebGPU not available"); return; }
  const renderer = new THREE.WebGPURenderer({ antialias: false, powerPreference: "high-performance" });
  await renderer.init();
  if (!renderer.backend.isWebGPUBackend) { say("WebGPU backend required"); return; }
  const device = renderer.backend.device;
  device.lost.then(i => say("GPU device lost: " + i.message));
  const prof = new GpuProfiler(device);
  prof.enabled = query.has("prof");
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const canvas = document.getElementById("c");
  const ctx = canvas.getContext("webgpu");
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: "opaque", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });

  say("loading sky…");
  const sky = await loadSky(params.hdri);
  const sun = sky.sun;
  const scene = new THREE.Scene();
  scene.background = sky.texture;
  scene.environment = sky.texture;

  const ocean = new Ocean(device, params);
  const O = makeOceanNodes(ocean, params);
  // the water is rendered after the opaque scene from its own scenes (back faces, then front faces) with a
  // backdrop copy (colour + linear depth) before each, see Post.copyBackdrop
  const external = (gpuTexture, float32 = false) => {
    const t = new THREE.ExternalTexture(gpuTexture);
    if (float32) { t.type = THREE.FloatType; t.format = THREE.RedFormat; t.minFilter = t.magFilter = THREE.NearestFilter; }
    return t;
  };
  const water = makeWaterMaterial(O, sky.texture, params,
    external(device.createTexture({ size: [1, 1], format: "rgba16float", usage: GPUTextureUsage.TEXTURE_BINDING })),
    external(device.createTexture({ size: [1, 1], format: "r32float", usage: GPUTextureUsage.TEXTURE_BINDING }), true));
  const waterGrid = makeRadialGrid();
  const waterScenes = [water.backMaterial, water.material].map(m => {
    const mesh = new THREE.Mesh(waterGrid, m);
    mesh.frustumCulled = false;
    return new THREE.Scene().add(mesh);
  });

  const sunLight = new THREE.DirectionalLight(0xffffff, 1);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(4096, 4096);
  const sc = sunLight.shadow.camera;
  sc.left = -45; sc.right = 45; sc.top = 45; sc.bottom = -45; sc.near = 1; sc.far = 400;
  sunLight.shadow.bias = -0.0004;
  sunLight.shadow.normalBias = 0.03;
  sc.layers.enable(SHADOW_LAYER);   // low-poly shadow casters (main camera: layer 0 only)
  scene.add(sunLight, sunLight.target);

  say("loading scene…");
  const world = await buildWorld(scene, O, sky, params);
  const particles = makeParticles(O);
  scene.add(particles.mesh);

  const camera = new THREE.PerspectiveCamera(params.fov, 16 / 9, 0.05, 20000);
  // WebGPU clip z in [0, 1] from the start: post.prepare (nearS) unprojects before the first three.js render,
  // which would otherwise still see the WebGL convention on the first frame
  camera.coordinateSystem = THREE.WebGPUCoordinateSystem;
  camera.position.set(-1.2, 1.25, -4);
  camera.lookAt(1.5, 0.6, 20);

  const post = new Post(device, ocean, format);
  const drops = new LensDrops();
  const seq = new Sequence();

  // ---------------------------------------------------------------- sizing
  let rt = null, W = 0, H = 0, cssW = 0, cssH = 0;
  function resize(w, h) {
    cssW = w; cssH = h;
    canvas.width = w; canvas.height = h;
    const s = params.renderScale;
    // at least 64 px: post.A has 7 mip levels (also covers a minimised window)
    const rw = Math.max(64, Math.round(w * s)), rh = Math.max(64, Math.round(h * s));
    if (rt && rw === W && rh === H) return;
    W = rw; H = rh;
    if (rt) rt.dispose();
    rt = new THREE.RenderTarget(W, H, { type: THREE.HalfFloatType, depthBuffer: true });
    rt.depthTexture = new THREE.DepthTexture(W, H);
    camera.aspect = w / Math.max(h, 1);
    camera.updateProjectionMatrix();
    world.updateLods(H, camera.fov);
    post.resize(W, H);
    water.setBackdrop(external(post.backdrop));
    water.setNearS(external(post.nearTex, true));
    rt._needsPostBind = true;
  }
  const fitWindow = () => { if (!fixedSize) resize(Math.round(innerWidth * Math.min(devicePixelRatio, 2)), Math.round(innerHeight * Math.min(devicePixelRatio, 2))); };
  let fixedSize = false;
  addEventListener("resize", fitWindow);
  fitWindow();

  // ---------------------------------------------------------------- free-fly camera
  const keys = new Set();
  let yaw = 0, pitch = 0, dragging = false, mode = CAPTURE ? "seq" : (query.get("mode") || "seq");
  const syncAngles = () => { const d = camera.getWorldDirection(new THREE.Vector3()); yaw = Math.atan2(d.x, d.z); pitch = Math.asin(d.y); };
  syncAngles();
  const viewNames = Object.keys(VIEWS);
  let fixedCam = null;
  const setView = (name) => {
    const [pos, target] = VIEWS[name];
    mode = "fixed"; fixedCam = name;
    camera.position.set(...pos); camera.lookAt(...target); camera.updateMatrixWorld(); syncAngles();
  };
  addEventListener("keydown", e => {
    keys.add(e.code);
    if (e.code === "Space") { mode = mode === "seq" ? "free" : "seq"; syncAngles(); }
    if (e.code === "KeyP") { prof.enabled = !prof.enabled; prof.reset(); }
    const k = +e.key;
    if (k >= 1 && k <= viewNames.length) setView(viewNames[k - 1]);
    if (e.key === "0") mode = "seq";
  });
  addEventListener("keyup", e => keys.delete(e.code));
  canvas.addEventListener("pointerdown", e => { dragging = true; canvas.setPointerCapture(e.pointerId); if (mode !== "free") { mode = "free"; syncAngles(); } });
  canvas.addEventListener("pointerup", () => { dragging = false; });
  canvas.addEventListener("pointermove", e => {
    if (!dragging) return;
    yaw -= e.movementX * 0.003; pitch = Math.max(-1.5, Math.min(1.5, pitch - e.movementY * 0.003));
  });
  const vel = new THREE.Vector3();
  function freeFly(dt) {
    const sp = keys.has("ShiftLeft") ? 6 : keys.has("ControlLeft") ? 0.25 : 1.5;
    const f = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    const r = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0)).normalize();
    const want = new THREE.Vector3();
    if (keys.has("KeyW")) want.add(f); if (keys.has("KeyS")) want.sub(f);
    if (keys.has("KeyD")) want.add(r); if (keys.has("KeyA")) want.sub(r);
    if (keys.has("KeyE")) want.y += 1; if (keys.has("KeyQ")) want.y -= 1;
    want.multiplyScalar(sp);
    vel.lerp(want, 1 - Math.exp(-dt * 6));
    camera.position.addScaledVector(vel, dt);
    camera.lookAt(camera.position.clone().add(f));
  }

  // ---------------------------------------------------------------- GUI
  if (!CAPTURE && !query.has("nogui")) {
    const gui = new GUI({ title: "water-surface-breaking 水面" });
    gui.close();
    const rebuild = () => ocean.rebuildSpectrum();
    const g1 = gui.addFolder("Ocean");
    g1.add(params, "windSpeed", 1, 15, 0.1).onFinishChange(rebuild);
    g1.add(params, "fetch", 1, 300, 1).name("fetch km").onFinishChange(rebuild);
    g1.add(params, "windDir", 0, 360, 1).onFinishChange(rebuild);
    g1.add(params, "swellHeight", 0, 2, 0.01).onFinishChange(rebuild);
    g1.add(params, "swellLength", 10, 200, 1).onFinishChange(rebuild);
    g1.add(params, "choppiness", 0, 1.6, 0.01);
    g1.add(params, "foamStrength", 0, 2, 0.01);
    const g2 = gui.addFolder("Water optics");
    g2.add(params.sigmaA, "0", 0, 1, 0.005).name("absorb R");
    g2.add(params.sigmaA, "1", 0, 0.5, 0.005).name("absorb G");
    g2.add(params.sigmaA, "2", 0, 0.5, 0.005).name("absorb B");
    g2.add(params.sigmaS, "0", 0, 0.5, 0.005).name("scatter R");
    g2.add(params.sigmaS, "1", 0, 0.5, 0.005).name("scatter G");
    g2.add(params.sigmaS, "2", 0, 0.5, 0.005).name("scatter B");
    g2.add(params, "msBoost", 0, 6, 0.1);
    g2.add(params, "causticStrength", 0, 2, 0.01);
    g2.add(params, "causticDepth", 0.5, 10, 0.1);
    g2.add(params, "causticBlur", 0, 2, 0.01);
    g2.add(params, "godrays", 0, 1, 0.01);
    g2.add(params, "godraySteps", 0, 96, 1);
    const g3 = gui.addFolder("Lens");
    for (const k of ["bandWidth", "meniscusRefract", "waterlineDark", "highlight", "dropRefract", "dropBlur", "rimDark", "filmRefract", "drainSpeed", "filmTau", "wetTau", "beadDensity", "drops", "dropSize", "slideSpeed", "evaporate"])
      g3.add(params, k, 0, k === "evaporate" || k === "wetTau" ? 30 : k === "bandWidth" ? 0.05 : 3, 0.001);
    gui.add(params, "quality", Object.keys(QUALITY)).onChange(q => {
      Object.assign(params, QUALITY[q]);
      gui.controllersRecursive().forEach(c => c.updateDisplay());
      W = 0; resize(cssW, cssH);
    });
    const g4 = gui.addFolder("Camera");
    g4.add(params, "autoExposure");
    g4.add(params, "exposure", 0.05, 8, 0.01);
    g4.add(params, "exposureKey", 0.02, 0.6, 0.01);
    g4.add(params, "bloom", 0, 0.2, 0.001);
    g4.add(params, "renderScale", 0.5, 2, 0.05).onFinishChange(() => { W = 0; resize(cssW, cssH); });
    g4.add(params, "fov", 20, 100, 1).onChange(v => { camera.fov = v; camera.updateProjectionMatrix(); world.updateLods(H, v); });
  }

  // ---------------------------------------------------------------- frame
  let floatH = 0, time = 0, seqTime = +(query.get("t") || 0), last = performance.now(), fps = 0, frameMs = 0;
  const submergedAt = (u, v) => {
    const p = new THREE.Vector3(u * 2 - 1, 1 - v * 2, 0).unproject(camera);   // WebGPU clip z: 0 = near plane
    return p.y < ocean.heightAt(p.x, p.z);
  };
  const _near = new THREE.Vector3();

  function frame(dt) {
    prof.beginFrame();
    time += dt;
    if (mode === "seq") {
      seqTime += dt; if (seqTime > seq.duration + 2) seqTime = 0;
      seq.apply(camera, Math.min(seqTime, seq.duration));
      // the camera floats like a hand-held housing near the surface: y is relative to the (lagged) local
      // water height, fully when close to it, fading out further away. The lag makes the waterline slosh.
      const h = ocean.heightAt(camera.position.x, camera.position.z);
      floatH += (h - floatH) * (1 - Math.exp(-dt / params.floatLag));
      const rel = camera.position.y;
      camera.position.y = rel + floatH * Math.exp(-Math.abs(rel) / 0.8) * params.floatFollow;
    }
    else if (mode === "free") freeFly(dt);
    camera.updateMatrixWorld();

    // sun follows the camera for a tight shadow frustum
    sunLight.color.copy(sun.color).multiplyScalar(params.sunScale);
    sunLight.intensity = 1;
    const fwd = camera.getWorldDirection(new THREE.Vector3());
    const focus = camera.position.clone().addScaledVector(fwd, 25);
    sunLight.target.position.copy(focus);
    sunLight.position.copy(focus).addScaledVector(sun.dir, 150);
    sunLight.target.updateMatrixWorld();

    const sunState = { dir: sun.dir, color: sunLight.color, ambient: sun.ambient };
    updateOceanUniforms(O, params, sunState);
    O.U.camXZ.value.set(camera.position.x, camera.position.z);
    O.U.camFwd.value.copy(fwd);
    O.U.time.value = time;
    water.uniforms.roughness.value = params.waterRoughness;
    water.uniforms.sss.value = params.sss;
    water.uniforms.refractStrength.value = params.refractStrength;
    particles.update(camera, time);

    // 1) ocean compute + caustics
    prof.phase = "ocean";
    let enc = device.createCommandEncoder({ label: "ocean" });
    ocean.update(dt, enc, camera.position, sun.dir);
    // lens droplets (CPU), post uniforms and the per-pixel near-plane wave test (read by the water material)
    post.updateDown(camera);
    const n = drops.update(dt, submergedAt, post.down, cssW / cssH, params);
    post.setDrops(drops.buf, n);
    post.prepare(enc, camera, params, sunState, O.U, dt, time);
    device.queue.submit([enc.finish()]);
    ocean.afterSubmit();
    O.U.causticOrigin.value.set(...ocean.caustics.origin);

    // 2) scene (three.js) into the HDR target
    prof.phase = "scene";
    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);
    if (rt._needsPostBind) {
      const colorGPU = renderer.backend.get(rt.texture).texture;
      const depthGPU = renderer.backend.get(rt.depthTexture).texture;
      post.bindScene(colorGPU, depthGPU);
      prof.mainTarget = colorGPU;
      rt._needsPostBind = false;
    }
    prof.phase = "water";
    renderer.autoClear = false;
    for (const ws of waterScenes) {
      enc = device.createCommandEncoder({ label: "backdrop" });
      post.copyBackdrop(enc, camera);
      device.queue.submit([enc.finish()]);
      renderer.render(ws, camera);
    }
    renderer.autoClear = true;
    prof.phase = "post";

    // 3) post stack -> canvas
    enc = device.createCommandEncoder({ label: "post" });
    const target = ctx.getCurrentTexture();
    post.render(enc, target.createView());
    device.queue.submit([enc.finish()]);
    prof.endFrame();
    return target;
  }

  let hudAt = 0, profText = "";
  const profTable = () => {
    const st = prof.stats(60);
    if (!st.frames) return prof.supported ? "GPU timing…" : "timestamp-query not supported";
    const row = (k, v) => `${k.padEnd(18)} ${v.toFixed(2).padStart(6)} ms`;
    return [...Object.entries(st.passes).map(([k, v]) => row(k, v)), row("sum of passes", st.total), row("GPU frame span", st.span)].join("\n");
  };
  let benching = false;   // MN.bench drives frame() itself
  function loop(now) {
    const dt = Math.min((now - last) / 1000, 1 / 20);
    last = now;
    if (benching) { requestAnimationFrame(loop); return; }
    const t0 = performance.now();
    frame(dt);
    frameMs = frameMs * 0.9 + (performance.now() - t0) * 0.1;
    fps = fps * 0.95 + (1 / Math.max(dt, 1e-3)) * 0.05;
    if (status && !CAPTURE) {
      const camS = camera.position.y - ocean.heightAt(camera.position.x, camera.position.z);
      status.textContent = `${fps.toFixed(0)} fps · ${W}×${H} · Hs ${ocean.hs.toFixed(2)} m · camera ${camS >= 0 ? "+" : ""}${camS.toFixed(2)} m · ${mode === "seq" ? "demo (drag / Space = free fly)" : mode === "fixed" ? `view ${fixedCam} (0 = demo)` : "free fly: WASD QE, Shift/Ctrl, drag to look, Space = demo"} · 1-${viewNames.length} views · P = GPU timing`;
      if (prof.enabled) {
        if (now - hudAt > 500) { hudAt = now; profText = profTable(); }
        status.textContent += "\n" + profText;
      }
    }
    requestAnimationFrame(loop);
  }

  // ---------------------------------------------------------------- capture API (tools/capture.mjs)
  // copy synchronously right after the frame (before the canvas texture is presented), map later
  function grabCopy(tex) {
    const bpr = Math.ceil((tex.width * 4) / 256) * 256;
    const buf = device.createBuffer({ size: bpr * tex.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [tex.width, tex.height]);
    device.queue.submit([enc.finish()]);
    return { tex: { width: tex.width, height: tex.height }, buf, bpr };
  }
  async function grab({ tex, buf, bpr }) {
    await buf.mapAsync(GPUMapMode.READ);
    const src = new Uint8Array(buf.getMappedRange());
    const img = new ImageData(tex.width, tex.height);
    const bgra = format === "bgra8unorm";
    for (let y = 0; y < tex.height; y++)
      for (let x = 0; x < tex.width; x++) {
        const s = y * bpr + x * 4, d = (y * tex.width + x) * 4;
        img.data[d] = src[s + (bgra ? 2 : 0)]; img.data[d + 1] = src[s + 1]; img.data[d + 2] = src[s + (bgra ? 0 : 2)]; img.data[d + 3] = 255;
      }
    buf.unmap(); buf.destroy();
    const oc = new OffscreenCanvas(tex.width, tex.height);
    oc.getContext("2d").putImageData(img, 0, 0);
    const blob = await oc.convertToBlob({ type: "image/png" });
    const b = new Uint8Array(await blob.arrayBuffer());
    let s = "";
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(s);
  }

  window.MN = {
    ready: false,
    params,
    setSize(w, h) { fixedSize = true; canvas.style.width = "100vw"; canvas.style.height = "auto"; resize(w, h); },
    // deterministic stepping for recordings: the lens film / drops / exposure need consecutive frames
    async step(dt, opts = {}) {
      if (opts.seqTime !== undefined) { mode = "seq"; seqTime = opts.seqTime; }
      if (opts.cam) { mode = "fixed"; camera.position.set(...opts.cam.pos); camera.lookAt(...opts.cam.target); if (opts.cam.fov) { camera.fov = opts.cam.fov; camera.updateProjectionMatrix(); } }
      const target = frame(dt);
      const copy = opts.grab ? grabCopy(target) : null;
      await device.queue.onSubmittedWorkDone();
      if (copy) return await grab(copy);
      return true;
    },
    // continuous rAF submission (no per-frame await), fixed camera, GPU time per pass from timestamp queries.
    // dt is fixed so every run simulates the same ocean; wall-clock ms is only meaningful without vsync.
    async bench({ views = BENCH_VIEWS, frames = 120, warm = 30 } = {}) {
      const out = {};
      const raf = () => new Promise(r => requestAnimationFrame(r));
      const was = prof.enabled;
      prof.enabled = true;
      benching = true;
      for (const v of views) {
        setView(v);
        for (let i = 0; i < warm; i++) { frame(1 / 60); await raf(); }
        await device.queue.onSubmittedWorkDone();
        await new Promise(r => setTimeout(r, 50));
        prof.reset();
        let cpu = 0;
        const t0 = performance.now();
        for (let i = 0; i < frames; i++) {
          const c0 = performance.now();
          frame(1 / 60);
          cpu += performance.now() - c0;
          await raf();
        }
        await device.queue.onSubmittedWorkDone();
        const wall = (performance.now() - t0) / frames;
        await new Promise(r => setTimeout(r, 100));
        out[v] = { wallMs: wall, cpuMs: cpu / frames, ...prof.stats(frames) };
      }
      prof.enabled = was;
      benching = false;
      return out;
    },
    async readPixel(name, x, y) {
      const t = { scene: renderer.backend.get(rt.texture).texture, A: post.texA, B: post.texB, depth: null }[name];
      const b = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const e = device.createCommandEncoder();
      e.copyTextureToBuffer({ texture: t, origin: [x, y] }, { buffer: b, bytesPerRow: 256 }, [1, 1]);
      device.queue.submit([e.finish()]);
      await b.mapAsync(GPUMapMode.READ);
      const v = Array.from(new Uint16Array(b.getMappedRange().slice(0, 8))).map(h => halfToF(h));
      b.unmap(); return v;
    },
    async debug() {
      const read = async (tex, x, y) => {
        const b = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const e = device.createCommandEncoder();
        e.copyTextureToBuffer({ texture: tex, origin: [x, y] }, { buffer: b, bytesPerRow: 256 }, [1, 1]);
        device.queue.submit([e.finish()]);
        await b.mapAsync(GPUMapMode.READ);
        const v = Array.from(new Uint16Array(b.getMappedRange().slice(0, 8))).map(h => +halfToF(h).toFixed(4));
        b.unmap(); return v;
      };
      const eb = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const e = device.createCommandEncoder(); e.copyBufferToBuffer(post.exposureBuf, 0, eb, 0, 16); device.queue.submit([e.finish()]);
      await eb.mapAsync(GPUMapMode.READ); const ex = Array.from(new Float32Array(eb.getMappedRange().slice(0)));
      const out = { ex };
      for (const [n, t] of [["scene", renderer.backend.get(rt.texture).texture], ["A", post.texA], ["B", post.texB], ["disp0", ocean.disp[0]], ["caus", ocean.caustics.texture]])
        out[n] = [await read(t, t.width >> 1, t.height >> 1), await read(t, t.width >> 1, t.height >> 3)];
      return out;
    },
    // rgba16float texture (mip 0) -> PNG, value * scale (debug)
    async dumpTexture(name, scale = 1) {
      const tex = { caustics: ocean.caustics.texture, A: post.texA, disp0: ocean.disp[0], deriv2: ocean.deriv[2], foam1: ocean.foam[1] }[name];
      const w = tex.width, h = tex.height, bpr = Math.ceil((w * 8) / 256) * 256;
      const b = device.createBuffer({ size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const e = device.createCommandEncoder();
      e.copyTextureToBuffer({ texture: tex }, { buffer: b, bytesPerRow: bpr }, [w, h]);
      device.queue.submit([e.finish()]);
      await b.mapAsync(GPUMapMode.READ);
      const src = new Uint16Array(b.getMappedRange());
      const img = new ImageData(w, h);
      let sum = 0, mx = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) {
        const v = halfToF(src[(y * bpr) / 2 + x * 4 + c]);
        if (c === 0) { sum += v; mx = Math.max(mx, v); }
        img.data[(y * w + x) * 4 + c] = c === 3 ? 255 : Math.max(0, Math.min(255, v * scale * 255));
      }
      b.unmap();
      const oc = new OffscreenCanvas(w, h); oc.getContext("2d").putImageData(img, 0, 0);
      const bytes = new Uint8Array(await (await oc.convertToBlob({ type: "image/png" })).arrayBuffer());
      let str = ""; for (let i = 0; i < bytes.length; i += 0x8000) str += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return { png: btoa(str), mean: sum / (w * h), max: mx };
    },
    info: () => ({ W, H, hs: ocean.hs, sunDir: sun.dir.toArray(), sunE: sun.color.toArray(), ambient: sun.ambient.toArray(), drops: drops.drops.length, cam: camera.position.toArray() }),
    camera, ocean, sun, prof, scene, renderer,
  };

  // warm-up: compile pipelines before the first real frame
  frame(1 / 60);
  await device.queue.onSubmittedWorkDone();
  say("");
  window.MN.ready = true;
  if (!CAPTURE) requestAnimationFrame(t => { last = t; loop(t); });
}

main().catch(e => { console.error(e); say("Error: " + e.message); });
