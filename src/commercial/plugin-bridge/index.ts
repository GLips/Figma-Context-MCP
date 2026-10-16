/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { Logger } from "~/utils/logger.js";
import { PluginBridge, type PluginLink } from "./bridge.js";
import { pluginSeenRecently, recordPluginSighting } from "./plugin-sighting.js";
import { createLocalImageReader, type LocalImageReader } from "./images.js";
import { ImageUploadStore } from "./image-intake.js";
import { startUploadEndpoint, type UploadEndpoint } from "./upload-endpoint.js";
import { createContainedFileReader } from "./contained-file.js";
import { createSavedScriptReader } from "./saved-script.js";
import {
  ImageByteCache,
  createImagesCapability,
  createImageSourceFetcher,
} from "./image-requests.js";
import { createCommentPinsCapability } from "./comment-pins.js";
import { WS_PORT_BLOCK, type WriteAccessNotice } from "@framelink/plugin/protocol";
import { resolveStateDir } from "~/commercial/state-dir.js";
import { WriteAccess } from "~/commercial/entitlement/write-access.js";
import { WriteMeter } from "~/commercial/entitlement/write-meter.js";
import {
  DeviceSignIn,
  SIGN_IN_NEEDS_FIGMA_USER_NOTICE,
} from "~/commercial/entitlement/device-sign-in.js";
import { FramelinkApiClient } from "~/commercial/entitlement/framelink-api.js";
import { WriteAccessStore } from "~/commercial/entitlement/write-access-store.js";

// How often a connected server checks whether its plugin owners' seats or counts have gone stale. The
// staleness rules themselves live in WriteAccess.syncWriteAccess; this is only the polling tick.
const WRITE_ACCESS_SYNC_TICK_MS = 10 * 60 * 1000;

/**
 * Where a plugin stands for this process. `connected` is on the wire now; `expected` has connected
 * in this process, or authenticated with a server on this state dir recently — so the write path
 * exists even while it redials; `absent` has shown no sign of one.
 */
export type PluginPresence = "connected" | "expected" | "absent";

/**
 * The running WS relay plus the plugin's presence. The relay starts with the server in BOTH transports
 * (one loopback port from the block; negligible when unused), but plugin-dependent tool advertisement
 * waits for a plugin to be connected or expected (bindPluginAdvertisement).
 *
 * The first-connect latch never resets: once a plugin has connected, it is expected for the process
 * lifetime. That is deliberately stronger than a disconnect grace period — the plugin's relay (ui.ts)
 * reconnects on a ~1s cadence, and a latch cannot flap on blips at all. Do not "fix" this by
 * un-advertising on disconnect: list-caching MCP clients would strand the agent mid-task.
 */
export interface PluginBridgeRuntime {
  bridge: PluginBridge;
  /** Close a short-lived CLI runtime and its background synchronization. Call drain first. */
  stop?(): void;
  /** Seat and free-allowance authorization for figma_execute_code, and each run's charge. */
  writeMeter: WriteMeter;
  /** Read figma_execute_code's scriptPath, contained under the asset root. */
  readSavedScript(scriptPath: string): Promise<string>;
  /** Read flcm.image's local paths, contained under the asset root; granted to each run it submits. */
  readLocalImage: LocalImageReader;
  pluginPresence(): PluginPresence;
  /** Run cb on the first plugin connection; runs immediately if one already happened. */
  onFirstConnect(cb: () => void): void;
}

/** What advertising needs of the runtime: whether a plugin is around, never a way to use it. */
export type PluginPresenceSource = Pick<PluginBridgeRuntime, "pluginPresence" | "onFirstConnect">;

/**
 * Advertise what depends on a plugin according to its presence: now, and — on stdio, whose one server
 * outlives the session — again when a plugin first connects. Stateless HTTP builds a server per
 * request, which re-reads presence here; subscribing those short-lived servers would only accumulate
 * dead closures until first connect.
 */
export function bindPluginAdvertisement(
  runtime: PluginPresenceSource,
  transport: "stdio" | "http",
  advertise: (pluginExpected: boolean) => void,
): void {
  const expected = runtime.pluginPresence() !== "absent";
  advertise(expected);
  if (expected || transport !== "stdio") return;
  runtime.onFirstConnect(() => advertise(true));
}

/**
 * Start the WS relay on the port block and wire what each authenticated link is told. Called once per
 * process from server startup; every MCP server instance (one for stdio, one per stateless HTTP
 * request) shares the returned runtime.
 */
