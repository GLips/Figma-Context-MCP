# Re-export key functionalities to make them available at the package level

# From .mcp (core server logic and tool registration)
from .mcp import _create_server as create_server # Expose the server creation function

# From .config (server configuration loading)
from .config import get_server_config, ServerConfig, FigmaAuthOptions

# From .services.figma_service (Figma API interaction)
from .services.figma_service import FigmaService

# From .services.simplify_node_response (Simplified data structures)
from .services.simplify_node_response import SimplifiedDesign, SimplifiedNode, BoundingBox, TextStyle # Add other relevant models if they are part of the public API

# From .cli (main server startup logic, if intended to be programmatic)
# Might not be common to expose CLI's main directly, but if startServer was used programmatically:
from .cli import main_server_logic as start_server 

# Define __all__ to specify the public API of the package
__all__ = [
    "create_server",
    "get_server_config",
    "ServerConfig",
    "FigmaAuthOptions",
    "FigmaService",
    "SimplifiedDesign",
    "SimplifiedNode",
    "BoundingBox",
    "TextStyle",
    "start_server",
]

# Optional: Add a version attribute
__version__ = "0.1.0" # Should match pyproject.toml
