import { defineConfig } from "vite";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  root: ".",
  server: { port: 5173, host: "localhost", open: true },
  build: {
    target: "esnext",
    outDir: "dist",
    rollupOptions: { input: resolve(__dirname, "index.html") },
  },
  optimizeDeps: { include: ["three"] },
  assetsInclude: ["**/*.glsl", "**/*.wgsl"],
});
