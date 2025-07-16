import type { SimplifiedDesign, SimplifiedNode } from "../services/simplify-node-response.js";
import type { GetFileMetaResponse } from "@figma/rest-api-spec";
import { ParseDataCache } from "../utils/parse-data-cache.js";
import { Logger } from "../utils/logger.js";

// Mock data for testing
const mockNode1: SimplifiedNode = {
  id: "node-1",
  name: "Test Node 1",
  type: "FRAME",
  children: [
    {
      id: "child-1",
      name: "Child Node 1",
      type: "RECTANGLE",
      children: [
        {
          id: "grandchild-1",
          name: "Grandchild Node 1",
          type: "TEXT",
        },
        {
          id: "grandchild-2",
          name: "Grandchild Node 2",
          type: "VECTOR",
        },
      ],
    },
    {
      id: "child-2",
      name: "Child Node 2",
      type: "TEXT",
    },
  ],
};

const mockNode2: SimplifiedNode = {
  id: "node-2",
  name: "Test Node 2",
  type: "COMPONENT",
  children: [
    {
      id: "child-3",
      name: "Child Node 3",
      type: "RECTANGLE",
    },
  ],
};

const mockNode3: SimplifiedNode = {
  id: "node-3",
  name: "Test Node 3",
  type: "INSTANCE",
};

const mockShallowNode1: SimplifiedNode = {
  id: "node-1",
  name: "Test Node 1",
  type: "FRAME",
  children: [
    {
      id: "child-1",
      name: "Child Node 1",
      type: "RECTANGLE",
    },
    {
      id: "child-2",
      name: "Child Node 2",
      type: "TEXT",
    },
  ],
};

const mockDesign1: SimplifiedDesign = {
  nodes: [mockNode1],
  name: "Test Design 1",
  lastModified: "2023-01-01T10:00:00Z",
  thumbnailUrl: "https://example.com/thumb1.png",
  components: {},
  componentSets: {},
  globalVars: {
    styles: {},
  },
};

const mockDesign2: SimplifiedDesign = {
  nodes: [mockNode2],
  name: "Test Design 2",
  lastModified: "2023-01-01T11:00:00Z",
  thumbnailUrl: "https://example.com/thumb2.png",
  components: {},
  componentSets: {},
  globalVars: {
    styles: {},
  },
};

const mockDesign3: SimplifiedDesign = {
  nodes: [mockNode3],
  name: "Test Design 3",
  lastModified: "2023-01-01T12:00:00Z",
  thumbnailUrl: "https://example.com/thumb3.png",
  components: {},
  componentSets: {},
  globalVars: {
    styles: {},
  },
};

const mockShallowDesign1: SimplifiedDesign = {
  nodes: [mockShallowNode1],
  name: "Test Design 1 Shallow",
  lastModified: "2023-01-01T10:00:00Z",
  thumbnailUrl: "https://example.com/thumb1.png",
  components: {},
  componentSets: {},
  globalVars: {
    styles: {},
  },
};

const mockMultiNodeDesign: SimplifiedDesign = {
  nodes: [mockNode1, mockNode2, mockNode3],
  name: "Multi Node Design",
  lastModified: "2023-01-01T13:00:00Z",
  thumbnailUrl: "https://example.com/multi-thumb.png",
  components: {},
  componentSets: {},
  globalVars: {
    styles: {},
  },
};

// Mock file meta response
const mockFileMeta = {
  name: "Test File",
  last_modified: "2023-01-01T10:00:00Z",
} as unknown as GetFileMetaResponse;

const mockUpdatedFileMeta = {
  name: "Test File",
  last_modified: "2023-01-01T14:00:00Z",
} as unknown as GetFileMetaResponse;

Logger.isHTTP = true;

