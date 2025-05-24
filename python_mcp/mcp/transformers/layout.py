from typing import Dict as PyDict, Optional, List as PyList, Any, Union
from pydantic import BaseModel, Field
import math

from mcp.utils.common import generate_css_shorthand
from mcp.utils.identity import is_frame, is_layout, has_value

# --- Pydantic Model ---

class SimplifiedLayout(BaseModel):
    mode: str = "none"  # Default to "none"
    justify_content: Optional[str] = None
    align_items: Optional[str] = None
    align_self: Optional[str] = None # Added this, was missing in initial prompt but present in TS logic
    wrap: Optional[bool] = None
    gap: Optional[str] = None
    location_relative_to_parent: Optional[PyDict[str, float]] = None
    dimensions: Optional[PyDict[str, Union[float, str]]] = None # width, height, aspect_ratio
    padding: Optional[str] = None
    sizing: Optional[PyDict[str, str]] = None # horizontal, vertical
    overflow_scroll: Optional[PyList[str]] = None
    position: Optional[str] = None # "absolute" or None

    class Config:
        populate_by_name = True


# --- Helper Functions ---

def _convert_sizing(sizing_value: Optional[str]) -> Optional[str]:
    """Maps Figma sizing terms to simpler terms."""
    if sizing_value == "FIXED":
        return "fixed"
    if sizing_value == "FILL":
        return "fill"
    if sizing_value == "HUG": # In Figma, HUG_CONTENTS
        return "hug"
    return None

def _convert_self_align(align: Optional[str]) -> Optional[str]:
    """Maps Figma layoutAlign to flexbox align-self terms."""
    if align == "MIN":
        return "flex-start"
    if align == "MAX":
        return "flex-end"
    if align == "CENTER":
        return "center"
    if align == "STRETCH": # STRETCH in Figma is equivalent to stretch in flex
        return "stretch"
    # INHERIT or AUTO are not directly mapped here, similar to TS
    return None

def _get_direction(axis: str, mode: str) -> Optional[str]:
    """Determines if an axis/mode combination refers to horizontal or vertical."""
    if axis == "primary":
        return "horizontal" if mode == "row" else "vertical"
    if axis == "counter":
        return "vertical" if mode == "row" else "horizontal"
    return None

def _convert_align(
    axis_align: Optional[str],
    # stretch_config: Optional[PyDict[str, Any]] = None # Placeholder for complex stretch logic
) -> Optional[str]:
    """Maps Figma primaryAxisAlignItems/counterAxisAlignItems to flexbox terms."""
    # Basic mapping without stretch logic for now
    if axis_align == "MIN":
        return "flex-start"
    if axis_align == "MAX":
        return "flex-end"
    if axis_align == "CENTER":
        return "center"
    if axis_align == "SPACE_BETWEEN":
        return "space-between"
    if axis_align == "BASELINE":
         # CSS baseline alignment is complex and often context-dependent.
         # 'baseline' is a valid value for align-items and justify-content.
        return "baseline"
    # The complex stretch logic from TS involving children analysis is omitted for now.
    # If STRETCH is passed, it's typically for counterAxisAlignItems='STRETCH' which is default in Figma for auto-layout
    # and translates to align-items: stretch.
    # If it's primaryAxisAlignItems, it's more complex (content distribution if children don't fill).
    # For now, let's assume if axis_align is "STRETCH", it means "stretch".
    if axis_align == "STRETCH": # This is a simplification
        return "stretch"
    return None


