import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  splitting: false,
  sourcemap: false,
  dts: false,
  shims: true,
  banner: { js: "#!/usr/bin/env node" },
  // sharp is optional & native; never bundle it.
  external: ["sharp"],
});
