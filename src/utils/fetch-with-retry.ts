import { execFile } from "child_process";
import { promisify } from "util";
import { Logger } from "./logger.js";

const execFileAsync = promisify(execFile);

type RequestOptions = RequestInit & {
  /**
   * Force format of headers to be a record of strings, e.g. { "Authorization": "Bearer 123" }
   *
   * Avoids complexity of needing to deal with `instanceof Headers`, which is not supported in some environments.
   */
  headers?: Record<string, string>;
};

export async function fetchWithRetry<T extends { status?: number }>(
  url: string,
  options: RequestOptions = {},
): Promise<T> {
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
    // Most options here are to ensure stderr only contains errors, so we can use it to confidently check if an error occurred.
    // -s: Silent mode—no progress bar in stderr
    // -S: Show errors in stderr
    // --fail-with-body: curl errors with code 22, and outputs body of failed request, e.g. "Fetch failed with status 404"
    // -L: Follow redirects
    const curlArgs = ["-s", "-S", "--fail-with-body", "-L", ...curlHeaders, url];

    try {
      // Fallback to curl for  corporate networks that have proxies that sometimes block fetch
      Logger.log(`[fetchWithRetry] Executing curl with args: ${JSON.stringify(curlArgs)}`);
      const { stdout, stderr } = await execFileAsync("curl", curlArgs);

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

      const result = JSON.parse(stdout) as T;

      // Successful Figma requests don't have a status property, and some endpoints return 200 with an
      // error status in the body, e.g. https://www.figma.com/developers/api#get-images-endpoint
      if (result.status && result.status !== 200) {
        throw new Error(`Curl command failed: ${result}`);
      }

      return result;
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
 * Converts HeadersInit to an array of curl header arguments for execFile.
 * @param headers Headers to convert.
 * @returns Array of strings for curl arguments: ["-H", "key: value", "-H", "key2: value2"]
 */
function formatHeadersForCurl(headers: Record<string, string> | undefined): string[] {
  if (!headers) {
    return [];
  }

  const headerArgs: string[] = [];
  for (const [key, value] of Object.entries(headers)) {
    headerArgs.push("-H", `${key}: ${value}`);
  }
  return headerArgs;
}
