import os
import argparse
import logging # Using standard logging, will use mcp.utils.logger later
import sys
from typing import Optional, Dict

from pydantic import BaseModel, Field, validator
from dotenv import load_dotenv

# Attempt to import FigmaAuthOptions from figma_service
# If this creates a circular dependency, FigmaAuthOptions might need to be moved to a common types module.
# For now, let's assume it can be imported or will be moved if issues arise.
try:
    from mcp.services.figma_service import FigmaAuthOptions
except ImportError:
    # Fallback definition if import fails (e.g. during initial setup or if figma_service is not yet created)
    # This should ideally be resolved by ensuring figma_service.py is created first or moving FigmaAuthOptions
    # to a common location.
    class FigmaAuthOptions(BaseModel):
        figma_api_key: Optional[str] = None
        figma_oauth_token: Optional[str] = None
        use_oauth: bool = False
        # Add a note that this is a fallback
        _is_fallback: bool = PrivateAttr(default=True)


# Import logger from mcp.utils.logger
# Assuming it's already created and configured.
# If not, standard logging will be used as a placeholder.
try:
    from mcp.utils.logger import logger, log, error as log_error # Use specific log functions
except ImportError:
    logger = logging.getLogger(__name__)
    # Basic configuration for fallback logger
    logging.basicConfig(level=logging.INFO, format='[%(levelname)s] %(message)s')
    def log(*args): logger.info(" ".join(map(str,args)))
    def log_error(*args): logger.error(" ".join(map(str,args)))


# --- Pydantic Models ---

class ConfigSources(BaseModel):
    figma_api_key_source: str = Field(default="none", alias="figmaApiKeySource")
    figma_oauth_token_source: str = Field(default="none", alias="figmaOauthTokenSource")
    port_source: str = Field(default="none", alias="portSource")

    class Config:
        populate_by_name = True # Allow using aliases for input
        allow_population_by_field_name = True # Allow direct assignment as well

class ServerConfig(BaseModel):
    auth: FigmaAuthOptions
    port: int
    config_sources: ConfigSources

    @validator('port', pre=True, always=True)
    def port_must_be_int(cls, v):
        if isinstance(v, str):
            try:
                return int(v)
            except ValueError:
                raise ValueError(f"Port must be a valid integer, got {v}")
        return v

# --- Helper Functions ---

def _mask_api_key(key: Optional[str]) -> str:
    """Masks an API key, showing only the first and last 4 characters."""
    if not key:
        return "Not Set"
    if len(key) <= 8:
        return "****" # Too short to mask effectively otherwise
    return f"{key[:4]}...{key[-4:]}"

# --- Main Configuration Function ---

