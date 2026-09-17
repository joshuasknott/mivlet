import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/target/**",
      "**/node_modules/**",
      "**/.wrangler/**",
      "**/_generated/**",
      "**/worker-configuration.d.ts",
      "**/*.test.{ts,tsx}",
      "**/*.spec.{ts,tsx}",
      "**/tests/**",
      "apps/desktop/convex/_generated/**",
    ],
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
  },
  {
    files: ["apps/**/*.{ts,tsx}", "packages/**/*.{ts,tsx}", "scripts/**/*.mjs"],
    languageOptions: {
      parser: tseslint.parser,
    },
    rules: {
      "no-debugger": "error",
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-with": "error",
    },
  },
);
