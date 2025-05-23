# Main file for simplifying Figma API node responses

from typing import Dict, List, Optional, Any, Union, cast
from pydantic import BaseModel, Field, validator
import logging

# --- Import type aliases and utility functions ---
from mcp.utils.common import (
    generate_var_id,
    parse_paint, # Expects FigmaPaint dict, returns SimplifiedFill
    is_visible,
    remove_empty_keys,
    StyleId, # This is NewType('StyleId', str)
    SimplifiedFill, # This is Union[CSSHexColor, CSSRGBAColor, Dict[str, Any]]
    FigmaRGBA, # For TextStyle color
    format_rgba_color # For TextStyle color
)
from mcp.utils.sanitization import (
    sanitize_components,
    sanitize_component_sets,
    SimplifiedComponentDefinition as ImportedSimplifiedComponentDefinition, # Alias to avoid potential naming conflicts
    SimplifiedComponentSetDefinition as ImportedSimplifiedComponentSetDefinition
)
from mcp.transformers.layout import build_simplified_layout
from mcp.transformers.style import build_simplified_strokes
from mcp.transformers.effects import build_simplified_effects
# from mcp.utils.identity import has_value # May not be needed if using .get() extensively

logger = logging.getLogger(__name__)

# --- Pydantic Models ---

class TextStyle(BaseModel):
    font_family: Optional[str] = Field(default=None, alias="fontFamily")
    font_post_script_name: Optional[str] = Field(default=None, alias="fontPostScriptName")
    font_weight: Optional[Union[int, float]] = Field(default=None, alias="fontWeight") # TS has number
    font_size: Optional[float] = Field(default=None, alias="fontSize") # TS has number
    letter_spacing: Optional[float] = Field(default=None, alias="letterSpacing") # TS has number
    line_height_px: Optional[float] = Field(default=None, alias="lineHeightPx") # TS has number
    line_height_percent: Optional[float] = Field(default=None, alias="lineHeightPercent")
    line_height_unit: Optional[str] = Field(default=None, alias="lineHeightUnit")
    text_align_horizontal: Optional[str] = Field(default=None, alias="textAlignHorizontal")
    text_align_vertical: Optional[str] = Field(default=None, alias="textAlignVertical")
    text_decoration: Optional[str] = Field(default=None, alias="textDecoration") # e.g., "UNDERLINE", "STRIKETHROUGH"
    text_case: Optional[str] = Field(default=None, alias="textCase") # e.g., "UPPER", "LOWER", "TITLE"
    # Added from inspection of Figma API style object for text
    # color: Optional[FigmaRGBA] = None # Store the raw Figma color object
    # Simplified color representation
    color_css: Optional[str] = Field(default=None, alias="color") # Store as CSS string like rgba(r,g,b,a)

    class Config:
        populate_by_name = True
        extra = 'ignore' # Ignore extra fields from Figma style object

class GlobalVars(BaseModel):
    # Using Any for value now, can be refined if specific style types are enforced
    styles: Dict[StyleId, Any] = Field(default_factory=dict)

class BoundingBox(BaseModel):
    x: float
    y: float
    width: float
    height: float

class SimplifiedNode(BaseModel):
    id: str
    name: str
    type: str
    bounding_box: Optional[BoundingBox] = None
    text: Optional[str] = None
    text_style: Optional[StyleId] = None
    fills: Optional[StyleId] = None # StyleId referencing a list of SimplifiedFill
    # The original TS had 'styles: Optional[StyleId]', which is confusing.
    # Assuming it meant a generic style ID bucket, or perhaps it was a typo for 'style_id'
    # referring to a component style. Given the context, I'll omit 'styles: Optional[StyleId]'
    # as its purpose isn't clear and other specific style references (text_style, fills, etc.) exist.
    # If it referred to Figma's node.styles property (like {"fill": "S:123;"}),
    # that's usually pre-resolved or handled differently.
    strokes: Optional[StyleId] = None # StyleId referencing a SimplifiedStroke model dict
    effects: Optional[StyleId] = None # StyleId referencing a SimplifiedEffects model dict
    opacity: Optional[float] = None
    border_radius: Optional[str] = None # CSS shorthand string
    layout: Optional[StyleId] = None # StyleId referencing a SimplifiedLayout model dict
    component_id: Optional[str] = Field(default=None, alias="componentId")
    component_properties: Optional[Dict[str, Any]] = Field(default=None, alias="componentProperties")
    children: Optional[List['SimplifiedNode']] = None # Self-referential

    class Config:
        populate_by_name = True


