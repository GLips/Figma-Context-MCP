import { McpServer, type McpServerOptions, type ToolCallResult } from '../mcp';
import { FigmaService } from '../services/figma';
import { Logger } from '../utils/logger';

// Mock Logger to prevent console output during tests
jest.mock('../utils/logger');

// Mock FigmaService
jest.mock('../services/figma.js');

const MockFigmaService = FigmaService as jest.MockedClass<typeof FigmaService>;

describe('McpServer - download_figma_images tool', () => {
  let mcpServer: McpServer;
  const mockGetImages = jest.fn();
  const mockGetImageFills = jest.fn();

  beforeEach(() => {
    // Reset mocks for FigmaService methods
    mockGetImages.mockReset();
    mockGetImageFills.mockReset();

    // Assign mock implementations
    MockFigmaService.prototype.getImages = mockGetImages;
    MockFigmaService.prototype.getImageFills = mockGetImageFills;

    const options: McpServerOptions = {
      figmaApiKey: 'test-figma-key',
      // No need for actual service instances as they are mocked
    };
    mcpServer = new McpServer(options);
    // Ensure tools are registered. In a real scenario, McpServer constructor would handle this.
    // For testing, we might need to explicitly register or ensure the tool is available.
    // Assuming download_figma_images is registered via standard tool registration.
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  const defaultToolParams = {
    fileKey: 'test-file-key',
    localPath: '/tmp/mcp-images',
    imagesToRender: [],
    imageFillsToRender: [],
  };

  it('should call getImages and getImageFills and return success with paths', async () => {
    const imagesToRender = [
      { nodeId: '1:1', fileName: 'render.svg', fileType: 'svg' as 'svg' | 'png' },
      { nodeId: '1:2', fileName: 'render.png', fileType: 'png' as 'svg' | 'png' },
    ];
    const imageFillsToRender = [
      { nodeId: '2:1', fileName: 'fill.png', imageRef: 'fill_ref1' },
    ];

    mockGetImages.mockResolvedValue(['/tmp/mcp-images/render.svg', '/tmp/mcp-images/render.png']);
    mockGetImageFills.mockResolvedValue(['/tmp/mcp-images/fill.png']);

    const params = { ...defaultToolParams, imagesToRender, imageFillsToRender };
    const result: ToolCallResult = await mcpServer.callTool('download_figma_images', params);

    expect(mockGetImages).toHaveBeenCalledWith(
      params.fileKey,
      imagesToRender,
      params.localPath,
      undefined // scale, defaults to undefined if not provided
    );
    expect(mockGetImageFills).toHaveBeenCalledWith(
      params.fileKey,
      imageFillsToRender,
      params.localPath
    );
    expect(result.output).toEqual(expect.stringContaining('Successfully downloaded 3 images:'));
    expect(result.output).toEqual(expect.stringContaining('/tmp/mcp-images/render.svg'));
    expect(result.output).toEqual(expect.stringContaining('/tmp/mcp-images/render.png'));
    expect(result.output).toEqual(expect.stringContaining('/tmp/mcp-images/fill.png'));
    expect(result.isError).toBe(false);
  });

  it('should handle only imagesToRender', async () => {
    const imagesToRender = [{ nodeId: '1:1', fileName: 'only_render.png', fileType: 'png' as 'svg' | 'png' }];
    mockGetImages.mockResolvedValue(['/tmp/mcp-images/only_render.png']);
    mockGetImageFills.mockResolvedValue([]); // getImageFills will be called with empty array

    const params = { ...defaultToolParams, imagesToRender };
    const result: ToolCallResult = await mcpServer.callTool('download_figma_images', params);

    expect(mockGetImages).toHaveBeenCalledWith(params.fileKey, imagesToRender, params.localPath, undefined);
    expect(mockGetImageFills).toHaveBeenCalledWith(params.fileKey, [], params.localPath);
    expect(result.output).toEqual(expect.stringContaining('Successfully downloaded 1 images:'));
    expect(result.output).toEqual(expect.stringContaining('/tmp/mcp-images/only_render.png'));
    expect(result.isError).toBe(false);
  });

  it('should handle only imageFillsToRender', async () => {
    const imageFillsToRender = [{ nodeId: '2:1', fileName: 'only_fill.jpg', imageRef: 'ref_fill_only' }];
    mockGetImageFills.mockResolvedValue(['/tmp/mcp-images/only_fill.jpg']);
    mockGetImages.mockResolvedValue([]); // getImages will be called with empty array

    const params = { ...defaultToolParams, imageFillsToRender };
    const result: ToolCallResult = await mcpServer.callTool('download_figma_images', params);
    
    expect(mockGetImageFills).toHaveBeenCalledWith(params.fileKey, imageFillsToRender, params.localPath);
    expect(mockGetImages).toHaveBeenCalledWith(params.fileKey, [], params.localPath, undefined);
    expect(result.output).toEqual(expect.stringContaining('Successfully downloaded 1 images:'));
    expect(result.output).toEqual(expect.stringContaining('/tmp/mcp-images/only_fill.jpg'));
    expect(result.isError).toBe(false);
  });

  it('should handle no images requested', async () => {
    mockGetImages.mockResolvedValue([]);
    mockGetImageFills.mockResolvedValue([]);

    const result: ToolCallResult = await mcpServer.callTool('download_figma_images', defaultToolParams);

    expect(mockGetImages).toHaveBeenCalledWith(defaultToolParams.fileKey, [], defaultToolParams.localPath, undefined);
    expect(mockGetImageFills).toHaveBeenCalledWith(defaultToolParams.fileKey, [], defaultToolParams.localPath);
    expect(result.output).toBe('Successfully downloaded 0 images.');
    expect(result.isError).toBe(false);
  });

  it('should return error if getImages throws', async () => {
    const imagesToRender = [{ nodeId: '1:1', fileName: 'error_render.png', fileType: 'png' as 'svg' | 'png' }];
    mockGetImages.mockRejectedValue(new Error('Figma API error for getImages'));
    mockGetImageFills.mockResolvedValue([]);

    const params = { ...defaultToolParams, imagesToRender };
    const result: ToolCallResult = await mcpServer.callTool('download_figma_images', params);

    expect(result.isError).toBe(true);
    expect(result.output).toEqual(expect.stringContaining('Error downloading images: Figma API error for getImages'));
  });

  it('should return error if getImageFills throws', async () => {
    const imageFillsToRender = [{ nodeId: '2:1', fileName: 'error_fill.png', imageRef: 'ref_err_fill' }];
    mockGetImageFills.mockRejectedValue(new Error('Figma API error for getImageFills'));
    mockGetImages.mockResolvedValue([]);

    const params = { ...defaultToolParams, imageFillsToRender };
    const result: ToolCallResult = await mcpServer.callTool('download_figma_images', params);

    expect(result.isError).toBe(true);
    expect(result.output).toEqual(expect.stringContaining('Error downloading images: Figma API error for getImageFills'));
  });

  it('should pass scale parameter to getImages if provided', async () => {
    const imagesToRender = [{ nodeId: '1:1', fileName: 'scaled.png', fileType: 'png' as 'svg' | 'png' }];
    const scale = 3;
    mockGetImages.mockResolvedValue(['/tmp/mcp-images/scaled.png']);
    mockGetImageFills.mockResolvedValue([]);

    const params = { ...defaultToolParams, imagesToRender, scale };
    await mcpServer.callTool('download_figma_images', params);

    expect(mockGetImages).toHaveBeenCalledWith(
      params.fileKey,
      imagesToRender,
      params.localPath,
      scale // Expect scale to be passed
    );
  });
});
