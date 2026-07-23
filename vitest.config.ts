import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

export default mergeConfig(
  viteConfig,
  defineConfig({
    root: ".",
    test: {
      environment: "happy-dom",
      include: ["web/src/**/*.test.ts", "web/src/**/*.test.tsx"],
      globals: true,
    },
  }),
);
