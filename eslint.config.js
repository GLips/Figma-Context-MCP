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
// Every error the plugin throws is an FlcmError carrying a kind, and code decides by that kind,
// never by message text: a reworded sentence must not change who gets blamed. The `.message` ban
// can't tell an Error from a wire frame or warning record, so those few reads carry a disable.
const FLCM_ERROR_MESSAGE =
  "Throw an FlcmError with a kind (plugin/src/preamble/flcm-error.ts), and branch on `kind`, never on message text. Quote a foreign failure with describeFailure.";
// The plugin keeps its own toolchain (typecheck, node:test, the build's zod guard), so the general
// rule sets skip it (their `ignores`); its sources get the FlcmError rule and the repo-wide import ban.
const PLUGIN_SOURCES = "plugin/src/**/*.ts";

export default [
  { ...js.configs.recommended, ignores: ["plugin/**"] },
  {
    files: ["**/*.ts", "**/*.tsx"],
    ignores: ["plugin/**"],
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
    files: [PLUGIN_SOURCES],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 2022, sourceType: "module" },
    },
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "NewExpression[callee.name=/^(Error|TypeError|RangeError|SyntaxError)$/]",
          message: FLCM_ERROR_MESSAGE,
        },
        {
          selector: "CallExpression[callee.name=/^(Error|TypeError|RangeError|SyntaxError)$/]",
          message: FLCM_ERROR_MESSAGE,
        },
        { selector: "MemberExpression[property.name='message']", message: FLCM_ERROR_MESSAGE },
      ],
    },
  },
  {
    // The one module that reads a failure's text and builds the error type itself.
    files: ["plugin/src/preamble/flcm-error.ts"],
    rules: { "no-restricted-syntax": "off" },
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
    // Of the plugin, only its non-test sources are linted (see PLUGIN_SOURCES). The general rules
    // would flag deliberate patterns there (e.g. code.ts's `any` on Figma's SceneNode union).
    // .agent_cache (cloned reference repos) and .scratch (local probes) are never ours — eslint
    // walks them regardless of .gitignore, so someone else's lint errors would fail `pnpm validate`.
    ignores: [
      "**/dist/**",
      "node_modules/**",
      "plugin/*",
      "!plugin/src",
      "plugin/src/**/*.test.ts",
      ".agent_cache/**",
      ".claude/**",
      ".scratch/**",
    ],
  },
];
