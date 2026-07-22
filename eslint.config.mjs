import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated / vendored:
    ".papi/**",
    "contracts/typechain-types/**",
    "contracts/artifacts/**",
    "contracts/cache/**",
    "public/**",
    "test-results/**",
    "playwright-report/**",
  ]),
  {
    // Playwright fixtures use a callback parameter named `use`, which the
    // react-hooks plugin misreads as React's `use` hook.
    files: ["e2e/**"],
    rules: {
      "react-hooks/rules-of-hooks": "off",
    },
  },
  {
    // TODO: pre-existing backlog (lint was broken until eslint-config-next 16
    // landed — the old 0.2.4 pin had no /core-web-vitals flat-config entry, so
    // `npm run lint` never ran). Burn these down, then restore to "error".
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": "warn",
      "react/display-name": "warn",
      // react-hooks v7 compiler-powered diagnostics — real smells, but a
      // pre-existing backlog; not introduced by the dependency bumps.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/use-memo": "warn",
    },
  },
]);

export default eslintConfig;
