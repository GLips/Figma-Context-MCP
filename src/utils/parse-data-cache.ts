import { LRUCache } from "./lru.js";
import { Logger } from "./logger.js";
import type { GetFileMetaResponse } from "@figma/rest-api-spec";
import type { SimplifiedDesign, SimplifiedNode } from "~/extractors/types.js";

interface CacheItem {
  data: SimplifiedDesign;
  lastTouchedAt: string;
}

interface CacheValidationParams {
  fileKey: string;
  getFileMeta: () => Promise<GetFileMetaResponse>;
}

export class ParseDataCache {
  private readonly cache: LRUCache<string, CacheItem>;
  debug: boolean = false;

  constructor(capacity: number = 10) {
    this.cache = new LRUCache<string, CacheItem>(capacity);
  }

  /**
   * Check if cached node data satisfies the required depth
   * The logic is based on whether the cached data was fetched with sufficient depth
   * to provide the target node with the requested depth capabilities
   */
  private checkNodeDepthSatisfiesRequirement(
    cacheData: SimplifiedDesign,
    targetNodeId: string,
    requiredDepth: number | null,
  ): boolean {

    if (requiredDepth === null || requiredDepth === undefined) {
      return true; // No depth requirement, any cached data is acceptable
    }
    // Find the target node in the cache data
    const targetNode = this.findNodeInTree(cacheData.nodes, targetNodeId);
    if (!targetNode) {
      Logger.log(`targetNode not found: ${targetNodeId} ${cacheData.nodes.map((node) => node.id).join(",")}`);
      return false; // Node not found in cache
    }

    // The key insight: check if the cached design has sufficient overall depth
    // to indicate it was fetched with enough depth to support the query
    const overallCacheDepth = Math.max(...cacheData.nodes.map((node) => this.getNodeDepth(node)));

    // For individual node queries, we're more lenient:
    // 1. If overall cache depth >= required depth, accept it
    // 2. If the target node has children or can provide the required depth from itself, accept it
    const targetNodeDepth = this.getNodeDepth(targetNode);

    return overallCacheDepth >= requiredDepth || targetNodeDepth >= requiredDepth;
  }

  /**
   * Get the actual depth of a node tree (how many levels of children it has)
   * Depth 0 = no children, Depth 1 = has children, Depth 2 = has grandchildren, etc.
   */
  private getNodeDepth(node: SimplifiedNode): number {
    if (!node.children || node.children.length === 0) {
      return 0;
    }

    const childDepths = node.children.map((child) => this.getNodeDepth(child));
    return 1 + Math.max(...childDepths);
  }

  /**
   * Get the depth of a specific node from the root of the tree
   * Returns the number of levels from root to the target node
   * Root nodes have depth 0, their children have depth 1, etc.
   */
  private getNodeDepthFromRoot(nodes: SimplifiedNode[], targetId: string, currentDepth: number = 0): number {
    for (const node of nodes) {
      if (node.id === targetId) {
        return currentDepth;
      }
      if (node.children) {
        const found = this.getNodeDepthFromRoot(node.children, targetId, currentDepth + 1);
        if (found !== -1) {
          return found;
        }
      }
    }
    return -1; // Not found
  }

  /**
   * Limit node tree to specified depth
   * maxDepth 0 = no children, maxDepth 1 = 1 level of children, etc.
   */
  private limitNodeDepth(node: SimplifiedNode, maxDepth: number): SimplifiedNode {
    if (maxDepth <= 0) {
      // Remove children if depth limit is reached
      const { children, ...nodeWithoutChildren } = node;
      return nodeWithoutChildren;
    }

    if (!node.children || node.children.length === 0) {
      return node;
    }

    return {
      ...node,
      children: node.children.map((child) => this.limitNodeDepth(child, maxDepth - 1)),
    };
  }

  /**
   * Recursively find a node by ID in the node tree
   */
  private findNodeInTree(nodes: SimplifiedNode[], targetId: string): SimplifiedNode | null {
    for (const node of nodes) {
      if (node.id === targetId) {
        return node;
      }
      if (node.children) {
        const found = this.findNodeInTree(node.children, targetId);
        if (found) {
          return found;
        }
      }
    }
    return null;
  }

  /**
   * Extract depth limit from cache key
   * Cache keys with depth limits end with ":number", e.g., "file1:node-1:3"
   * Cache keys without depth limits end with ":default", e.g., "file1:node-1:default"
   */
  private getCacheKeyDepthLimit(cacheKey: string): number | null {
    const parts = cacheKey.split(':');
    const lastPart = parts[parts.length - 1];
    
    // If the last part is a number, it's a depth limit
    const depthLimit = parseInt(lastPart, 10);
    if (!isNaN(depthLimit)) {
      return depthLimit;
    }
    
    // If it's "default" or any other string, no depth limit
    return null;
  }

