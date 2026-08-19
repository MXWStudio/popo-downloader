import { build } from "esbuild";
import { mkdir } from "node:fs/promises";

await mkdir("runtime", { recursive: true });

const shared = {
  entryPoints: ["src/index.ts"],
  bundle: true,
  target: ["chrome114"],
  sourcemap: false,
  legalComments: "none",
  logLevel: "warning",
  define: {
    __POPO_DIAGNOSTIC_DSN__: JSON.stringify(process.env.POPO_DIAGNOSTIC_DSN || "")
  }
};

await build({
  ...shared,
  format: "iife",
  globalName: "PopoRuntime",
  outfile: "runtime/popo-runtime.js"
});

await build({
  ...shared,
  platform: "node",
  format: "cjs",
  outfile: "runtime/popo-runtime.cjs"
});

const uiShared = {
  bundle: true,
  platform: "browser",
  format: "iife",
  target: ["chrome114"],
  minify: true,
  sourcemap: false,
  legalComments: "none",
  logLevel: "warning",
  define: {
    "process.env.NODE_ENV": '"production"'
  }
};

await Promise.all([
  build({
    ...uiShared,
    entryPoints: ["src/popup.tsx"],
    outfile: "runtime/popup.js"
  }),
  build({
    ...uiShared,
    entryPoints: ["src/page-ui.tsx"],
    outfile: "runtime/page-ui.js"
  })
]);
