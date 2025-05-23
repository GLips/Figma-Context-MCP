from typing import Optional, List, Dict as PyDict, Any
from pydantic import BaseModel, Field

from mcp.utils.common import format_rgba_color, is_visible # Import is_visible from common
from mcp.utils.identity import has_value

# Pydantic Model for Simplified Effects
class SimplifiedEffects(BaseModel):
    box_shadow: Optional[str] = None
    filter_blur: Optional[str] = Field(default=None, alias="filter") # 'filter' is a built-in, so use filter_blur
    backdrop_filter: Optional[str] = None
    text_shadow: Optional[str] = None

    class Config:
        # Allows model_dump to use aliases (e.g. 'filter' instead of 'filter_blur')
        # For returning a dict with specific key names if needed:
        # return model.model_dump(by_alias=True, exclude_none=True)
        populate_by_name = True # Allow using alias for input as well


# Helper functions (prefixed with _ to indicate internal use)

def _simplify_drop_shadow(effect: PyDict[str, Any]) -> str:
    """
    Converts a Figma drop shadow effect to a CSS box-shadow string.
    Example: offsetXpx offsetYpx radiuspx spreadpx color
    """
    offset = effect.get("offset", {"x": 0, "y": 0})
    radius = effect.get("radius", 0)
    spread = effect.get("spread", 0) # Figma API specific
    color = effect.get("color", {"r": 0, "g": 0, "b": 0, "a": 1}) # Default to black
    
    # format_rgba_color expects FigmaRGBA dict and optional opacity
    # effect.color already contains alpha, opacity field on effect itself is for the effect, not the color's alpha
    css_color = format_rgba_color(color) 
    
    return f"{offset.get('x', 0)}px {offset.get('y', 0)}px {radius}px {spread}px {css_color}"

def _simplify_inner_shadow(effect: PyDict[str, Any]) -> str:
    """
    Converts a Figma inner shadow effect to a CSS box-shadow string with 'inset'.
    Example: inset offsetXpx offsetYpx radiuspx spreadpx color
    """
    return f"inset {_simplify_drop_shadow(effect)}"

def _simplify_blur(effect: PyDict[str, Any]) -> str:
    """
    Converts a Figma blur effect to a CSS filter blur string.
    Example: blur(radiuspx)
    """
    radius = effect.get("radius", 0)
    return f"blur({radius}px)"


# Main function to build simplified effects

def build_simplified_effects(node_data: PyDict[str, Any]) -> PyDict[str, Optional[str]]:
    """
    Builds a simplified effects object from Figma node data.
    Filters for visible effects and processes them into CSS strings.
    """
    if not has_value(node_data, "effects"):
        return SimplifiedEffects().model_dump(exclude_none=True, by_alias=True)

    # Filter for visible effects (using is_visible from common.py or identity.py)
    # The original TS used effect.visible ?? true
    # Assuming effect dicts have a 'visible' key, defaulting to True if missing.
    visible_effects = [
        effect for effect in node_data.get("effects", []) 
        if isinstance(effect, dict) and effect.get("visible", True)
    ]

    if not visible_effects:
        return SimplifiedEffects().model_dump(exclude_none=True, by_alias=True)

    box_shadows: List[str] = []
    layer_blurs: List[str] = []  # For 'filter' property
    background_blurs: List[str] = [] # For 'backdrop-filter' property

    for effect in visible_effects:
        effect_type = effect.get("type")
        if effect_type == "DROP_SHADOW":
            box_shadows.append(_simplify_drop_shadow(effect))
        elif effect_type == "INNER_SHADOW":
            box_shadows.append(_simplify_inner_shadow(effect))
        elif effect_type == "LAYER_BLUR":
            layer_blurs.append(_simplify_blur(effect))
        elif effect_type == "BACKGROUND_BLUR":
            background_blurs.append(_simplify_blur(effect))
        # Other effect types like SLICE are ignored as per original logic

    # Handle text shadow specifically for TEXT nodes
    text_shadow_str: Optional[str] = None
    box_shadow_str: Optional[str] = None

    if node_data.get("type") == "TEXT":
        if box_shadows: # In Figma, text nodes use box shadows as text shadows
            text_shadow_str = ", ".join(box_shadows)
    else:
        if box_shadows:
            box_shadow_str = ", ".join(box_shadows)
            
    filter_blur_str = " ".join(layer_blurs) if layer_blurs else None
    backdrop_filter_str = " ".join(background_blurs) if background_blurs else None
    
    effects_model = SimplifiedEffects(
        box_shadow=box_shadow_str,
        filter_blur=filter_blur_str, # Pydantic will use alias "filter" on output if by_alias=True
        backdrop_filter=backdrop_filter_str,
        text_shadow=text_shadow_str
    )
    
    # Return as dict, excluding None values, and using aliases (e.g. "filter")
    return effects_model.model_dump(exclude_none=True, by_alias=True)

