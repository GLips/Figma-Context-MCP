import asyncio
import yaml # PyYAML
from pydantic import BaseModel, Field, ValidationError
from typing import Dict, Any, List, Optional, Callable, Awaitable, Type

# Attempt to import from local project structure
try:
    from mcp.services.figma_service import FigmaService, FigmaAuthOptions
    from mcp.services.simplify_node_response import SimplifiedDesign # Used for type hint, result is dict
    from mcp.utils.logger import logger, set_http_mode as set_logger_http_mode
except ImportError:
    import logging # Ensure logging is imported for the fallback
    # Fallbacks for standalone development or if modules are not yet fully structured
    logger = logging.getLogger(__name__)
    logging.basicConfig(level=logging.INFO)
    logger.warning("MCP: Using fallback logger due to ImportError.")
    def set_logger_http_mode(is_http: bool): logger.info(f"Logger HTTP mode set to: {is_http} (fallback)")

    # Fallback Pydantic models if imports fail
    class FigmaAuthOptions(BaseModel): figma_api_key: Optional[str] = None
    class FigmaService: pass # Placeholder
    class SimplifiedDesign(BaseModel): pass # Placeholder


# --- Pydantic Schemas for Tool Arguments ---

class GetFigmaDataArgs(BaseModel):
    fileKey: str = Field(..., description="The Figma file key.")
    nodeId: Optional[str] = Field(default=None, description="Optional Figma node ID.")
    depth: Optional[int] = Field(default=None, description="Optional depth for node fetching.")

class NodeImageRequest(BaseModel):
    nodeId: str = Field(..., description="ID of the node to image or containing the image fill.")
    imageRef: Optional[str] = Field(default=None, description="For image fills, the imageRef property from Figma Paint object.")
    fileName: str = Field(..., description="Desired output filename for the image.")
    # fileType is part of FetchImageParams in FigmaService, but not explicitly in this model from TS
    # The handler will need to determine this or it should be added if needed by download_figma_images_handler

class DownloadFigmaImagesArgs(BaseModel):
    fileKey: str = Field(..., description="The Figma file key.")
    nodes: List[NodeImageRequest] = Field(..., description="List of nodes/images to download.")
    scale: Optional[float] = Field(default=2.0, description="Image scale factor (for PNG).")
    localPath: str = Field(..., description="Local directory path to save images.")


# --- Mock MCP Server ---

