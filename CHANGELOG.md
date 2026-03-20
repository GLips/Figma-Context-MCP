# figma-developer-mcp

## [0.7.1](https://github.com/GLips/Figma-Context-MCP/compare/v0.7.0...v0.7.1) (2026-03-20)


### Bug Fixes

* handle drive root paths in image directory security check ([#301](https://github.com/GLips/Figma-Context-MCP/issues/301)) ([9f32616](https://github.com/GLips/Figma-Context-MCP/commit/9f32616caa29b1dbdd5c5a9dcfafa3dd717070a3))

## [0.7.0](https://github.com/GLips/Figma-Context-MCP/compare/v0.6.6...v0.7.0) (2026-03-19)


### ⚠ BREAKING CHANGES

* getServerConfig() no longer takes an isStdioMode parameter. It now detects stdio mode internally and returns it as part of ServerConfig.

### Features

* add --image-dir config for image download path control ([#297](https://github.com/GLips/Figma-Context-MCP/issues/297)) ([0417766](https://github.com/GLips/Figma-Context-MCP/commit/0417766eb5fc1e0b76e55da497961f9aee2f62f7))
* replace yargs with cleye for CLI flag parsing ([#285](https://github.com/GLips/Figma-Context-MCP/issues/285)) ([0092ee7](https://github.com/GLips/Figma-Context-MCP/commit/0092ee789fce01b9ef1dab5e8f32c52e71107dbb))
* support gifRef for downloading animated GIF embeds ([#286](https://github.com/GLips/Figma-Context-MCP/issues/286)) ([f1ec913](https://github.com/GLips/Figma-Context-MCP/commit/f1ec9133c31a351b55651126c20ea2f842c0a9ee))


### Bug Fixes

* remove inline release-type so release-please reads config file ([a03cd68](https://github.com/GLips/Figma-Context-MCP/commit/a03cd68826da1c1596273a223a612eb919832397))
* replace sharp dependency with js-native jimp for image manipulation ([#289](https://github.com/GLips/Figma-Context-MCP/issues/289)) ([62b9f94](https://github.com/GLips/Figma-Context-MCP/commit/62b9f94b1607dd08daeaa90e8ace0a896fe6eb50))
* skip jimp processing for SVGs and prevent image-fill collapse ([#298](https://github.com/GLips/Figma-Context-MCP/issues/298)) ([a4a4b13](https://github.com/GLips/Figma-Context-MCP/commit/a4a4b13ec7cae5d603022b1c8719cc717749195b))

## [0.6.6](https://github.com/GLips/Figma-Context-MCP/compare/v0.6.5...v0.6.6) (2026-03-04)


### Bug Fixes

* use Node 24 in release workflow for npm OIDC support ([11ba7c6](https://github.com/GLips/Figma-Context-MCP/commit/11ba7c6a2e22910c483592ba7cdc1966fcdc9166))

## [0.6.5](https://github.com/GLips/Figma-Context-MCP/compare/v0.6.4...v0.6.5) (2026-03-04)


### Bug Fixes

* upgrade MCP SDK to 1.27.1 and modernize tool registration ([#282](https://github.com/GLips/Figma-Context-MCP/issues/282)) ([4153e5f](https://github.com/GLips/Figma-Context-MCP/commit/4153e5f857aa708ee9ee10156e553c1289f03cf7))

## 0.6.4

### Patch Changes

- [#250](https://github.com/GLips/Figma-Context-MCP/pull/250) [`9966623`](https://github.com/GLips/Figma-Context-MCP/commit/996662352cdeaa8e6d4a6f64154d6135c00a35ee) Thanks [@GLips](https://github.com/GLips)! - Collapse containers that only have vector children to better handle SVG image downloads and also make output size smaller.

## 0.6.3

### Patch Changes

- [#246](https://github.com/GLips/Figma-Context-MCP/pull/246) [`7f4b585`](https://github.com/GLips/Figma-Context-MCP/commit/7f4b5859454b0567c2121ff22c69a0344680b124) Thanks [@GLips](https://github.com/GLips)! - Updates to validate user input, run HTTP server on localhost only

## 0.6.2

### Patch Changes

- [#244](https://github.com/GLips/Figma-Context-MCP/pull/244) [`8277424`](https://github.com/GLips/Figma-Context-MCP/commit/8277424205e6421a133ac38086f6eb7ac124ea65) Thanks [@GLips](https://github.com/GLips)! - Support imports without starting server or looking for env vars.

## 0.6.1

### Patch Changes

- [#240](https://github.com/GLips/Figma-Context-MCP/pull/240) [`2b1923d`](https://github.com/GLips/Figma-Context-MCP/commit/2b1923dcf50275a3d4daf9279265d27c6fadb2f7) Thanks [@GLips](https://github.com/GLips)! - Fix issue where importing package triggered config check.

- [#239](https://github.com/GLips/Figma-Context-MCP/pull/239) [`00bad7d`](https://github.com/GLips/Figma-Context-MCP/commit/00bad7dae48a6d0cc55d78560cc691a39271f151) Thanks [@Hengkai-Ye](https://github.com/Hengkai-Ye)! - Fix: Make sure LLM provides a filename extension when calling download_figma_images

## 0.6.0

### Minor Changes

- [#233](https://github.com/GLips/Figma-Context-MCP/pull/233) [`26a048b`](https://github.com/GLips/Figma-Context-MCP/commit/26a048bbd09db2b7e5265b5777609fb619617068) Thanks [@scarf005](https://github.com/scarf005)! - Return named styles from Figma instead of auto-generated IDs when they exist.

## 0.5.2

### Patch Changes

- [#227](https://github.com/GLips/Figma-Context-MCP/pull/227) [`68fbc87`](https://github.com/GLips/Figma-Context-MCP/commit/68fbc87645d25c57252d4d9bec5f43ee4238b09f) Thanks [@fightZy](https://github.com/fightZy)! - Update Node ID regex to support additional formats, e.g. multiple nodes.

## 0.5.1

### Patch Changes

- [#205](https://github.com/GLips/Figma-Context-MCP/pull/205) [`618bbe9`](https://github.com/GLips/Figma-Context-MCP/commit/618bbe98c49428e617de0240f0e9c2842867ae9b) Thanks [@GLips](https://github.com/GLips)! - Calculate gradient values instead of passing raw Figma data.

## 0.5.0

### Minor Changes

- [#197](https://github.com/GLips/Figma-Context-MCP/pull/197) [`d67ff14`](https://github.com/GLips/Figma-Context-MCP/commit/d67ff143347bb1dbc152157b75d6e8b290dabb0f) Thanks [@GLips](https://github.com/GLips)! - Improve structure of MCP files, change strategy used for parsing Figma files to make it more flexible and extensible.

- [#199](https://github.com/GLips/Figma-Context-MCP/pull/199) [`a8b59bf`](https://github.com/GLips/Figma-Context-MCP/commit/a8b59bf079128c9dba0bf6d8cd1601b8a6654b88) Thanks [@GLips](https://github.com/GLips)! - Add support for pattern fills in Figma.

- [#203](https://github.com/GLips/Figma-Context-MCP/pull/203) [`edf4182`](https://github.com/GLips/Figma-Context-MCP/commit/edf41826f5bd4ebe6ea353a9c9b8be669f0ae659) Thanks [@GLips](https://github.com/GLips)! - Add support for Fill, Fit, Crop and Tile image types in Figma. Adds image post-processing step.

### Patch Changes

- [#202](https://github.com/GLips/Figma-Context-MCP/pull/202) [`4a44681`](https://github.com/GLips/Figma-Context-MCP/commit/4a44681903f1c071c5892454d19370ed89ecd0a3) Thanks [@GLips](https://github.com/GLips)! - Add --skip-image-downloads option to CLI args and SKIP_IMAGE_DOWNLOADS env var to hide the download image tool when set.

## 0.4.3

### Patch Changes

- [#179](https://github.com/GLips/Figma-Context-MCP/pull/179) [`17988a0`](https://github.com/GLips/Figma-Context-MCP/commit/17988a0b5543330c6b8f7f24baa33b65a0da7957) Thanks [@GLips](https://github.com/GLips)! - Update curl command in fetchWithRetry to include error handling options, ensure errors are actually caught properly and returned to users.

## 0.4.2

### Patch Changes

- [#170](https://github.com/GLips/Figma-Context-MCP/pull/170) [`d560252`](https://github.com/GLips/Figma-Context-MCP/commit/d56025286e8c3c24d75f170974c12f96d32fda8b) Thanks [@GLips](https://github.com/GLips)! - Add support for custom .env files.

## 0.4.1

### Patch Changes

- [#161](https://github.com/GLips/Figma-Context-MCP/pull/161) [`8d34c6c`](https://github.com/GLips/Figma-Context-MCP/commit/8d34c6c23df3b2be5d5366723aeefdc2cca0a904) Thanks [@YossiSaadi](https://github.com/YossiSaadi)! - Add --json CLI flag and OUTPUT_FORMAT env var to support JSON output format in addition to YAML.

## 0.4.0

### Minor Changes

- [#126](https://github.com/GLips/Figma-Context-MCP/pull/126) [`6e99226`](https://github.com/GLips/Figma-Context-MCP/commit/6e9922693dcff70b69be6b505e24062a89e821f0) Thanks [@habakan](https://github.com/habakan)! - Add SVG export options to control text outlining, id inclusion, and whether strokes should be simplified.

### Patch Changes

- [#153](https://github.com/GLips/Figma-Context-MCP/pull/153) [`4d58e83`](https://github.com/GLips/Figma-Context-MCP/commit/4d58e83d2e56e2bc1a4799475f29ffe2a18d6868) Thanks [@miraclehen](https://github.com/miraclehen)! - Refactor layout positioning logic and add pixel rounding.

- [#112](https://github.com/GLips/Figma-Context-MCP/pull/112) [`c48b802`](https://github.com/GLips/Figma-Context-MCP/commit/c48b802ff653cfc46fe6077a8dc96bd4a15edb40) Thanks [@dgxyzw](https://github.com/dgxyzw)! - Change format of component properties in simplified response.

- [#150](https://github.com/GLips/Figma-Context-MCP/pull/150) [`4a4318f`](https://github.com/GLips/Figma-Context-MCP/commit/4a4318faa6c2eb91a08e6cc2e41e3f9e2f499a41) Thanks [@GLips](https://github.com/GLips)! - Add curl fallback to make API requests more robust in corporate environments

- [#149](https://github.com/GLips/Figma-Context-MCP/pull/149) [`46550f9`](https://github.com/GLips/Figma-Context-MCP/commit/46550f91340969cf3683f4537aefc87d807f1b64) Thanks [@miraclehen](https://github.com/miraclehen)! - Resolve promise in image downloading function only after file is finished writing.

## 0.3.1

### Patch Changes

- [#133](https://github.com/GLips/Figma-Context-MCP/pull/133) [`983375d`](https://github.com/GLips/Figma-Context-MCP/commit/983375d3fe7f2c4b48ce770b13e5b8cb06b162d0) Thanks [@dgomez-orangeloops](https://github.com/dgomez-orangeloops)! - Auto-update package version in code.

## 0.3.0

### Minor Changes

- [#122](https://github.com/GLips/Figma-Context-MCP/pull/122) [`60c663e`](https://github.com/GLips/Figma-Context-MCP/commit/60c663e6a83886b03eb2cde7c60433439e2cedd0) Thanks [@YossiSaadi](https://github.com/YossiSaadi)! - Include component and component set names to help LLMs find pre-existing components in code

- [#109](https://github.com/GLips/Figma-Context-MCP/pull/109) [`64a1b10`](https://github.com/GLips/Figma-Context-MCP/commit/64a1b10fb62e4ccb5d456d4701ab1fac82084af3) Thanks [@jonmabe](https://github.com/jonmabe)! - Add OAuth token support using Authorization Bearer method for alternate Figma auth.

- [#128](https://github.com/GLips/Figma-Context-MCP/pull/128) [`3761a70`](https://github.com/GLips/Figma-Context-MCP/commit/3761a70db57b3f038335a5fb568c2ca5ff45ad21) Thanks [@miraclehen](https://github.com/miraclehen)! - Handle size calculations for non-AutoLayout elements and absolutely positioned elements.

### Patch Changes

- [#106](https://github.com/GLips/Figma-Context-MCP/pull/106) [`4237a53`](https://github.com/GLips/Figma-Context-MCP/commit/4237a5363f696dcf7abe046940180b6861bdcf22) Thanks [@saharis9988](https://github.com/saharis9988)! - Remove empty keys from simplified design output.

- [#119](https://github.com/GLips/Figma-Context-MCP/pull/119) [`d69d96f`](https://github.com/GLips/Figma-Context-MCP/commit/d69d96fd8a99c9b59111d9c89613a74c1ac7aa7d) Thanks [@cooliceman](https://github.com/cooliceman)! - Add scale support for PNG images pulled via download_figma_images tool.

- [#129](https://github.com/GLips/Figma-Context-MCP/pull/129) [`56f968c`](https://github.com/GLips/Figma-Context-MCP/commit/56f968cd944cbf3058f71f3285c363e895dcf91d) Thanks [@fightZy](https://github.com/fightZy)! - Make shadows on text nodes apply text-shadow rather than box-shadow

## 0.2.2

### Patch Changes

- fd10a46: - Update HTTP server creation method to no longer subclass McpServer
  - Change logging behavior on HTTP server
- 6e2c8f5: Minor bump, testing fix for hanging CF DOs

## 0.2.2-beta.1

### Patch Changes

- 6e2c8f5: Minor bump, testing fix for hanging CF DOs

## 0.2.2-beta.0

### Patch Changes

- fd10a46: - Update HTTP server creation method to no longer subclass McpServer
  - Change logging behavior on HTTP server
