import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  {
    ignores: ["**/dist/**", "**/*.generated.ts", "packages/cli/local-assets/**"],
  },
  {
    files: ["packages/*/src/**/*.{ts,tsx}"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    rules: {
      // Correctness checks remain errors. Maintenance advice is visible without
      // blocking a change; TypeScript's existing strict checks are unchanged.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      "no-useless-assignment": "warn",
      "no-useless-escape": "warn",
      "no-regex-spaces": "warn",
      "prefer-const": "warn",
      "preserve-caught-error": "warn",
      // An intentionally ignored cleanup failure needs an explanatory comment
      // inside its catch block; do not allow undocumented empty catches globally.
      "no-empty": ["error", { allowEmptyCatch: false }],
    },
  },
  {
    files: ["packages/*/src/**/*.test.{ts,tsx}"],
    rules: {
      // Fixtures may model partial/invalid external data or empty async streams.
      // These exceptions do not apply to production code or other error checks.
      "@typescript-eslint/no-explicit-any": "off",
      "require-yield": "off",
    },
  },
]);
