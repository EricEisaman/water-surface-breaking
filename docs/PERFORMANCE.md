# Performance and profiling

Minamo targets desktop GPUs. On a laptop RTX 4070 at 1920×1080 output, a frame takes roughly **7 ms of GPU time with the default `high` preset**, about 5 ms with `medium` and about 4 ms with `low`. Your numbers will differ with the GPU, the driver and the browser; treat these as orders of magnitude, not as a benchmark.

## Quality presets

Pick one with `?quality=high|medium|low` or in the panel (top right).

| Preset | What changes |
|---|---|
| `high` (default) | Renders internally at 1.25× the window size (supersampling instead of TAA), 40 light-shaft steps |
| `medium` | Native resolution, 40 light-shaft steps |
| `low` | 0.8× resolution, 24 light-shaft steps |

Any number in `src/params.js` can also be set from the URL, for example `?renderScale=1.5&godraySteps=64`. Rock LOD distances are recomputed from the internal resolution and the field of view, so changing the preset, the window size or the FOV keeps the same on-screen detail.

## Where the time goes

Roughly, with the `high` preset and the camera above the water:

| Part | Share |
|---|---|
| Opaque scene (rocks, terrain) and its shadow map | about 2.5–3 ms |
| Water surface (two background copies, back and front faces) | about 1.3 ms |
| Caustics (three dispersion passes + mips) | about 0.7 ms |
| Per-pixel waterline test (`nearS`) | about 0.5 ms |
| Ocean FFT and assembly | about 0.3 ms |
| Underwater compositing and light shafts | about 0.3–0.6 ms |
| Lens (water film, drops) | about 0.4 ms, up to 1 ms right after the camera leaves the water |
| Bloom, exposure, tone mapping | about 0.4 ms |

## Profiling it yourself

- Press **P** in the page for a live per-pass table. It uses WebGPU timestamp queries; in a normal Chrome they are quantised to 100 µs, so read it as a rough guide.
- For exact numbers, build and run the benchmark in a fresh Chrome with developer features on and vsync off:

  ```bash
  npm run build
  node tools/capture.mjs --bench 240 [--views above,half,under,snell] [--query "quality=medium"] [--json out/bench.json]
  ```

  It renders each fixed view for 240 frames with continuous `requestAnimationFrame` submission and prints the GPU time of every pass, the GPU frame span (first pass start to last pass end) and the wall time per frame. On a laptop, differences below about 0.3 ms are within noise.
- `src/perf/gpuProfiler.js` wraps `beginRenderPass` / `beginComputePass` and adds timestamp writes, so three.js's own passes are measured too. Give your own passes a `label` and they show up as `<phase>.<label>`.

## Things that keep it fast

- **No three.js viewport nodes in materials.** Every `viewportSharedTexture()` / `viewportDepthTexture()` node makes three.js end the render pass, copy the whole target and start a new pass. The water material instead reads one background copy made by Minamo itself.
- **Rock LODs with a fixed screen-space error** and coarse, separate shadow casters (the scanned rocks are hundreds of thousands of triangles each at full detail).
- **The waterline test runs once per pixel per frame** and every later pass reads its result.
- **Light shafts at half resolution** with a depth- and medium-aware upsample.
- **Lens beads are skipped on a dry lens.**

## Ideas not done yet

- TAA / temporal upscaling instead of 1.25× supersampling. The biggest win left, but the water's vertex displacement needs its own motion vectors, the lens has to stay after TAA and pixels that change medium must drop their history.
- Caustics in a single pass with dispersion approximated at lookup time.
- A lighter water mesh.
- KTX2 textures to save GPU memory.
- Rock shadows inside the light shafts (a froxel volume).