class SimplifiedDesign(BaseModel):
    name: str
    last_modified: str = Field(alias="lastModified")
    thumbnail_url: str = Field(alias="thumbnailUrl")
    nodes: List[SimplifiedNode]
    # Use the imported (and potentially aliased) definitions
    components: Dict[str, ImportedSimplifiedComponentDefinition]
    component_sets: Dict[str, ImportedSimplifiedComponentSetDefinition] = Field(alias="componentSets")
    global_vars: GlobalVars

    class Config:
        populate_by_name = True

# Update forward refs for SimplifiedNode
SimplifiedNode.model_rebuild()


# --- Helper Functions ---

def _find_or_create_var(global_vars: GlobalVars, value: Any, prefix: str) -> StyleId:
    """
    Checks if a style value already exists in global_vars.styles.
    If yes, returns its ID.
    If no, generates a new ID, stores the value, and returns the new ID.
    """
    # Simple direct match check; for complex objects, a deep comparison or hashing might be needed
    # For now, we assume that if parse_paint, build_simplified_strokes etc. return identical dicts/lists
    # for identical inputs, we can check for `value in global_vars.styles.values()`.
    # However, dicts are not hashable for direct use as keys if we flip it.
    # So, iterate and compare.
    for style_id, existing_value in global_vars.styles.items():
        if existing_value == value: # This requires perfect match for dicts/lists
            return style_id
    
    new_id = generate_var_id(prefix)
    global_vars.styles[new_id] = value
    return new_id


