import { FigmaService, type FigmaAuthOptions } from '../../services/figma';
import { Logger } from '../../utils/logger';
import type { GetImageFillsResponse, GetImagesResponse } from '@figma/rest-api-spec';

// Mock Logger to prevent console output during tests
jest.mock('../../utils/logger');

// Mock downloadFigmaImage from ~/utils/common.js
const mockDownloadFigmaImage = jest.fn();
jest.mock('../../utils/common.js', () => {
  const originalModule = jest.requireActual('../../utils/common.js');
  return {
    ...originalModule,
    downloadFigmaImage: mockDownloadFigmaImage,
  };
});

// Global fetch mock
let mockFetch: jest.SpyInstance;

const mockAuthOptions: FigmaAuthOptions = {
  figmaApiKey: 'test-api-key',
  figmaOAuthToken: '',
  useOAuth: false,
};

describe('FigmaService', () => {
  let figmaService: FigmaService;

  beforeEach(() => {
    figmaService = new FigmaService(mockAuthOptions);
    mockFetch = jest.spyOn(global, 'fetch');
    mockDownloadFigmaImage.mockImplementation(async (fileName, localPath, imageUrl) => {
      if (!imageUrl) return Promise.reject(new Error('Mocked downloadFigmaImage: Missing imageUrl'));
      return Promise.resolve(`${localPath}/${fileName}`);
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getImages', () => {
    it('should fetch and download PNG and SVG images, then return their local paths', async () => {
      const fileKey = 'file123';
      const localPath = '/tmp/images';
      const scale = 2;
      const nodes = [
        { nodeId: '1:1', fileName: 'icon.svg', fileType: 'svg' as 'svg' | 'png' },
        { nodeId: '1:2', fileName: 'banner.png', fileType: 'png' as 'svg' | 'png' },
        { nodeId: '1:3', fileName: 'another.png', fileType: 'png' as 'svg' | 'png' },
      ];

      const mockSvgResponse: GetImagesResponse = {
        images: { '1:1': 'http://example.com/icon.svg' },
        err: null,
      };
      const mockPngResponse: GetImagesResponse = {
        images: { '1:2': 'http://example.com/banner.png', '1:3': 'http://example.com/another.png' },
        err: null,
      };

      mockFetch
        .mockResolvedValueOnce({ // For SVGs
          ok: true,
          json: async () => mockSvgResponse,
        } as Response)
        .mockResolvedValueOnce({ // For PNGs
          ok: true,
          json: async () => mockPngResponse,
        } as Response);

      const result = await figmaService.getImages(fileKey, nodes, localPath, scale);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch).toHaveBeenCalledWith(
        `https://api.figma.com/v1/images/${fileKey}?ids=1:1&format=svg`,
        expect.any(Object)
      );
      expect(mockFetch).toHaveBeenCalledWith(
        `https://api.figma.com/v1/images/${fileKey}?ids=1:2,1:3&scale=${scale}&format=png`,
        expect.any(Object)
      );

      expect(mockDownloadFigmaImage).toHaveBeenCalledTimes(3);
      expect(mockDownloadFigmaImage).toHaveBeenCalledWith('icon.svg', localPath, 'http://example.com/icon.svg');
      expect(mockDownloadFigmaImage).toHaveBeenCalledWith('banner.png', localPath, 'http://example.com/banner.png');
      expect(mockDownloadFigmaImage).toHaveBeenCalledWith('another.png', localPath, 'http://example.com/another.png');

      expect(result).toEqual([
        `${localPath}/icon.svg`,
        `${localPath}/banner.png`,
        `${localPath}/another.png`,
      ]);
    });

    it('should return an empty array if no nodes are provided', async () => {
      const result = await figmaService.getImages('file123', [], '/tmp', 2);
      expect(result).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockDownloadFigmaImage).not.toHaveBeenCalled();
    });

    it('should handle cases where some image URLs are not returned by Figma', async () => {
        const fileKey = 'fileMissing';
        const localPath = '/tmp/partial';
        const nodes = [
            { nodeId: '1:1', fileName: 'exists.png', fileType: 'png' as 'svg' | 'png'},
            { nodeId: '1:2', fileName: 'missing.png', fileType: 'png' as 'svg' | 'png'},
        ];
        const mockPngResponse: GetImagesResponse = {
            images: { '1:1': 'http://example.com/exists.png' }, // 1:2 is missing
            err: null,
        };
        mockFetch.mockResolvedValueOnce({ ok: true, json: async () => mockPngResponse } as Response);

        const result = await figmaService.getImages(fileKey, nodes, localPath, 2);

        expect(mockDownloadFigmaImage).toHaveBeenCalledTimes(1);
        expect(mockDownloadFigmaImage).toHaveBeenCalledWith('exists.png', localPath, 'http://example.com/exists.png');
        expect(result).toEqual([`${localPath}/exists.png`]);
        expect(Logger.warn).toHaveBeenCalledWith("Image URL not found for node ID: 1:2 in getImages");
    });
  });

  describe('getImageFills', () => {
    it('should fetch image fill URLs and download them, then return their local paths', async () => {
      const fileKey = 'file-with-fills';
      const localPath = '/tmp/fills';
      const nodes = [
        { nodeId: '2:1', fileName: 'fill1.png', imageRef: 'ref_abc' },
        { nodeId: '2:2', fileName: 'fill2.jpg', imageRef: 'ref_def' },
      ];

      const mockImageFillsResponse: GetImageFillsResponse = {
        meta: { images: { 'ref_abc': 'http://example.com/fill1.png', 'ref_def': 'http://example.com/fill2.jpg' } },
        err: null,
        status: 200,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockImageFillsResponse,
      } as Response);

      const result = await figmaService.getImageFills(fileKey, nodes, localPath);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        `https://api.figma.com/v1/files/${fileKey}/images`,
        expect.any(Object)
      );

      expect(mockDownloadFigmaImage).toHaveBeenCalledTimes(2);
      expect(mockDownloadFigmaImage).toHaveBeenCalledWith('fill1.png', localPath, 'http://example.com/fill1.png');
      expect(mockDownloadFigmaImage).toHaveBeenCalledWith('fill2.jpg', localPath, 'http://example.com/fill2.jpg');

      expect(result).toEqual([
        `${localPath}/fill1.png`,
        `${localPath}/fill2.jpg`,
      ]);
    });

    it('should return an empty array if no nodes are provided for image fills', async () => {
      const result = await figmaService.getImageFills('file123', [], '/tmp');
      expect(result).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockDownloadFigmaImage).not.toHaveBeenCalled();
    });

    it('should handle cases where some image fill URLs are not found in the meta', async () => {
        const fileKey = 'file-missing-fills';
        const localPath = '/tmp/partial-fills';
        const nodes = [
            { nodeId: '3:1', fileName: 'exists.png', imageRef: 'ref_exists' },
            { nodeId: '3:2', fileName: 'missing.png', imageRef: 'ref_missing' },
        ];
        const mockImageFillsResponse: GetImageFillsResponse = {
            meta: { images: { 'ref_exists': 'http://example.com/exists.png' } }, // ref_missing is not here
            err: null,
            status: 200,
        };
        mockFetch.mockResolvedValueOnce({ ok: true, json: async () => mockImageFillsResponse } as Response);

        const result = await figmaService.getImageFills(fileKey, nodes, localPath);
        
        expect(mockDownloadFigmaImage).toHaveBeenCalledTimes(1);
        expect(mockDownloadFigmaImage).toHaveBeenCalledWith('exists.png', localPath, 'http://example.com/exists.png');
        // The current implementation of getImageFills filters out empty strings resulting from missing image URLs before returning.
        // So, the result array will only contain paths for successfully processed images.
        expect(result).toEqual([`${localPath}/exists.png`]);
    });
  });
});
