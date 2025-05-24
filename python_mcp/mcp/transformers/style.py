from typing import Optional, List as PyList, Dict as PyDict, Any
from pydantic import BaseModel, Field

from mcp.utils.common import parse_paint, generate_css_shorthand, is_visible, SimplifiedFill
from mcp.utils.identity import has_value, is_stroke_weights

# Pydantic Model for Simplified Stroke Style
class SimplifiedStroke(BaseModel):
    colors: PyList[SimplifiedFill] = Field(default_factory=list) # SimplifiedFill is Union[str, Dict]
    stroke_weight: Optional[str] = None
    stroke_dashes: Optional[PyList[float]] = None
    stroke_align: Optional[str] = None # e.g., INSIDE, OUTSIDE, CENTER

    class Config:
        populate_by_name = True # Allows using aliases if defined, though not used here

# Main function to build simplified stroke style
def build_simplified_strokes(node_data: PyDict[str, Any]) -> PyDict[str, Any]:
    """
    Builds a simplified stroke style object from Figma node data.
    Processes stroke colors, weight, dashes, and alignment.
    Returns a dictionary containing only the keys that have actual values.
    """
    
    # Initialize with default values that will be part of the model
    stroke_colors: PyList[SimplifiedFill] = []
    stroke_weight_val: Optional[str] = None
    stroke_dashes_val: Optional[PyList[float]] = None
    stroke_align_val: Optional[str] = None

    # Strokes (Colors)
    # The original TS checks `node.strokes && node.strokes.length > 0`
    # has_value(node_data, 'strokes') implicitly checks for non-empty if strokes is a list
    if has_value(node_data, 'strokes') and isinstance(node_data['strokes'], list) and node_data['strokes']:
        raw_strokes = node_data['strokes']
        # Filter for visible strokes and parse them
        # The original is_visible in common.ts took `element: { visible?: boolean }`
        # Assuming parse_paint handles visibility or strokes are dicts with 'visible' key
        visible_strokes = [s for s in raw_strokes if isinstance(s, dict) and is_visible(s)]
        stroke_colors = [parse_paint(stroke_paint) for stroke_paint in visible_strokes]

    # Stroke Weight
    # Check for individualStrokeWeights first
    if has_value(node_data, 'individualStrokeWeights', lambda v: is_stroke_weights(v)):
        # is_stroke_weights checks if the value is a dict with top, right, bottom, left
        # generate_css_shorthand takes such a dict
        stroke_weight_val = generate_css_shorthand(node_data['individualStrokeWeights'])
    elif has_value(node_data, 'strokeWeight', lambda v: isinstance(v, (int, float)) and v > 0):
        weight = node_data['strokeWeight']
        stroke_weight_val = f"{weight}px"

    # Stroke Dashes
    # The original TS checks `node.strokeDashes && node.strokeDashes.length > 0`
    if has_value(node_data, 'strokeDashes', lambda v: isinstance(v, list) and len(v) > 0):
        stroke_dashes_val = node_data['strokeDashes']
    
    # Stroke Align
    if has_value(node_data, 'strokeAlign', lambda v: isinstance(v, str)):
        stroke_align_val = node_data['strokeAlign']

    # Create Pydantic model instance
    simplified_stroke_model = SimplifiedStroke(
        colors=stroke_colors,
        stroke_weight=stroke_weight_val,
        stroke_dashes=stroke_dashes_val,
        stroke_align=stroke_align_val
    )

    # Return as dict, excluding None values and empty lists for 'colors'
    # Pydantic's exclude_none works for None, for empty list we add custom logic
    dump = simplified_stroke_model.model_dump(exclude_none=True)
    
    # If 'colors' is present and is an empty list, remove it from the dump.
    # This ensures 'colors' key only appears if there are actual colors.
    if "colors" in dump and not dump["colors"]:
        del dump["colors"]
        
    return dump