describe("ParseDataCache", () => {
  let cache: ParseDataCache;

  beforeEach(() => {
    cache = new ParseDataCache(10);
  });

  describe("Basic Cache Operations", () => {
    it("should store and retrieve cache items", async () => {
      const cacheKey = "file1:node-1:default";
      cache.put(cacheKey, mockDesign1, "2023-01-01T10:00:00Z");

      const result = await cache.get(cacheKey);
      expect(result).toEqual(mockDesign1);
    });

    it("should return null for non-existent cache keys", async () => {
      const result = await cache.get("non-existent-key");
      expect(result).toBeNull();
    });

    it("should check if cache has a specific key", () => {
      const cacheKey = "file1:node-1:default";
      expect(cache.has(cacheKey)).toBe(false);

      cache.put(cacheKey, mockDesign1, "2023-01-01T10:00:00Z");
      expect(cache.has(cacheKey)).toBe(true);
    });

    it("should store cache with timestamp", async () => {
      const cacheKey = "file1:node-1:default";
      const timestamp = "2023-01-01T10:00:00Z";

      cache.put(cacheKey, mockDesign1, timestamp);
      const result = await cache.get(cacheKey);

      expect(result).toEqual(mockDesign1);
    });
  });

  describe("Cache Freshness Validation", () => {
    it("should validate fresh cache with matching timestamps", async () => {
      const cacheKey = "file1:node-1:default";
      const timestamp = "2023-01-01T10:00:00Z";

      cache.put(cacheKey, mockDesign1, timestamp);

      const validationParams = {
        fileKey: "file1",
        getFileMeta: jest.fn().mockResolvedValue(mockFileMeta),
      };

      const result = await cache.get(cacheKey, validationParams);
      expect(result).toEqual(mockDesign1);
      expect(validationParams.getFileMeta).toHaveBeenCalled();
    });

    it("should invalidate cache with mismatched timestamps", async () => {
      const cacheKey = "file1:node-1:default";
      const oldTimestamp = "2023-01-01T10:00:00Z";

      cache.put(cacheKey, mockDesign1, oldTimestamp);

      const validationParams = {
        fileKey: "file1",
        getFileMeta: jest.fn().mockResolvedValue(mockUpdatedFileMeta),
      };

      const result = await cache.get(cacheKey, validationParams);
      expect(result).toBeNull();
      expect(cache.has(cacheKey)).toBe(false);
    });

    it("should treat cache without timestamp as valid", async () => {
      const cacheKey = "file1:node-1:default";

      cache.put(cacheKey, mockDesign1, ""); // No timestamp (empty string)

      const validationParams = {
        fileKey: "file1",
        getFileMeta: jest.fn().mockResolvedValue(mockUpdatedFileMeta),
      };

      const result = await cache.get(cacheKey, validationParams);
      expect(result).toEqual(mockDesign1);
    });

    it("should handle validation errors gracefully", async () => {
      const cacheKey = "file1:node-1:default";
      const timestamp = "2023-01-01T10:00:00Z";

      cache.put(cacheKey, mockDesign1, timestamp);

      const validationParams = {
        fileKey: "file1",
        getFileMeta: jest.fn().mockRejectedValue(new Error("API Error")),
      };

      const result = await cache.get(cacheKey, validationParams);
      expect(result).toEqual(mockDesign1); // Should return cached data despite error
    });
  });

  describe("Node Search Operations", () => {
    beforeEach(() => {
      cache.put("file1:node-1:default", mockDesign1, "2023-01-01T10:00:00Z");
      cache.put("file1:node-2:default", mockDesign2, "2023-01-01T10:00:00Z");
      cache.put("file2:node-3:default", mockDesign3, "2023-01-01T10:00:00Z");
    });

    it("should find node data in cache", async () => {
      const result = await cache.findNodeData("file1", "node-1");
      expect(result).toEqual(mockNode1);
    });

    it("should find child node data in cache", async () => {
      const result = await cache.findNodeData("file1", "child-1");
      expect(result).toEqual(mockNode1.children?.[0]);
    });

    it("should find grandchild node data in cache", async () => {
      const result = await cache.findNodeData("file1", "grandchild-1");
      expect(result).toEqual(mockNode1.children?.[0]?.children?.[0]);
    });

    it("should return null for non-existent nodes", async () => {
      const result = await cache.findNodeData("file1", "non-existent");
      expect(result).toBeNull();
    });

    it("should return null for nodes in different files", async () => {
      const result = await cache.findNodeData("file1", "node-3");
      expect(result).toBeNull();
    });

    it("should validate node data freshness", async () => {
      const validationParams = {
        fileKey: "file1",
        getFileMeta: jest.fn().mockResolvedValue(mockUpdatedFileMeta),
      };

      // Put cache with old timestamp
      cache.put("file1:node-1:default", mockDesign1, "2023-01-01T10:00:00Z");

      const result = await cache.findNodeData("file1", "node-1", validationParams);
      expect(result).toBeNull(); // Should be null due to expired cache
    });
  });

  describe("Depth Parameter Tests", () => {
    beforeEach(() => {
      // Cache deep design data
      cache.put("file1:node-1:default", mockDesign1, "2023-01-01T10:00:00Z");
      // Cache shallow design data
      cache.put("file1:node-1:1", mockShallowDesign1, "2023-01-01T10:00:00Z");
    });

    it("should return cached node without depth requirement", async () => {
      const result = await cache.findNodeData("file1", "node-1");
      expect(result).toEqual(mockNode1);
      expect(result?.children).toHaveLength(2);
    });

    it("should return cached node with depth requirement satisfied", async () => {
      const result = await cache.findNodeData("file1", "node-1", undefined, 2);
      expect(result).toEqual(mockNode1);
      expect(result?.children).toHaveLength(2);
      expect(result?.children?.[0]?.children).toHaveLength(2);
    });

    it("should limit node depth when cached data exceeds requirement", async () => {
      const result = await cache.findNodeData("file1", "node-1", undefined, 1);
      expect(result).toBeDefined();
      expect(result?.id).toBe("node-1");
      expect(result?.children).toHaveLength(2);
      // Children should not have grandchildren due to depth limit
      expect(result?.children?.[0]?.children).toBeUndefined();
    });

    it("should return null when cached node does not satisfy depth requirement", async () => {
      // Cache only shallow data
      cache.clearAllCache();
      cache.put("file1:node-1:1", mockShallowDesign1, "2023-01-01T10:00:00Z");

      // Request deeper data than cached
      const result = await cache.findNodeData("file1", "node-1", undefined, 2);
      expect(result).toBeNull();
    });

    it("should find grandchild nodes when depth allows", async () => {
      const result = await cache.findNodeData("file1", "grandchild-1", undefined, 2);
      expect(result).toBeDefined();
      expect(result?.id).toBe("grandchild-1");
    });

    it("should not find grandchild nodes when depth is limited", async () => {
      // Cache only shallow data
      cache.clearAllCache();
      cache.put("file1:node-1:1", mockShallowDesign1, "2023-01-01T10:00:00Z");

      const result = await cache.findNodeData("file1", "grandchild-1", undefined, 1);
      expect(result).toBeNull();
    });
  });

  describe("Multiple Node Operations with Depth", () => {
    beforeEach(() => {
      cache.put("file1:node-1:default", mockDesign1, "2023-01-01T10:00:00Z");
      cache.put("file1:node-2:default", mockDesign2, "2023-01-01T10:00:00Z");
      cache.put("file1:multi:default", mockMultiNodeDesign, "2023-01-01T10:00:00Z");
    });

    it("should find multiple nodes with all cached and no depth requirement", async () => {
      const result = await cache.findMultipleNodes("file1", ["node-1", "node-2"]);

      expect(result.cachedNodes).toHaveLength(2);
      expect(result.missingNodeIds).toHaveLength(0);
      expect(result.sourceDesign).toBeTruthy();
    });

    it("should find multiple nodes with depth requirement", async () => {
      const result = await cache.findMultipleNodes("file1", ["node-1", "node-2"], undefined, 1);

      expect(result.cachedNodes).toHaveLength(2);
      expect(result.missingNodeIds).toHaveLength(0);
      expect(result.sourceDesign).toBeTruthy();
      
      // Check that depth is limited
      const node1 = result.cachedNodes.find(n => n.id === "node-1");
      expect(node1?.children?.[0]?.children).toBeUndefined();
    });

    it("should find multiple nodes with some missing due to depth", async () => {
      // Clear and add only shallow cache for one node
      cache.clearAllCache();
      cache.put("file1:node-1:1", mockShallowDesign1, "2023-01-01T10:00:00Z");
      cache.put("file1:node-2:default", mockDesign1, "2023-01-01T10:00:00Z");

      const result = await cache.findMultipleNodes("file1", ["node-1", "node-2"], undefined, 2);

      expect(result.cachedNodes).toHaveLength(1); // Only node-2 satisfies depth requirement
      expect(result.missingNodeIds).toEqual(["node-2"]);
    });

    it("should validate multiple nodes freshness with depth", async () => {
      const validationParams = {
        fileKey: "file1",
        getFileMeta: jest.fn().mockResolvedValue(mockUpdatedFileMeta),
      };

      // Put cache with old timestamp
      cache.put("file1:node-1:default", mockDesign1, "2023-01-01T10:00:00Z");

      const result = await cache.findMultipleNodes("file1", ["node-1"], validationParams, 1);

      expect(result.cachedNodes).toHaveLength(0);
      expect(result.missingNodeIds).toEqual(["node-1"]);
    });
  });

  describe("Cache Management Operations", () => {
    beforeEach(() => {
      cache.put("file1:node-1:default", mockDesign1, "2023-01-01T10:00:00Z");
      cache.put("file1:node-2:default", mockDesign2, "2023-01-01T10:00:00Z");
      cache.put("file2:node-3:default", mockDesign3, "2023-01-01T10:00:00Z");
    });

    it("should clear cache for specific file", () => {
      cache.clearFileCache("file1");

      expect(cache.has("file1:node-1:default")).toBe(false);
      expect(cache.has("file1:node-2:default")).toBe(false);
      expect(cache.has("file2:node-3:default")).toBe(true);
    });

    it("should clear all cache", () => {
      cache.clearAllCache();

      expect(cache.has("file1:node-1:default")).toBe(false);
      expect(cache.has("file1:node-2:default")).toBe(false);
      expect(cache.has("file2:node-3:default")).toBe(false);
    });
  });

  describe("LRU Cache Behavior", () => {
    it("should evict least recently used items when capacity is exceeded", async () => {
      const smallCache = new ParseDataCache(2);

      smallCache.put("key1", mockDesign1, "2023-01-01T10:00:00Z");
      smallCache.put("key2", mockDesign2, "2023-01-01T10:00:00Z");

      expect(smallCache.has("key1")).toBe(true);
      expect(smallCache.has("key2")).toBe(true);

      // This should evict key1
      smallCache.put("key3", mockDesign3, "2023-01-01T10:00:00Z");

      expect(smallCache.has("key1")).toBe(false);
      expect(smallCache.has("key2")).toBe(true);
      expect(smallCache.has("key3")).toBe(true);
    });

    it("should update access order on get operations", async () => {
      const smallCache = new ParseDataCache(2);

      smallCache.put("key1", mockDesign1, "2023-01-01T10:00:00Z");
      smallCache.put("key2", mockDesign2, "2023-01-01T10:00:00Z");

      // Access key1 to make it recently used
      await smallCache.get("key1");

      // This should evict key2 instead of key1
      smallCache.put("key3", mockDesign3, "2023-01-01T10:00:00Z");

      expect(smallCache.has("key1")).toBe(true);
      expect(smallCache.has("key2")).toBe(false);
      expect(smallCache.has("key3")).toBe(true);
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty node arrays", async () => {
      const result = await cache.findMultipleNodes("file1", []);

      expect(result.cachedNodes).toHaveLength(0);
      expect(result.missingNodeIds).toHaveLength(0);
      expect(result.sourceDesign).toBeNull();
    });

    it("should handle deep nested node search", async () => {
      const deepNestedDesign: SimplifiedDesign = {
        ...mockDesign1,
        nodes: [
          {
            id: "parent",
            name: "Parent",
            type: "FRAME",
            children: [
              {
                id: "deep-child",
                name: "Deep Child",
                type: "RECTANGLE",
                children: [
                  {
                    id: "deeper-child",
                    name: "Deeper Child",
                    type: "TEXT",
                    children: [
                      {
                        id: "deepest-child",
                        name: "Deepest Child",
                        type: "VECTOR",
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };

      cache.put("file1:deep:default", deepNestedDesign, "2023-01-01T10:00:00Z");

      const result = await cache.findNodeData("file1", "deepest-child");
      expect(result?.id).toBe("deepest-child");
    });

    it("should handle depth limit on deeply nested nodes", async () => {
      const deepNestedDesign: SimplifiedDesign = {
        ...mockDesign1,
        nodes: [
          {
            id: "parent",
            name: "Parent",
            type: "FRAME",
            children: [
              {
                id: "deep-child",
                name: "Deep Child",
                type: "RECTANGLE",
                children: [
                  {
                    id: "deeper-child",
                    name: "Deeper Child",
                    type: "TEXT",
                    children: [
                      {
                        id: "deepest-child",
                        name: "Deepest Child",
                        type: "VECTOR",
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };

      cache.put("file1:deep:default", deepNestedDesign, "2023-01-01T10:00:00Z");

      // Test with depth limit of 2
      const result = await cache.findNodeData("file1", "parent", undefined, 2);
      expect(result?.id).toBe("parent");
      expect(result?.children?.[0]?.children?.[0]?.children).toBeUndefined();
    });

    it("should handle zero depth limit", async () => {
      cache.put("file1:node-1:default", mockDesign1, "2023-01-01T10:00:00Z");

      const result = await cache.findNodeData("file1", "node-1", undefined, 0);
      expect(result?.id).toBe("node-1");
      expect(result?.children).toBeUndefined();
    });

    it("should handle malformed file meta response", async () => {
      const cacheKey = "file1:node-1:default";
      const timestamp = "2023-01-01T10:00:00Z";

      cache.put(cacheKey, mockDesign1, timestamp);

      const validationParams = {
        fileKey: "file1",
        getFileMeta: jest.fn().mockResolvedValue({} as unknown as GetFileMetaResponse), // Empty response
      };

      const result = await cache.get(cacheKey, validationParams);
      expect(result).toEqual(mockDesign1); // Should handle gracefully
    });

    it("should return null when requesting full child node data from depth-limited cached parent", async () => {
      // Create a design with nested children for testing depth limits
      const parentWithLimitedDepth: SimplifiedNode = {
        id: "parent-node",
        name: "Parent Node",
        type: "FRAME",
        children: [
          {
            id: "child-node",
            name: "Child Node",
            type: "RECTANGLE",
            children: [
              {
                id: "grandchild-node",
                name: "Grandchild Node",
                type: "TEXT",
              },
            ],
          },
        ],
      };

      const designWithLimitedDepth: SimplifiedDesign = {
        nodes: [parentWithLimitedDepth],
        name: "Test Design with Limited Depth",
        lastModified: "2023-01-01T10:00:00Z",
        thumbnailUrl: "https://example.com/thumb.png",
        components: {},
        componentSets: {},
        globalVars: {
          styles: {},
        },
      };

      // Cache the parent node with depth:3 (limited depth)
      cache.put("file1:parent-node:2", designWithLimitedDepth, "2023-01-01T10:00:00Z");

      // Try to get child node without depth parameter (requesting full data)
      // This should return null because we can't guarantee the cached data contains
      // the complete child node structure
      const result = await cache.findNodeData("file1", "child-node");
      expect(result).toBeNull();
    });

    it("should return null when requesting full grandchild node data from depth-limited cached ancestor", async () => {
      // Create a design with deep nesting
      const deepParentWithLimitedDepth: SimplifiedNode = {
        id: "deep-parent",
        name: "Deep Parent",
        type: "FRAME",
        children: [
          {
            id: "deep-child",
            name: "Deep Child",
            type: "RECTANGLE",
            children: [
              {
                id: "deep-grandchild",
                name: "Deep Grandchild",
                type: "TEXT",
                children: [
                  {
                    id: "deep-great-grandchild",
                    name: "Deep Great Grandchild",
                    type: "VECTOR",
                  },
                ],
              },
            ],
          },
        ],
      };

      const deepDesignWithLimitedDepth: SimplifiedDesign = {
        nodes: [deepParentWithLimitedDepth],
        name: "Deep Test Design with Limited Depth",
        lastModified: "2023-01-01T10:00:00Z",
        thumbnailUrl: "https://example.com/deep-thumb.png",
        components: {},
        componentSets: {},
        globalVars: {
          styles: {},
        },
      };

      // Cache the parent node with depth:2 (limited depth)
      cache.put("file1:deep-parent:2", deepDesignWithLimitedDepth, "2023-01-01T10:00:00Z");

      // Try to get deep grandchild without depth parameter (requesting full data)
      // This should return null because the cached data with depth:2 might not contain
      // the complete deep-grandchild structure (which could have children beyond depth 2)
      const result = await cache.findNodeData("file1", "deep-grandchild");
      expect(result).toBeNull();
    });

    it("should return child node when cached parent has sufficient depth for the request", async () => {
      const parentWithSufficientDepth: SimplifiedNode = {
        id: "sufficient-parent",
        name: "Sufficient Parent",
        type: "FRAME",
        children: [
          {
            id: "sufficient-child-deep",
            name: "Sufficient Child Deep",
            type: "RECTANGLE",
            children: [
              {
                id: "deep-grandchild",
                name: "Deep Grandchild",
                type: "TEXT",
              },
            ],
          },
          {
            id: "sufficient-child-at-limit",
            name: "Sufficient Child At Limit",
            type: "ELLIPSE",
            children: [
              {
                id: "deep-grandchild-1",
                name: "Deep Grandchild 1",
                type: 'RECTANGLE',
                children: [
                  {
                    id: "deep-grandchild-2",
                    name: "Deep Grandchild 2",
                    type: "RECTANGLE",
                  },
                ],
              },
            ],
          },
        ],
      };

      const designWithSufficientDepth: SimplifiedDesign = {
        nodes: [parentWithSufficientDepth],
        name: "Test Design with Sufficient Depth",
        lastModified: "2023-01-01T10:00:00Z",
        thumbnailUrl: "https://example.com/sufficient-thumb.png",
        components: {},
        componentSets: {},
        globalVars: {
          styles: {},
        },
      };

      cache.put("file1:sufficient-parent:3", designWithSufficientDepth, "2023-01-01T10:00:00Z");

      const result = await cache.findNodeData("file1", "deep-grandchild");
      expect(result).toBeDefined();
      expect(result?.id).toBe("deep-grandchild");

      const unCompleteResult = await cache.findNodeData("file1", "deep-grandchild-2");
      expect(unCompleteResult).toBeNull();
    });
  });
});
