from typing import Any, Callable, Optional, Dict, List, Union

# Figma-specific type aliases (for conceptual clarity, not strict type enforcement)
# These would typically come from a generated SDK or Pydantic models in a larger project.
Rectangle = Dict[str, float] # Expects x, y, width, height
HasFramePropertiesTrait = Dict[str, Any] # Expects clipsContent
HasLayoutTrait = Dict[str, Any] # Expects absoluteBoundingBox
StrokeWeights = Dict[str, float] # Expects top, right, bottom, left
CSSHexColor = str
CSSRGBAColor = str


def is_truthy(val: Any) -> bool:
    """
    Checks if a value is truthy in a Pythonic way (similar to JavaScript's truthiness).
    Effectively `bool(val)`.
    """
    return bool(val)


def has_value(
    obj: Any,
    key: str,
    type_guard: Optional[Callable[[Any], bool]] = None
) -> bool:
    """
    Checks if an object (expected to be a dictionary) has a given key,
    and optionally if the value associated with that key passes a type_guard.
    """
    if not isinstance(obj, dict) or key not in obj:
        return False
    val = obj[key]
    return type_guard(val) if type_guard else val is not None


def is_frame(val: Any) -> bool:
    """
    Checks if a value appears to be a Figma Frame-like object
    by checking for the 'clipsContent' boolean property.
    """
    return (
        isinstance(val, dict) and
        "clipsContent" in val and
        isinstance(val["clipsContent"], bool)
    )


def is_layout(val: Any) -> bool:
    """
    Checks if a value appears to have Figma Layout properties,
    specifically an 'absoluteBoundingBox' dictionary with x, y, width, height.
    """
    if not (isinstance(val, dict) and "absoluteBoundingBox" in val):
        return False
    
    bbox = val["absoluteBoundingBox"]
    return (
        isinstance(bbox, dict) and
        all(k in bbox for k in ("x", "y", "width", "height")) and
        all(isinstance(bbox[k], (int, float)) for k in ("x", "y", "width", "height"))
    )


def is_stroke_weights(val: Any) -> bool:
    """
    Checks if a value appears to be a Figma StrokeWeights-like object
    by checking for 'top', 'right', 'bottom', 'left' numeric properties.
    """
    return (
        isinstance(val, dict) and
        all(k in val for k in ("top", "right", "bottom", "left")) and
        all(isinstance(val[k], (int, float)) for k in ("top", "right", "bottom", "left"))
    )


def is_rectangle(obj: Any, key: Optional[str] = None) -> bool:
    """
    Checks if an object is a Rectangle.
    If 'key' is provided, it checks if obj[key] is a Rectangle.
    Otherwise, it checks if obj itself is a Rectangle.
    A Rectangle must have 'x', 'y', 'width', 'height' numeric properties.
    """
    target_obj = obj
    if key:
        if not (isinstance(obj, dict) and key in obj):
            return False
        target_obj = obj[key]

    return (
        isinstance(target_obj, dict) and
        all(k in target_obj for k in ("x", "y", "width", "height")) and
        all(isinstance(target_obj[k], (int, float)) for k in ("x", "y", "width", "height"))
    )


def is_rectangle_corner_radii(val: Any) -> bool:
    """
    Checks if a value is a list of 4 numbers, representing rectangle corner radii.
    """
    return (
        isinstance(val, list) and
        len(val) == 4 and
        all(isinstance(v, (int, float)) for v in val)
    )


def is_css_color_value(val: Any) -> bool:
    """
    Checks if a value is a string that starts with '#' (hex color)
    or 'rgba' (rgba color).
    """
    return (
        isinstance(val, str) and
        (val.startswith("#") or val.startswith("rgba"))
    )