# Example Usage (for testing purposes)
if __name__ == "__main__":
    # Mock data for testing
    sample_node_simple_stroke = {
        "strokes": [{"type": "SOLID", "color": {"r": 1, "g": 0, "b": 0, "a": 1}, "visible": True}],
        "strokeWeight": 2,
        "strokeAlign": "INSIDE",
        "strokeDashes": [5, 5]
    }
    print("Simple Stroke:", build_simplified_strokes(sample_node_simple_stroke))
    # Expected: {'colors': ['#FF0000'], 'stroke_weight': '2px', 'stroke_dashes': [5.0, 5.0], 'stroke_align': 'INSIDE'}

    sample_node_individual_strokes = {
        "strokes": [{"type": "SOLID", "color": {"r": 0, "g": 1, "b": 0, "a": 1}, "visible": True}],
        "individualStrokeWeights": {"top": 1, "right": 2, "bottom": 1, "left": 2}, # Will produce 1px 2px
        "strokeAlign": "CENTER"
    }
    print("Individual Strokes:", build_simplified_strokes(sample_node_individual_strokes))
    # Expected: {'colors': ['#00FF00'], 'stroke_weight': '1px 2px', 'stroke_align': 'CENTER'}

    sample_node_no_stroke_weight = {
        "strokes": [{"type": "SOLID", "color": {"r": 0, "g": 0, "b": 1, "a": 1}, "visible": True}],
        "strokeWeight": 0, # Should be ignored
        "strokeAlign": "OUTSIDE"
    }
    print("No Stroke Weight (strokeWeight is 0):", build_simplified_strokes(sample_node_no_stroke_weight))
    # Expected: {'colors': ['#0000FF'], 'stroke_align': 'OUTSIDE'}

    sample_node_no_strokes = {
        "strokeWeight": 3
    }
    print("No Strokes (colors):", build_simplified_strokes(sample_node_no_strokes))
    # Expected: {'stroke_weight': '3px'}
    
    sample_node_empty_stroke_dashes = {
        "strokes": [{"type": "SOLID", "color": {"r": 0.5, "g": 0.5, "b": 0.5, "a": 1}, "visible": True}],
        "strokeWeight": 1,
        "strokeDashes": [] # Should be ignored
    }
    print("Empty Stroke Dashes:", build_simplified_strokes(sample_node_empty_stroke_dashes))
    # Expected: {'colors': ['#808080'], 'stroke_weight': '1px'}

    sample_node_invisible_stroke = {
        "strokes": [{"type": "SOLID", "color": {"r": 1, "g": 0, "b": 0, "a": 1}, "visible": False}],
        "strokeWeight": 2
    }
    print("Invisible Stroke:", build_simplified_strokes(sample_node_invisible_stroke))
    # Expected: {'stroke_weight': '2px'} (colors should be empty and thus not in output)
    
    sample_node_all_zero_individual = {
        "strokes": [{"type": "SOLID", "color": {"r": 0, "g": 1, "b": 0, "a": 1}, "visible": True}],
        "individualStrokeWeights": {"top": 0, "right": 0, "bottom": 0, "left": 0}, # generate_css_shorthand returns None
        "strokeAlign": "CENTER"
    }
    print("All Zero Individual Strokes (ignoreZero=true):", build_simplified_strokes(sample_node_all_zero_individual))
    # Expected: {'colors': ['#00FF00'], 'stroke_align': 'CENTER'} (no stroke_weight)

    # Test with a gradient fill for stroke
    gradient_stroke_paint = {
        "type": "GRADIENT_LINEAR", 
        "visible": True,
        "gradientHandlePositions": [{"x":0,"y":0},{"x":1,"y":1}],
        "gradientStops": [
            {"position":0, "color":{"r":1,"g":0,"b":0,"a":1}},
            {"position":1, "color":{"r":0,"g":0,"b":1,"a":0.5}}
        ],
        "opacity": 0.8 # Opacity of the paint itself
    }
    sample_node_gradient_stroke = {
        "strokes": [gradient_stroke_paint],
        "strokeWeight": 4
    }
    print("Gradient Stroke:", build_simplified_strokes(sample_node_gradient_stroke))
    # Expected (color part might be complex dict):
    # {'colors': [{'type': 'GRADIENT_LINEAR', ...}], 'stroke_weight': '4px'}

    # Test with no relevant stroke properties
    sample_node_no_props = {
        "name": "TestFrame"
    }
    print("No relevant props:", build_simplified_strokes(sample_node_no_props))
    # Expected: {}
    
    # Test with only strokeAlign
    sample_node_only_align = {
        "strokeAlign": "INSIDE"
    }
    print("Only Align:", build_simplified_strokes(sample_node_only_align))
    # Expected: {'stroke_align': 'INSIDE'}
