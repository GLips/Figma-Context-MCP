import asyncio
import os
import pathlib
import random
import string
import logging
from typing import Any, Dict, List, Optional, Union, NewType, TypeAlias

import httpx

# --- Type Aliases (for clarity, matching TypeScript concepts) ---
StyleId = NewType('StyleId', str)
CSSHexColor: TypeAlias = str
CSSRGBAColor: TypeAlias = str

# SimplifiedFill can be a string (hex/rgba) or a dict for IMAGE/GRADIENT
SimplifiedFill = Union[CSSHexColor, CSSRGBAColor, Dict[str, Any]]

# Figma API type concepts (simplified for this context)
FigmaRGBA = Dict[str, float]  # Expects r, g, b, a (0.0-1.0)
FigmaPaint = Dict[str, Any]   # Represents a Figma Paint object
FigmaColorStop = Dict[str, Any] # Represents a Figma Color Stop
FigmaVector = Dict[str, float] # Represents a Figma Vector (e.g. for gradient handles)

ColorValue = Dict[str, Union[CSSHexColor, float]] # For {hex: str, opacity: float}

# Configure a logger for this module
logger = logging.getLogger(__name__)


# --- Utility Functions ---

async def download_figma_image(
    file_name: str,
    local_path: str,
    image_url: str
) -> str:
    """
    Download Figma image and save it locally.
    Uses httpx for asynchronous download.
    """
    try:
        # Ensure local path exists
        path = pathlib.Path(local_path)
        path.mkdir(parents=True, exist_ok=True)

        full_path = path / file_name

        async with httpx.AsyncClient() as client:
            response = await client.get(image_url)
            response.raise_for_status()  # Raises HTTPStatusError for 4xx/5xx responses

            with open(full_path, "wb") as f:
                f.write(response.content)
            
            logger.info(f"Image downloaded successfully to {full_path}")
            return str(full_path)

    except httpx.HTTPStatusError as e:
        logger.error(f"Failed to download image {image_url}: HTTP {e.response.status_code} - {e.response.text}")
        raise ValueError(f"Failed to download image: {e.response.status_code}") from e
    except httpx.RequestError as e:
        logger.error(f"Request error while downloading image {image_url}: {e}")
        raise ValueError(f"Request error downloading image: {e}") from e
    except IOError as e:
        logger.error(f"Failed to write image to {full_path}: {e}")
        if full_path.exists():
            os.remove(full_path) # Attempt to clean up partial file
        raise ValueError(f"Failed to write image: {e}") from e
    except Exception as e:
        logger.error(f"An unexpected error occurred in download_figma_image: {e}")
        if 'full_path' in locals() and pathlib.Path(full_path).exists():
             os.remove(full_path)
        raise ValueError(f"Unexpected error downloading image: {e}") from e


def remove_empty_keys(input_val: Any) -> Any:
    """
    Recursively remove keys with empty lists or empty dicts from a dictionary.
    Handles lists by processing their elements.
    """
    if isinstance(input_val, list):
        # Process items in a list, then filter out None if items were removed
        # Note: Original TS code doesn't filter out empty items from lists, just cleans them.
        return [remove_empty_keys(item) for item in input_val]
    elif isinstance(input_val, dict):
        result = {}
        for key, value in input_val.items():
            cleaned_value = remove_empty_keys(value)
            # Skip empty lists and empty dicts
            if isinstance(cleaned_value, list) and not cleaned_value:
                continue
            if isinstance(cleaned_value, dict) and not cleaned_value:
                continue
            # Original TS also checks for `cleanedValue !== undefined` which is not
            # directly applicable in Python unless checking for a specific sentinel.
            # Here, we assume if a key exists, its cleaned value should be kept unless empty list/dict.
            result[key] = cleaned_value
        return result
    else:
        return input_val


def hex_to_rgba(hex_color: str, opacity: float = 1.0) -> CSSRGBAColor:
    """
    Convert hex color value and opacity to rgba format string.
    """
    hex_color = hex_color.lstrip("#")
    if len(hex_color) == 3:
        hex_color = "".join([c * 2 for c in hex_color])
    
    if len(hex_color) != 6:
        raise ValueError("Invalid hex color format. Must be 3 or 6 characters, excluding '#'.")

    try:
        r = int(hex_color[0:2], 16)
        g = int(hex_color[2:4], 16)
        b = int(hex_color[4:6], 16)
    except ValueError as e:
        raise ValueError(f"Invalid hex string: {hex_color}") from e

    valid_opacity = max(0.0, min(1.0, opacity))
    return f"rgba({r}, {g}, {b}, {valid_opacity})"