def _parse_node(
    global_vars: GlobalVars,
    node_data: Dict[str, Any],
    parent_data: Optional[Dict[str, Any]] = None
) -> Optional[SimplifiedNode]:
    """
    Recursively parses a Figma node and its children into a SimplifiedNode structure.
    """
    if not is_visible(node_data):
        return None

    node_id = node_data.get("id", "")
    node_name = node_data.get("name", "Unnamed Node")
    node_type = node_data.get("type", "UNKNOWN")

    # Basic SimplifiedNode structure
    simplified_node_dict: Dict[str, Any] = {
        "id": node_id,
        "name": node_name,
        "type": node_type,
    }

    # Bounding Box (absoluteBoundingBox from Figma node)
    if "absoluteBoundingBox" in node_data and isinstance(node_data["absoluteBoundingBox"], dict):
        bbox_data = node_data["absoluteBoundingBox"]
        try:
            simplified_node_dict["bounding_box"] = BoundingBox(
                x=bbox_data.get("x", 0.0),
                y=bbox_data.get("y", 0.0),
                width=bbox_data.get("width", 0.0),
                height=bbox_data.get("height", 0.0)
            ).model_dump() # Store as dict
        except Exception as e:
            logger.warning(f"Node {node_id}: Could not parse boundingBox: {bbox_data}. Error: {e}")


    # INSTANCE specific fields
    if node_type == "INSTANCE":
        simplified_node_dict["component_id"] = node_data.get("componentId")
        # componentProperties might need deeper processing if its structure is complex
        # For now, direct copy if it exists.
        if "componentProperties" in node_data:
            simplified_node_dict["component_properties"] = node_data.get("componentProperties")

    # Text Style (from node_data.style which is a Figma Style object for text)
    # This refers to the properties of the text itself, not a shared style reference.
    figma_text_style_obj = node_data.get("style")
    if isinstance(figma_text_style_obj, dict):
        # Convert Figma RGBA color to CSS string for TextStyle model
        style_color_css = None
        if "fills" in figma_text_style_obj and figma_text_style_obj["fills"]:
            # Text color in Figma is often the first solid fill
            # This is a simplification; text can have multiple fills (gradients, etc.)
            # The `style` object for text has its own `fills` array.
            first_fill = figma_text_style_obj["fills"][0]
            if first_fill.get("type") == "SOLID" and "color" in first_fill:
                # Assuming figma_text_style_obj.color is FigmaRGBA
                # Let's use format_rgba_color to get a CSS string
                style_color_css = format_rgba_color(cast(FigmaRGBA, first_fill["color"]))

        text_style_data = {key: figma_text_style_obj.get(key) for key in TextStyle.model_fields}
        # Override 'color' field for our model with the CSS string
        text_style_data['color'] = style_color_css 

        # Remove fields that are not part of TextStyle model before creating instance
        # Or use extra = 'ignore' in model config
        valid_text_style_data = {k: v for k, v in text_style_data.items() if k in TextStyle.model_fields or k in TextStyle.model_fields_set}
        
        # Handle potential alias for color_css if input is 'color'
        if 'color' in figma_text_style_obj and 'color_css' not in valid_text_style_data :
            # This part is tricky. The `style` object from Figma for text nodes has a `fills` array for color.
            # It does not directly have a `color` field in `style` itself.
            # The `color_css` field in `TextStyle` is custom.
            # The `TextStyle` model's `color` alias should map to `color_css`.
            # Let's assume `figma_text_style_obj` directly contains fields that match TextStyle aliases.
            # The alias `color` in `TextStyle` should map to `color_css`.
            # So, if `figma_text_style_obj` has `color`, Pydantic should handle it if `color` is an alias for `color_css`.
            # For clarity, I'll pass it as `color_css` if that's the internal field name.
            # The current TextStyle model has `color_css: Optional[str] = Field(default=None, alias="color")`
            # So if input has `color`, Pydantic will populate `color_css`.
            # The `style_color_css` derived above from `fills` should be assigned to the field that `alias="color"` points to.
            
            # Re-create text_style_data using Pydantic's parsing for aliases
            parsed_style = TextStyle.model_validate(figma_text_style_obj)
            # Then update with our derived color if it exists
            if style_color_css:
                 parsed_style.color_css = style_color_css
            
            style_id = _find_or_create_var(global_vars, parsed_style.model_dump(exclude_none=True, by_alias=True), "text")
            simplified_node_dict["text_style"] = style_id


    # Fills (from node_data.fills which is an array of Paint objects)
    if "fills" in node_data and isinstance(node_data["fills"], list) and node_data["fills"]:
        # Filter for visible fills and parse them
        parsed_fills_list = [
            parse_paint(fill_paint) for fill_paint in node_data["fills"]
            if isinstance(fill_paint, dict) and is_visible(fill_paint)
        ]
        if parsed_fills_list: # Only add if there are visible fills
            fills_id = _find_or_create_var(global_vars, parsed_fills_list, "fill")
            simplified_node_dict["fills"] = fills_id

    # Strokes
    # build_simplified_strokes returns a dict like SimplifiedStroke.model_dump()
    strokes_data = build_simplified_strokes(node_data)
    if strokes_data: # build_simplified_strokes already returns empty dict if no relevant properties
        strokes_id = _find_or_create_var(global_vars, strokes_data, "stroke")
        simplified_node_dict["strokes"] = strokes_id

    # Effects
    # build_simplified_effects returns a dict like SimplifiedEffects.model_dump()
    effects_data = build_simplified_effects(node_data)
    if effects_data: # build_simplified_effects already returns empty dict if no relevant properties
        effects_id = _find_or_create_var(global_vars, effects_data, "effect")
        simplified_node_dict["effects"] = effects_id
        
    # Layout
    # build_simplified_layout returns a dict like SimplifiedLayout.model_dump()
    layout_data = build_simplified_layout(node_data, parent_data)
    if layout_data: # build_simplified_layout already returns empty dict if no relevant properties
        layout_id = _find_or_create_var(global_vars, layout_data, "layout")
        simplified_node_dict["layout"] = layout_id

    # Direct properties
    if "characters" in node_data:
        simplified_node_dict["text"] = node_data["characters"]
    
    if "opacity" in node_data:
        simplified_node_dict["opacity"] = node_data["opacity"]

    # Border Radius (CornerRadius for uniform, RectangleCornerRadii for individual)
    # RectangleCornerRadii takes precedence if available and valid
    # generate_css_shorthand from common.py can be used if we adapt RectangleCornerRadii to its input format
    # For now, a simpler approach:
    if "rectangleCornerRadii" in node_data and isinstance(node_data["rectangleCornerRadii"], list) and len(node_data["rectangleCornerRadii"]) == 4:
        # Assuming [topLeft, topRight, bottomRight, bottomLeft]
        # This needs to be converted to CSS shorthand string "top-left top-right bottom-right bottom-left"
        # Or use generate_css_shorthand if it can take a list or be adapted.
        # For now, just store as a string representation of the list if complex.
        # The TS version uses `generateCSSShorthand({ top, right, bottom, left })`
        # So, if rectangleCornerRadii exists, it's preferred.
        # Let's assume rectangleCornerRadii maps to: top-left, top-right, bottom-right, bottom-left
        # This doesn't directly map to generate_css_shorthand's {top,right,bottom,left} for borders.
        # For border-radius, CSS is "top-left top-right bottom-right bottom-left"
        # If all are same, it's one value. If top-left=bottom-right and top-right=bottom-left, it's two.
        # Let's simplify: if all same, use that. Otherwise, space separated.
        r = node_data["rectangleCornerRadii"]
        if all(x == r[0] for x in r):
            simplified_node_dict["border_radius"] = f"{r[0]}px" if r[0] > 0 else None # remove if 0
        else:
            simplified_node_dict["border_radius"] = " ".join(f"{x}px" for x in r)
        if simplified_node_dict.get("border_radius") == "0px 0px 0px 0px" or simplified_node_dict.get("border_radius") == "0px":
            simplified_node_dict.pop("border_radius", None)

    elif "cornerRadius" in node_data and node_data["cornerRadius"] > 0: # Fallback to cornerRadius
        simplified_node_dict["border_radius"] = f"{node_data['cornerRadius']}px"


    # Recursively parse children
    children_nodes: List[SimplifiedNode] = []
    if "children" in node_data and isinstance(node_data["children"], list):
        for child_data in node_data["children"]:
            if isinstance(child_data, dict):
                parsed_child = _parse_node(global_vars, child_data, node_data)
                if parsed_child:
                    children_nodes.append(parsed_child)
    
    if children_nodes:
        simplified_node_dict["children"] = children_nodes

    # Type transformation for VECTOR to IMAGE-SVG
    if simplified_node_dict["type"] == "VECTOR":
        simplified_node_dict["type"] = "IMAGE-SVG"
    
    try:
        final_node = SimplifiedNode(**simplified_node_dict)
        return final_node
    except Exception as e:
        logger.error(f"Node {node_id} ({node_name}): Failed to validate SimplifiedNode. Error: {e}. Data: {simplified_node_dict}")
        return None


