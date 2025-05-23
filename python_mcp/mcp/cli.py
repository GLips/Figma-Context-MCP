#!/usr/bin/env python

import os
import sys
import argparse # argparse is used in config, but cli.py itself might not need it directly if config handles all
import asyncio
import logging # Used for fallback logger
from typing import Any, Optional # Added Optional for MockMcpServer in StdioServerTransport

from dotenv import load_dotenv
from pydantic import BaseModel # Ensure BaseModel is imported for fallback

# Adjust imports to be relative if this file is part of the mcp package
try:
    from .config import get_server_config, ServerConfig # ServerConfig for type hint
    from .server import start_http_server # Flask server
    from .mcp import _create_server, MockMcpServer # _create_server returns MockMcpServer
    from .utils.logger import Logger, set_http_mode # Use the new Logger instance
except ImportError:
    # Fallback imports for standalone execution or if structure is not fully recognized
    # This indicates that the script might be run in a way that Python's module resolution
    # for relative imports isn't working as expected (e.g. not using `python -m mcp.cli`)
    # Or, it's during the very first creation steps.
    print("CLI: Attempting fallback imports. If this persists, check PYTHONPATH or how the script is run.", file=sys.stderr)
    
    # Fallback for Logger
    # Logger instance is now expected to have .log, .error, .info, .warning methods
    _fallback_logger = logging.getLogger(__name__)
    logging.basicConfig(level=logging.INFO, format='[%(levelname)s] CLI: %(message)s')
    class FallbackLogger:
        def log(self, *args): _fallback_logger.info(" ".join(map(str,args)))
        def info(self, *args): _fallback_logger.info(" ".join(map(str,args)))
        def error(self, *args): _fallback_logger.error(" ".join(map(str,args)))
        def warning(self, *args): _fallback_logger.warning(" ".join(map(str,args)))
        def debug(self, *args): _fallback_logger.debug(" ".join(map(str,args))) # Add debug for StdioServerTransport
    Logger = FallbackLogger() # type: ignore
    def set_http_mode(is_http: bool): Logger.info(f"Logger HTTP mode set to: {is_http} (fallback)") # type: ignore
    Logger.warning("Using fallback logger.") # type: ignore

    # Fallback for config and server components
    # These would need to be more complete for the script to actually function in fallback mode.
    class ServerConfig(BaseModel): # BaseModel is now imported
        auth: Any # type: ignore
        port: int
        config_sources: Any # type: ignore
    def get_server_config(is_stdio_mode: bool) -> ServerConfig:
        Logger.error("Fallback get_server_config called. Please ensure imports are correct.")
        raise NotImplementedError("Fallback get_server_config is not functional.")
    def start_http_server(port: int, mcp_server: Any):
        Logger.error("Fallback start_http_server called.")
        raise NotImplementedError("Fallback start_http_server is not functional.")
    class MockMcpServer:
        async def connect(self, transport: Any): pass # Minimal mock
    def _create_server(auth_options: Any, is_http: bool) -> MockMcpServer:
        Logger.error("Fallback _create_server called.")
        raise NotImplementedError("Fallback _create_server is not functional.")


# --- Mock StdioServerTransport Class ---

class StdioServerTransport:
    def __init__(self):
        Logger.info("StdioServerTransport initialized.")
        self.mcp_server: Optional[MockMcpServer] = None

    async def attach_to_server(self, mcp_server: MockMcpServer):
        """
        Connects this transport to the MCP server and starts 'listening' on stdio.
        """
        self.mcp_server = mcp_server
        if self.mcp_server and hasattr(self.mcp_server, 'connect'):
            await self.mcp_server.connect(self) # Call MockMcpServer's connect
        
        Logger.log("Stdio transport active. Server is 'listening' on stdin/stdout.")
        Logger.log("Type JSON-RPC messages to stdin or use an MCP client configured for stdio.")
        
        # Simulate Stdio Interaction Loop
        try:
            # In a real implementation, this loop would:
            # 1. Asynchronously read lines from sys.stdin.
            # 2. Parse JSON-RPC messages.
            # 3. Dispatch to self.mcp_server (e.g., mcp_server.handle_message(parsed_message)).
            # 4. Write responses to sys.stdout.
            # For this mock, we just keep the event loop alive to simulate a running server.
            while True:
                # Placeholder for actual stdin reading and processing
                # Example: line = await async_read_stdin_line() -> needs an async stdin reader
                # For now, just sleep to keep the asyncio loop running.
                await asyncio.sleep(1)
                # To make it slightly more interactive for testing, one could print a heartbeat.
                # Logger.debug("Stdio server alive...") 
        except KeyboardInterrupt:
            Logger.log("Stdio server shutting down due to KeyboardInterrupt.")
        except asyncio.CancelledError:
            Logger.log("Stdio server task cancelled.")
        finally:
            if self.mcp_server and hasattr(self.mcp_server, 'close'):
                await self.mcp_server.close() # Ensure server resources are cleaned up
            Logger.log("StdioServerTransport finished.")


