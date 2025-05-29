# YAML Structure for `get_figma_data` Output

The `get_figma_data` tool returns a YAML representation of a `SimplifiedDesign` object. This document details the structure of that object, focusing on how to interpret and use its various properties.

## Top-Level `SimplifiedDesign` Object

The root object contains the following properties:

-   `name`: (string) The name of the Figma file.
-   `lastModified`: (string) ISO date string of when the file was last modified.
-   `thumbnailUrl`: (string) URL for the Figma file's thumbnail.
-   `nodes`: (array) An array of `SimplifiedNode` objects representing the top-level, visible nodes requested from the Figma file.
-   `components`: (object) A dictionary where keys are component IDs and values are `SimplifiedComponentDefinition` objects, detailing master components.
-   `componentSets`: (object) A dictionary where keys are component set IDs and values are `SimplifiedComponentSetDefinition` objects, detailing component sets (groups of variants).
-   `globalVars`: (object) Stores common styles (text, fill, stroke, effect, layout) that are referenced by nodes. See [Global Variables](#global-variables) for details.
-   `imageAssets`: (array) An array of `ImageAsset` objects, providing a consolidated list of images that can be downloaded. See [Image Assets](#image-assets) for details.

**Example:**

```yaml
name: My Landing Page
lastModified: '2023-10-27T10:00:00Z'
thumbnailUrl: 'https://figma-alpha-api.s3.us-west-2.amazonaws.com/thumbnails/...'
nodes:
  - id: '1:2'
    name: Hero Section
    type: FRAME
    # ... other properties
    children:
      # ... child nodes
  # ... other top-level nodes
components:
  '100:1':
    name: 'Button/Primary'
    # ... other component def properties
componentSets:
  '100:0':
    name: 'Button'
    # ... other component set def properties
globalVars:
  styles:
    fill-abc123:
      - type: SOLID
        hex: '#ff0000'
        rgba: rgba(255, 0, 0, 1)
        opacity: 1
    # ... other global styles
imageAssets:
  - nodeId: '25:10'
    fileNameSuggestion: 'User_Avatar.svg'
    type: SVG
  - nodeId: '30:5'
    imageRef: 'img_ref_xyz789'
    fileNameSuggestion: 'Background_Image_fill.png'
    type: FILL
```

## `SimplifiedNode` Object

Each `SimplifiedNode` object represents a single element from the Figma design. It has the following properties:

-   `id`: (string) The unique ID of the node in the Figma file (e.g., "1:2").
-   `name`: (string) The name of the node as it appears in the Figma layers panel (e.g., "Primary Button").
-   `type`: (string) The type of the node (e.g., "FRAME", "RECTANGLE", "TEXT", "INSTANCE", "IMAGE-SVG"). Note that "VECTOR" nodes are converted to "IMAGE-SVG".
-   `boundingBox`: (object, optional) The absolute bounding box of the node.
    -   `x`: (number) X-coordinate.
    -   `y`: (number) Y-coordinate.
    -   `width`: (number) Width of the node.
    -   `height`: (number) Height of the node.
-   `text`: (string, optional) For "TEXT" nodes, the actual text content (e.g., "Sign Up").
-   `textStyle`: (string, optional) An ID referencing a text style object in `globalVars.styles` (e.g., "style-def456").
-   `fills`: (string, optional) An ID referencing an array of fill style objects in `globalVars.styles` (e.g., "fill-abc123").
-   `styles`: (string, optional) *Deprecated by Figma API, may not contain useful data.* Generally, prefer specific style properties like `fills`, `strokes`, `textStyle`.
-   `strokes`: (string, optional) An ID referencing a stroke style object in `globalVars.styles` (e.g., "stroke-ghi789").
-   `effects`: (string, optional) An ID referencing an effects object (e.g., drop shadows, blurs) in `globalVars.styles` (e.g., "effect-jkl012").
-   `opacity`: (number, optional) The opacity of the node, between 0 and 1 (e.g., 0.5 for 50% opacity). Only present if not 1.
-   `borderRadius`: (string, optional) Border radius as a CSS string (e.g., "10px" or "5px 10px 15px 20px").
-   `layout`: (string, optional) An ID referencing a layout style object in `globalVars.styles` (e.g., "layout-mno345"), describing AutoLayout properties.
-   `componentId`: (string, optional) For "INSTANCE" nodes, the ID of the main component this instance derives from. This ID can be used to look up details in the `components` object.
-   `componentProperties`: (object, optional) For "INSTANCE" nodes, an object detailing the values of any component properties (variants) applied to this instance.
-   `children`: (array, optional) An array of `SimplifiedNode` objects representing the visible children of this node.

**Example `SimplifiedNode`:**

```yaml
- id: '10:5'
  name: 'Login Button'
  type: INSTANCE
  boundingBox:
    x: 100
    y: 200
    width: 150
    height: 40
  fills: 'fill-primary-blue' # References a style in globalVars
  textStyle: 'style-button-text' # References a style in globalVars
  componentId: '100:1' # Main component ID
  componentProperties:
    State: Hover
  children: # e.g., if the button instance contains a text node and an icon node
    - id: '10:6'
      name: 'Button Text'
      type: TEXT
      text: 'Login'
      textStyle: 'style-button-text' # Can also be directly on child
      # ...
```

## Global Variables (`globalVars`)

The `globalVars` object is designed to reduce redundancy in the YAML output. Common styles that are reused across multiple nodes are defined once in `globalVars.styles` and then referenced by their generated ID from individual `SimplifiedNode` objects.

-   `globalVars.styles`: (object) A dictionary where:
    -   Keys are uniquely generated style IDs (e.g., `fill-abc123`, `style-def456`).
    -   Values are the actual style objects. The structure of these objects depends on the style type:
        -   **Text Styles**: Contain properties like `fontFamily`, `fontWeight`, `fontSize`, `lineHeight`, `letterSpacing`, `textAlignHorizontal`, etc.
        -   **Fill Styles**: An array of fill objects (e.g., `SOLID`, `GRADIENT_LINEAR`). Solid fills will have `hex`, `rgba`, and `opacity`. Gradients will have `gradientHandlePositions` and `gradientStops`.
        -   **Stroke Styles**: Contain properties like `colors` (array of fill objects), `weights` (top, right, bottom, left), and `align`.
        -   **Effect Styles**: Contain arrays for `dropShadows`, `innerShadows`, `layerBlurs`, `backgroundBlurs`.
        -   **Layout Styles**: Describe AutoLayout properties like `layoutMode` (HORIZONTAL/VERTICAL), `itemSpacing`, `paddingLeft`, `paddingRight`, `paddingTop`, `paddingBottom`, alignment properties, etc.

**Example `globalVars`:**

```yaml
globalVars:
  styles:
    style-button-label:
      fontFamily: Inter
      fontWeight: 600
      fontSize: 16
      textAlignHorizontal: CENTER
    fill-primary-button:
      - type: SOLID
        hex: '#007bff'
        rgba: rgba(0, 123, 255, 1)
        opacity: 1
    layout-card-horizontal:
      layoutMode: HORIZONTAL
      itemSpacing: 16
      paddingLeft: 16
      paddingRight: 16
```

A node would then reference these like so:

```yaml
- id: '12:34'
  name: 'Submit Button'
  type: RECTANGLE # Or INSTANCE
  textStyle: 'style-button-label'
  fills: 'fill-primary-button'
  layout: 'layout-card-horizontal' # If it's a frame with AutoLayout
  # ...
```

## Components and Component Sets

-   `components`: (object) A dictionary mapping component IDs to their definitions. Each `SimplifiedComponentDefinition` provides details about a master component (e.g., its name, type, default bounding box). This is useful for understanding the base structure of instances.
-   `componentSets`: (object) A dictionary mapping component set IDs to their definitions. A component set groups related components (variants). For instance, a "Button" component set might contain variants for "Primary", "Secondary", "Disabled", "Hover", etc.

These are primarily for informational purposes or advanced integrations where you might want to understand the original component structure from Figma. When dealing with instances (`type: INSTANCE`), the `componentId` property on the node will point to an ID in the `components` object.

## Image Assets (`imageAssets`)

This is a crucial top-level array that consolidates all renderable images from the Figma selection into a single list, making it easier to download them.

-   `imageAssets`: (array) An array of `ImageAsset` objects.

Each `ImageAsset` object has the following structure:

-   `nodeId`: (string) The ID of the Figma node associated with this image.
    -   For `SVG` types, this is the ID of the original `VECTOR` node.
    -   For `FILL` types, this is the ID of the node that *has* the image fill.
-   `imageRef`: (string, optional) The internal Figma image reference ID. This is **only present for `type: "FILL"`**.
-   `fileNameSuggestion`: (string) A suggested filename for the downloaded image, typically derived from the node's name and the image type (e.g., "User_Icon.svg", "Hero_Background_fill.png").
-   `type`: (string) The type of image asset, which dictates how it should be downloaded:
    -   `"SVG"`: Indicates the asset is a vector graphic and should be downloaded as an SVG. The `nodeId` should be used for download.
    -   `"FILL"`: Indicates the asset is a raster image (e.g., PNG, JPG) used as a fill on a node. The `imageRef` should be used for download. (The server currently defaults to downloading these as PNGs).

**Purpose and Usage:**

The `imageAssets` array is designed to be directly used to construct the `nodes` parameter for the `download_figma_images` tool.

**Example `imageAssets`:**

```yaml
imageAssets:
  - nodeId: '55:120' # This was originally a VECTOR node
    fileNameSuggestion: 'Company_Logo.svg'
    type: SVG
  - nodeId: '60:25'  # This RECTANGLE node has an image fill
    imageRef: 'figma_image_ref_abc123'
    fileNameSuggestion: 'Hero_Banner_fill.png'
    type: FILL
  - nodeId: '60:30'  # This FRAME node also has an image fill
    imageRef: 'figma_image_ref_xyz789'
    fileNameSuggestion: 'Profile_Picture_fill.png'
    type: FILL
```

**How to use with `download_figma_images`:**

Iterate through the `imageAssets` array.
-   If `type` is `"SVG"`, add an object `{ nodeId, fileName: fileNameSuggestion, fileType: "svg" }` to the `imagesToRender` parameter of `download_figma_images`.
-   If `type` is `"FILL"`, add an object `{ nodeId, imageRef, fileName: fileNameSuggestion }` to the `imageFillsToRender` parameter of `download_figma_images`.

See `LLM_PROMPTING_GUIDE.md` for a detailed workflow example.
```
