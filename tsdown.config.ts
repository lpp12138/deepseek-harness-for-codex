import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/bin.ts"],
  clean: true,
  dts: false,
  format: ["esm"],
  minify: false,
  outDir: "plugins/deepseek-harness/dist",
  deps: { alwaysBundle: [/.*/], onlyBundle: false },
  shims: true,
  platform: "node",
  target: "node22",
});
