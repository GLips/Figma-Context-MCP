import asyncio
import httpx
import os
import yaml # PyYAML
import logging
from typing import Dict, List, Optional, Any, Union, Type

from pydantic import BaseModel, Field

from mcp.utils.common import download_figma_image
# Assuming Logger is in mcp.utils.logger, adjust if different
# from mcp.utils.logger import Logger # Using standard logging for now
from mcp.services.simplify_node_response import parse_figma_response, SimplifiedDesign

logger = logging.getLogger(__name__)

# --- Pydantic Models ---

class FigmaAuthOptions(BaseModel):
    figma_api_key: Optional[str] = None
    figma_oauth_token: Optional[str] = None
    use_oauth: bool = False

class FetchImageParams(BaseModel):
    node_id: str
    file_name: str # Desired output filename
    file_type: str # "png" or "svg"

class FetchImageFillParams(BaseModel):
    node_id: str # ID of the node that contains the fill
    file_name: str # Desired output filename for this fill
    image_ref: str # The imageRef property from a Figma Paint object

# --- Custom Exception ---

class FigmaError(Exception):
    def __init__(self, status: int, message: str):
        self.status = status
        self.message = message
        super().__init__(f"Figma API Error {status}: {message}")

# --- Helper Function for Logging ---

def _write_logs_if_dev(file_name: str, value: Any):
    """
    Writes the given value to a YAML file in the 'logs' directory
    if the environment variable PYTHON_ENV or MCP_ENV is set to "development".
    """
    python_env = os.getenv("PYTHON_ENV", os.getenv("MCP_ENV", "")).lower()
    if python_env == "development":
        logs_dir = "logs"
        try:
            os.makedirs(logs_dir, exist_ok=True)
            file_path = os.path.join(logs_dir, file_name)
            with open(file_path, "w") as f:
                yaml.dump(value, f, sort_keys=False, allow_unicode=True)
            logger.info(f"Successfully wrote development log: {file_path}")
        except IOError as e:
            logger.error(f"Failed to write development log {file_name}: {e}")
        except Exception as e:
            logger.error(f"An unexpected error occurred while writing dev log {file_name}: {e}")

# --- FigmaService Class ---

