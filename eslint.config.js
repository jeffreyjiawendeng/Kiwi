import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { boundaryConfigs } from "./tooling/eslint/boundaries.js";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/release/**",
      "**/node_modules/**",
      "**/*.tsbuildinfo",
      ".kiwi_spec/**",
      "fixtures/checkers/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "no-console": ["error", { allow: ["warn", "error"] }],
      eqeqeq: ["error", "always"],
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSAsExpression > TSAnyKeyword",
          message: "Narrow unknown through validation instead of casting to any.",
        },
      ],
    },
  },
  ...boundaryConfigs(),
  {
    files: ["tooling/**/*.{js,mjs}", "**/*.config.{js,mjs,ts}"],
    rules: { "no-console": "off" },
  },
);