def convert_color(color: FigmaRGBA, opacity: float = 1.0) -> ColorValue:
    """
    Convert color from Figma RGBA (0-1 floats) to { hex: CSSHexColor, opacity: float }.
    """
    if not all(k in color for k in ('r', 'g', 'b')):
        raise ValueError("Invalid color dict. Must contain 'r', 'g', 'b' keys.")

    r_val = color['r']
    g_val = color['g']
    b_val = color['b']
    a_val = color.get('a', 1.0) # Figma color.a is the alpha of the color itself

    # Ensure values are within 0-1 range
    r = int(round(max(0.0, min(1.0, r_val)) * 255))
    g = int(round(max(0.0, min(1.0, g_val)) * 255))
    b = int(round(max(0.0, min(1.0, b_val)) * 255))

    # Combined opacity: layer/fill opacity * color's internal alpha
    # This matches the behavior of Figma where fill opacity and color alpha multiply.
    final_opacity = max(0.0, min(1.0, opacity * a_val))
    
    hex_str = f"#{r:02X}{g:02X}{b:02X}"
    return {"hex": hex_str, "opacity": round(final_opacity, 2)} # Round opacity for cleaner output


def format_rgba_color(color: FigmaRGBA, opacity: float = 1.0) -> CSSRGBAColor:
    """
    Convert color from Figma RGBA (0-1 floats) to CSS rgba(r,g,b,a) string.
    r,g,b are 0-255.
    """
    if not all(k in color for k in ('r', 'g', 'b')):
        raise ValueError("Invalid color dict. Must contain 'r', 'g', 'b' keys.")

    r_val = color['r']
    g_val = color['g']
    b_val = color['b']
    a_val = color.get('a', 1.0) # Figma color.a is the alpha of the color itself

    r = int(round(max(0.0, min(1.0, r_val)) * 255))
    g = int(round(max(0.0, min(1.0, g_val)) * 255))
    b = int(round(max(0.0, min(1.0, b_val)) * 255))
    
    final_opacity = max(0.0, min(1.0, opacity * a_val))
    
    return f"rgba({r}, {g}, {b}, {round(final_opacity, 2)})" # Round opacity


def generate_var_id(prefix: str = "var") -> StyleId:
    """
    Generate a 6-character random alphanumeric ID, prefixed by `prefix_`.
    """
    chars = string.ascii_uppercase + string.digits
    random_part = "".join(random.choices(chars, k=6))
    return StyleId(f"{prefix}_{random_part}")


def generate_css_shorthand(
    values: Dict[str, int],
    ignore_zero: bool = True,
    suffix: str = "px"
) -> Optional[str]:
    """
    Generate CSS shorthand for values like padding, margin.
    `values` is a dict {'top': int, 'right': int, 'bottom': int, 'left': int}.
    Returns None if ignore_zero is True and all values are 0.
    """
    if not all(k in values for k in ('top', 'right', 'bottom', 'left')):
        raise ValueError("Invalid values dict. Must contain 'top', 'right', 'bottom', 'left' keys.")

    top, right, bottom, left = values['top'], values['right'], values['bottom'], values['left']

    if ignore_zero and top == 0 and right == 0 and bottom == 0 and left == 0:
        return None

    if top == right == bottom == left:
        return f"{top}{suffix}"
    if top == bottom and right == left:
        return f"{top}{suffix} {right}{suffix}"
    if right == left:
        return f"{top}{suffix} {right}{suffix} {bottom}{suffix}"
    
    return f"{top}{suffix} {right}{suffix} {bottom}{suffix} {left}{suffix}"


