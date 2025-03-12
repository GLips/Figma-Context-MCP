import axios, { AxiosError } from "axios";
import { Logger } from "~/server";

export interface GitLabError {
  status: number;
  err: string;
}

export interface GitLabFile {
  file_path: string;
  content: string;
  encoding?: string;
  last_commit_id?: string;
}

export interface GitLabCommit {
  id: string;
  short_id: string;
  title: string;
  author_name: string;
  created_at: string;
  message: string;
}

export interface GitLabBranch {
  name: string;
  commit: GitLabCommit;
  merged: boolean;
  protected: boolean;
  default: boolean;
}

export interface GitLabTreeItem {
  id: string;
  name: string;
  type: "tree" | "blob";
  path: string;
  mode: string;
}

export class GitLabService {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly projectId: string;
  private readonly defaultBranch: string;

  constructor(token: string, baseUrl: string, projectId: string, defaultBranch: string) {
    this.token = token;
    this.baseUrl = baseUrl;
    this.projectId = encodeURIComponent(projectId);
    this.defaultBranch = defaultBranch;
  }

  private async request<T>(endpoint: string, method: 'get' | 'post' | 'put' | 'delete' = 'get', data?: any): Promise<T> {
    try {
      const url = `${this.baseUrl}${endpoint}`;
      Logger.log(`Calling ${url} with method ${method}`);
      
      const config = {
        headers: {
          'PRIVATE-TOKEN': this.token,
          'Content-Type': 'application/json'
        }
      };

      let response;
      
      try {
        switch (method) {
          case 'get':
            response = await axios.get(url, config);
            break;
          case 'post':
            response = await axios.post(url, data, config);
            break;
          case 'put':
            response = await axios.put(url, data, config);
            break;
          case 'delete':
            response = await axios.delete(url, config);
            break;
        }
        
        return response.data;
      } catch (axiosError) {
        if (axiosError instanceof AxiosError) {
          Logger.error(`Axios error details:`, {
            message: axiosError.message,
            code: axiosError.code,
            status: axiosError.response?.status,
            statusText: axiosError.response?.statusText,
            headers: axiosError.response?.headers,
            data: axiosError.response?.data
          });
          
          if (axiosError.response) {
            throw {
              status: axiosError.response.status,
              err: (axiosError.response.data as { message?: string }).message || "Unknown error",
            } as GitLabError;
          }
        }
        throw axiosError;
      }
    } catch (error) {
      Logger.error(`Request error:`, error);
      if (error instanceof Error) {
        throw new Error(`Failed to make ${method} request to GitLab API: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Get a file from the repository
   * @param filePath Path to the file in the repository
   * @param ref Branch or commit reference (defaults to the configured default branch)
   * @returns The file content
   */
  async getFile(filePath: string, ref?: string): Promise<string> {
    const branchRef = ref || this.defaultBranch;
    const endpoint = `/projects/${this.projectId}/repository/files/${encodeURIComponent(filePath)}/raw?ref=${branchRef}`;
    
    try {
      return await this.request<string>(endpoint);
    } catch (error) {
      Logger.error(`Failed to get file ${filePath} from branch ${branchRef}:`, error);
      throw error;
    }
  }

  /**
   * Create or update a file in the repository
   * @param filePath Path to the file in the repository
   * @param content Content of the file
   * @param commitMessage Commit message
   * @param branch Branch to commit to (defaults to the configured default branch)
   * @returns Success status
   */
  async createOrUpdateFile(
    filePath: string, 
    content: string, 
    commitMessage: string,
    branch?: string
  ): Promise<boolean> {
    const branchRef = branch || this.defaultBranch;
    const endpoint = `/projects/${this.projectId}/repository/files/${encodeURIComponent(filePath)}`;
    
    try {
      // Check if file exists
      let fileExists = false;
      try {
        await this.getFile(filePath, branchRef);
        fileExists = true;
      } catch (error) {
        // File doesn't exist, we'll create it
        fileExists = false;
      }

      const method = fileExists ? 'put' : 'post';
      const data = {
        branch: branchRef,
        content,
        commit_message: commitMessage,
        encoding: 'text'
      };

      await this.request(endpoint, method, data);
      return true;
    } catch (error) {
      const isFileExists = await this.checkFileExists(filePath, branchRef);
      Logger.error(`Failed to ${isFileExists ? 'update' : 'create'} file ${filePath} on branch ${branchRef}:`, error);
      return false;
    }
  }

  /**
   * Check if a file exists in the repository
   * @param filePath Path to the file in the repository
   * @param ref Branch or commit reference
   * @returns Whether the file exists
   */
  private async checkFileExists(filePath: string, ref: string): Promise<boolean> {
    try {
      await this.getFile(filePath, ref);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get list of branches in the repository
   * @returns List of branches
   */
  async getBranches(): Promise<GitLabBranch[]> {
    const endpoint = `/projects/${this.projectId}/repository/branches`;
    
    try {
      return await this.request<GitLabBranch[]>(endpoint);
    } catch (error) {
      Logger.error('Failed to get branches:', error);
      throw error;
    }
  }

  /**
   * Create a new branch in the repository
   * @param branchName Name of the new branch
   * @param ref Branch or commit to create from (defaults to the configured default branch)
   * @returns The created branch
   */
  async createBranch(branchName: string, ref?: string): Promise<GitLabBranch> {
    const branchRef = ref || this.defaultBranch;
    const endpoint = `/projects/${this.projectId}/repository/branches`;
    
    try {
      return await this.request<GitLabBranch>(endpoint, 'post', {
        branch: branchName,
        ref: branchRef
      });
    } catch (error) {
      Logger.error(`Failed to create branch ${branchName} from ${branchRef}:`, error);
      throw error;
    }
  }

  /**
   * Get recent commits from a branch
   * @param branch Branch to get commits from (defaults to the configured default branch)
   * @param limit Maximum number of commits to return
   * @returns List of commits
   */
  async getCommits(branch?: string, limit: number = 10): Promise<GitLabCommit[]> {
    const branchRef = branch || this.defaultBranch;
    const endpoint = `/projects/${this.projectId}/repository/commits?ref_name=${branchRef}&per_page=${limit}`;
    
    try {
      return await this.request<GitLabCommit[]>(endpoint);
    } catch (error) {
      Logger.error(`Failed to get commits from branch ${branchRef}:`, error);
      throw error;
    }
  }

  /**
   * Get the repository tree (files and directories)
   * @param path Path in the repository (use empty string for root)
   * @param ref Branch or commit reference (defaults to the configured default branch)
   * @param recursive Whether to get the tree recursively
   * @returns List of files and directories
   */
  async getRepositoryTree(path: string = "", ref?: string, recursive: boolean = false): Promise<GitLabTreeItem[]> {
    const branchRef = ref || this.defaultBranch;
    let endpoint = `/projects/${this.projectId}/repository/tree?ref=${branchRef}`;
    
    if (path) {
      endpoint += `&path=${encodeURIComponent(path)}`;
    }
    
    if (recursive) {
      endpoint += "&recursive=true";
    }
    
    try {
      return await this.request<GitLabTreeItem[]>(endpoint);
    } catch (error) {
      Logger.error(`Failed to get repository tree for path ${path} from branch ${branchRef}:`, error);
      throw error;
    }
  }

  /**
   * Test the GitLab connection
   * @returns Connection status
   */
  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      Logger.log(`Testing GitLab connection to ${this.baseUrl}`);
      
      // Try a simple request to the version endpoint
      const config = {
        headers: {
          'PRIVATE-TOKEN': this.token,
          'Content-Type': 'application/json'
        }
      };
      
      const response = await axios.get(`${this.baseUrl}/version`, config);
      
      return {
        success: true,
        message: `Successfully connected to GitLab API. Version: ${JSON.stringify(response.data)}`
      };
    } catch (error) {
      let errorMessage = "Unknown error";
      
      if (error instanceof AxiosError) {
        if (error.code === 'ECONNREFUSED') {
          errorMessage = `Connection refused to ${this.baseUrl}. Please check if the URL is correct and accessible.`;
        } else if (error.code === 'ENOTFOUND') {
          errorMessage = `Host not found: ${this.baseUrl}. Please check if the URL is correct.`;
        } else if (error.response) {
          errorMessage = `GitLab API responded with status ${error.response.status}: ${error.response.statusText}`;
          if (error.response.data && typeof error.response.data === 'object') {
            errorMessage += ` - ${JSON.stringify(error.response.data)}`;
          }
        } else {
          errorMessage = `Error connecting to GitLab API: ${error.message}`;
        }
        
        Logger.error(`Connection test failed:`, {
          message: error.message,
          code: error.code,
          status: error.response?.status,
          statusText: error.response?.statusText,
          data: error.response?.data
        });
      } else if (error instanceof Error) {
        errorMessage = `Error connecting to GitLab API: ${error.message}`;
        Logger.error(`Connection test failed:`, error);
      }
      
      return {
        success: false,
        message: errorMessage
      };
    }
  }
} 