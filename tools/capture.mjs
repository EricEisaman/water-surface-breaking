// Screenshots, recordings and timing of the demo in a real Chrome on the NVIDIA GPU (WebGPU), over the
// DevTools protocol. No npm packages needed (Node >= 22 has a global WebSocket).
// On dual-GPU laptops Chrome often runs WebGPU on the integrated GPU, so we ask for the high-performance
// adapter and print which one WebGPU actually got.
//
//   npm run build, then:
//   node tools/capture.mjs --shots out/shots [--w 1920 --h 1080] [--only above,half]     one PNG per preset view
//   node tools/capture.mjs --seqshots out/seq --times 2,9,16,27,31                         demo sequence stills
//   node tools/capture.mjs --video out/demo.mp4 [--fps 30] [--from 0 --dur 34]             demo sequence -> mp4
//   node tools/capture.mjs --bench 240 [--views above,half,under,snell] [--json out/bench.json]
//        per-pass GPU ms (timestamp queries), continuous rAF submission, vsync off
//   node tools/capture.mjs --view [--url http://localhost:5195/]                          interactive window
//   any: --query "renderScale=1.5&godraySteps=64"
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VIEWS, BENCH_VIEWS } from "../src/views.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith("--") ? a.push([v.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : true]) : 0, a), []));
const W = +(args.w || 1920), H = +(args.h || 1080);
const CHROME = args.chrome || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PROFILE = path.join(ROOT, "out", ".chrome-profile");
const sleep = ms => new Promise(r => setTimeout(r, ms));


