import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      "no-undef": "off", // TypeScript handles this; no-undef doesn't understand TS types like NodeJS
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: prettier.rules,
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "**/tests/**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.jest, // vitest globals are the same names
      },
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    // The plugin carries its own toolchain — its own tsconfig/typecheck, its
    // own node:test runner, and the build's zod-purity guard. It was never
    // linted under this config in its origin repo; adopting these rules now
    // would flag deliberate patterns (e.g. code.ts's `any` on Figma's
    // SceneNode union). Its quality bar is typecheck + tests + build guard,
    // run by the root `validate`.
    ignores: ["dist/**", "node_modules/**", "plugin/**"],
  },
];