# --- Main Server Logic ---

async def main_server_logic():
    """
    Determines server mode (stdio or HTTP) and starts the appropriate server.
    """
    # Set initial logger mode for CLI startup messages
    # The _create_server function will set it again based on actual mode.
    try:
        set_http_mode(False) 
    except NameError: # If using fallback logger
        Logger.info("(Fallback) Logger HTTP mode would be set to False for CLI startup.")


    is_stdio_mode = "--stdio" in sys.argv
    
    Logger.info(f"Determined server mode: {'STDIO' if is_stdio_mode else 'HTTP'}")

    try:
        config_obj: ServerConfig = get_server_config(is_stdio_mode=is_stdio_mode)
    except NotImplementedError: # From fallback get_server_config
        Logger.error("Critical error: Configuration system not available. Exiting.")
        sys.exit(1)
    except SystemExit: # If get_server_config calls sys.exit (e.g. no auth)
        # Error message already printed by get_server_config
        Logger.info("Exiting due to configuration validation failure.")
        return # Do not proceed


    try:
        mcp_server = _create_server(auth_options=config_obj.auth, is_http=not is_stdio_mode)
    except NotImplementedError: # From fallback _create_server
        Logger.error("Critical error: MCP server creation logic not available. Exiting.")
        sys.exit(1)

    if is_stdio_mode:
        Logger.info("Initializing Figma MCP Server in STDIO mode...")
        transport = StdioServerTransport()
        try:
            await transport.attach_to_server(mcp_server)
        except asyncio.CancelledError:
            Logger.info("STDIO server main task was cancelled.")
        except Exception as e:
            Logger.error(f"Error during STDIO server execution: {e}", exc_info=True)
    else: # HTTP mode
        Logger.info(f"Initializing Figma MCP Server in HTTP mode on port {config_obj.port}...")
        try:
            # start_http_server (Flask app.run) is blocking.
            # For a production async server, one might use Uvicorn with an ASGI app.
            # For this project with Flask, this is the expected behavior for the dev server.
            start_http_server(port=config_obj.port, mcp_server=mcp_server)
            # Code here will only be reached after Flask server stops.
            if mcp_server and hasattr(mcp_server, 'close'): # Clean up FigmaService if HTTP server stops gracefully
                 await mcp_server.close()
            Logger.info("HTTP server has shut down.")
        except NotImplementedError: # From fallback start_http_server
            Logger.error("Critical error: HTTP server starting logic not available. Exiting.")
            sys.exit(1)
        except Exception as e:
            Logger.error(f"HTTP server failed to start or crashed: {e}", exc_info=True)
            if mcp_server and hasattr(mcp_server, 'close'):
                 await mcp_server.close() # Attempt cleanup
            sys.exit(1)


# --- Main Execution Block ---

if __name__ == "__main__":
    # Construct the path to .env in the current working directory where cli.py might be invoked
    # This assumes .env is in the same directory as where `python -m mcp.cli` or `python mcp/cli.py` is run from.
    # If python_mcp is the CWD, then .env in python_mcp.
    # If repo root is CWD and running `python python_mcp/mcp/cli.py`, then .env in repo root.
    # For `python -m mcp.cli` from repo root, CWD is repo root.
    # Let's assume .env is expected in the current working directory of the command.
    
    dotenv_path = os.path.join(os.getcwd(), ".env")
    # load_dotenv will also search common locations like current dir or parent if path is not found.
    # Explicitly providing a path can be useful. If .env is in python_mcp dir:
    # script_dir = os.path.dirname(__file__) # Path to mcp directory
    # dotenv_path_in_script_dir = os.path.join(script_dir, "..", ".env") # If .env is in python_mcp root
    # For now, let's stick to CWD's .env
    
    loaded_env = load_dotenv(dotenv_path=dotenv_path)
    if loaded_env:
        Logger.info(f"Loaded environment variables from: {dotenv_path}")
    else:
        # Try loading .env from the script's package root (python_mcp) if not found in CWD.
        # This assumes cli.py is in mcp/ package one level down from python_mcp/
        script_dir_path = os.path.dirname(os.path.abspath(__file__))
        package_root_env_path = os.path.join(script_dir_path, '..', '.env')
        loaded_pkg_env = load_dotenv(dotenv_path=package_root_env_path)
        if loaded_pkg_env:
            Logger.info(f"Loaded environment variables from package root: {package_root_env_path}")
        else:
            Logger.info("No .env file found in CWD or package root, or it is empty. Proceeding with explicit env vars or CLI args.")

    try:
        asyncio.run(main_server_logic())
    except KeyboardInterrupt:
        Logger.info("Application shut down by user (KeyboardInterrupt).")
    except Exception as e:
        Logger.error(f"An unexpected error occurred at the top level: {e}", exc_info=True)
    finally:
        Logger.info("CLI application finished.")