const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".exr": "application/octet-stream", ".jpg": "image/jpeg", ".png": "image/png", ".gltf": "model/gltf+json", ".bin": "application/octet-stream", ".glb": "model/gltf-binary", ".webp": "image/webp" };
function serve() {
  if (!fs.existsSync(path.join(DIST, "index.html"))) throw new Error("dist/ missing: run `npm run build` first");
  const srv = http.createServer((req, res) => {
    const p = path.join(DIST, decodeURIComponent(new URL(req.url, "http://x").pathname));
    const file = fs.existsSync(p) && fs.statSync(p).isDirectory() ? path.join(p, "index.html") : p;
    if (!file.startsWith(DIST) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r => srv.listen(0, "127.0.0.1", () => r(srv)));
}

function launch(url, extra = []) {
  const port = 9333 + Math.floor(Math.random() * 500);
  const proc = spawn(CHROME, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${PROFILE}`, "--no-first-run", "--no-default-browser-check",
    "--mute-audio", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    "--enable-unsafe-webgpu", ...extra, url,
  ], { stdio: "ignore", detached: !!args.view });
  return { proc, port };
}

async function connect(port, match) {
  for (let i = 0; i < 150; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const t = list.find(x => x.type === "page" && match(x.url));
      if (t) {
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((r, j) => { ws.addEventListener("open", r, { once: true }); ws.addEventListener("error", j, { once: true }); });
        let id = 0; const pending = new Map();
        ws.addEventListener("message", ev => {
          const m = JSON.parse(ev.data);
          if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
          if (m.method === "Runtime.consoleAPICalled") console.log("[page]", m.params.type, m.params.args.map(a => a.value ?? a.description).join(" ").slice(0, 1500));
          if (m.method === "Runtime.exceptionThrown") console.log("[page exception]", JSON.stringify(m.params.exceptionDetails).slice(0, 2000));
        });
        const send = (method, params = {}) => new Promise(r => { const k = ++id; pending.set(k, r); ws.send(JSON.stringify({ id: k, method, params })); });
        const evalJs = async expr => {
          const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
          if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 1500));
          return r.result.result.value;
        };
        return { ws, send, evalJs };
      }
    } catch { }
    await sleep(200);
  }
  throw new Error("chrome devtools not reachable");
}

async function findLuid() {
  if (args.luid) return args.luid;
  const { proc, port } = launch("about:blank", ["--headless=new"]);
  try {
    const c = await connect(port, u => u === "about:blank");
    await c.send("Page.navigate", { url: "chrome://gpu" });
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const txt = await c.evalJs("(() => { const v = document.querySelector('info-view'); return v && v.shadowRoot ? v.shadowRoot.textContent : ''; })()");
      const m = txt && txt.match(/\[[^\]]*NVIDIA[^\]]*\][^\n]*?LUID=\{(-?\d+),(\d+)\}/);
      if (m) return `${m[1]},${m[2]}`;
    }
    return null;
  } finally { proc.kill(); await sleep(800); }
}
const luid = await findLuid();
if (!luid) console.warn("no NVIDIA adapter LUID found in chrome://gpu, using the default GPU");
// developer features: un-quantised timestamp queries; vsync / frame-rate limit off so --bench is not capped
const gpuFlags = ["--use-angle=d3d11", "--force_high_performance_gpu", "--enable-webgpu-developer-features", "--disable-gpu-vsync", "--disable-frame-rate-limit", ...(luid ? [`--use-adapter-luid=${luid}`] : [])];

if (args.view) {
  const url = typeof args.url === "string" ? args.url : "http://localhost:5195/";
  launch(url, [...gpuFlags, "--start-maximized"]).proc.unref();
  console.log(`opened ${url} (start \`npm run dev\` first)`);
  process.exit(0);
}

const srv = typeof args.url === "string" ? null : await serve();
const base = typeof args.url === "string" ? args.url : `http://127.0.0.1:${srv.address().port}/`;
const query = `?capture${args.query ? "&" + args.query : ""}`;
const { proc: chrome, port } = launch(base + query, [...gpuFlags, `--window-size=${Math.min(W, 1600) + 40},${Math.min(H, 950) + 140}`]);
let exitCode = 0;
try {
  const { send, evalJs } = await connect(port, u => u.startsWith(base));
  await send("Runtime.enable");
  for (let i = 0; i < 600 && !(await evalJs("!!(window.MN && window.MN.ready)")); i++) {
    await sleep(250);
    const st = await evalJs("document.getElementById('status')?.textContent || ''");
    if (st.startsWith("Error") || st.includes("not available") || st.includes("lost")) throw new Error("page: " + st);
    if (i % 40 === 39) console.log("status:", st);
  }
  if (!(await evalJs("!!(window.MN && window.MN.ready)"))) throw new Error("page did not become ready");
  console.log("adapter:", await evalJs("navigator.gpu.requestAdapter({powerPreference:'high-performance'}).then(a => a ? JSON.stringify({vendor: a.info.vendor, arch: a.info.architecture}) : 'none')"));
  await evalJs(`MN.setSize(${W}, ${H})`);
  const save = (b64, file) => { fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true }); fs.writeFileSync(file, Buffer.from(b64, "base64")); };
  const settle = +(args.settle || 45);

  if (args.shots) {
    const which = typeof args.only === "string" ? args.only.split(",") : Object.keys(VIEWS);
    for (const v of which) {
      const [pos, target] = VIEWS[v];
      for (let i = 0; i < settle; i++) await evalJs(`MN.step(1/60, { cam: { pos: [${pos}], target: [${target}] } })`);
      save(await evalJs(`MN.step(1/60, { cam: { pos: [${pos}], target: [${target}] }, grab: true })`), path.join(args.shots, `${v}.png`));
      console.log("wrote", v);
    }
  }
  if (typeof args.cam === "string") {
    const c = args.cam.split(",").map(Number);
    for (let i = 0; i < settle; i++) await evalJs(`MN.step(1/60, { cam: { pos: [${c.slice(0, 3)}], target: [${c.slice(3, 6)}]${c[6] ? ", fov: " + c[6] : ""} } })`);
    save(await evalJs(`MN.step(1/60, { cam: { pos: [${c.slice(0, 3)}], target: [${c.slice(3, 6)}] }, grab: true })`), args.camshot || "out/cam.png");
    console.log("wrote", args.camshot || "out/cam.png");
  }
  if (args.seqshots) {
    // run the sequence from 0 at 30 fps so lens film / drops / exposure are in the right state
    const times = String(args.times || "2,9,16,22,27,31").split(",").map(Number).sort((a, b) => a - b);
    const fps = 30;
    let f = 0;
    for (const t of times) {
      while (f / fps < t) { await evalJs(`MN.step(${1 / fps}, { seqTime: ${f / fps} })`); f++; }
      save(await evalJs(`MN.step(${1 / fps}, { seqTime: ${f / fps}, grab: true })`), path.join(args.seqshots, `t${String(t).padStart(4, "0")}.png`));
      f++;
      console.log("wrote t =", t);
    }
  }
  if (args.video) {
    const fps = +(args.fps || 30), from = +(args.from || 0), dur = +(args.dur || 34);
    const dir = path.join(ROOT, "out", "frames");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    // pre-roll a second so the exposure and lens state are settled at the first frame
    for (let i = 0; i < fps; i++) await evalJs(`MN.step(${1 / fps}, { seqTime: ${Math.max(0, from - 1 + i / fps)} })`);
    const n = Math.round(fps * dur);
    const t0 = Date.now();
    for (let f = 0; f < n; f++) {
      save(await evalJs(`MN.step(${1 / fps}, { seqTime: ${from + f / fps}, grab: true })`), path.join(dir, `f${String(f).padStart(5, "0")}.png`));
      if (f % 60 === 0) console.log(`frame ${f}/${n} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    }
    const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(fps), "-i", path.join(dir, "f%05d.png"),
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", String(args.crf || 19), "-preset", "fast", "-movflags", "+faststart", path.resolve(args.video)], { stdio: "inherit" });
    if (r.status !== 0) throw new Error("ffmpeg failed");
    console.log(`wrote ${n} frames -> ${args.video}`);
  }
  if (args.bench) {
    const views = typeof args.views === "string" ? args.views.split(",") : BENCH_VIEWS;
    const frames = args.bench === true ? 240 : +args.bench;
    const r = await evalJs(`MN.bench({ views: ${JSON.stringify(views)}, frames: ${frames}, warm: 60 })`);
    const names = [...new Set(views.flatMap(v => Object.keys(r[v].passes)))];
    const row = (k, f) => console.log(k.padEnd(22) + views.map(v => f(r[v]).toFixed(2).padStart(9)).join(""));
    console.log(`GPU ms per pass, ${W}x${H} output, ${frames} frames`);
    console.log("".padEnd(22) + views.map(v => v.padStart(9)).join(""));
    for (const n of names) row(n, x => x.passes[n] || 0);
    row("sum of passes", x => x.total);
    row("GPU frame span", x => x.span);
    row("wall ms/frame", x => x.wallMs);
    row("CPU ms/frame", x => x.cpuMs);
    if (typeof args.json === "string") { fs.mkdirSync(path.dirname(path.resolve(args.json)), { recursive: true }); fs.writeFileSync(args.json, JSON.stringify({ W, H, frames, query: args.query || "", results: r }, null, 1)); }
  }
  if (typeof args.dump === "string") {
    const [name, scale] = args.dump.split(",");
    const r = await evalJs(`MN.dumpTexture("${name}", ${+(scale || 1)})`);
    save(r.png, `out/dump_${name}.png`);
    console.log("dump", name, "mean", r.mean, "max", r.max);
  }
  if (typeof args.pix === "string") {
    const [x, y] = args.pix.split(",").map(Number);
    for (const n of ["scene", "A", "B"]) console.log("pixel", n, JSON.stringify(await evalJs(`MN.readPixel("${n}", ${x}, ${y})`)));
  }
  if (typeof args.eval === "string") console.log("eval", JSON.stringify(await evalJs(args.eval)));
  if (args.debug) console.log("debug", JSON.stringify(await evalJs("MN.debug()")));
  console.log("info", JSON.stringify(await evalJs("MN.info()")));
} catch (e) {
  console.error(e.message);
  exitCode = 1;
} finally {
  chrome.kill();
  srv?.close();
  setTimeout(() => process.exit(exitCode), 500);
}
