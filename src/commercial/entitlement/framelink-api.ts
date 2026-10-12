/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Thin HTTP client for the Framelink app's write-access endpoints. Parses responses at this boundary
// and maps status codes to outcomes; every policy decision lives in the pure modules beside it.
// Plain fetch rather than utils/fetch-json: these endpoints answer with meaningful 400/401 bodies
// (device-flow `error` codes, a revoked token) that must be read, not retried or thrown.
import { z } from "zod";

/**
 * Every path this client calls, in one place. The device-flow pair are BetterAuth's
 * device-authorization plugin routes under the app's `/api/auth` mount.
 */
export const FRAMELINK_API_PATHS = {
  writeUsage: "/api/write/usage",
  writeEntitlement: "/api/write/entitlement",
  deviceCode: "/api/auth/device/code",
  deviceToken: "/api/auth/device/token",
} as const;

// The app's device client allowlist names this server by this id.
export const FRAMELINK_DEVICE_CLIENT_ID = "framelink-mcp";

// The device-code request has no field for the Figma user the token is for, so it rides in `scope`;
// the app refuses to issue the token unless the signed-in user's linked Figma account matches it.
const deviceScopeFor = (figmaUserId: string): string => `figma_user:${figmaUserId}`;

const REQUEST_TIMEOUT_MS = 10_000;

const WriteUsageResponseBody = z.object({
  figmaUserId: z.string(),
  usedThisMonth: z.number().int().nonnegative(),
  resetsAt: z.string(),
});
export type WriteUsageResponse = z.infer<typeof WriteUsageResponseBody>;

const WriteEntitlementResponse = z.object({
  figmaUserId: z.string().nullable(),
  seat: z.boolean(),
  validatedAt: z.string(),
});

const DeviceCodeResponse = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string(),
  verification_uri_complete: z.string().optional(),
  expires_in: z.number(),
  interval: z.number(),
});

const DeviceTokenResponse = z.object({ access_token: z.string() });
const DeviceTokenError = z.object({ error: z.string() });

export type WriteEntitlementResult =
  | { kind: "validated"; figmaUserId: string | null; seat: boolean; validatedAt: string }
  // The token is unknown, expired, or revoked: the only answer that may drop a cached seat besides seat:false.
  | { kind: "invalid-token" };

export interface DeviceSignIn {
  deviceCode: string;
  userCode: string;
  /** The verification page with the code pre-filled when the app offers one. */
  verificationUri: string;
  expiresInMs: number;
  intervalMs: number;
}

export type DeviceTokenPoll =
  | { kind: "token"; accessToken: string }
  | { kind: "pending" }
  | { kind: "slow-down" }
  | { kind: "denied" }
  | { kind: "expired" }
  // Any other RFC 8628 error code (invalid_client, invalid_grant, …): the flow can't finish.
  | { kind: "failed"; error: string };

/**
 * A request that didn't produce a usable answer. `unavailable` is an outage worth retrying later
 * (network, timeout, 5xx, 429, a malformed or misaddressed body); `rejected` is any other 4xx — the
 * app understood and refused, so the same request will keep failing.
 */
export class FramelinkApiError extends Error {
  constructor(
    readonly kind: "unavailable" | "rejected",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "FramelinkApiError";
  }
}

export class FramelinkApiClient {
  constructor(
    readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async reportWriteUsage(body: {
    installId: string;
    figmaUserId: string;
    executions: { executionId: string; at: string }[];
  }): Promise<WriteUsageResponse> {
    const response = await this.send(FRAMELINK_API_PATHS.writeUsage, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!response.ok) throw httpError(FRAMELINK_API_PATHS.writeUsage, response);
    const answer = await parseBody(
      WriteUsageResponseBody,
      response,
      FRAMELINK_API_PATHS.writeUsage,
    );
    // A count for someone else must not land in this user's ledger.
    if (answer.figmaUserId !== body.figmaUserId)
      throw new FramelinkApiError(
        "unavailable",
        `${FRAMELINK_API_PATHS.writeUsage}: answered for a different Figma user`,
      );
    return answer;
  }

  async getWriteEntitlement(token: string): Promise<WriteEntitlementResult> {
    const response = await this.send(FRAMELINK_API_PATHS.writeEntitlement, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.status === 401) return { kind: "invalid-token" };
    if (!response.ok) throw httpError(FRAMELINK_API_PATHS.writeEntitlement, response);
    const body = await parseBody(
      WriteEntitlementResponse,
      response,
      FRAMELINK_API_PATHS.writeEntitlement,
    );
    return { kind: "validated", ...body };
  }

  async requestDeviceSignIn(figmaUserId: string): Promise<DeviceSignIn> {
    const response = await this.send(FRAMELINK_API_PATHS.deviceCode, {
      method: "POST",
      body: JSON.stringify({
        client_id: FRAMELINK_DEVICE_CLIENT_ID,
        scope: deviceScopeFor(figmaUserId),
      }),
    });
    if (!response.ok) throw httpError(FRAMELINK_API_PATHS.deviceCode, response);
    const body = await parseBody(DeviceCodeResponse, response, FRAMELINK_API_PATHS.deviceCode);
    return {
      deviceCode: body.device_code,
      userCode: body.user_code,
      verificationUri: body.verification_uri_complete ?? body.verification_uri,
      expiresInMs: body.expires_in * 1000,
      intervalMs: body.interval * 1000,
    };
  }

  async pollDeviceToken(deviceCode: string): Promise<DeviceTokenPoll> {
    const response = await this.send(FRAMELINK_API_PATHS.deviceToken, {
      method: "POST",
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: FRAMELINK_DEVICE_CLIENT_ID,
      }),
    });
    if (response.ok) {
      const body = await parseBody(DeviceTokenResponse, response, FRAMELINK_API_PATHS.deviceToken);
      return { kind: "token", accessToken: body.access_token };
    }
    // RFC 8628 §3.5: pending and slow_down arrive as 400s carrying an `error` code.
    if (response.status !== 400) throw httpError(FRAMELINK_API_PATHS.deviceToken, response);
    const { error } = await parseBody(DeviceTokenError, response, FRAMELINK_API_PATHS.deviceToken);
    if (error === "authorization_pending") return { kind: "pending" };
    if (error === "slow_down") return { kind: "slow-down" };
    if (error === "access_denied") return { kind: "denied" };
    if (error === "expired_token") return { kind: "expired" };
    return { kind: "failed", error };
  }

  private async send(path: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(new URL(path, this.baseUrl), {
        ...init,
        headers: { "Content-Type": "application/json", ...init.headers },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new FramelinkApiError("unavailable", `${path}: ${(err as Error).message}`, {
        cause: err,
      });
    }
  }
}

function httpError(path: string, response: Response): FramelinkApiError {
  const kind = response.status === 429 || response.status >= 500 ? "unavailable" : "rejected";
  return new FramelinkApiError(kind, `${path}: HTTP ${response.status}`);
}

async function parseBody<T>(schema: z.ZodType<T>, response: Response, path: string): Promise<T> {
  const parsed = schema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success)
    throw new FramelinkApiError("unavailable", `${path}: unexpected response body`);
  return parsed.data;
}