class MockMcpServer:
    def __init__(self, server_info: Dict[str, Any]):
        self.server_info = server_info
        self.tools: Dict[str, Dict[str, Any]] = {} # Store name, description, schema, handler
        self.figma_service_instance: Optional[FigmaService] = None # To hold the service instance

    def tool(
        self,
        name: str,
        description: str,
        schema_model: Type[BaseModel],
        handler: Callable[..., Awaitable[Dict[str, Any]]] # Handler is async and returns a dict
    ):
        """Registers a tool with the server."""
        self.tools[name] = {
            "name": name,
            "description": description,
            "schema_model": schema_model,
            "handler": handler,
        }
        logger.info(f"MCP Server: Tool '{name}' registered.")

    async def connect(self, transport: Any): # transport type can be more specific if known
        """Placeholder for connecting a transport layer."""
        # In a real server, this would set up listeners or connections.
        # For this mock, it might manage the lifecycle of shared services like FigmaService.
        logger.info(f"MCP Server: connect called with transport {transport}. Figma service instance: {self.figma_service_instance}")
        if self.figma_service_instance and hasattr(self.figma_service_instance, '__aenter__'):
            try:
                await self.figma_service_instance.__aenter__()
                logger.info("FigmaService context entered via MockMcpServer.connect")
            except Exception as e:
                logger.error(f"Error entering FigmaService context in MockMcpServer.connect: {e}")
        # The actual message handling loop would be started by the transport or server framework.

    async def close(self):
        """Placeholder for cleaning up resources, like closing the FigmaService client."""
        logger.info("MCP Server: close called.")
        if self.figma_service_instance and hasattr(self.figma_service_instance, '__aexit__'):
            try:
                await self.figma_service_instance.__aexit__(None, None, None)
                logger.info("FigmaService context exited via MockMcpServer.close")
            except Exception as e:
                logger.error(f"Error exiting FigmaService context in MockMcpServer.close: {e}")

    async def handle_message(self, request_payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """
        Handles an incoming JSON-RPC like request payload.
        Routes 'tools/call' method to the appropriate tool handler.
        """
        logger.debug(f"MockMcpServer received message: {request_payload}")
        request_id = request_payload.get("id") # JSON-RPC request ID

        if request_payload.get("method") == "tools/call":
            params = request_payload.get("params", {})
            tool_name = params.get("name")
            tool_arguments_dict = params.get("arguments", {})

            if not tool_name or not isinstance(tool_name, str):
                logger.error(f"Missing or invalid tool name in request: {request_payload}")
                return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32602, "message": "Invalid params: Missing or invalid tool name"}}

            if tool_name in self.tools:
                tool_info = self.tools[tool_name]
                schema_model: Type[BaseModel] = tool_info["schema_model"]
                handler: Callable[..., Awaitable[Dict[str, Any]]] = tool_info["handler"]

                try:
                    # Validate arguments against the Pydantic schema model
                    validated_args = schema_model.model_validate(tool_arguments_dict)
                except ValidationError as e:
                    logger.error(f"Argument validation failed for tool '{tool_name}': {e}. Arguments: {tool_arguments_dict}")
                    # Return detailed validation error if needed, or a generic one
                    error_details = e.errors() # Pydantic's detailed errors
                    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32602, "message": f"Invalid params: {error_details}"}}
                
                try:
                    # Call the tool handler with validated Pydantic model instance
                    tool_result_dict = await handler(validated_args)
                    # The handler should return a dict like: {"content": [...], "is_error": False}
                    # This needs to be wrapped in a JSON-RPC response structure if the client expects it.
                    # For now, assuming the client's `request` method handles CallToolResult parsing directly
                    # and doesn't need the full JSON-RPC wrapper from this handler.
                    # However, the prompt for MockClient.request implies it gets a dict that fits CallToolResult.
                    # So, the handler's direct output is what's expected.
                    return tool_result_dict # This matches what MockClient's .request() expects for CallToolResult
                except Exception as e:
                    logger.error(f"Error executing tool '{tool_name}': {e}", exc_info=True)
                    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32600, "message": f"Tool execution error: {str(e)}"}}
            else:
                logger.error(f"Tool '{tool_name}' not found.")
                return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": f"Method not found: Tool '{tool_name}' not registered"}}
        else:
            logger.warning(f"Unsupported method in request: {request_payload.get('method')}")
            return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": "Method not found"}}


# --- Tool Registration ---

