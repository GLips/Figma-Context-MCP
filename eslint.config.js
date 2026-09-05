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
    // `@framelink/core/internal` exposes `walkNodes` + `createRefStyleTable` — together, the
    // toolkit for assembling a walk that diverges from `simplify`, which is the fork the shared
    // core exists to prevent. The read-path tests genuinely need it (they drive the walk through
    // the REST adapter, so they can't live inside core); production code never should. The
    // override below re-permits it for tests only.
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@framelink/core/internal",
              message:
                "Production code must use `simplify` from @framelink/core. The internal walk seam is test-only — see core/src/internal.ts.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "**/tests/**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.jest, // vitest globals are the same names
      },
    },
    rules: {
      "no-restricted-imports": "off",
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
    // .agent_cache holds external repos cloned for reference reading (gitignored, never ours) — eslint
    // walks it regardless of .gitignore, so 300+ of someone else's lint errors would fail `pnpm validate`.
    ignores: ["dist/**", "node_modules/**", "plugin/**", ".agent_cache/**"],
  },
];
