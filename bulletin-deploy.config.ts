// Product manifest for the standalone T3RMINAL terminal. Without this file
// bulletin-deploy can only publish a "legacy contenthash" — no product icon,
// displayName, or app.<domain>.dot subname. With it, the publishManifest step
// registers the full Polkadot product manifest.
//
// ⁠ domain ⁠ MUST equal the domain bulletin-deploy is invoked with or
// publishManifest aborts. The domain is chosen interactively in
// scripts/deploy.ts, so it's threaded in via the BULLETIN_DEPLOY_DOMAIN env var
// that deploy.ts sets alongside MNEMONIC; the fallback matches the default
// target in bundle/manifest.toml.
//
// ⁠ icon.path ⁠ and ⁠ executables[].path ⁠ resolve relative to THIS file. ⁠ ./out ⁠
// is Next's static-export directory and is exactly the build dir deploy.ts
// uploads, so the app executable reuses that already-stored CID instead of
// re-uploading the same bytes. This is a single SPA — no widget/worker build —
// so ⁠ app ⁠ is the only executable.
//
// NOTE: this file is excluded from the app's tsconfig, so it is never
// type-checked by ⁠ next build ⁠. At publish time bulletin-deploy loads it via
// jiti, which resolves any imports relative to THIS file — and ⁠ bulletin-deploy ⁠
// is never installed in the app's node_modules (only globally / via npx). So
// ⁠ import { defineConfig } from "bulletin-deploy" ⁠ would throw "Cannot find
// module 'bulletin-deploy'" and abort the manifest publish. defineConfig is only
// an identity helper (config => config) for editor hints, so we define it
// locally instead: zero runtime dependency, same authoring shape.
const defineConfig = <T>(config: T): T => config;

export default defineConfig({
  domain: process.env.BULLETIN_DEPLOY_DOMAIN ?? "t3rminal.dot",
  displayName: "T3RMINAL",
  description:
    "Polkadot point-of-sale terminal — accept payments and anchor signed sales reports on-chain.",
  icon: { path: "./icon.png", format: "png" },
  executables: [
    {
      kind: "app",
      path: "./out",
      appVersion: [0, 1, 0],
    },
  ],
});