def _register_tools(server: MockMcpServer, figma_service: FigmaService):
    """Registers all Figma related tools with the MCP server."""

    # --- get_figma_data tool ---
    async def get_figma_data_handler(args: GetFigmaDataArgs) -> Dict[str, Any]:
        logger.info(f"Executing get_figma_data with args: {args.model_dump_json()}")
        try:
            if args.nodeId:
                # Type hint for clarity, though parse_figma_response returns a dict
                figma_data_model: SimplifiedDesign = await figma_service.get_node(
                    file_key=args.fileKey, node_id=args.nodeId, depth=args.depth
                )
            else:
                figma_data_model: SimplifiedDesign = await figma_service.get_file(
                    file_key=args.fileKey, depth=args.depth
                )
            
            # Convert Pydantic model to dict, then dump to YAML
            # parse_figma_response (called by figma_service methods) already returns a dict
            # that has had remove_empty_keys applied.
            # So, figma_data_model is already a dict here if FigmaService returns the dict from parse_figma_response
            # If FigmaService methods return Pydantic models, then model_dump is needed.
            # Based on FigmaService, get_node/get_file return SimplifiedDesign Pydantic models.
            figma_data_dict = figma_data_model.model_dump(exclude_none=True, by_alias=True)
            
            yaml_result = yaml.dump(figma_data_dict, sort_keys=False, allow_unicode=True)
            
            return {"content": [{"type": "text", "text": yaml_result}], "is_error": False}
        except ValidationError as e: # Pydantic validation error for args
            logger.error(f"Validation error for get_figma_data arguments: {e}")
            return {"content": [{"type": "text", "text": f"Argument validation error: {e}"}], "is_error": True}
        except Exception as e:
            logger.error(f"Error in get_figma_data_handler: {e}", exc_info=True)
            return {"content": [{"type": "text", "text": f"An error occurred: {str(e)}"}], "is_error": True}

    server.tool(
        name="get_figma_data",
        description="Fetches Figma file data or specific node data and returns it as YAML.",
        schema_model=GetFigmaDataArgs,
        handler=get_figma_data_handler
    )

    # --- download_figma_images tool ---
    async def download_figma_images_handler(args: DownloadFigmaImagesArgs) -> Dict[str, Any]:
        logger.info(f"Executing download_figma_images with args: {args.model_dump_json(exclude_none=True)}")
        
        # Imports needed for FetchImageParams, FetchImageFillParams from figma_service
        try:
            from mcp.services.figma_service import FetchImageParams, FetchImageFillParams
        except ImportError:
            logger.error("Failed to import FetchImageParams/FetchImageFillParams for download_figma_images_handler")
            return {"content": [{"type": "text", "text": "Internal server error: Image handling components missing."}], "is_error": True}

        image_fill_nodes_params: List[FetchImageFillParams] = []
        render_image_nodes_params: List[FetchImageParams] = []

        for node_req in args.nodes:
            if node_req.imageRef: # This is an image fill
                image_fill_nodes_params.append(
                    FetchImageFillParams(
                        node_id=node_req.nodeId,
                        file_name=node_req.fileName,
                        image_ref=node_req.imageRef
                    )
                )
            else: # This is a node to be rendered as an image (PNG/SVG)
                # Determine file_type from fileName extension
                file_ext = os.path.splitext(node_req.fileName)[1].lower()
                if file_ext not in [".png", ".svg"]:
                    logger.warning(f"Unsupported file type for {node_req.fileName}. Defaulting to PNG.")
                    file_type = "png"
                else:
                    file_type = file_ext[1:] # Remove dot

                render_image_nodes_params.append(
                    FetchImageParams(
                        node_id=node_req.nodeId,
                        file_name=node_req.fileName,
                        file_type=file_type
                    )
                )
        
        downloaded_paths: List[str] = []
        errors_occurred: List[str] = []

        try:
            # Run fill downloads and image renders concurrently
            tasks_to_run = []
            if image_fill_nodes_params:
                tasks_to_run.append(
                    figma_service.get_image_fills(
                        file_key=args.fileKey,
                        nodes=image_fill_nodes_params,
                        local_path=args.localPath
                    )
                )
            if render_image_nodes_params:
                tasks_to_run.append(
                    figma_service.get_images(
                        file_key=args.fileKey,
                        nodes=render_image_nodes_params,
                        local_path=args.localPath,
                        scale=args.scale or 2.0 # Ensure scale has a default
                    )
                )
            
            if not tasks_to_run:
                return {"content": [{"type": "text", "text": "No valid image requests to process."}], "is_error": False}

            # asyncio.gather returns a list of results, in the order tasks were added
            results_from_gather = await asyncio.gather(*tasks_to_run, return_exceptions=True)
            
            for result_item in results_from_gather:
                if isinstance(result_item, Exception):
                    errors_occurred.append(f"A download task failed: {str(result_item)}")
                elif isinstance(result_item, list): # Expected result from get_image_fills/get_images
                    downloaded_paths.extend(result_item)
                # Handle unexpected result types if necessary
                else:
                    logger.warning(f"Unexpected result type from asyncio.gather: {type(result_item)}")


            if errors_occurred:
                error_summary = "; ".join(errors_occurred)
                # If some paths were downloaded, mention them.
                if downloaded_paths:
                    return {"content": [{"type": "text", "text": f"Completed with errors. Downloaded: {downloaded_paths}. Errors: {error_summary}"}], "is_error": True}
                else:
                    return {"content": [{"type": "text", "text": f"All image downloads failed. Errors: {error_summary}"}], "is_error": True}

            return {"content": [{"type": "text", "text": f"Successfully downloaded images: {downloaded_paths}"}], "is_error": False}

        except ValidationError as e: # Pydantic validation error for args
            logger.error(f"Validation error for download_figma_images arguments: {e}")
            return {"content": [{"type": "text", "text": f"Argument validation error: {e}"}], "is_error": True}
        except Exception as e:
            logger.error(f"Error in download_figma_images_handler: {e}", exc_info=True)
            return {"content": [{"type": "text", "text": f"An error occurred: {str(e)}"}], "is_error": True}

    server.tool(
        name="download_figma_images",
        description="Downloads rendered images of nodes or actual image fills from Figma.",
        schema_model=DownloadFigmaImagesArgs,
        handler=download_figma_images_handler
    )