class FigmaService:
    def __init__(self, auth_options: FigmaAuthOptions):
        if not auth_options.figma_api_key and not auth_options.figma_oauth_token:
            raise ValueError("Either Figma API key or OAuth token must be provided.")
        
        self.api_key = auth_options.figma_api_key
        self.oauth_token = auth_options.figma_oauth_token
        self.use_oauth = auth_options.use_oauth
        
        self.base_url = "https://api.figma.com/v1"
        # Initialize client here, but it will be managed by __aenter__/__aexit__ primarily
        # Timeout can be configured here, e.g., httpx.AsyncClient(timeout=30.0)
        self.client = httpx.AsyncClient() 

    async def __aenter__(self):
        # If self.client is already initialized, this ensures it's ready.
        # If it were None initially, this would be the place to initialize it.
        # self.client = httpx.AsyncClient() 
        return self

    async def __aexit__(self, exc_type: Optional[Type[BaseException]] = None, 
                        exc_value: Optional[BaseException] = None, 
                        traceback: Optional[Any] = None):
        await self.client.aclose()

    async def close(self):
        """Explicitly closes the HTTP client."""
        await self.client.aclose()

    async def _request(self, endpoint: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """
        Private helper method to make GET requests to the Figma API.
        """
        headers = {}
        if self.use_oauth and self.oauth_token:
            headers["Authorization"] = f"Bearer {self.oauth_token}"
        elif self.api_key:
            headers["X-Figma-Token"] = self.api_key
        else:
            raise FigmaError(401, "No valid authentication method configured.")

        url = f"{self.base_url}{endpoint}"
        try:
            response = await self.client.get(url, headers=headers, params=params)
            response.raise_for_status() # Raises HTTPStatusError for 4xx/5xx responses
            return response.json()
        except httpx.HTTPStatusError as e:
            # Try to parse error message from Figma response if available
            try:
                error_data = e.response.json()
                message = error_data.get("err", error_data.get("message", e.response.text))
                status = error_data.get("status", e.response.status_code)
            except Exception:
                message = e.response.text
                status = e.response.status_code
            logger.error(f"Figma API request to {url} failed with status {status}: {message}")
            raise FigmaError(status=status, message=message) from e
        except httpx.RequestError as e:
            logger.error(f"Request error while calling Figma API endpoint {url}: {e}")
            raise FigmaError(status=500, message=f"Request error: {e}") from e # Generic status for request errors


    async def get_image_fills(self, file_key: str, nodes: List[FetchImageFillParams], local_path: str) -> List[str]:
        """
        Downloads images referenced by imageRef in fills for specified nodes.
        """
        if not nodes:
            return []

        # 1. Fetch all image fill URLs for the entire file
        try:
            response_data = await self._request(f"/files/{file_key}/images")
            image_refs_map = response_data.get("meta", {}).get("images", {})
            if not image_refs_map: # Handles if 'images' is None or empty
                logger.info(f"No image references found in file {file_key}.")
                return []
        except FigmaError as e:
            logger.error(f"Failed to get image references for file {file_key}: {e}")
            return [] # Or re-raise depending on desired strictness

        download_tasks = []
        for node_params in nodes:
            image_url = image_refs_map.get(node_params.image_ref)
            if image_url:
                # download_figma_image is async, so it can be gathered
                task = download_figma_image(
                    file_name=node_params.file_name,
                    local_path=local_path,
                    image_url=image_url
                )
                download_tasks.append(task)
            else:
                logger.warning(f"Image ref {node_params.image_ref} for node {node_params.node_id} not found in file {file_key}'s image map.")

        downloaded_paths: List[str] = []
        if download_tasks:
            results = await asyncio.gather(*download_tasks, return_exceptions=True)
            for result in results:
                if isinstance(result, str):
                    downloaded_paths.append(result)
                elif isinstance(result, Exception):
                    logger.error(f"Failed to download an image fill: {result}")
        
        return downloaded_paths


    async def get_images(self, file_key: str, nodes: List[FetchImageParams], local_path: str, scale: float = 2.0) -> List[str]:
        """
        Downloads rendered images (PNG/SVG) for specified nodes.
        """
        if not nodes:
            return []

        svg_nodes = [node for node in nodes if node.file_type.lower() == "svg"]
        png_nodes = [node for node in nodes if node.file_type.lower() == "png"]
        
        node_image_urls: Dict[str, str] = {} # node_id -> image_url

        # Fetch SVG image URLs
        if svg_nodes:
            svg_node_ids = ",".join([node.node_id for node in svg_nodes])
            try:
                response_data_svg = await self._request(
                    f"/images/{file_key}",
                    params={"ids": svg_node_ids, "format": "svg"}
                )
                node_image_urls.update(response_data_svg.get("images", {}))
            except FigmaError as e:
                logger.error(f"Failed to get SVG image URLs for file {file_key}: {e}")
                # Continue to try PNGs, or could fail early

        # Fetch PNG image URLs
        if png_nodes:
            png_node_ids = ",".join([node.node_id for node in png_nodes])
            try:
                response_data_png = await self._request(
                    f"/images/{file_key}",
                    params={"ids": png_node_ids, "format": "png", "scale": str(scale)}
                )
                node_image_urls.update(response_data_png.get("images", {}))
            except FigmaError as e:
                logger.error(f"Failed to get PNG image URLs for file {file_key}: {e}")

        download_tasks = []
        for node_params in nodes: # Iterate original nodes list to preserve order/association
            image_url = node_image_urls.get(node_params.node_id)
            if image_url:
                task = download_figma_image(
                    file_name=node_params.file_name, # Using the file_name from FetchImageParams
                    local_path=local_path,
                    image_url=image_url
                )
                download_tasks.append(task)
            else:
                logger.warning(f"Image URL for node {node_params.node_id} (type: {node_params.file_type}) not found.")

        downloaded_paths: List[str] = []
        if download_tasks:
            results = await asyncio.gather(*download_tasks, return_exceptions=True)
            for result in results:
                if isinstance(result, str):
                    downloaded_paths.append(result)
                elif isinstance(result, Exception):
                    logger.error(f"Failed to download an image: {result}")
        
        return downloaded_paths


    async def get_file(self, file_key: str, depth: Optional[int] = None) -> SimplifiedDesign:
        """
        Fetches the full Figma file structure and parses it.
        """
        params = {}
        if depth is not None:
            params["depth"] = depth
        
        raw_response = await self._request(f"/files/{file_key}", params=params if params else None)
        _write_logs_if_dev(f"{file_key}_raw_file.yml", raw_response)
        
        simplified_design = parse_figma_response(raw_response) # This returns a dict-like or Pydantic model
        
        # If simplified_design is a Pydantic model, dump it before logging as dict
        simplified_response_dict = simplified_design
        if hasattr(simplified_design, 'model_dump'):
            simplified_response_dict = simplified_design.model_dump(exclude_none=True, by_alias=True)

        _write_logs_if_dev(f"{file_key}_simplified_file.yml", simplified_response_dict)
        
        # parse_figma_response is expected to return SimplifiedDesign model instance, or a dict that can be parsed into it.
        # The current parse_figma_response returns a dict after remove_empty_keys.
        # So, we need to validate it back into the model.
        return SimplifiedDesign.model_validate(simplified_design)


    async def get_node(self, file_key: str, node_id: str, depth: Optional[int] = None) -> SimplifiedDesign:
        """
        Fetches specific nodes from a Figma file and parses the response.
        """
        params: Dict[str, Any] = {"ids": node_id}
        if depth is not None:
            params["depth"] = depth
            
        raw_response = await self._request(f"/files/{file_key}/nodes", params=params)
        _write_logs_if_dev(f"{file_key}_node_{node_id}_raw.yml", raw_response)

        # parse_figma_response expects a structure similar to GetFileResponse.
        # The GetFileNodesResponse has `nodes` as a top-level key containing the node documents.
        # `parse_figma_response` already handles this structure.
        simplified_design_data = parse_figma_response(raw_response)

        simplified_response_dict = simplified_design_data
        if hasattr(simplified_design_data, 'model_dump'):
            simplified_response_dict = simplified_design_data.model_dump(exclude_none=True, by_alias=True)

        _write_logs_if_dev(f"{file_key}_node_{node_id}_simplified.yml", simplified_response_dict)
        
        return SimplifiedDesign.model_validate(simplified_design_data)


# Example usage (conceptual)
async def main():
    # Ensure PYTHON_ENV=development for logs
    os.environ["PYTHON_ENV"] = "development" # For testing _write_logs_if_dev

    auth = FigmaAuthOptions(figma_api_key="YOUR_FIGMA_API_KEY") # Replace with your key
    
    # Create dummy files for logging test
    _write_logs_if_dev("test_log.yml", {"message": "Hello from test log"})

    # Replace with actual file_key and node_id for real testing
    # file_key = "YOUR_FILE_KEY"
    # node_id_to_fetch = "1:2" 
    
    # async with FigmaService(auth) as figma_client:
    #     try:
    #         print("Fetching file...")
    #         # file_data = await figma_client.get_file(file_key, depth=1)
    #         # print(f"File Name: {file_data.name}")
    #         # print(f"Last Modified: {file_data.last_modified}")
    #         # if file_data.nodes:
    #         # print(f"Root node ID: {file_data.nodes[0].id}")

    #         # print(f"\nFetching node {node_id_to_fetch}...")
    #         # node_data_response = await figma_client.get_node(file_key, node_id_to_fetch, depth=1)
    #         # print(f"Node data name: {node_data_response.name}")
    #         # if node_data_response.nodes:
    #         #     print(f"Fetched node details: {node_data_response.nodes[0].name}")

    #         # Example image fetching (replace with valid refs and paths)
    #         # image_fill_nodes = [
    #         #     FetchImageFillParams(node_id="1:10", file_name="fill_image1.png", image_ref="your_image_ref_1")
    #         # ]
    #         # downloaded_fills = await figma_client.get_image_fills(file_key, image_fill_nodes, "./temp_images")
    #         # print(f"Downloaded image fills: {downloaded_fills}")

    #         # image_nodes = [
    #         #     FetchImageParams(node_id="1:12", file_name="node_image1.png", file_type="png"),
    #         #     FetchImageParams(node_id="1:13", file_name="node_image2.svg", file_type="svg")
    #         # ]
    #         # downloaded_images = await figma_client.get_images(file_key, image_nodes, "./temp_images")
    #         # print(f"Downloaded images: {downloaded_images}")

    #     except FigmaError as e:
    #         print(f"An error occurred: Status {e.status}, Message: {e.message}")
    #     except Exception as e:
    #         print(f"A general error occurred: {e}")

if __name__ == "__main__":
    # To run the conceptual main:
    # asyncio.run(main())
    # For actual testing, you'd uncomment parts of main and provide real keys/IDs.
    print("FigmaService class and helpers defined.")
    print("To test, uncomment and configure asyncio.run(main()) with your Figma keys and file details.")
