# LLM Prompting Guide for Figma to Code Conversion

This guide provides step-by-step instructions for an LLM (or a user prompting an LLM) on how to effectively use the Material Component Producer (MCP) server to convert Figma designs into code, particularly targeting Flowbite Pro `.tsx` templates.

## Overall Workflow

The general process involves:

1.  **Fetching Design Data:** Use the `get_figma_data` tool to retrieve a simplified representation of your Figma design.
2.  **Interpreting Data:** Understand the returned YAML structure (see `YAML_STRUCTURE.md`).
3.  **Handling Images:** Identify and download all necessary images using the `imageAssets` array and the `download_figma_images` tool.
4.  **Mapping to Components:** Translate Figma nodes and their properties to your target `.tsx` component templates (e.g., Flowbite Pro).
5.  **Applying Styles:** Use the styling information from the YAML to apply appropriate styles to your components, potentially translating them to Tailwind CSS classes.
6.  **Generating Code:** The LLM generates the final `.tsx` code based on the interpreted data and the target component library.

## Step-by-Step Instructions

### 1. Call `get_figma_data`

This is the first step to get the design information from Figma.

*   **Tool:** `get_figma_data`
*   **Parameters:**
    *   `fileKey`: (string, required) The ID of the Figma file. This can be extracted from the Figma file URL (e.g., `https://www.figma.com/file/{fileKey}/your-file-name`).
    *   `nodeId`: (string, optional) The ID of a specific node (e.g., a Frame or Component) within the Figma file to fetch. If omitted, the entire document is usually fetched (behavior might depend on server configuration, but typically it's the main page/document). It's often beneficial to target a specific top-level frame representing a screen or a large section. Node IDs look like "1:2", "123:4567".
    *   `depth`: (number, optional) The maximum depth of the node hierarchy to traverse. A smaller depth can speed up the request for very complex designs but might miss nested elements. Experiment to find a good balance. If omitted, a server-defined default is used.

**Example Prompt Thought Process (for User):**

> "Okay, I want to convert the 'User Profile Screen' from my Figma design. The file key is 'abc123xyz'. The screen is a top-level frame with ID '102:5'. I want to make sure I get all its contents, so I'll try a depth of 5 to start."

**Example Tool Call (LLM generates this):**

```json
{
  "tool_name": "get_figma_data",
  "parameters": {
    "fileKey": "abc123xyz",
    "nodeId": "102:5",
    "depth": 5
  }
}
```

### 2. Interpret the Returned YAML

The `get_figma_data` tool will return a YAML string. This YAML represents the `SimplifiedDesign` object.

*   **Action:** Parse this YAML.
*   **Reference:** Carefully review `YAML_STRUCTURE.md` to understand all the fields, especially `nodes`, `globalVars`, and the new `imageAssets` array.

**Example Prompt Thought Process (for LLM):**

> "The YAML is received. I need to parse it and understand its structure. I see `name`, `lastModified`, `nodes`, `globalVars`, and `imageAssets`. I'll focus on iterating through `nodes` to build the component structure, and I'll pay close attention to `imageAssets` for image downloads."

### 3. Image Handling (Detailed)

This is a multi-step process to ensure all images are correctly identified and prepared for use in the generated code.

#### a. Construct Parameters for `download_figma_images`

Iterate through the `imageAssets` array found at the top level of the parsed YAML from `get_figma_data`.

*   For each `ImageAsset` object in the `imageAssets` array:
    *   **If `type` is `"SVG"`:**
        *   This means the image is a vector graphic (originally a `VECTOR` node in Figma).
        *   Add an object to the `imagesToRender` parameter for the `download_figma_images` tool:
            ```json
            {
              "nodeId": imageAsset.nodeId, // e.g., "55:120"
              "fileName": imageAsset.fileNameSuggestion, // e.g., "Company_Logo.svg"
              "fileType": "svg"
            }
            ```
    *   **If `type` is `"FILL"`:**
        *   This means the image is a raster image (PNG, JPG) used as a fill on a node.
        *   Add an object to the `imageFillsToRender` parameter for the `download_figma_images` tool:
            ```json
            {
              "nodeId": imageAsset.nodeId, // ID of the node *having* the fill
              "imageRef": imageAsset.imageRef, // e.g., "figma_image_ref_abc123"
              "fileName": imageAsset.fileNameSuggestion // e.g., "Hero_Banner_fill.png"
            }
            ```
            *(Note: The `nodeId` here is for context/debugging; `imageRef` is the critical part for fetching the fill).*

**Example Prompt Thought Process (for LLM):**

> "Okay, I have the `imageAssets` array:
> ```yaml
> imageAssets:
>   - nodeId: '55:120'
>     fileNameSuggestion: 'Company_Logo.svg'
>     type: SVG
>   - nodeId: '60:25'
>     imageRef: 'figma_image_ref_abc123'
>     fileNameSuggestion: 'Hero_Banner_fill.png'
>     type: FILL
> ```
> I will prepare parameters for `download_figma_images`.
> `imagesToRender` will get: `[{ "nodeId": "55:120", "fileName": "Company_Logo.svg", "fileType": "svg" }]`
> `imageFillsToRender` will get: `[{ "nodeId": "60:25", "imageRef": "figma_image_ref_abc123", "fileName": "Hero_Banner_fill.png" }]`"

#### b. Call `download_figma_images`

Once you've constructed the lists of images to download, call the tool.

*   **Tool:** `download_figma_images`
*   **Parameters:**
    *   `fileKey`: (string, required) The same Figma file key used for `get_figma_data`.
    *   `imagesToRender`: (array, optional) The array of objects you constructed for SVG images (and other direct renders if any).
    *   `imageFillsToRender`: (array, optional) The array of objects you constructed for image fills.
    *   `scale`: (number, optional) For PNG images requested via `imagesToRender` (not typically used for SVGs or image fills directly, but the service might apply it if relevant for `imagesToRender` of type PNG). Defaults to 2. Use higher values for higher resolution PNGs if needed.
    *   `localPath`: (string, required) The path within the MCP server's environment where images should be saved (e.g., `/app/public/images`, `/tmp/figma_downloads`). The LLM usually doesn't control this directly but should be aware that the returned paths will be relative to the server's filesystem.

**Example Tool Call (LLM generates this, based on previous step):**

```json
{
  "tool_name": "download_figma_images",
  "parameters": {
    "fileKey": "abc123xyz",
    "imagesToRender": [
      { "nodeId": "55:120", "fileName": "Company_Logo.svg", "fileType": "svg" }
    ],
    "imageFillsToRender": [
      { "nodeId": "60:25", "imageRef": "figma_image_ref_abc123", "fileName": "Hero_Banner_fill.png" }
    ],
    "localPath": "/app/downloaded_images" // Or a path provided by the user/system
  }
}
```

#### c. Use the Returned Image Paths

The `download_figma_images` tool will return a list of strings, where each string is the local path on the MCP server where an image was saved (e.g., `"/app/downloaded_images/Company_Logo.svg"`).

*   **Action:** When generating your HTML/CSS (or `.tsx` components), use these paths as the `src` for `<img>` tags or `url()` for CSS backgrounds.
*   **Important:** These paths are local to the MCP server. The final application might need a way to serve these files or adjust the paths if the images are moved to a CDN or a different public directory. For generating `.tsx` components, you'll typically use these paths as if they will be available in your final application's public assets folder.

**Example Prompt Thought Process (for LLM):**

> "The `download_figma_images` tool returned:
> `['/app/downloaded_images/Company_Logo.svg', '/app/downloaded_images/Hero_Banner_fill.png']`
> When I generate the component for the logo (node '55:120'), I'll use `/app/downloaded_images/Company_Logo.svg` as the image source. For the element with the hero banner (node '60:25'), I'll use `/app/downloaded_images/Hero_Banner_fill.png` for its background image."

### 4. Component Mapping (e.g., to Flowbite Pro `.tsx` Templates)

This is where the core "translation" from Figma structure to your target component library happens.

*   **Iterate through `SimplifiedNode` objects** from the parsed YAML.
*   For each node:
    *   **Identify Component Type:** Use `node.name`, `node.type`, and potentially `node.componentId` (and the corresponding entry in `SimplifiedDesign.components`) to determine which Flowbite Pro `.tsx` template is most appropriate. For example:
        *   A node named "Primary Button" of type `INSTANCE` with a `componentId` pointing to a "Button" master component likely maps to a Flowbite `<Button>` component.
        *   A node named "User Avatar" of type `IMAGE-SVG` might map to an `<Avatar>` component or a simple `<img>` tag within a layout component.
        *   A "FRAME" with `layoutMode: 'HORIZONTAL'` and children might map to a `<Stack>` or a `div` with Flexbox.
    *   **Map Properties:**
        *   `node.text` for text content.
        *   `node.componentProperties` for variants (e.g., if `componentProperties` has `State: Hover`, pass the appropriate prop like `isHovered={true}` or a variant prop to your Flowbite component).
        *   `node.children`: Recursively process child nodes and map them to children of the current `.tsx` component.

**Example Prompt Thought Process (for LLM):**

> "The current node is:
> ```yaml
> - id: '10:5'
>   name: 'Login Button - Primary'
>   type: INSTANCE
>   componentId: '100:1' # Maps to "Button/Primary" in SimplifiedDesign.components
>   componentProperties:
>     Size: Large
>     State: Default
>   children:
>     - type: TEXT
>       text: 'Log In'
> ```
> This looks like a Flowbite `Button` component. The text is 'Log In'. The `Size: Large` property suggests I should use the `size="lg"` prop for the Flowbite Button. I will render `<Button size="lg">Log In</Button>`."

### 5. Style Application

Apply styling based on the information in the YAML.

*   **Global Styles:** If a node has `textStyle`, `fills`, `strokes`, `effects`, or `layout` properties, these are IDs pointing to style definitions in `globalVars.styles`.
    *   Retrieve the style object from `globalVars.styles`.
    *   **Translate to Target Styling:**
        *   **Inline Styles (Less Ideal):** Directly convert Figma properties (e.g., `hex` color, `fontSize`) to inline CSS styles.
        *   **Tailwind CSS (Preferred for Flowbite Pro):** Translate Figma properties to Tailwind CSS classes. This requires knowledge of both Figma's style properties and Tailwind's utility classes.
            *   Example: `fontSize: 16` -> `text-base` (or `text-[16px]`). `fills: [{ hex: '#007bff' }]` -> `bg-blue-500` (requires mapping hex to Tailwind color names or using arbitrary values `bg-[#007bff]`). `layoutMode: HORIZONTAL`, `itemSpacing: 8` -> `flex space-x-2` (spacing might need conversion px to Tailwind's scale).
*   **Direct Properties:** Apply `opacity` and `borderRadius` directly. `borderRadius` is already a CSS string.
*   **Layout:** `layout` properties from `globalVars` (describing AutoLayout) should be translated to Flexbox or Grid CSS, or corresponding Tailwind utilities (e.g., `flex`, `grid`, `gap-4`, `p-4`).

**Example Prompt Thought Process (for LLM):**

> "The node 'Login Button - Primary' has `fills: 'fill-btn-primary'` and `textStyle: 'style-btn-text'`.
> In `globalVars.styles`:
> ```yaml
> fill-btn-primary:
>   - type: SOLID
>     hex: '#2563EB' # Blue color
> style-btn-text:
>   fontFamily: Inter
>   fontWeight: 600
>   fontSize: 14
> ```
> For Flowbite with Tailwind:
> The fill `#2563EB` is a common blue, likely `bg-blue-600` or `bg-blue-700`. I'll use `bg-blue-600`.
> The text style `fontSize: 14`, `fontWeight: 600` translates to `text-sm font-semibold`.
> So the Button component will have classes like: `<Button size="lg" className="bg-blue-600 text-sm font-semibold">Log In</Button>`."

### 6. Generating Code

This is the final step where the LLM, armed with all the interpreted data, component mappings, and style translations, generates the `.tsx` code using the chosen component library (e.g., Flowbite Pro).

*   **Output:** The LLM should produce well-structured `.tsx` code.
*   **Self-Correction/Refinement:** The LLM might need to iterate or refine the code based on its understanding of the components and the Figma design's nuances.

## Important Considerations

*   **Complexity:** Figma designs can be very complex. Start with simpler components or sections and gradually increase complexity.
*   **Mapping Fidelity:** A perfect 1:1 mapping is not always possible or desirable. The LLM needs to make intelligent choices to map Figma concepts to the target component library's paradigms.
*   **User Interaction:** The LLM should be prepared to ask clarifying questions if the Figma data is ambiguous or if the mapping to Flowbite Pro components is not straightforward.
*   **Tool Limitations:** Be aware of the limitations of the tools (e.g., specific Figma features not fully supported by the simplifier).

This guide provides a comprehensive framework. Effective use will involve iterative prompting and refinement by the user and intelligent interpretation and code generation by the LLM.
```