def parse_paint(raw_paint: FigmaPaint) -> SimplifiedFill:
    """
    Convert a Figma paint object to a simplified representation.
    """
    paint_type = raw_paint.get("type")
    is_visible = raw_paint.get("visible", True) # Consider visibility

    if not is_visible: # If paint is not visible, effectively it's not there
        return {} # Or some other representation of "no fill"

    if paint_type == "IMAGE":
        return {
            "type": "IMAGE",
            "imageRef": raw_paint.get("imageRef"),
            "scaleMode": raw_paint.get("scaleMode"),
        }
    elif paint_type == "SOLID":
        color_data = raw_paint.get("color")
        if not color_data:
            raise ValueError("Solid paint is missing color data.")
        
        # Figma's `opacity` field on the Paint object applies to this specific fill/stroke
        # while `color.a` is the alpha channel of the color itself.
        paint_opacity = raw_paint.get("opacity", 1.0) 
        
        converted = convert_color(color_data, paint_opacity)
        if converted["opacity"] == 1.0:
            return converted["hex"]
        else:
            # Need to re-format as rgba string if there's alpha
            return format_rgba_color(color_data, paint_opacity)

    elif paint_type in ["GRADIENT_LINEAR", "GRADIENT_RADIAL", "GRADIENT_ANGULAR", "GRADIENT_DIAMOND"]:
        gradient_stops = raw_paint.get("gradientStops", [])
        # Opacity of the gradient fill itself
        paint_opacity = raw_paint.get("opacity", 1.0)

        return {
            "type": paint_type,
            "gradientHandlePositions": raw_paint.get("gradientHandlePositions"),
            "gradientStops": [
                {
                    "position": stop.get("position"),
                    # Apply the overall paint opacity to each stop's color
                    "color": convert_color(stop.get("color"), paint_opacity) 
                }
                for stop in gradient_stops
            ],
        }
    else:
        raise ValueError(f"Unknown or unsupported paint type: {paint_type}")


def is_visible(element: Dict[str, Any]) -> bool:
    """
    Check if an element (Figma node) is visible.
    Figma's 'visible' property defaults to true if not present.
    """
    return element.get("visible", True)

# Example of running the async function (if needed for testing directly)
# async def main():
#     try:
#         # Create a dummy file server or use a public image URL
#         # For local testing, you might need to serve a file at http://localhost:8000/test.png
#         # Example: python -m http.server 8000 in a directory with test.png
#         # path = await download_figma_image("test_download.png", "./temp_images", "YOUR_IMAGE_URL_HERE")
#         # print(f"Downloaded to: {path}")
#         pass
#     except ValueError as e:
#         print(f"Error: {e}")

# if __name__ == "__main__":
#     asyncio.run(main())
#     # Test other functions
#     print(hex_to_rgba("#FF0000", 0.5))
#     print(convert_color({'r': 1, 'g': 0, 'b': 0, 'a': 0.8}, opacity=0.5))
#     print(format_rgba_color({'r': 1, 'g': 0, 'b': 0, 'a': 1}, opacity=0.7))
#     print(generate_var_id("style"))
#     print(generate_css_shorthand({'top': 10, 'right': 10, 'bottom': 10, 'left': 10}))
#     print(generate_css_shorthand({'top': 10, 'right': 20, 'bottom': 10, 'left': 20}))
#     print(generate_css_shorthand({'top': 0, 'right': 0, 'bottom': 0, 'left': 0}))
#     print(generate_css_shorthand({'top': 0, 'right': 0, 'bottom': 0, 'left': 0}, ignore_zero=False))

#     test_paint_solid_hex = {"type": "SOLID", "color": {"r":0.2,"g":0.4,"b":0.6,"a":1}, "opacity": 1.0}
#     print(f"Solid Hex: {parse_paint(test_paint_solid_hex)}")
#     test_paint_solid_rgba = {"type": "SOLID", "color": {"r":0.2,"g":0.4,"b":0.6,"a":0.5}, "opacity": 1.0}
#     print(f"Solid RGBA (color.a): {parse_paint(test_paint_solid_rgba)}")
#     test_paint_solid_opacity = {"type": "SOLID", "color": {"r":0.2,"g":0.4,"b":0.6,"a":1}, "opacity": 0.7}
#     print(f"Solid RGBA (paint.opacity): {parse_paint(test_paint_solid_opacity)}")
#     test_paint_solid_both_opacity = {"type": "SOLID", "color": {"r":0.2,"g":0.4,"b":0.6,"a":0.5}, "opacity": 0.5}
#     print(f"Solid RGBA (both opacity): {parse_paint(test_paint_solid_both_opacity)}")
#     test_paint_grad = {
#         "type": "GRADIENT_LINEAR", 
#         "gradientHandlePositions": [{"x":0,"y":0},{"x":1,"y":1}],
#         "gradientStops": [
#             {"position":0, "color":{"r":1,"g":0,"b":0,"a":1}},
#             {"position":1, "color":{"r":0,"g":0,"b":1,"a":0.5}}
#         ],
#         "opacity": 0.8
#     }
#     print(f"Gradient: {parse_paint(test_paint_grad)}")

#     data = {"a": 1, "b": [], "c": {"d": 2, "e": {}}, "f": [1,2], "g": {"h": []}}
#     print(f"Remove empty: {remove_empty_keys(data)}")
#     print(f"Is visible: {is_visible({'visible': True})}")
#     print(f"Is visible (not set): {is_visible({})}")
#     print(f"Is visible (false): {is_visible({'visible': False})}")
