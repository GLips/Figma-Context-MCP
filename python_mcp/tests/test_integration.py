import pytest
import pytest_asyncio # For async fixtures if needed later, though not for figma_env_vars
import os
import yaml # For potential debug logging or loading test data later
import asyncio
from typing import Dict, Any, Tuple, List, Optional, Callable, Awaitable

from pydantic import BaseModel, Field

# --- Simplified Pydantic Models for Tool Results (mimicking SDK schema) ---

class CallToolResultContentItem(BaseModel):
    type: str
    text: Optional[str] = None
    # Add other content types if needed by tests, e.g., image_url: Optional[str] = None
    # For this initial setup, text is sufficient.

class CallToolResult(BaseModel):
    content: List[CallToolResultContentItem] = Field(default_factory=list)
    is_error: bool = False
    # Add other fields if the simplified result needs them, e.g., tool_name: Optional[str] = None

# --- Mock SDK Components ---

class MockInMemoryTransport:
    def __init__(self, name: str):
        self.name = name
        self.linked_transport: Optional['MockInMemoryTransport'] = None
        self.message_handler: Optional[Callable[[Dict[str, Any]], Awaitable[Optional[Dict[str, Any]]]]] = None
        self.sent_messages: List[Dict[str, Any]] = []
        self.received_messages: List[Dict[str, Any]] = [] # Messages this transport "receives"

    async def connect(self, message_handler: Callable[[Dict[str, Any]], Awaitable[Optional[Dict[str, Any]]]]) -> None:
        self.message_handler = message_handler
        # print(f"Transport {self.name}: Connected with handler {message_handler}")

    async def send_message(self, message: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        # print(f"Transport {self.name}: Sending message: {message}")
        self.sent_messages.append(message)
        if self.linked_transport and self.linked_transport.message_handler:
            # Simulate the message being "received" by the linked transport
            self.linked_transport.received_messages.append(message)
            # print(f"Transport {self.name}: Forwarding to linked transport {self.linked_transport.name}")
            response = await self.linked_transport.message_handler(message)
            # print(f"Transport {self.name}: Received response from linked: {response}")
            return response
        # print(f"Transport {self.name}: No linked transport or handler to forward to.")
        return None

    async def close(self) -> None:
        # print(f"Transport {self.name}: Closed")
        pass # Placeholder

    @staticmethod
    def create_linked_pair() -> Tuple['MockInMemoryTransport', 'MockInMemoryTransport']:
        transport1 = MockInMemoryTransport("client_transport")
        transport2 = MockInMemoryTransport("server_transport")
        transport1.linked_transport = transport2
        transport2.linked_transport = transport1
        # print("Created linked pair of transports.")
        return transport1, transport2

class MockClient:
    def __init__(self, client_info: Dict[str, str], capabilities: Dict[str, Any]):
        self.client_info = client_info
        self.capabilities = capabilities
        self.transport: Optional[MockInMemoryTransport] = None
        # print(f"MockClient initialized with info: {client_info}, capabilities: {capabilities}")

    async def connect(self, transport: MockInMemoryTransport) -> None:
        self.transport = transport
        # print(f"MockClient: Connected to transport {transport.name}")

    async def request(self, payload: Dict[str, Any], response_schema: Any = None) -> Any:
        # response_schema is ignored for this mock if send_message directly returns parsed data.
        # In a real SDK, response_schema (e.g., a Pydantic model) would be used to parse the raw response.
        # print(f"MockClient: Sending request payload: {payload}")
        if not self.transport:
            raise ConnectionError("MockClient transport not connected.")
        
        # The message sent by the client usually includes client_info, capabilities, etc.
        # For this mock, we assume the `payload` is the complete message structure
        # that the server-side handler (MCP's message handler) expects.
        raw_response = await self.transport.send_message(payload)
        # print(f"MockClient: Received raw response: {raw_response}")

        if raw_response:
            # Assuming raw_response is already in a dict structure that can be parsed
            # into CallToolResult or similar.
            # For `call_tool` specifically, the server (MCP) would return something
            # that fits the CallToolResultSchema.
            try:
                # If response_schema was provided and was a Pydantic model:
                # return response_schema.model_validate(raw_response)
                # For this task, we are returning CallToolResult
                return CallToolResult.model_validate(raw_response)
            except Exception as e:
                # print(f"MockClient: Error validating response against CallToolResult: {e}")
                # Fallback or re-raise, depending on how strict the test needs to be.
                # For now, let's assume tests will provide responses that fit CallToolResult.
                raise ValueError(f"Failed to parse response into CallToolResult: {e}, response was: {raw_response}") from e
        return None # Or raise error if response is expected

    async def close(self) -> None:
        # print("MockClient: Closed")
        if self.transport:
            await self.transport.close()
        pass # Placeholder

# --- Imports from project ---
# Assuming these modules exist at these paths. Adjust if necessary.
try:
    from mcp.config import get_server_config, ServerConfig, FigmaAuthOptions
    from mcp.mcp import _create_server, MockMcpServer # MockMcpServer is also defined here
    from mcp.services.figma_service import FigmaService # For type hinting or direct use if needed
except ImportError as e:
    # This allows the file to be parsed even if all dependencies are not perfectly set up,
    # which can happen during initial test writing or if PYTHONPATH is not configured.
    # Tests requiring these imports will fail gracefully or be skipped.
    print(f"Integration Test Setup: Failed to import core MCP components: {e}. Some tests may fail or be skipped.")
    # Define fallbacks if absolutely necessary for module to load, but tests will likely fail.
    ServerConfig = None
    FigmaAuthOptions = None
    _create_server = None
    # MockMcpServer is already defined in this file if we are overwriting
    # FigmaService = None


# --- Pytest Fixture for Figma Environment Variables ---

@pytest.fixture(scope="module") # Keep as module scope if figma_env_vars don't change per test
def figma_env_vars() -> Dict[str, str]: # This fixture is correctly defined
    api_key = os.environ.get("FIGMA_API_KEY")
    file_key = os.environ.get("FIGMA_FILE_KEY")
    # Add FIGMA_NODE_ID for node-specific tests if needed later
    # node_id = os.environ.get("FIGMA_NODE_ID") 
    if not api_key or not file_key:
        pytest.skip("FIGMA_API_KEY or FIGMA_FILE_KEY not set in environment. Skipping integration tests requiring Figma.")
    return {"api_key": api_key, "file_key": file_key}


# --- Pytest Fixture for MCP Client and Server Setup ---

@pytest_asyncio.fixture(scope="function") # Use function scope for clean setup per test
async def mcp_client_server_setup(figma_env_vars): # Depends on figma_env_vars
    if not _create_server or not get_server_config: # Check if imports failed
        pytest.skip("Core MCP components not imported, skipping mcp_client_server_setup.")

    # 1. Load Server Configuration
    # Use is_stdio_mode=True as tool calls are often via stdio/direct message passing in tests
    # The actual mode (stdio/http) might not matter much here since we're directly using _create_server
    # and MockInMemoryTransport, bypassing the actual stdio/http server listeners.
    config: ServerConfig = get_server_config(is_stdio_mode=True)
    auth_options: FigmaAuthOptions = config.auth
    
    # Ensure API key from fixture is used if available, overriding .env or other sources for test consistency
    auth_options.figma_api_key = figma_env_vars["api_key"]
    auth_options.figma_oauth_token = None # Explicitly disable OAuth for this test setup
    auth_options.use_oauth = False

    # 2. Instantiate Python MCP Server
    # is_http=False aligns with is_stdio_mode=True; logger mode will be set accordingly.
    mcp_server: MockMcpServer = _create_server(auth_options=auth_options, is_http=False)

    # 3. Create Linked Mock Transports
    client_transport, server_transport = MockInMemoryTransport.create_linked_pair()

    # 4. Instantiate Mock Client
    client = MockClient(client_info={"name": "test-integration-client"}, capabilities={})

    # 5. "Connect" them
    await client.connect(client_transport)
    # The server_transport listens for messages from the client_transport and passes them to mcp_server.handle_message
    await server_transport.connect(mcp_server.handle_message)
    
    # Call connect on mcp_server itself to manage FigmaService lifecycle (if implemented)
    # This is important for FigmaService.__aenter__ to be called.
    if hasattr(mcp_server, 'connect'):
       await mcp_server.connect(server_transport) # Pass the transport it's "using"

    try:
        yield client # Provide the client to the test
    finally:
        # Teardown: close client and server resources
        if hasattr(client, 'close'):
            await client.close()
        if hasattr(mcp_server, 'close'): # Ensure mcp_server.close() is called for FigmaService.__aexit__
            await mcp_server.close()


# --- Test Cases ---

@pytest.mark.asyncio # Remove unsupported timeout argument
async def test_get_figma_data(mcp_client_server_setup, figma_env_vars):
    client: MockClient = mcp_client_server_setup # Get the client from the fixture

    figma_file_key = figma_env_vars["file_key"]
    tool_args = {"fileKey": figma_file_key} # Arguments for get_figma_data tool

    # Prepare the request payload for the mock client
    # This structure mimics a JSON-RPC call for a tool
    request_payload = {
        "jsonrpc": "2.0",
        "method": "tools/call",
        "params": {
            "name": "get_figma_data",
            "arguments": tool_args,
        },
        "id": "test-id-123" # Unique ID for the request
    }

    # Make the request using the mock client
    # The MockClient's request method is expected to return a CallToolResult Pydantic model
    result: CallToolResult = await client.request(
        payload=request_payload,
        response_schema=CallToolResult # This is used by MockClient to validate/parse
    )

    # Assertions
    assert result is not None, "Result should not be None"
    assert isinstance(result, CallToolResult), f"Result is not a CallToolResult instance: {type(result)}"
    assert not result.is_error, f"Tool call resulted in an error: {result.content[0].text if result.content else 'Unknown error'}"
    
    assert result.content is not None, "Result content should not be None"
    assert len(result.content) > 0, "Result content should not be empty"
    assert result.content[0].type == "text", "First content item should be of type 'text'"
    assert result.content[0].text is not None, "Text content of the first item should not be None"

    # Parse the YAML content
    try:
        parsed_yaml = yaml.safe_load(result.content[0].text)
    except yaml.YAMLError as e:
        pytest.fail(f"Failed to parse YAML output: {e}\nYAML content:\n{result.content[0].text}")

    assert parsed_yaml is not None, "Parsed YAML should not be None"
    
    # Check for expected top-level keys in the simplified Figma data
    # Based on SimplifiedDesign model from simplify_node_response.py
    expected_keys = ["name", "lastModified", "thumbnailUrl", "nodes", "components", "componentSets", "globalVars"]
    for key in expected_keys:
        assert key in parsed_yaml, f"Expected key '{key}' not found in parsed YAML output."

    # Basic check for nodes structure (if file is not empty)
    if "nodes" in parsed_yaml and isinstance(parsed_yaml["nodes"], list) and len(parsed_yaml["nodes"]) > 0:
        first_node = parsed_yaml["nodes"][0]
        assert "id" in first_node, "First node should have an 'id'"
        assert "name" in first_node, "First node should have a 'name'"
        assert "type" in first_node, "First node should have a 'type'"
    elif "nodes" in parsed_yaml and isinstance(parsed_yaml["nodes"], list) and len(parsed_yaml["nodes"]) == 0:
        # This can happen for an empty Figma file or if depth is such that no nodes are returned
        print("Warning: Parsed YAML has an empty 'nodes' list.")
    else:
        # This case might indicate an issue if 'nodes' is expected but missing or not a list
        print(f"Warning or Info: 'nodes' key content: {parsed_yaml.get('nodes')}")


    print(f"Successfully received and parsed YAML for file: {parsed_yaml.get('name')}")
    # Add more specific assertions based on expected content if necessary
# Ensure there's a newline at the end of the file or remove this comment.