def _build_simplified_frame_values(node_data: PyDict[str, Any]) -> PyDict[str, Any]:
    """Builds layout properties derived from frame-specific Figma properties."""
    if not is_frame(node_data):
        return {"mode": "none"}

    frame_values: PyDict[str, Any] = {}
    layout_mode = node_data.get("layoutMode")

    if layout_mode == "HORIZONTAL":
        frame_values["mode"] = "row"
    elif layout_mode == "VERTICAL":
        frame_values["mode"] = "column"
    else: # NONE or not present
        frame_values["mode"] = "none"
        # Overflow scroll for non-autolayout frames
        overflow_dir = node_data.get("overflowDirection")
        if overflow_dir and overflow_dir != "NONE":
            scroll_map = {
                "HORIZONTAL_SCROLLING": ["x"],
                "VERTICAL_SCROLLING": ["y"],
                "HORIZONTAL_AND_VERTICAL_SCROLLING": ["x", "y"],
            }
            if scroll_map.get(overflow_dir):
                 frame_values["overflow_scroll"] = scroll_map.get(overflow_dir)
        return frame_values # Early exit for non-autolayout frames

    # Auto-layout specific properties:
    # primaryAxisAlignItems -> justify_content (for row) or align_items (for column)
    # counterAxisAlignItems -> align_items (for row) or justify_content (for column)
    primary_align = node_data.get("primaryAxisAlignItems")
    counter_align = node_data.get("counterAxisAlignItems")

    if frame_values["mode"] == "row":
        frame_values["justify_content"] = _convert_align(primary_align)
        frame_values["align_items"] = _convert_align(counter_align)
    else: # column
        frame_values["justify_content"] = _convert_align(counter_align) # For column, counter is horizontal
        frame_values["align_items"] = _convert_align(primary_align)   # For column, primary is vertical
    
    # layoutAlign for parent (align-self for this item within its parent frame)
    # This is handled by _build_simplified_layout_values as it relates to parent context
    # However, the original TS had `alignSelf: convertSelfAlign(node.layoutAlign)` here too.
    # This seems to be an item's instruction on how it should align IN its parent,
    # not how its children align.
    # Let's keep it here for now, as per TS structure for buildSimplifiedFrameValues.
    frame_values["align_self"] = _convert_self_align(node_data.get("layoutAlign"))


    if node_data.get("layoutWrap") == "WRAP":
        frame_values["wrap"] = True
    # else it's False or None (no_wrap is default)

    # Gap (itemSpacing for primary axis, counterAxisSpacing for cross axis if wrapping)
    # Simplified: use itemSpacing if primary, counterAxisSpacing if wrapping.
    # CSS gap is shorthand for row-gap and column-gap. Figma's itemSpacing is primary axis.
    # If wrapping, counterAxisSpacing might be relevant.
    # For now, only primary axis gap (itemSpacing).
    item_spacing = node_data.get("itemSpacing", 0)
    if item_spacing > 0 :
        frame_values["gap"] = f"{item_spacing}px" # Assuming itemSpacing is for primary axis

    # Padding
    padding_values = {
        "top": node_data.get("paddingTop", 0),
        "right": node_data.get("paddingRight", 0),
        "bottom": node_data.get("paddingBottom", 0),
        "left": node_data.get("paddingLeft", 0),
    }
    # generate_css_shorthand returns None if all are 0 and ignoreZero=True (default)
    padding_shorthand = generate_css_shorthand(padding_values)
    if padding_shorthand:
        frame_values["padding"] = padding_shorthand
        
    # Overflow scroll for autolayout frames
    overflow_dir = node_data.get("overflowDirection")
    if overflow_dir and overflow_dir != "NONE": # Should be clipsContent for autolayout?
                                              # TS uses node.clipsContent for autolayout scroll
        if node_data.get("clipsContent", False): # only allow scroll if clipsContent is true
            scroll_map = {
                "HORIZONTAL_SCROLLING": ["x"],
                "VERTICAL_SCROLLING": ["y"],
                "HORIZONTAL_AND_VERTICAL_SCROLLING": ["x", "y"],
            }
            if scroll_map.get(overflow_dir): # Should check clipsContent
                 frame_values["overflow_scroll"] = scroll_map.get(overflow_dir)
    
    return frame_values