# --- Main Parsing Function ---

def parse_figma_response(data: Dict[str, Any]) -> SimplifiedDesign:
    """
    Parses a raw Figma API response (GetFileResponse or GetFileNodesResponse)
    into a simplified design structure.
    """
    
    # Determine if it's GetFileResponse or GetFileNodesResponse
    # GetFileResponse has 'document', 'components', 'componentSets', 'name', 'lastModified', 'thumbnailUrl'
    # GetFileNodesResponse has 'nodes', 'name', 'lastModified', 'thumbnailUrl'
    # Components and componentSets might be within 'nodes' for GetFileNodesResponse, or need separate fetching.
    # For now, assume components and componentSets are top-level or derived before this function.
    # The TS code expects `data` to be `GetFileResult`. Let's assume `data` is like `GetFileResult`.

    raw_components = data.get("components", {})
    raw_component_sets = data.get("componentSets", {})

    # If 'nodes' key exists (like in GetFileNodesResponse), components might be within the node structure.
    # This part might need adjustment based on how Figma returns components in GetFileNodesResponse.
    # Typically, components are listed separately. The TS code implies they are aggregated.
    # For now, we rely on them being passed in `data.components` and `data.componentSets`.

    sanitized_components_map = sanitize_components(raw_components)
    sanitized_component_sets_map = sanitize_component_sets(raw_component_sets)

    global_vars_instance = GlobalVars() # Initialize empty global_vars

    # The main 'document' node in GetFileResponse, or the first node in GetFileNodesResponse's 'nodes' list.
    # This logic needs to be robust.
    # TS uses `data.document.children` if `data.document` exists, else `Object.values(data.nodes).map(n => n.document)`
    
    root_nodes_to_parse: List[Dict[str, Any]] = []
    if "document" in data and isinstance(data["document"], dict) and "children" in data["document"]:
        # This is like GetFileResponse
        root_nodes_to_parse = data["document"]["children"]
    elif "nodes" in data and isinstance(data["nodes"], dict):
        # This is like GetFileNodesResponse
        # Each value in data.nodes is a NodeInfo object, containing a 'document' (the node itself)
        for node_info in data["nodes"].values():
            if isinstance(node_info, dict) and "document" in node_info and isinstance(node_info["document"], dict):
                root_nodes_to_parse.append(node_info["document"])
    else:
        logger.warning("Could not find root nodes to parse in Figma response.")


    parsed_nodes: List[SimplifiedNode] = []
    for root_node_data in root_nodes_to_parse:
        parsed_node = _parse_node(global_vars_instance, root_node_data, parent_data=None) # No parent for root nodes
        if parsed_node:
            parsed_nodes.append(parsed_node)
            
    simplified_design_data = {
        "name": data.get("name", "Untitled Design"),
        "lastModified": data.get("lastModified", ""),
        "thumbnailUrl": data.get("thumbnailUrl", ""),
        "nodes": parsed_nodes,
        "components": sanitized_components_map,
        "componentSets": sanitized_component_sets_map,
        "globalVars": global_vars_instance,
    }

    # Create Pydantic model instance for SimplifiedDesign
    design_model = SimplifiedDesign(**simplified_design_data)
    
    # Return the model_dump, then apply remove_empty_keys
    # remove_empty_keys works on dicts/lists, so dump the model first.
    final_dict_output = design_model.model_dump(exclude_none=True, by_alias=True)
    
    return cast(SimplifiedDesign, remove_empty_keys(final_dict_output)) # Cast because remove_empty_keys returns Any


