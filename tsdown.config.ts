import { defineConfig } from "tsdown";

export default defineConfig([{
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
}, {
  entry: ["src/dsh-bridge/plugin.ts"], outDir: "dsh-execution-bridge/lib", clean: true, dts: false, format: ["esm"], platform: "node", target: "node22", minify: false,
  deps: { alwaysBundle: [/^(?!@deepseek-ai\/).*/], neverBundle: [/^@deepseek-ai\//], onlyBundle: false },
}]);