  /**
   * Search for a node in cache and return both the node and cache item
   * Now considers depth parameter when searching for compatible cache entries
   */
  private findNodeInCache(
    fileKey: string,
    nodeId: string,
    requiredDepth?: number | null,
  ): { node: SimplifiedNode; cacheItem: CacheItem } | null {
    let result: { node: SimplifiedNode; cacheItem: CacheItem } | null = null;

    // Iterate through all cache entries for the file
    this.cache.forEach((cacheItem, cacheKey) => {
      if (result) return; // Already found, no need to continue

      if (cacheKey.startsWith(`${fileKey}:`)) {
        const cacheDepthLimit = this.getCacheKeyDepthLimit(cacheKey);
        
        // If requesting full data (requiredDepth is null/undefined) but cache has depth limit,
        // we need to ensure the target node's data is complete within the cached depth
        if ((requiredDepth === null || requiredDepth === undefined) && cacheDepthLimit !== null) {
          const targetNode = this.findNodeInTree(cacheItem.data.nodes, nodeId);
          if (targetNode) {
            // Calculate the depth of the target node from the root
            const nodeDepthFromRoot = this.getNodeDepthFromRoot(cacheItem.data.nodes, nodeId);
            // Calculate the actual depth of the target node's subtree
            const nodeSubtreeDepth = this.getNodeDepth(targetNode);
            
            const totalDepthNeeded = nodeDepthFromRoot + nodeSubtreeDepth;
            
            if (totalDepthNeeded >= cacheDepthLimit) {
              Logger.log(
                `Found cached data for ${nodeId} (from cache key: ${cacheKey}) but cache has depth limit ${cacheDepthLimit} while requesting full data. Node depth from root: ${nodeDepthFromRoot}, subtree depth: ${nodeSubtreeDepth}, total depth needed: ${totalDepthNeeded} >= cache limit`,
              );
              return; // Continue to next cache entry
            }
            
            // If we reach here, the cached data should be complete
            Logger.log(
              `Found cached data for ${nodeId} (from cache key: ${cacheKey}) with depth limit ${cacheDepthLimit}. Node depth from root: ${nodeDepthFromRoot}, subtree depth: ${nodeSubtreeDepth}, total depth needed: ${totalDepthNeeded} < cache limit. Data should be complete.`,
            );
          } else {
            Logger.log(
              `Found cached data for ${nodeId} (from cache key: ${cacheKey}) but cache has depth limit ${cacheDepthLimit} while requesting full data`,
            );
            return; // Continue to next cache entry
          }
        }

        // Check if this cache data satisfies the depth requirement for the target node
        if (
          this.checkNodeDepthSatisfiesRequirement(cacheItem.data, nodeId, requiredDepth ?? null)
        ) {
          const node = this.findNodeInTree(cacheItem.data.nodes, nodeId);
          if (node) {
            Logger.log(
              `Found cached node: ${nodeId} (from cache key: ${cacheKey}) satisfies depth requirement: ${requiredDepth}`,
            );

            // If we need to limit the depth, create a limited version
            let finalNode = node;
            if (requiredDepth !== null && requiredDepth !== undefined && requiredDepth >= 0) {
              finalNode = this.limitNodeDepth(node, requiredDepth);
            }

            result = { node: finalNode, cacheItem };
          }
        } else {
          Logger.log(
            `Found cached data for ${nodeId} (from cache key: ${cacheKey}) but does not satisfy depth requirement: ${requiredDepth}`,
          );
        }
      }
    });

    return result;
  }

  /**
   * Create a SimplifiedDesign object containing multiple nodes
   */
  private createDesignFromNodes(
    originalDesign: SimplifiedDesign,
    nodes: SimplifiedNode[],
  ): SimplifiedDesign {
    return {
      name: originalDesign.name,
      lastModified: originalDesign.lastModified,
      thumbnailUrl: originalDesign.thumbnailUrl,
      nodes: nodes,
      components: originalDesign.components,
      componentSets: originalDesign.componentSets,
      globalVars: originalDesign.globalVars,
    };
  }