# Example usage (conceptual, would need mock data)
if __name__ == "__main__":
    # Mock data structure for testing _find_or_create_var
    gv = GlobalVars()
    val1 = {"color": "red", "size": 10}
    val2 = {"color": "blue", "size": 12}
    val3 = {"color": "red", "size": 10} # same as val1

    id1 = _find_or_create_var(gv, val1, "style")
    id2 = _find_or_create_var(gv, val2, "style")
    id3 = _find_or_create_var(gv, val3, "style")
    print(f"ID1: {id1}, ID2: {id2}, ID3: {id3}") # Expect ID1 == ID3
    print("Global Vars Styles:", gv.styles)

    # Mock data for TextStyle
    mock_figma_text_style = {
        "fontFamily": "Inter",
        "fontWeight": 700,
        "fontSize": 16.0,
        "letterSpacing": 0.5,
        "lineHeightPx": 20.0,
        "lineHeightUnit": "PIXELS",
        "textAlignHorizontal": "LEFT",
        "textAlignVertical": "TOP",
        "fills": [{"type": "SOLID", "color": {"r": 0.1, "g": 0.2, "b": 0.3, "a": 1.0}}] # For color_css
    }
    ts_model = TextStyle.model_validate(mock_figma_text_style)
    # Manually derive color_css for testing this part if needed
    # color_css_val = format_rgba_color(mock_figma_text_style["fills"][0]["color"])
    # ts_model.color_css = color_css_val
    print("TextStyle model dump:", ts_model.model_dump(by_alias=True, exclude_none=True))
    # Expected: {
    # 'fontFamily': 'Inter', 'fontWeight': 700, 'fontSize': 16.0, 'letterSpacing': 0.5, 
    # 'lineHeightPx': 20.0, 'lineHeightUnit': 'PIXELS', 'textAlignHorizontal': 'LEFT', 
    # 'textAlignVertical': 'TOP', 'color': 'rgba(26, 51, 77, 1.0)'  <-- if color_css was set
    # }
    # With current logic in _parse_node, color_css is derived and set, so this would be populated.
    # The alias 'color' for 'color_css' in TextStyle means input 'color' maps to 'color_css'.
    # If the input mock_figma_text_style had a 'color' field, it would populate ts_model.color_css.
    # The current mock has 'fills', which _parse_node uses to derive color.
    
    # Conceptual test for parse_figma_response
    # mock_api_response = { ... complex Figma API structure ... }
    # simplified_design_output = parse_figma_response(mock_api_response)
    # print("Simplified Design:", simplified_design_output) # This would be a large dict/SimplifiedDesign object
