// ESLint flat config (ESLint 9+/10) for the acp4idea bundle.
//
// Layers, in order:
//   1. ignores        — build output only (node_modules is ignored by default)
//   2. js recommended — core rules for every file
//   3. ts recommended — @typescript-eslint rules for TS sources (also disables
//      core rules that duplicate TypeScript's own checks, e.g. no-undef)
//   4. TS source rules — project-specific strictness (no explicit any, no
//      non-null assertions, import type enforcement)
//   5. JS files      — Node globals for tests and the launcher script
//
// Run from the package root:  pnpm lint
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["lib/**", "node_modules/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    rules: {
      // The checklist hard rules: no `any`, no `!` assertions, no unused
      // variables, and type-only imports must use `import type`.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-unused-vars": "error",
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    files: ["test/**/*.mjs", "bin/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
);
