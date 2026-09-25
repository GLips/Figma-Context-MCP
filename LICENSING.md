# Licensing

**Draft proposal. Not reviewed by a lawyer. Not yet effective.**

Framelink ships one npm package. [LICENSE](LICENSE) supplies the default MIT
license. The operative scope of the proposed [commercial source license](licensing/LICENSE-Framelink-Commercial.md)
is the per-file `LicenseRef-Framelink-Commercial` SPDX header. Third-party notices
retain their effect.

The write path lives in two commercial roots, `src/commercial/` and `plugin/`, plus
the write-path scripts listed in `COMMERCIAL_PATHS` in `scripts/check-license-headers.mjs`.
Every source file there carries the commercial header. One exception: the generated
reference `plugin/docs/authoring/flcm.md` is marked `<!-- SPDX-License-Identifier: MIT -->`
so public docs stay public. Read functionality and the shared read transform (`core/`)
stay MIT.

[Write access terms](licensing/TERMS.md) hold the allowance and counting rules
(incorporated into the license) and the operational terms.

## Metadata and headers

Root package metadata:

```json
"license": "SEE LICENSE IN LICENSING.md"
```

Exact header for a wholly commercial file after adoption:

```ts
/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
```

For MIT files that need an explicit marker (generated output, files next to
commercial code):

```ts
/*! SPDX-License-Identifier: MIT */
```

Both use `/*!` so minifiers keep them.

Preserve copyright notices. Use the commercial header only where rights have
been verified; split mixed source before applying it. The identifier is a custom
SPDX reference, not an SPDX-listed license. Find covered source directly:

```sh
rg -l '^\s*\*?\s*SPDX-License-Identifier: LicenseRef-Framelink-Commercial\s*$' src core plugin scripts
```

`pnpm check:license-headers` (part of `pnpm validate`) fails if a source file in a
commercial root lacks the header, or a file outside them carries it.

## Distribution

Builds preserve legal comments, add the banner below, and copy licensing documents
alongside root and plugin bundles. The npm tarball includes the documents at its
root and in `dist`. Generated copies retain their source portions' obligations;
a mixed bundle's banner does not relicense its MIT components.

```js
/*! Framelink licensing: see LICENSING.md alongside this artifact. Preserve component notices when redistributing. */
```

Bundles can't show per-file scope, so builds also write
`licensing/COMMERCIAL-FILES.txt` into `dist/` and `plugin/dist/`: the sorted source
paths carrying the commercial header.

Redistribute companion texts and component notices with standalone artifacts.
`pnpm check:package` verifies the actual tarball's documents, contents, metadata,
JavaScript banners, and that the manifest matches the header scan.