def _build_simplified_layout_values(
    node_data: PyDict[str, Any],
    parent_data: Optional[PyDict[str, Any]],
    mode_from_frame_values: str # "none", "row", or "column"
) -> PyDict[str, Any]:
    """Builds layout properties related to sizing, positioning, and dimensions."""
    if not is_layout(node_data): # Checks for absoluteBoundingBox
        return {}

    layout_values: PyDict[str, Any] = {}
    node_box = node_data.get("absoluteBoundingBox")
    if not node_box: return {} # Should not happen if is_layout is true

    # Sizing (Horizontal and Vertical)
    sizing_horizontal = _convert_sizing(node_data.get("layoutSizingHorizontal"))
    sizing_vertical = _convert_sizing(node_data.get("layoutSizingVertical"))
    if sizing_horizontal or sizing_vertical:
        layout_values["sizing"] = {}
        if sizing_horizontal:
            layout_values["sizing"]["horizontal"] = sizing_horizontal
        if sizing_vertical:
            layout_values["sizing"]["vertical"] = sizing_vertical
            
    # Position: "absolute" if layoutPositioning is "ABSOLUTE"
    if node_data.get("layoutPositioning") == "ABSOLUTE": # Figma specific term
        layout_values["position"] = "absolute"

    # Location Relative to Parent
    # Conditions from TS:
    # (parent_is_frame && !parent_is_autolayout && !node_is_absolute) || node_is_absolute_within_autolayout_parent
    parent_is_frame = parent_data and is_frame(parent_data)
    parent_is_autolayout = parent_is_frame and parent_data.get("layoutMode", "NONE") != "NONE"
    node_is_absolute = layout_values.get("position") == "absolute"

    if parent_data and is_layout(parent_data): # Parent must also have bounding box
        parent_box = parent_data.get("absoluteBoundingBox")
        if parent_box:
            calc_relative_pos = False
            if node_is_absolute: # If node is absolute, position relative to parent container.
                calc_relative_pos = True
            elif parent_is_frame and not parent_is_autolayout: # Relative to non-autolayout parent frame.
                calc_relative_pos = True
            
            if calc_relative_pos:
                layout_values["location_relative_to_parent"] = {
                    "x": node_box["x"] - parent_box["x"],
                    "y": node_box["y"] - parent_box["y"],
                }

    # Dimensions (width, height, aspectRatio)
    # This logic is complex due to Figma's layout system (layoutGrow, layoutAlign, sizing, preserveRatio)
    width = node_box.get("width", 0)
    height = node_box.get("height", 0)
    dimensions: PyDict[str, Union[float, str]] = {}

    # Default dimensions are from absoluteBoundingBox
    dimensions["width"] = width
    dimensions["height"] = height

    # Aspect Ratio (if preserveRatio is true and not stretch in both dimensions)
    preserve_ratio = node_data.get("preserveRatio", False)
    is_stretch_h = node_data.get("layoutAlign") == "STRETCH" and mode_from_frame_values == "column" # Item stretches horizontally in a vertical layout
    is_stretch_v = node_data.get("layoutAlign") == "STRETCH" and mode_from_frame_values == "row"    # Item stretches vertically in a horizontal layout
    
    # If parent is autolayout and this item is set to STRETCH for the counter axis
    if parent_is_autolayout:
        parent_layout_mode = parent_data.get("layoutMode") # HORIZONTAL (row) or VERTICAL (column)
        item_layout_align = node_data.get("layoutAlign") # How this item aligns in parent's counter axis
        
        if parent_layout_mode == "HORIZONTAL" and item_layout_align == "STRETCH": # Parent is row, item stretches vertically
             is_stretch_v = True
        if parent_layout_mode == "VERTICAL" and item_layout_align == "STRETCH": # Parent is column, item stretches horizontally
             is_stretch_h = True


    # Overrides based on layoutSizing
    if sizing_horizontal == "fill" and not is_stretch_h : # If fill but not stretch, it means layoutGrow=1 for primary axis
        dimensions["width"] = "fill-container" # Custom string to represent this state
    if sizing_vertical == "fill" and not is_stretch_v:
        dimensions["height"] = "fill-container"

    if sizing_horizontal == "hug":
        dimensions["width"] = "hug-contents"
    if sizing_vertical == "hug":
        dimensions["height"] = "hug-contents"
        
    # If item is STRETCH in an auto-layout parent, its size on that axis is "stretch"
    if is_stretch_h:
        dimensions["width"] = "stretch"
    if is_stretch_v:
        dimensions["height"] = "stretch"


    if preserve_ratio and not (is_stretch_h and is_stretch_v): # If both stretch, ratio might not be preserved
        if width > 0 and height > 0:
            # Round to a few decimal places to avoid float precision issues
            dimensions["aspect_ratio"] = round(width / height, 4)
        
    if dimensions:
        layout_values["dimensions"] = dimensions
        
    return layout_values


# --- Main Orchestration Function ---

