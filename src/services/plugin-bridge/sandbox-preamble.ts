// The flcm std-lib source the server ships to the plugin with every EXECUTE_CODE (ADR-0010).
//
// THIS MODULE'S BODY IS REPLACED AT BUILD TIME. Both bundler configs (tsup.config.ts for the shipped
// server, vitest.config.ts for tests) hook this exact file and swap in a version that returns the
// real generated string, along with the preamble's input graph as watch files. Generating it here
// isn't possible: bundling the preamble runs esbuild, a devDependency, over plugin sources the
// published package doesn't carry.
//
// Why a real file with a placeholder rather than a virtual module: `src/bin.ts` is run directly
// through tsx (the process-level tests do exactly this), and Node's ESM loader cannot resolve a
// `virtual:` scheme — the server wouldn't boot from source at all. A real module keeps every path
// working and degrades to the named error below only if code mode is actually invoked unbundled.
export function flcmSandboxPreamble(): string {
  throw new Error(
    "The flcm std-lib was not injected into this build. Run the server through `pnpm build` or " +
      "`pnpm dev` — tsup.config.ts generates it at build time; it cannot be built at runtime.",
  );
}
