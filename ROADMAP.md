# Figma MCP Server Roadmap

This roadmap outlines planned improvements and features for the Figma MCP Server project. Items are organized by development phases and effort levels.

## Overview

The Figma MCP Server enables AI coding assistants to access Figma design data directly, improving the accuracy of design-to-code translations. This roadmap focuses on expanding capabilities, improving developer experience, and ensuring robust enterprise support.

## Core Feature Enhancements 🚀

_High impact, foundational improvements_

### Component & Prototype Support (High Priority)

- [ ] **Add dedicated tool for component extraction** ([#124](https://github.com/GLips/Figma-Context-MCP/issues/124))
  - [ ] Create `get_figma_components` tool for fetching full component/component set design data including variants and properties
- [ ] **Improve INSTANCE support**
  - [ ] Return only overridden values
  - [ ] Hide children of INSTANCE except for slot type children or if full data is explicitly requested via new tool call parameter
- [ ] **Prototype support**
  - [ ] Extract interactivity data (e.g. actions on hover, click, etc.)
  - [ ] Return data on animations / transitions
  - [?] State management hints

### Image & Asset Handling

- [ ] **Fix masked / cropped image exports**
  - [ ] Correctly export cropped images ([#162](https://github.com/GLips/Figma-Context-MCP/issues/162))
  - [?] Support complex mask shapes and transformations
  - [?] Pull image fills/vectors out to top level for better AI visibility
- [ ] **Improve SVG handling**
  - [ ] Better icon identification, e.g. if all components of a frame are VECTOR, download the full frame as an SVG
  - [?] Add support for raw path data in response—not sure if this is valuable yet

### Layout Improvements

- [ ] **Smart wrapped layout detection**
  - [?] Detect and convert fixed-width children to percentage-based widths
  - [ ] Better flexbox wrap support
  - [ ] Grid layout detection for wrapped items
  - [ ] Support for Figma's new grid layout

### Advanced Styling

- [ ] **Enhanced gradient support**
  - [ ] Make sure gradients are exported correctly in CSS syntax ([#152](https://github.com/GLips/Figma-Context-MCP/issues/152))
- [ ] **Grid system support**
  - [ ] Support for Figma's new grid autolayout (an addition to the long-existing flex autolayout)
  - [ ] Legacy "layout guide" grids
- [ ] **Named styles extraction**
  - [ ] Export style names associated with different layouts, colors, text, etc. for easier identification by the LLM (can use `/v1/styles/:key` endpoint)

### Text & Typography

- [ ] **Text styling**
  - [ ] Add support for formatted text in text fields ([#159](https://github.com/GLips/Figma-Context-MCP/issues/159))
  - [ ] Add support for mixed text styles (e.g. multiple colors) ([#140](https://github.com/GLips/Figma-Context-MCP/issues/140))

## Enterprise & Advanced Features 🏢

_Features for scaling and enterprise adoption_

### Enterprise Support

- [ ] **Variable System Enhancements**
  - [ ] Port `deduceVariablesFromTokens` for non-Enterprise users (see [tothienbao6a0's fork](https://github.com/tothienbao6a0/Figma-Context-MCP/blob/d9b035de76f44c952382b8155a5d5bf938e52a77/src/services/variable-deduction.ts#L30) for inspiration?)
  - [ ] Add `getFigmaVariables` for Enterprise plans
  - [?] Export design tokens in standard formats

## Developer Experience 🛠️

_Improving usability and integration_

### Performance & Reliability

- [ ] **Better error handling**
  - [ ] Retry logic for API failures
  - [ ] Graceful degradation
  - [ ] Detailed error messages which the LLM can expand on for users

### Documentation & Testing

- [ ] **Test coverage improvements**
  - [ ] Unit tests for all transformers
  - [ ] Integration tests with mock Figma API
  - [ ] E2E tests to visually check the implementation of an LLM coding agent prompted with MCP server output—likely uses a custom test framework to kick off e.g. Claude Code in the background

## Quick Wins 🎪

_Low effort, high impact_

- [ ] Better handling of text overflow (e.g. auto width, auto height, fixed width + truncate text setting)
- [ ] Double check to make sure blend modes are forwarded properly in the simplified response

## Technical Debt 🧹

_Code quality and maintenance_

- [ ] Clean up image download code (noted in mcp.ts)
- [ ] Refactor `convertAlign` function (layout.ts)
- [ ] Standardize error handling across services

## Research & Exploration 🔬

_Investigate feasibility / value_

- [ ] Figma plugin companion 🚀🚀🚀
- [ ] **Design System Integration**
  - [ ] Token extraction and mapping
  - [ ] Component dependency graphs
- [ ] **Figma File Metadata**
  - [ ] Investigate how we can use frames that are marked "Ready for Dev"
  - [ ] Investigate feasibility of pulling in annotations via the Figma API
  - [ ] Investigate feasibility/value of using—and even modifying—"Dev Resources" links via Figma API

## Contributing

We welcome contributions! Please check the issues labeled with "good first issue" or "help wanted". For major features, please open an issue first to discuss the implementation approach.

---

_This roadmap is subject to change based on community feedback and priorities. Last updated: June 2025_
