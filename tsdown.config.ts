import { defineConfig, type UserConfig } from "tsdown";

const shared: UserConfig = {
  format: ["esm", "cjs"],
  fixedExtension: true,
  dts: true,
  target: "node22",
  outDir: "dist",
  clean: false,
};

export default defineConfig([
  {
    ...shared,
    clean: true,
    platform: "node",
    entry: { index: "src/index.ts", testing: "src/testing/index.ts" },
  },
  {
    ...shared,
    // The client entry point runs in browsers and React Native, so it must not
    // resolve Node built-ins.
    platform: "neutral",
    entry: { client: "src/client/index.ts" },
  },
]);
