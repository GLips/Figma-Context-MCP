import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import prettier from "eslint-config-prettier";
import globals from "globals";

// Every local listener is created and bound in src/utils/local-listener.ts, which refuses browser
// requests by policy. A listener opened anywhere else would skip that, so these bans enforce it.
const SERVER_MODULES = ["http", "https", "http2", "net"].flatMap((m) => [m, `node:${m}`]);
const SERVER_MODULE_PATTERN = "/^(node:)?(http|https|http2|net)$|^ws$/";
const CORE_INTERNAL_IMPORT = {
  name: "@framelink/core/internal",
  message:
    "Production code must use `simplify` from @framelink/core. The internal walk seam is test-only — see core/src/internal.ts.",
};
const LOCAL_LISTENER_MESSAGE =
  "Open local listeners through src/utils/local-listener.ts, which refuses browser requests.";

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
    // The core's internal walk seam is test-only; the test block below re-permits it.
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "no-restricted-imports": ["error", { paths: [CORE_INTERNAL_IMPORT] }],
    },
  },
  {
    // The shipped server only. Scripts run their own throwaway listeners. This block's
    // no-restricted-imports replaces the one above rather than merging, hence the repeat.
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            CORE_INTERNAL_IMPORT,
            ...SERVER_MODULES.map((name) => ({
              name,
              importNames: ["createServer", "createSecureServer", "Server"],
              allowTypeImports: true,
              message: LOCAL_LISTENER_MESSAGE,
            })),
            {
              name: "ws",
              importNames: ["WebSocketServer", "Server"],
              allowTypeImports: true,
              message: LOCAL_LISTENER_MESSAGE,
            },
            {
              name: "@modelcontextprotocol/sdk/server/express.js",
              message: LOCAL_LISTENER_MESSAGE,
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        // Named-import bans can't see `http.createServer` or `new ws.WebSocketServer`, so a server
        // module may only be imported by name.
        ...["ImportNamespaceSpecifier", "ImportDefaultSpecifier"].map((specifier) => ({
          selector: `ImportDeclaration[importKind!='type'][source.value=${SERVER_MODULE_PATTERN}] > ${specifier}`,
          message: LOCAL_LISTENER_MESSAGE,
        })),
        {
          selector: `ImportExpression[source.value=${SERVER_MODULE_PATTERN}]`,
          message: LOCAL_LISTENER_MESSAGE,
        },
        {
          selector: "MemberExpression[object.name='WebSocket'][property.name='Server']",
          message: LOCAL_LISTENER_MESSAGE,
        },
        {
          selector: "CallExpression[callee.property.name='listen']",
          message: LOCAL_LISTENER_MESSAGE,
        },
      ],
    },
  },
  {
    // The boundary itself: the one place a listener may be created and bound.
    files: ["src/utils/local-listener.ts"],
    rules: {
      "no-restricted-imports": "off",
      "no-restricted-syntax": "off",
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
      "no-restricted-syntax": "off",
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
    // .agent_cache (cloned reference repos) and .scratch (local probes) are never ours — eslint
    // walks them regardless of .gitignore, so someone else's lint errors would fail `pnpm validate`.
    ignores: [
      "**/dist/**",
      "node_modules/**",
      "plugin/**",
      ".agent_cache/**",
      ".claude/**",
      ".scratch/**",
    ],
  },
];
