// The properties of a PostHog `$exception` event, encoded as posthog-node 5 encoded them (its
// ErrorPropertiesBuilder with the node stack parser and module modifier), so Error Tracking groups
// these issues with the ones reported before. Source context lines are left out: they would mean
// reading files off the user's disk to send them.
import { dirname, posix } from "node:path";

const PLATFORM = "node:javascript";
const STACKTRACE_FRAME_LIMIT = 50;
const UNKNOWN_FUNCTION = "?";

type StackFrame = {
  filename?: string;
  module?: string;
  function?: string;
  lineno?: number;
  colno?: number;
  in_app?: boolean;
  platform: string;
};

/** `$exception_list` and `$exception_level` for one error with no cause. */
export function exceptionProperties(error: Error): Record<string, unknown> {
  const frames = parseStack(error.stack ?? "");
  return {
    $exception_list: [
      {
        type: error.name || error.constructor.name,
        value: String(error.message),
        mechanism: { type: "generic", handled: true, synthetic: false },
        ...(frames.length ? { stacktrace: { type: "raw", frames } } : {}),
      },
    ],
    $exception_level: "error",
  };
}

function parseStack(stack: string): StackFrame[] {
  const frames: StackFrame[] = [];
  for (const line of stack.split("\n")) {
    if (line.length > 1024) continue;
    const cleaned = line.replace(/\(error: (.*)\)/, "$1");
    if (/\S*Error: /.test(cleaned)) continue;
    const frame = parseNodeStackLine(cleaned);
    if (frame) frames.push(frame);
    if (frames.length >= STACKTRACE_FRAME_LIMIT) break;
  }
  if (!frames.length) return [];
  frames.reverse();
  const last = frames[frames.length - 1];
  const moduleOf = moduleFromFilename();
  return frames.slice(0, STACKTRACE_FRAME_LIMIT).map((frame) => {
    const filename = frame.filename || last.filename;
    return {
      ...frame,
      filename,
      function: frame.function || UNKNOWN_FUNCTION,
      module: moduleOf(filename),
    };
  });
}

const FULL_MATCH = /at (?:async )?(?:(.+?)\s+\()?(?:(.+):(\d+):(\d+)?|([^)]+))\)?/;

function parseNodeStackLine(line: string): StackFrame | undefined {
  const match = line.match(FULL_MATCH);
  if (!match) return /^\s*[-]{4,}$/.test(line) ? { filename: line, platform: PLATFORM } : undefined;
  let object: string | undefined;
  let method: string | undefined;
  let functionName: string | undefined;
  let typeName: string | undefined;
  let methodName: string | undefined;
  if (match[1]) {
    functionName = match[1];
    let methodStart = functionName.lastIndexOf(".");
    if (functionName[methodStart - 1] === ".") methodStart--;
    if (methodStart > 0) {
      object = functionName.slice(0, methodStart);
      method = functionName.slice(methodStart + 1);
      const objectEnd = object.indexOf(".Module");
      if (objectEnd > 0) {
        functionName = functionName.slice(objectEnd + 1);
        object = object.slice(0, objectEnd);
      }
    }
  }
  if (method) {
    typeName = object;
    methodName = method;
  }
  if (method === "<anonymous>") {
    methodName = undefined;
    functionName = undefined;
  }
  if (functionName === undefined) {
    methodName = methodName || UNKNOWN_FUNCTION;
    functionName = typeName ? `${typeName}.${methodName}` : methodName;
  }
  let filename = match[2]?.startsWith("file://") ? match[2].slice(7) : match[2];
  const isNative = match[5] === "native";
  if (filename?.match(/\/[A-Z]:/)) filename = filename.slice(1);
  if (!filename && match[5] && !isNative) filename = match[5];
  return {
    filename: filename ? decodeURI(filename) : undefined,
    module: undefined,
    function: functionName,
    lineno: Number.parseInt(match[3] || "", 10) || undefined,
    colno: Number.parseInt(match[4] || "", 10) || undefined,
    in_app: isInApp(filename || "", isNative),
    platform: PLATFORM,
  };
}

function isInApp(filename: string, isNative: boolean): boolean {
  const isInternal =
    isNative ||
    (filename &&
      !filename.startsWith("/") &&
      !filename.match(/^[A-Z]:/) &&
      !filename.startsWith(".") &&
      !filename.match(/^[a-zA-Z]([a-zA-Z0-9.\-+])*:\/\//));
  return !isInternal && filename !== undefined && !filename.includes("node_modules/");
}

function moduleFromFilename(): (filename: string | undefined) => string | undefined {
  const base = process.argv[1] ? dirname(process.argv[1]) : process.cwd();
  return (filename) => {
    if (!filename) return undefined;
    const parsed = posix.parse(filename);
    let { dir } = parsed;
    let file = parsed.base;
    if (parsed.ext === ".js" || parsed.ext === ".mjs" || parsed.ext === ".cjs")
      file = file.slice(0, -parsed.ext.length);
    const decoded = decodeURIComponent(file);
    if (!dir) dir = ".";
    const n = dir.lastIndexOf("/node_modules");
    if (n > -1) return `${dir.slice(n + 14).replace(/\//g, ".")}:${decoded}`;
    if (dir.startsWith(base)) {
      const moduleName = dir.slice(base.length + 1).replace(/\//g, ".");
      return moduleName ? `${moduleName}:${decoded}` : decoded;
    }
    return decoded;
  };
}