# Example Usage (for testing)
if __name__ == "__main__":
    # Mock mcp.utils.identity.is_visible if it's not directly available
    # For now, assuming effect.get("visible", True) is sufficient as used above.

    sample_node_text_with_shadow = {
        "type": "TEXT",
        "effects": [
            {
                "type": "DROP_SHADOW", "visible": True, "color": {"r":0, "g":0, "b":0, "a":0.5}, 
                "offset": {"x":2, "y":2}, "radius": 4, "spread": 0
            },
            {
                "type": "DROP_SHADOW", "visible": True, "color": {"r":1, "g":0, "b":0, "a":0.8}, 
                "offset": {"x":-1, "y":-1}, "radius": 1, "spread": 0
            }
        ]
    }
    print("Text with Shadow:", build_simplified_effects(sample_node_text_with_shadow))
    # Expected: {'text_shadow': '2px 2px 4px 0px rgba(0, 0, 0, 0.5), -1px -1px 1px 0px rgba(255, 0, 0, 0.8)'}


    sample_node_frame_with_effects = {
        "type": "FRAME",
        "effects": [
            {
                "type": "INNER_SHADOW", "visible": True, "color": {"r":0, "g":0, "b":0, "a":0.2}, 
                "offset": {"x":1, "y":1}, "radius": 3, "spread": 1
            },
            {
                "type": "LAYER_BLUR", "visible": True, "radius": 5
            },
            {
                "type": "BACKGROUND_BLUR", "visible": True, "radius": 10
            },
            {
                "type": "DROP_SHADOW", "visible": False, "color": {"r":0, "g":0, "b":0, "a":0.5},
                "offset": {"x":5, "y":5}, "radius": 5, "spread": 0 # This one is not visible
            }
        ]
    }
    print("Frame with Effects:", build_simplified_effects(sample_node_frame_with_effects))
    # Expected: {
    #   'box_shadow': 'inset 1px 1px 3px 1px rgba(0, 0, 0, 0.2)', 
    #   'filter': 'blur(5px)', 
    #   'backdrop_filter': 'blur(10px)'
    # }

    sample_node_no_effects = {
        "type": "RECTANGLE"
    }
    print("Node with no effects:", build_simplified_effects(sample_node_no_effects))
    # Expected: {}

    sample_node_empty_effects_list = {
        "type": "RECTANGLE",
        "effects": []
    }
    print("Node with empty effects list:", build_simplified_effects(sample_node_empty_effects_list))
    # Expected: {}

    # Test case from original TS:
    # boxShadow: "0px 4px 4px 0px rgba(0,0,0,0.25), 0px 4px 4px 0px rgba(0,0,0,0.25)",
    # filter: "blur(4px)",
    # backdropFilter: "blur(4px)",
    figma_like_node = {
        "name": "some-name",
        "type": "FRAME",
        "effects": [
            {
                "type": "DROP_SHADOW",
                "visible": True,
                "color": {"r": 0, "g": 0, "b": 0, "a": 0.25},
                "blendMode": "NORMAL",
                "offset": {"x": 0, "y": 4},
                "radius": 4,
                "spread": 0,
            },
            { # This is a duplicate, should be concatenated
                "type": "DROP_SHADOW",
                "visible": True,
                "color": {"r": 0, "g": 0, "b": 0, "a": 0.25},
                "blendMode": "NORMAL",
                "offset": {"x": 0, "y": 4},
                "radius": 4,
                "spread": 0,
            },
            {
                "type": "LAYER_BLUR",
                "visible": True,
                "radius": 4,
            },
            {
                "type": "BACKGROUND_BLUR",
                "visible": True,
                "radius": 4,
            },
        ],
    }
    print("Figma-like Node:", build_simplified_effects(figma_like_node))
    # Expected: {
    #  'box_shadow': '0px 4px 4px 0px rgba(0, 0, 0, 0.25), 0px 4px 4px 0px rgba(0, 0, 0, 0.25)', 
    #  'filter': 'blur(4px)', 
    #  'backdrop_filter': 'blur(4px)'
    # }
    
    # Check spread parameter in drop shadow
    drop_shadow_with_spread = {
        "type": "FRAME",
        "effects": [
            {
                "type": "DROP_SHADOW", "visible": True, "color": {"r":0, "g":0, "b":0, "a":0.5}, 
                "offset": {"x":2, "y":2}, "radius": 4, "spread": 5 # Spread is 5
            }
        ]
    }
    print("Drop shadow with spread:", build_simplified_effects(drop_shadow_with_spread))
    # Expected: {'box_shadow': '2px 2px 4px 5px rgba(0, 0, 0, 0.5)'}

    # Check inner shadow with spread
    inner_shadow_with_spread = {
        "type": "FRAME",
        "effects": [
            {
                "type": "INNER_SHADOW", "visible": True, "color": {"r":0, "g":0, "b":0, "a":0.5}, 
                "offset": {"x":2, "y":2}, "radius": 4, "spread": 5 # Spread is 5
            }
        ]
    }
    print("Inner shadow with spread:", build_simplified_effects(inner_shadow_with_spread))
    # Expected: {'box_shadow': 'inset 2px 2px 4px 5px rgba(0, 0, 0, 0.5)'}

    # Check if is_visible from mcp.utils.identity is correctly used (conceptual)
    # If is_visible was imported and used like:
    # visible_effects = [effect for effect in node_data["effects"] if is_visible(effect)]
    # This test would be more direct. Current implementation uses effect.get("visible", True)
    # which matches the TS `effect.visible ?? true`
    print("Assuming 'is_visible' logic using effect.get('visible', True) is aligned with TS.")

    # Check default color for drop shadow
    drop_shadow_no_color = {
        "type": "FRAME",
        "effects": [
            {
                "type": "DROP_SHADOW", "visible": True,
                "offset": {"x":2, "y":2}, "radius": 4, "spread": 0 
                # No color provided, should default to black
            }
        ]
    }
    print("Drop shadow no color:", build_simplified_effects(drop_shadow_no_color))
    # Expected: {'box_shadow': '2px 2px 4px 0px rgba(0, 0, 0, 1)'}

    # Check Pydantic model with alias
    model_instance = SimplifiedEffects(box_shadow="test", filter_blur="blur(5px)")
    print("Model dump with alias:", model_instance.model_dump(by_alias=True, exclude_none=True))
    # Expected: {'box_shadow': 'test', 'filter': 'blur(5px)'}
    model_instance_init_with_alias = SimplifiedEffects(box_shadow="test", filter="blur(5px)") # init with alias
    print("Model init with alias, dump with alias:", model_instance_init_with_alias.model_dump(by_alias=True, exclude_none=True))
    # Expected: {'box_shadow': 'test', 'filter': 'blur(5px)'}