def get_server_config(is_stdio_mode: bool) -> ServerConfig:
    """
    Retrieves server configuration from CLI arguments, environment variables, and defaults.
    Prioritizes CLI > Environment > Defaults.
    """
    load_dotenv() # Load .env file if present

    parser = argparse.ArgumentParser(description="Figma MCP Server Configuration")
    parser.add_argument(
        "--figma-api-key", type=str, help="Figma API Key", default=None
    )
    parser.add_argument(
        "--figma-oauth-token", type=str, help="Figma OAuth Token", default=None
    )
    parser.add_argument(
        "--port", type=int, help="Port for the server (if not in stdio mode)", default=None
    )
    
    # Parse only known args, ignore others that might be for other tools (e.g. by MCP client)
    args, _ = parser.parse_known_args()

    sources: Dict[str, str] = {
        "figma_api_key_source": "none",
        "figma_oauth_token_source": "none",
        "port_source": "none",
    }

    # Determine Figma API Key
    figma_api_key_val: Optional[str] = None
    if args.figma_api_key:
        figma_api_key_val = args.figma_api_key
        sources["figma_api_key_source"] = "cli"
    elif os.getenv("FIGMA_API_KEY"):
        figma_api_key_val = os.getenv("FIGMA_API_KEY")
        sources["figma_api_key_source"] = "env"
    else:
        sources["figma_api_key_source"] = "none"


    # Determine Figma OAuth Token
    figma_oauth_token_val: Optional[str] = None
    if args.figma_oauth_token:
        figma_oauth_token_val = args.figma_oauth_token
        sources["figma_oauth_token_source"] = "cli"
    elif os.getenv("FIGMA_OAUTH_TOKEN"):
        figma_oauth_token_val = os.getenv("FIGMA_OAUTH_TOKEN")
        sources["figma_oauth_token_source"] = "env"
    else:
        sources["figma_oauth_token_source"] = "none"

    # Determine Port
    port_val: int
    default_port = 3333
    if args.port is not None:
        port_val = args.port
        sources["port_source"] = "cli"
    elif os.getenv("PORT"):
        try:
            port_val = int(os.getenv("PORT", "")) # type: ignore
            sources["port_source"] = "env"
        except ValueError:
            log_error(f"Invalid PORT environment variable: {os.getenv('PORT')}. Using default {default_port}.")
            port_val = default_port
            sources["port_source"] = "default"
    else:
        port_val = default_port
        sources["port_source"] = "default"

    # Validation: Ensure at least one auth method is provided
    if not figma_api_key_val and not figma_oauth_token_val:
        error_message = (
            "Authentication error: Neither Figma API Key nor OAuth Token was provided.\n"
            "Please provide one via CLI argument (--figma-api-key or --figma-oauth-token) "
            "or environment variable (FIGMA_API_KEY or FIGMA_OAUTH_TOKEN)."
        )
        sys.stderr.write(error_message + "\n")
        sys.exit(1)

    use_oauth_val = bool(figma_oauth_token_val) # Use OAuth if token is present

    # Logging configuration sources (unless in stdio mode)
    if not is_stdio_mode:
        log("Server Configuration Initialized:")
        log(f"  Figma API Key: {_mask_api_key(figma_api_key_val)} (Source: {sources['figma_api_key_source']})")
        log(f"  Figma OAuth Token: {_mask_api_key(figma_oauth_token_val)} (Source: {sources['figma_oauth_token_source']})")
        log(f"  Port: {port_val} (Source: {sources['port_source']})")
        log(f"  Authentication Mode: {'OAuth' if use_oauth_val else 'API Key'}")
        if hasattr(FigmaAuthOptions, '_is_fallback') and FigmaAuthOptions()._is_fallback:
             log_error("Warning: FigmaAuthOptions using fallback definition. Check for circular dependencies or import errors.")


    config_sources_model = ConfigSources(
        figmaApiKeySource=sources["figma_api_key_source"],
        figmaOauthTokenSource=sources["figma_oauth_token_source"],
        portSource=sources["port_source"]
    )
    
    auth_options_model = FigmaAuthOptions(
        figma_api_key=figma_api_key_val,
        figma_oauth_token=figma_oauth_token_val,
        use_oauth=use_oauth_val
    )

    return ServerConfig(
        auth=auth_options_model,
        port=port_val,
        config_sources=config_sources_model
    )

# Example usage (for testing or direct run, typically not in a library module)
if __name__ == "__main__":
    # To test this, you can run:
    # python mcp/config.py --figma-api-key=MY_CLI_KEY --port=1234
    # or set environment variables:
    # FIGMA_OAUTH_TOKEN="MY_ENV_TOKEN" python mcp/config.py
    
    # Mock is_stdio_mode for testing
    test_is_stdio = False
    print(f"Testing with is_stdio_mode = {test_is_stdio}")
    
    try:
        server_config = get_server_config(is_stdio_mode=test_is_stdio)
        print("\nSuccessfully retrieved server configuration:")
        print(server_config.model_dump_json(indent=2, by_alias=True))
        
        # Test case: no auth provided (should exit)
        # To test this, ensure no FIGMA_API_KEY or FIGMA_OAUTH_TOKEN env vars are set
        # and run without --figma-api-key or --figma-oauth-token args.
        # Example: (Comment out any key settings in your environment or this script to test)
        # print("\nTesting scenario: No auth provided (should exit with error)")
        # get_server_config(is_stdio_mode=False) # This would call sys.exit(1)
        
    except SystemExit as e:
        print(f"SystemExit caught with code: {e.code}. This is expected if auth validation fails.")
    except Exception as e:
        print(f"An error occurred: {e}")