def build_simplified_layout(
    node_data: PyDict[str, Any],
    parent_data: Optional[PyDict[str, Any]] = None
) -> PyDict[str, Any]:
    """
    Builds a simplified layout object from Figma node data and optional parent data.
    """
    frame_values = _build_simplified_frame_values(node_data)
    mode_from_frame = frame_values.get("mode", "none")
    
    # If align_self was set in frame_values, ensure it's used.
    # align_self can also come from layoutAlign when parent is auto-layout.
    # The SimplifiedLayout model will handle merging if keys overlap.
    
    layout_specific_values = _build_simplified_layout_values(node_data, parent_data, mode_from_frame)

    # Combine results. Pydantic model will take care of structure and defaults.
    # layout_specific_values might overwrite things from frame_values if keys collide (e.g. 'position')
    # This is generally okay as layout_specific_values are more context-aware.
    
    combined_data = {**frame_values, **layout_specific_values}

    # If node is "ABSOLUTE" positioned, it shouldn't have auto-layout container properties like
    # justify_content, align_items, wrap, gap from its own frame settings if it were also a frame.
    # However, it can still *be* an autolayout container for its children.
    # The current structure correctly separates "being an autolayout container" (frame_values)
    # from "how this item is positioned/sized in its parent" (layout_specific_values).
    # If an item is position:absolute, its own frame_values like justify_content still apply to its children.

    # If `align_self` is set by `_build_simplified_frame_values` based on `node.layoutAlign`
    # and the parent is NOT an autolayout frame, this `align_self` is meaningless.
    # `layoutAlign` is only meaningful if the parent is an autolayout frame.
    parent_is_autolayout = parent_data and parent_data.get("layoutMode", "NONE") != "NONE"
    if "align_self" in combined_data and not parent_is_autolayout:
        # If parent is not autolayout, this node cannot 'align-self' in it.
        # However, if this node *is* absolutely positioned, align_self is also not applicable.
        # CSS align-self applies to flex items. Absolute positioning takes it out of flow.
        if combined_data.get("position") == "absolute" or not parent_is_autolayout:
             del combined_data["align_self"]


    layout_model = SimplifiedLayout(**combined_data)
    
    return layout_model.model_dump(exclude_none=True, by_alias=True)