  /**
   * Validate cache item freshness by comparing timestamps
   */
  private async validateCacheItem(
    cacheItem: CacheItem,
    validationParams: CacheValidationParams,
  ): Promise<boolean> {
    if (!cacheItem.lastTouchedAt) {
      // Cache items without timestamp are considered valid (backward compatibility)
      return true;
    }

    try {
      const startTime = performance.now();
      const fileMeta = await validationParams.getFileMeta();
      Logger.log(`Figma Call Meta Time taken: ${((performance.now() - startTime) / 1000).toFixed(2)}s`);
      const currentLastTouchedAt = fileMeta.last_touched_at;

      if (currentLastTouchedAt && currentLastTouchedAt !== cacheItem.lastTouchedAt) {
        Logger.log(
          `Cache expired: ${validationParams.fileKey} (cached: ${cacheItem.lastTouchedAt}, current: ${currentLastTouchedAt})`,
        );
        return false;
      }

      return true;
    } catch (error) {
      Logger.log(`Error validating cache freshness: ${error}, assuming cache is valid`);
      return true; // Assume cache is valid when validation fails
    }
  }

  /**
   * Get cache item with optional freshness validation
   */
  async get(
    cacheKey: string,
    validationParams?: CacheValidationParams,
  ): Promise<SimplifiedDesign | null> {
    const cacheItem = this.cache.get(cacheKey);
    if (!cacheItem) {
      return null;
    }

    // Validate freshness if validation params are provided
    if (validationParams) {
      const isValid = await this.validateCacheItem(cacheItem, validationParams);
      if (!isValid) {
        // Cache expired, delete and return null
        this.cache.delete(cacheKey);
        return null;
      }
    }

    Logger.log(`Using exact cache match: ${cacheKey}`);
    return cacheItem.data;
  }

  /**
   * Find and validate cached node data
   */
  async findNodeData(
    fileKey: string,
    nodeId: string,
    validationParams?: CacheValidationParams,
    requiredDepth?: number | null,
  ): Promise<SimplifiedNode | null> {
    const result = this.findNodeInCache(fileKey, nodeId, requiredDepth);
    if (!result) {
      return null;
    }

    // Validate freshness if validation params are provided
    if (validationParams) {
      const isValid = await this.validateCacheItem(result.cacheItem, validationParams);
      if (!isValid) {
        // Cache expired, clear related cache
        this.clearFileCache(fileKey);
        return null;
      }
    }

    return result.node;
  }

  /**
   * Handle cache lookup for multiple nodes
   */
  async findMultipleNodes(
    fileKey: string,
    nodeIds: string[],
    validationParams?: CacheValidationParams,
    requiredDepth?: number | null,
  ): Promise<{
    cachedNodes: SimplifiedNode[];
    missingNodeIds: string[];
    sourceDesign: SimplifiedDesign | null;
  }> {
    const cachedNodes: SimplifiedNode[] = [];
    const missingNodeIds: string[] = [];
    let sourceDesign: SimplifiedDesign | null = null;

    for (const nodeId of nodeIds) {
      const cachedNode = await this.findNodeData(fileKey, nodeId, validationParams, requiredDepth);
      if (cachedNode) {
        cachedNodes.push(cachedNode);
        // Record source design data for later merging
        if (!sourceDesign) {
          this.cache.forEach((cacheItem, cacheKey) => {
            if (
              cacheKey.startsWith(`${fileKey}:`) &&
              this.findNodeInTree(cacheItem.data.nodes, nodeId)
            ) {
              sourceDesign = cacheItem.data;
            }
          });
        }
      } else {
        missingNodeIds.push(nodeId);
      }
    }

    return { cachedNodes, missingNodeIds, sourceDesign };
  }

  /**
   * Cache data with optional timestamp
   */
  put(cacheKey: string, data: SimplifiedDesign, lastTouchedAt: string): void {
    const cacheItem: CacheItem = {
      data,
      lastTouchedAt,
    };
    this.cache.put(cacheKey, cacheItem);
    Logger.log(`Cached data: ${cacheKey}${lastTouchedAt ? ` (timestamp: ${lastTouchedAt})` : ""}`);
  }

  /**
   * Merge node data and create new design object
   */
  mergeNodesAsDesign(sourceDesign: SimplifiedDesign, nodes: SimplifiedNode[]): SimplifiedDesign {
    return this.createDesignFromNodes(sourceDesign, nodes);
  }

  /**
   * Clear all cache entries for a specific file
   */
  clearFileCache(fileKey: string): void {
    const keysToDelete: string[] = [];
    this.cache.forEach((_, cacheKey) => {
      if (cacheKey.startsWith(`${fileKey}:`)) {
        keysToDelete.push(cacheKey);
      }
    });
    keysToDelete.forEach((key) => this.cache.delete(key));
    Logger.log(`Cleared ${keysToDelete.length} cache entries for file: ${fileKey}`);
  }

  /**
   * Clear all cache entries
   */
  clearAllCache(): void {
    this.cache.clear();
    Logger.log("Cleared all node cache");
  }

  /**
   * Check if cache contains a specific key
   */
  has(cacheKey: string): boolean {
    return this.cache.has(cacheKey);
  }
}