export function startPluginBridge({
  assetRoot,
  framelinkApiUrl,
  acceptUploads = false,
}: {
  assetRoot: string;
  framelinkApiUrl: string;
  /**
   * Open the image upload endpoint. Only a long-lived server wants it: an upload outlives the command
   * that made it, so a CLI run's own short-lived runtime has nothing to hold handles for.
   */
  acceptUploads?: boolean;
}): PluginBridgeRuntime {
  // The images handler answers the plugin's mid-run image requests (protocol 2). Sources split by
  // scheme: https urls go through the guarded fetch plus a session-lifetime URL→bytes cache, local
  // paths through the run's grant of the asset-root-contained file read (uncached — see
  // image-requests.ts).
  // One contained reader per process, shared by flcm.image paths and saved scripts: it pins the
  // canonical asset root on first use, so the authorization boundary can't shift under a retargeted
  // root symlink mid-session.
  const readContained = createContainedFileReader(assetRoot);
  const readLocalImage = createLocalImageReader(readContained, { uploadsAccepted: acceptUploads });
  const uploads = new ImageUploadStore();
  let uploadEndpoint: UploadEndpoint | null = null;
  let stopped = false;
  if (acceptUploads) {
    startUploadEndpoint({ store: uploads }).then(
      (endpoint) => {
        if (stopped) endpoint.stop();
        else uploadEndpoint = endpoint;
      },
      (err: Error) => Logger.log(`Image upload endpoint did not start: ${err.message}`),
    );
  }
  const api = new FramelinkApiClient(framelinkApiUrl);
  const writeAccess = new WriteAccess(api, new WriteAccessStore());
  const notifyLinkPanel = (link: PluginLink, notice: WriteAccessNotice) => {
    bridge.request(link, { type: "WRITE_ACCESS", notice }).catch(() => {});
  };
  // A write-access notice is about one owner's seat and allowance on this server, so it reaches every
  // panel signed in as that owner here — and no other Figma user's, though theirs share this machine.
  const notifyOwnerPanels = (figmaUserId: string, notice: WriteAccessNotice) => {
    for (const link of bridge.authenticatedLinks())
      if (link.owner?.figmaUserId === figmaUserId) notifyLinkPanel(link, notice);
  };
  const writeMeter = new WriteMeter(writeAccess, { notifyOwnerPanels });
  const signIn = new DeviceSignIn(api, writeAccess, notifyOwnerPanels);
  const framelinkOrigin = new URL(framelinkApiUrl).origin;
  const syncOwnerWriteAccess = (link: PluginLink, options?: { force: boolean }) => {
    if (link.owner) inBackground(writeAccess.syncWriteAccess(link.owner, options));
  };
  const bridge: PluginBridge = new PluginBridge({
    framelinkOrigin,
    events: {
      onLinkAuthenticated: (link) => {
        recordPluginSighting();
        syncOwnerWriteAccess(link);
      },
      // A grant is the moment the human starts a run of writes: bring the owner's seat up to date.
      onGrantChanged: (link, granted) => {
        if (granted) syncOwnerWriteAccess(link, { force: true });
      },
      onWriteAccessSignIn: (link) => {
        if (link.owner) inBackground(signIn.start(link.owner));
        else notifyLinkPanel(link, SIGN_IN_NEEDS_FIGMA_USER_NOTICE);
      },
      onRunEvent: (event) => writeMeter.runEvent(event),
    },
    capabilities: new Map([
      [
        "images.fetch",
        createImagesCapability({
          fetchImage: createImageSourceFetcher({
            uploads: acceptUploads
              ? { store: uploads, port: () => uploadEndpoint?.port ?? null }
              : null,
          }),
          cache: new ImageByteCache(),
        }),
      ],
      ["comments.pins", createCommentPinsCapability()],
    ]),
  });
  // Surface where the plugin link credential lives — a 0600 secret, so an operator should be able to
  // locate and inspect it at startup. Override via FRAMELINK_STATE_DIR. Grants live in the plugin.
  Logger.log(`Plugin pairing persisted under ${resolveStateDir()}`);
  const seenAtStart = pluginSeenRecently();
  // Callbacks awaiting the first plugin connection; null once it has happened (the latch fired).
  // One variable, not a boolean + array pair, so "latched but callbacks still queued" can't exist.
  let pendingFirstConnect: (() => void)[] | null = [];

  bridge.start(WS_PORT_BLOCK, () => {
    if (pendingFirstConnect) {
      const callbacks = pendingFirstConnect;
      pendingFirstConnect = null;
      for (const cb of callbacks) cb();
    }
  });

  const writeAccessTick = setInterval(() => {
    for (const link of bridge.authenticatedLinks()) syncOwnerWriteAccess(link);
  }, WRITE_ACCESS_SYNC_TICK_MS);
  writeAccessTick.unref();

  return {
    bridge,
    writeMeter,
    readSavedScript: createSavedScriptReader(readContained),
    readLocalImage,
    stop: () => {
      stopped = true;
      uploadEndpoint?.stop();
      clearInterval(writeAccessTick);
      signIn.stop();
      bridge.stop();
    },
    pluginPresence: () => {
      if (bridge.isPluginConnected()) return "connected";
      return pendingFirstConnect === null || seenAtStart ? "expected" : "absent";
    },
    onFirstConnect: (cb) => {
      if (pendingFirstConnect) pendingFirstConnect.push(cb);
      else cb();
    },
  };
}

/** Background write-access work reports its own failures; it must never become an unhandled rejection. */
function inBackground(work: Promise<void>): void {
  work.catch((err: Error) => Logger.log(`Write-access sync failed: ${err.message}`));
}