# --- Example Usage (for testing) ---
if __name__ == "__main__":
    # Sample Node Data (Frame with Auto Layout)
    sample_frame_node = {
        "id": "1:1", "type": "FRAME", "name": "Test Frame",
        "layoutMode": "HORIZONTAL", # row
        "primaryAxisAlignItems": "SPACE_BETWEEN", # justify-content
        "counterAxisAlignItems": "CENTER",      # align-items
        "itemSpacing": 10, # gap
        "paddingTop": 5, "paddingRight": 5, "paddingBottom": 5, "paddingLeft": 5, # padding
        "clipsContent": True, "overflowDirection": "HORIZONTAL_SCROLLING", # overflow_scroll
        "layoutSizingHorizontal": "HUG", # sizing: {horizontal: "hug"}
        "layoutSizingVertical": "FIXED", # sizing: {vertical: "fixed"}
        "preserveRatio": True,
        "absoluteBoundingBox": {"x": 0, "y": 0, "width": 100, "height": 50},
        "children": [] 
    }
    print("Sample Frame Node:", build_simplified_layout(sample_frame_node))
    # Expected (approx): {
    # 'mode': 'row', 'justify_content': 'space-between', 'align_items': 'center', 
    # 'gap': '10px', 'padding': '5px', 'sizing': {'horizontal': 'hug', 'vertical': 'fixed'},
    # 'dimensions': {'width': 'hug-contents', 'height': 50, 'aspect_ratio': 2.0},
    # 'overflow_scroll': ['x']
    # }

    sample_child_node_in_autolayout = {
        "id": "1:2", "type": "RECTANGLE", "name": "Child Rect",
        "layoutAlign": "STRETCH", # This item wants to stretch in parent's counter axis
        "layoutGrow": 0, # 0 = fixed size along primary axis, 1 = fill primary axis
        "layoutSizingHorizontal": "FIXED", # explicit fixed size for primary axis (if parent is row)
        "layoutSizingVertical": "FILL", # explicit fill for counter axis (if parent is row)
        "absoluteBoundingBox": {"x": 5, "y": 5, "width": 20, "height": 40}, # height is 40, parent height 50
    }
    print("Child in Auto Layout (Frame as Parent):", build_simplified_layout(sample_child_node_in_autolayout, sample_frame_node))
    # Expected for child (approx): {
    # 'mode': 'none', 'align_self': 'stretch', 
    # 'sizing': {'horizontal': 'fixed', 'vertical': 'fill'}, 
    # 'dimensions': {'width': 20, 'height': 'fill-container' } -> if parent is row & child is FILL vert.
    # or 'dimensions': {'width': 20, 'height': 'stretch' } -> if parent is row & child is STRETCH layoutAlign
    # }
    # The logic for 'stretch' vs 'fill-container' in dimensions needs to be precise based on parent's layout mode.
    # If parent=row, layoutAlign=STRETCH means child stretches vertically. So height='stretch'.
    # If layoutSizingVertical=FILL means child wants to fill vertically.

    sample_absolute_child = {
        "id": "1:3", "type": "RECTANGLE", "name": "Absolute Child",
        "layoutPositioning": "ABSOLUTE",
        "absoluteBoundingBox": {"x": 70, "y": 10, "width": 25, "height": 30}
    }
    print("Absolute Child (Frame as Parent):", build_simplified_layout(sample_absolute_child, sample_frame_node))
    # Expected (approx): {
    # 'mode': 'none', 'position': 'absolute', 
    # 'location_relative_to_parent': {'x': 70, 'y': 10}, 
    # 'dimensions': {'width': 25, 'height': 30}
    # }
    
    sample_non_autolayout_frame_parent = {
        "id": "2:1", "type": "FRAME", "name": "Non-AL Parent",
        "layoutMode": "NONE",
        "absoluteBoundingBox": {"x": 100, "y": 100, "width": 200, "height": 200},
        "children": []
    }
    sample_child_in_non_al_frame = {
        "id": "2:2", "type": "RECTANGLE", "name": "Child in Non-AL",
        "absoluteBoundingBox": {"x": 110, "y": 120, "width": 50, "height": 60},
        "layoutAlign": "CENTER" # Should be ignored if parent is not autolayout
    }
    print("Child in Non-AutoLayout Frame:", build_simplified_layout(sample_child_in_non_al_frame, sample_non_autolayout_frame_parent))
    # Expected (approx): {
    # 'mode': 'none', 
    # 'location_relative_to_parent': {'x': 10, 'y': 20}, 
    # 'dimensions': {'width': 50, 'height': 60}
    # NO align_self
    # }

    # Test for overflow on non-autolayout frame
    non_al_overflow_frame = {
        "id": "3:1", "type": "FRAME", "name": "Non-AL Overflow",
        "layoutMode": "NONE",
        "overflowDirection": "VERTICAL_SCROLLING",
        "absoluteBoundingBox": {"x": 0, "y": 0, "width": 100, "height": 100},
    }
    print("Non-AL Frame with Overflow:", build_simplified_layout(non_al_overflow_frame))
    # Expected: {'mode': 'none', 'overflow_scroll': ['y'], 'dimensions': {'width': 100, 'height': 100}}

    # Test for align_self being correctly removed if node is absolute
    child_absolute_with_layout_align = {
        "id": "1:4", "type": "RECTANGLE", "name": "Absolute Child with LayoutAlign",
        "layoutPositioning": "ABSOLUTE",
        "layoutAlign": "CENTER", # This should be removed because it's absolute
        "absoluteBoundingBox": {"x": 70, "y": 10, "width": 25, "height": 30}
    }
    print("Absolute Child with LayoutAlign (Frame as Parent):", build_simplified_layout(child_absolute_with_layout_align, sample_frame_node))
    # Expected: 'align_self' should NOT be present.


    # Test for hug contents
    hug_contents_node = {
        "id": "4:1", "type": "FRAME", "name": "Hug Frame",
        "layoutMode": "HORIZONTAL",
        "layoutSizingHorizontal": "HUG",
        "layoutSizingVertical": "HUG",
        "absoluteBoundingBox": {"x": 0, "y": 0, "width": 123, "height": 45}, # Actual size from hugging
    }
    print("Hug Contents Frame:", build_simplified_layout(hug_contents_node))
    # Expected: {
    # 'mode': 'row', 
    # 'sizing': {'horizontal': 'hug', 'vertical': 'hug'}, 
    # 'dimensions': {'width': 'hug-contents', 'height': 'hug-contents', 'aspect_ratio': 2.7333} (if preserveRatio was true)
    # or 'dimensions': {'width': 'hug-contents', 'height': 'hug-contents'} (if preserveRatio is false or not set)
    # }
