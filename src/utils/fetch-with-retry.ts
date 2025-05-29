import { exec } from "child_process";
import { promisify } from "util";
import { Logger } from "./logger.js";

const execAsync = promisify(exec);

export async function fetchWithRetry<T>(url: string, options: RequestInit = {}): Promise<T> {
  try {
    const response = await fetch(url, options);

    if (!response.ok) {
      throw new Error(`Fetch failed with status ${response.status}: ${response.statusText}`);
    }
    return (await response.json()) as T;
  } catch (fetchError: any) {
    Logger.log(
      `[fetchWithRetry] Initial fetch failed for ${url}: ${fetchError.message}. Likely a corporate proxy or SSL issue. Attempting curl fallback.`,
    );

    const curlHeaders = formatHeadersForCurl(options.headers);
    const curlCommand = `curl -s -L ${curlHeaders.join(" ")} "${url}"`;

    try {
      // Fallback to curl for  corporate networks that have proxies that sometimes block fetch
      Logger.log(`[fetchWithRetry] Executing curl command: ${curlCommand}`);
      const { stdout, stderr } = await execAsync(curlCommand);

      if (stderr) {
        // curl often outputs progress to stderr, so only treat as error if stdout is empty
        // or if stderr contains typical error keywords.
        if (
          !stdout ||
          stderr.toLowerCase().includes("error") ||
          stderr.toLowerCase().includes("fail")
        ) {
          throw new Error(`Curl command failed with stderr: ${stderr}`);
        }
        Logger.log(
          `[fetchWithRetry] Curl command for ${url} produced stderr (but might be informational): ${stderr}`,
        );
      }

      if (!stdout) {
        throw new Error("Curl command returned empty stdout.");
      }

      return JSON.parse(stdout) as T;
    } catch (curlError: any) {
      Logger.error(`[fetchWithRetry] Curl fallback also failed for ${url}: ${curlError.message}`);
      // Re-throw the original fetch error to give context about the initial failure
      // or throw a new error that wraps both, depending on desired error reporting.
      // For now, re-throwing the original as per the user example's spirit.
      throw fetchError;
    }
  }
}

/**
 * Converts HeadersInit to an array of curl header arguments.
 * @param headers Headers to convert.
 * @returns Array of strings, each a curl -H argument.
 */
function formatHeadersForCurl(headers: HeadersInit | undefined): string[] {
  if (!headers) {
    return [];
  }

  const curlHeaders: string[] = [];

  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      curlHeaders.push(`-H "${key}: ${value}"`);
    });
  } else if (Array.isArray(headers)) {
    headers.forEach(([key, value]) => {
      curlHeaders.push(`-H "${key}: ${value}"`);
    });
  } else {
    Object.entries(headers).forEach(([key, value]) => {
      curlHeaders.push(`-H "${key}: ${value}"`);
    });
  }
  return curlHeaders;
}
