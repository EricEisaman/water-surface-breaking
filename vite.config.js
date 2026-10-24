import { defineConfig } from "vite";

export default defineConfig({
  server: { port: 5195, strictPort: true },
  build: { target: "esnext", chunkSizeWarningLimit: 4000 },
});
