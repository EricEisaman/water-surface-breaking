// Fixed camera presets: [position, look-at]. Shared by the page (keys 1-6, benchmarks) and tools/capture.mjs.
// The first four are the benchmark views (docs/PERFORMANCE.md).
export const VIEWS = {
  above: [[-1.6, 1.3, 9.0], [2.2, 0.4, 23]],
  half: [[-0.8, 0.0, 13.4], [2.5, 0.0, 23]],
  under: [[0.2, -1.5, 15.5], [5.0, -1.2, 22]],
  snell: [[0.6, -2.0, 16.0], [1.0, 3.0, 20.0]],
  shafts: [[0.0, -1.2, 14.0], [6.0, 1.5, 22.0]],
  shore: [[-2.0, 2.2, 8.0], [0.0, 0.5, 40]],
};
export const BENCH_VIEWS = ["above", "half", "under", "snell"];
