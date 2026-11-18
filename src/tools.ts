import type { WebMCP } from "webmcp-types";

/** Tool metadata as its owner stores it and as frames exchange it. */
export interface ToolMetadata
  extends Pick<WebMCP.RegisteredTool, "name" | "title" | "description"> {
  annotations: WebMCP.RegisteredTool["annotations"];
  /** Snapshots at registration; each discovery result parses a fresh copy. */
  serializedSchema: string | undefined;
  serializedOutputSchema: string | undefined;
}

/** A tool as its owner stores it, whether registered by script or declared by a form. */
export interface StoredTool {
  metadata: ToolMetadata;
  /** Origins other than the owner's that may discover and execute the tool. */
  exposedTo: string[];
  /**
   * The tool's execute steps, which fire toolactivated by calling activate() once. Throwing before
   * that fails the call without toolactivated.
   */
  run(input: object, signal: AbortSignal, activate: () => void): unknown;
  /** Converts run()'s return value or promise fulfillment to the browser-facing response. */
  serialize(result: unknown): string | null;
  /** Names the tool execution error for run()'s exception or promise rejection. */
  failure(reason: unknown): ExecutionFailure;
}

export const toolNamePattern = /^[A-Za-z0-9_.-]{1,128}$/u;

// Detached windows may stop exposing this binding.
export const NativeDOMException = globalThis.DOMException;

export function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

// The first four names are the draft's tool execution errors:
// https://webmachinelearning.github.io/webmcp/#tool-execution-error
// InvalidStateError and NotAllowedError come from other executeTool() steps. Protocol failures
// without a draft counterpart, such as a malformed reply, are reported as OperationError.
// The messages are Chromium's: https://crrev.com/c/8546218
const executionFailures = {
  NotFoundError: "The requested tool was not found or is not accessible.",
  DataError: "Failed to parse tool input arguments.",
  OperationError: "Tool execution failed.",
  AbortError: "Tool execution aborted.",
  InvalidStateError: "Target frame is not accessible.",
  NotAllowedError: 'Access to the feature "tools" is disallowed by permissions policy.',
} as const;

export type ExecutionFailure = keyof typeof executionFailures;

export function executionError(name: ExecutionFailure): DOMException {
  // Each name has one fixed message, so a message reveals nothing beyond its name.
  return new NativeDOMException(executionFailures[name], name);
}

export function isExecutionError(
  error: unknown,
): error is DOMException & { name: ExecutionFailure } {
  return error instanceof NativeDOMException && Object.hasOwn(executionFailures, error.name);
}

// Another frame's reply is untrusted input.
export function readExecutionFailure(value: unknown): ExecutionFailure {
  if (typeof value === "string" && Object.hasOwn(executionFailures, value)) {
    // SAFETY: the own-property check above limits the string to the table's names.
    return value as ExecutionFailure;
  }
  return "OperationError";
}

// Installation replaces a page's configurable property, but must not fail halfway through.
export function canDefine(target: object, name: string): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(target, name);
  return descriptor ? descriptor.configurable === true : Object.isExtensible(target);
}

// Message tasks approximate the WebMCP task source. Chained zero-delay timers are clamped to
// 4 ms, and one port keeps the tasks in order. Created on first use so an import stays inert.
let taskPort: MessagePort | undefined;
const queuedTasks: (() => void)[] = [];

export function queueTask(callback: () => void): void {
  if (!taskPort) {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => queuedTasks.shift()?.();
    taskPort = channel.port2;
  }
  queuedTasks.push(callback);
  taskPort.postMessage(undefined);
}
