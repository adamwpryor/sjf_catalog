import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
  // Lifted-code posture (BUILD_PLAN §P4): the web layer is lifted ~verbatim from
  // CCSJ. These rules flag pervasive stylistic debt in that upstream code
  // (untyped `any`, hook smells). They are downgraded to warnings — surfaced,
  // not silenced — so the build stays clean while the debt remains visible.
  // Do NOT downgrade correctness rules here; retype/refactor upstream instead.
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unsafe-function-type": "warn",
      "react-hooks/static-components": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react/no-unescaped-entities": "warn",
    },
  },
]);

export default eslintConfig;
