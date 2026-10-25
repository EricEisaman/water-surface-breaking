import { defineConfig } from "vite";

export default defineConfig({
  base: "/water-surface-breaking/",

  server: {
    port: 5195,
    strictPort: true,
  },

  build: {
    target: "esnext",
    chunkSizeWarningLimit: 4000,
  },
});