# --- Server Creation Function ---

def _create_server(auth_options: FigmaAuthOptions, is_http: bool = False) -> MockMcpServer:
    """
    Creates and configures the MockMcpServer instance.
    """
    server_info = {"name": "Figma MCP Server", "version": "0.2.1"} # Version from TS
    
    # Initialize server
    server = MockMcpServer(server_info=server_info)
    
    # Initialize FigmaService - this instance will be shared by tool handlers
    # The lifecycle of figma_service (client.aclose()) needs to be managed.
    # MockMcpServer.connect and .close can handle __aenter__/__aexit__
    figma_service = FigmaService(auth_options=auth_options)
    server.figma_service_instance = figma_service # Store it on server instance for lifecycle management

    # Register tools
    _register_tools(server, figma_service)
    
    # Set logger mode (e.g., for HTTP specific logging format)
    # Assuming Logger.set_http_mode is available and correctly imported
    try:
        set_logger_http_mode(is_http)
    except NameError: # If fallback logger is used
        logger.info(f"(Fallback) Logger HTTP mode would be set to: {is_http}")
        
    logger.info(f"MockMcpServer created. HTTP mode: {is_http}. Server info: {server_info}")
    return server


# Example of how the server might be created and used (conceptual)
# This would typically be in a main CLI or server runner file.
if __name__ == "__main__":
    import logging # For __main__ example
    
    # This is a conceptual example. Real usage requires an event loop and transport.
    logger.info("Conceptual MCP Server Run (Python)")

    # 1. Get Configuration (auth options, etc.)
    # This would typically come from mcp.config.get_server_config()
    mock_auth_options = FigmaAuthOptions(figma_api_key="YOUR_MOCK_API_KEY_HERE_FOR_TESTING")
    if mock_auth_options.figma_api_key == "YOUR_MOCK_API_KEY_HERE_FOR_TESTING":
        logger.warning("Using placeholder API key for __main__ example.")

    # 2. Create the server instance
    # is_http would depend on whether it's an HTTP server or stdio
    mcp_server = _create_server(auth_options=mock_auth_options, is_http=False)

    # 3. Simulate connecting a transport (in a real scenario, a transport layer would do this)
    # And then the server would start handling messages via the transport.
    # For this mock, `connect` might manage the FigmaService lifecycle.
    
    async def run_mock_server_operations():
        mock_transport_placeholder = "mock_stdio_transport" # Placeholder
        await mcp_server.connect(mock_transport_placeholder)

        # Example: Manually call a tool handler (how a real server would dispatch)
        if "get_figma_data" in mcp_server.tools:
            tool_info = mcp_server.tools["get_figma_data"]
            handler = tool_info["handler"]
            schema = tool_info["schema_model"]
            
            # Simulate valid arguments
            try:
                # valid_args = schema(fileKey="someFileKey", nodeId="1:2")
                # logger.info(f"Simulating call to get_figma_data with {valid_args.model_dump_json()}")
                # result = await handler(valid_args)
                # logger.info(f"Simulated call result: {result}")
                pass # Commented out to prevent actual API call during file creation
            except Exception as e:
                logger.error(f"Error simulating tool call: {e}")
        
        await mcp_server.close() # Ensure FigmaService client is closed

    # asyncio.run(run_mock_server_operations()) # Commented out to prevent execution on import/creation
    logger.info("Conceptual run finished. To test tool handlers, uncomment asyncio.run and provide valid args.")
