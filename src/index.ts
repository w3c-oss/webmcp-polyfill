/*!
 * Copyright (c) 2026 World Wide Web Consortium
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WebMCP } from "webmcp-types";
import { ToolActivatedEvent, ToolCancelEvent } from "./events.js";
import {
  FrameBridge,
  activeWindow,
  annotationNames,
  executionError,
  readAncestorToolsPolicy,
  readToolsPolicy,
  type ExecutionFailure,
  type ToolMetadata,
} from "./frames.js";
import { activeSource, createTool, readToolState, toolConstructor } from "./tool.js";
export type { WebMCP } from "webmcp-types";

// Detached windows may stop exposing these bindings.
const NativeDOMException = globalThis.DOMException;
// Author changes to Promise must not reach Web IDL promise conversion or reactions.
const NativePromise = Promise;
const promiseThen = Promise.prototype.then;
const defineProperty = Object.defineProperty;

interface StoredTool {
  metadata: ToolMetadata;
  execute: WebMCP.ToolExecuteCallback<object>;
  exposedTo: string[];
}

const contexts = new WeakMap<Document, ModelContextPolyfill>();

/**
 * Install WebMCP in the current window.
 *
 * Does nothing outside a secure browser context or when `document.modelContext`
 * already exists, including partial native implementations. Call before registering
 * tools in each frame; repeated calls preserve existing contexts and registrations.
 *
 * Installing joins cross-frame discovery: the window listens for the polyfill's messages and
 * announces itself to the other frames of its tree.
 *
 * @throws {TypeError} If the window or Document prototype prevents installation.
 * @example
 * import { installWebMCP } from "@w3c/webmcp-polyfill";
 * installWebMCP();
 *
 * @see https://webmachinelearning.github.io/webmcp/#document-extension
 * @see https://github.com/w3c-oss/webmcp-polyfill/blob/main/TESTING.md
 */
export function installWebMCP(): void {
  if (typeof document === "undefined" || !globalThis.isSecureContext) {
    return;
  }
  if ("modelContext" in document) {
    return;
  }

  const documentPrototype = Document.prototype;
  const getDefaultView = Object.getOwnPropertyDescriptor(documentPrototype, "defaultView")!.get!;
  const interfaceObjects = {
    ModelContext: modelContextConstructor,
    Tool: toolConstructor,
    ToolActivatedEvent,
    ToolCancelEvent,
  };
  const canDefineInterface = (name: string): boolean => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    return descriptor ? descriptor.configurable === true : Object.isExtensible(globalThis);
  };
  if (
    !Object.isExtensible(documentPrototype) ||
    !Object.keys(interfaceObjects).every(canDefineInterface)
  ) {
    throw new TypeError("Cannot install WebMCP on this realm");
  }

  for (const [name, value] of Object.entries(interfaceObjects)) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }

  // A method is non-constructible; defaultView supplies the native Document brand check.
  const { getModelContext } = {
    getModelContext(this: Document): WebMCP.ModelContext {
      getDefaultView.call(this);
      let context = contexts.get(this);
      if (!context) {
        context = new ModelContextPolyfill(this);
        contexts.set(this, context);
      }
      return context;
    },
  };
  Object.defineProperty(getModelContext, "name", { value: "get modelContext" });
  Object.defineProperty(documentPrototype, "modelContext", {
    configurable: true,
    enumerable: true,
    get: getModelContext,
  });
  // Frames must answer discovery even before their first local API call.
  void document.modelContext;
}

class ModelContextPolyfill extends EventTarget implements WebMCP.ModelContext {
  readonly #document: Document;
  readonly #tools = new Map<string, StoredTool>();
  // Only a document that was active when its context was created has a bridge.
  readonly #frames?: FrameBridge;
  readonly #eventHandlers: EventHandlers = {
    ontoolchange: null,
    ontoolactivated: null,
    ontoolcancel: null,
  };
  // One listener serves every handler, so replacing a handler keeps its listener position.
  readonly #eventHandlerListener = (event: Event): void => {
    const name = eventHandlerName(event.type);
    const handler: unknown = name ? this.#eventHandlers[name] : null;
    // An EventHandler keeps a non-callable object but never invokes it.
    if (typeof handler !== "function") {
      return;
    }
    const result: unknown = Reflect.apply(handler, this, [event]);
    if (result === false) {
      Event.prototype.preventDefault.call(event);
    }
  };

  constructor(owner: Document) {
    super();
    this.#document = owner;
    const view = activeWindow(owner);
    if (!view) {
      return;
    }
    this.#frames = new FrameBridge(view, {
      getTools: (callerOrigin) => this.#exposedTools(callerOrigin),
      execute: (callerOrigin, toolId, serializedInput, signal) => {
        // An owner that unloaded or lost the tools permission rejects before any lookup.
        requireActiveWindow(owner);
        return this.#executeLocal(toolId, serializedInput, callerOrigin, signal);
      },
      changed: () => this.#queueToolChange(),
    });
  }

  get ontoolchange(): WebMCP.ModelContext["ontoolchange"] {
    return this.#eventHandlers.ontoolchange;
  }

  set ontoolchange(handler: WebMCP.ModelContext["ontoolchange"]) {
    this.#setEventHandler("ontoolchange", handler);
  }

  get ontoolactivated(): WebMCP.ModelContext["ontoolactivated"] {
    return this.#eventHandlers.ontoolactivated;
  }

  set ontoolactivated(handler: WebMCP.ModelContext["ontoolactivated"]) {
    this.#setEventHandler("ontoolactivated", handler);
  }

  get ontoolcancel(): WebMCP.ModelContext["ontoolcancel"] {
    return this.#eventHandlers.ontoolcancel;
  }

  set ontoolcancel(handler: WebMCP.ModelContext["ontoolcancel"]) {
    this.#setEventHandler("ontoolcancel", handler);
  }

  // Default parameters preserve Web IDL's required-argument counts in function.length.
  // Each operation reads #document first, so an invalid receiver throws before arguments are read.
  async registerTool(
    tool: object,
    options: WebMCP.ModelContextRegisterToolOptions = {},
  ): Promise<void> {
    const ownerDocument = this.#document;
    const { name, title, description, annotations, inputSchema, outputSchema, execute } =
      readToolDefinition(tool);
    const settings = readDictionary(options);
    const exposedTo = readOriginSequence(settings.exposedTo);
    const registrationSignal = readAbortSignal(settings.signal);

    requireActiveWindow(ownerDocument);
    const requireUnusedName = (): void => {
      for (const storedTool of this.#tools.values()) {
        if (storedTool.metadata.name === name) {
          throw new NativeDOMException(
            `A tool named ${name} is already registered`,
            "InvalidStateError",
          );
        }
      }
    };

    // Duplicate, then name, then description, then the schemas: the draft's order.
    requireUnusedName();
    if (!/^[A-Za-z0-9_.-]{1,128}$/u.test(name)) {
      throw new NativeDOMException(
        `Tool names are 1 to 128 characters of ASCII alphanumerics, "_", "-" or ".": ${name}`,
        "InvalidStateError",
      );
    }
    if (!description) {
      throw new NativeDOMException("A tool description cannot be empty", "InvalidStateError");
    }
    // inputSchema is serialized before outputSchema. Either failure rejects before the signal.
    const serializedSchema = inputSchema === undefined ? undefined : serializeJSON(inputSchema);
    const serializedOutputSchema =
      outputSchema === undefined ? undefined : serializeJSON(outputSchema);
    registrationSignal?.throwIfAborted();
    const exposedOrigins = parseOrigins(exposedTo);

    const toolId = crypto.randomUUID();
    const storedTool: StoredTool = {
      metadata: {
        id: toolId,
        name,
        title,
        description,
        annotations,
        serializedSchema,
        serializedOutputSchema,
      },
      execute,
      exposedTo: exposedOrigins,
    };

    const frames = await this.#requireFrames();
    registrationSignal?.throwIfAborted();
    // Another registration can complete while frame permissions are being checked.
    requireUnusedName();

    return new Promise<void>((resolve, reject) => {
      // Abort unregisters this registration, never a later one with the same name, and also
      // rejects the registration if it is still pending.
      registrationSignal?.addEventListener(
        "abort",
        () => {
          this.#tools.delete(toolId);
          void frames.notify(exposedOrigins);
          reject(registrationSignal.reason);
        },
        { once: true },
      );

      this.#tools.set(toolId, storedTool);
      frames.notify(exposedOrigins).then(resolve, reject);
    });
  }

  // The draft's tools ready state is read only by browser agent observations, which have no
  // counterpart here, so the polyfill keeps none. The observable effects remain: argument
  // conversion, the thrown errors, and reacting to the promise, which marks it as handled.
  waitForToolsUntil(promise: unknown): void {
    const ownerDocument = this.#document;
    // Every value converts to Promise<any>, so only a missing argument fails conversion.
    if (arguments.length < 1) {
      throw new TypeError("waitForToolsUntil() requires a promise");
    }
    const readinessPromise = toPromise(promise);

    requireActiveWindow(ownerDocument);
    // A cross-origin ancestor answers only by message, which a synchronous method cannot await.
    if (readAncestorToolsPolicy(ownerDocument) === false) {
      throw new NativeDOMException(
        'Access to the feature "tools" is disallowed by permissions policy.',
        "NotAllowedError",
      );
    }

    reactToPromise(readinessPromise, () => {});
  }

  async getTools(options: WebMCP.ModelContextGetToolOptions = {}): Promise<WebMCP.Tool[]> {
    const ownerDocument = this.#document;
    const settings = readDictionary(options);
    const fromOrigins = readOriginSequence(settings.fromOrigins);

    requireActiveWindow(ownerDocument);
    const frames = await this.#requireFrames();
    const requestedOrigins = parseOrigins(fromOrigins);

    const snapshots = await frames.getTools(requestedOrigins);

    // Compare code units; localeCompare() would change the draft's sort order.
    snapshots.sort((left, right) => {
      if (left.name === right.name) {
        return 0;
      }
      return left.name < right.name ? -1 : 1;
    });

    // The draft creates the Tool objects and resolves from a queued task.
    return new Promise((resolve) => {
      queueTask(() => resolve(snapshots.map(createTool)));
    });
  }

  async executeTool(
    tool: WebMCP.Tool,
    inputObject: object = {},
    options: WebMCP.ModelContextExecuteToolOptions = {},
  ): Promise<string> {
    const ownerDocument = this.#document;
    const target = readToolState(tool);
    const settings = readDictionary(options);
    const callerSignal = readAbortSignal(settings.signal);

    requireActiveWindow(ownerDocument);
    // A Tool's origin is the serialization of its registering document's; an opaque one is "null".
    if (target.origin === "null") {
      throw new NativeDOMException(
        "Tools registered by documents with an opaque origin cannot be executed",
        "NotSupportedError",
      );
    }
    if (!isObject(inputObject)) {
      throw new TypeError("inputObject must be an object");
    }

    const serializedInput = serializeJSON(inputObject);
    const targetWindow = activeSource(target);
    if (!targetWindow) {
      throw executionError("InvalidStateError");
    }
    callerSignal?.throwIfAborted();
    const frames = await this.#requireFrames();
    callerSignal?.throwIfAborted();
    const callerWindow = requireActiveWindow(ownerDocument);
    if (targetWindow !== callerWindow) {
      return frames.execute(
        targetWindow,
        target.origin,
        target.documentId,
        target.id,
        serializedInput,
        callerSignal,
      );
    }

    return this.#executeLocal(target.id, serializedInput, callerWindow.origin, callerSignal);
  }

  #executeLocal(
    toolId: string,
    serializedInput: string,
    callerOrigin: string,
    callerSignal?: AbortSignal,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      callerSignal?.throwIfAborted();
      const callbackController = new AbortController();
      // The draft's local pending tool execution: it exists from invocation until the callback
      // settles or the call is cancelled, and a late cancellation must not abort or report it.
      let callbackPending = false;
      // Known once the tool is found; a cancellation before then dispatches no event.
      let toolName = "";

      const onCallerAbort = (): void => {
        reject(callerSignal!.reason);

        // Reject the caller first; the running callback receives a default AbortError.
        queueTask(() => {
          if (!callbackPending) {
            return;
          }
          callbackPending = false;
          callbackController.abort();
          this.dispatchEvent(new ToolCancelEvent("toolcancel", { toolName }));
        });
      };

      const rejectExecution = (failure: ExecutionFailure): void => {
        callbackPending = false;
        queueTask(() => {
          callerSignal?.removeEventListener("abort", onCallerAbort);
          reject(executionError(failure));
        });
      };

      const completeExecution = (value: unknown): void => {
        callbackPending = false;
        // A cancelled call must not run the author's toJSON during serialization.
        if (callerSignal?.aborted) {
          return;
        }

        try {
          const serializedResult = serializeJSON(value);
          queueTask(() => {
            callerSignal?.removeEventListener("abort", onCallerAbort);
            resolve(serializedResult);
          });
        } catch {
          rejectExecution("OperationError");
        }
      };
      const rejectCallback = (): void => rejectExecution("OperationError");

      const dispatchTool = (): void => {
        if (callerSignal?.aborted) {
          return;
        }

        // executeTool() and #respond() checked Permissions Policy, which cannot change while the
        // document lives, so only an unloaded document remains to reject here.
        const ownerWindow = activeWindow(this.#document);
        if (!ownerWindow) {
          rejectExecution("AbortError");
          return;
        }
        // The registration may have been removed since getTools(), even if another tool now has
        // its name. The same failure for an unexposed tool keeps it from being probed.
        const storedTool = this.#tools.get(toolId);
        if (!storedTool || !isExposedTo(storedTool, ownerWindow.origin, callerOrigin)) {
          rejectExecution("NotFoundError");
          return;
        }
        toolName = storedTool.metadata.name;

        let input: unknown;
        try {
          input = JSON.parse(serializedInput);
        } catch {
          rejectExecution("DataError");
          return;
        }
        if (!isObject(input)) {
          rejectExecution("DataError");
          return;
        }

        callbackPending = true;
        // A Promise-returning callback that throws is treated as a rejection.
        try {
          // The callback runs without the registration object as its receiver.
          const execute = storedTool.execute;
          const callbackResult = execute(input, { signal: callbackController.signal });
          Promise.resolve(callbackResult).then(completeExecution, rejectCallback);
        } catch {
          rejectCallback();
        }

        // The draft fires toolactivated after invoking the callback, so listeners observe its
        // synchronous effects. If the callback detached this document, DOM's inner invoke skips
        // every listener because the context's relevant global is no longer fully active.
        // Listener exceptions are reported, not thrown.
        this.dispatchEvent(new ToolActivatedEvent("toolactivated", { toolName }));
      };

      callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
      queueTask(dispatchTool);
    });
  }

  async #requireFrames(): Promise<FrameBridge> {
    const frames = this.#frames;
    if (!frames || !(await frames.allowed())) {
      throw new NativeDOMException(
        'Access to the feature "tools" is disallowed by permissions policy.',
        "NotAllowedError",
      );
    }
    requireActiveWindow(this.#document);
    return frames;
  }

  #exposedTools(callerOrigin: string): ToolMetadata[] {
    const ownerOrigin = requireActiveWindow(this.#document).origin;
    const exposed = [];
    for (const storedTool of this.#tools.values()) {
      if (!isExposedTo(storedTool, ownerOrigin, callerOrigin)) {
        continue;
      }
      exposed.push(storedTool.metadata);
    }
    return exposed;
  }

  #queueToolChange(): Promise<void> {
    return new Promise((resolve) => {
      queueTask(() => {
        this.dispatchEvent(new Event("toolchange"));
        resolve();
      });
    });
  }

  #setEventHandler<Name extends EventHandlerName>(name: Name, handler: EventHandlers[Name]): void {
    const type = name.slice("on".length);
    const previousHandler = this.#eventHandlers[name];
    // [LegacyTreatNonObjectAsNull]: only a non-object becomes null.
    const nextHandler = isObject(handler) ? handler : null;
    // Replacing a handler preserves its listener position; clearing it removes that position.
    if (!previousHandler && nextHandler) {
      this.addEventListener(type, this.#eventHandlerListener);
    }
    if (previousHandler && !nextHandler) {
      this.removeEventListener(type, this.#eventHandlerListener);
    }
    this.#eventHandlers[name] = nextHandler;
  }
}

const eventHandlerNames = ["ontoolchange", "ontoolactivated", "ontoolcancel"] as const;
type EventHandlerName = (typeof eventHandlerNames)[number];
type EventHandlers = Pick<WebMCP.ModelContext, EventHandlerName>;

function eventHandlerName(type: string): EventHandlerName | undefined {
  return eventHandlerNames.find((name) => name === `on${type}`);
}

function isExposedTo(tool: StoredTool, ownerOrigin: string, callerOrigin: string): boolean {
  return ownerOrigin === callerOrigin || tool.exposedTo.includes(callerOrigin);
}

// Web IDL exposes a non-constructible interface with enumerable prototype members.
const modelContextConstructor = function ModelContext(): never {
  throw new TypeError("Illegal constructor");
};
// Preserve the public name through minification.
Object.defineProperty(modelContextConstructor, "name", { value: "ModelContext" });
Object.defineProperty(modelContextConstructor, "prototype", {
  value: ModelContextPolyfill.prototype,
  writable: false,
});
Object.setPrototypeOf(modelContextConstructor, EventTarget);
Object.defineProperties(ModelContextPolyfill.prototype, {
  constructor: { value: modelContextConstructor, configurable: true, writable: true },
  [Symbol.toStringTag]: { value: "ModelContext", configurable: true },
  registerTool: { enumerable: true },
  waitForToolsUntil: { enumerable: true },
  getTools: { enumerable: true },
  executeTool: { enumerable: true },
  ontoolchange: { enumerable: true },
  ontoolactivated: { enumerable: true },
  ontoolcancel: { enumerable: true },
});

// Web IDL reads and converts dictionary members in lexicographical order.
function readToolDefinition(value: unknown) {
  const descriptor = readDictionary(value);
  const annotations = readAnnotations(descriptor.annotations);
  const description = toDOMString(requireMember(descriptor.description, "description"));
  const callback = requireMember(descriptor.execute, "execute");
  if (typeof callback !== "function") {
    throw new TypeError("execute must be a function");
  }
  // SAFETY: callability is checked above; inputs and results are converted at invocation.
  const execute = callback as WebMCP.ToolExecuteCallback<object>;
  const inputSchema = readSchema(descriptor.inputSchema, "inputSchema");
  const name = toDOMString(requireMember(descriptor.name, "name"));
  const outputSchema = readSchema(descriptor.outputSchema, "outputSchema");
  const rawTitle = descriptor.title;
  const title = rawTitle === undefined ? "" : toUSVString(rawTitle);

  return { name, title, description, annotations, inputSchema, outputSchema, execute };
}

function readSchema(value: unknown, member: "inputSchema" | "outputSchema"): object | undefined {
  if (value !== undefined && !isObject(value)) {
    throw new TypeError(`${member} must be an object`);
  }
  return value;
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

// https://webidl.spec.whatwg.org/#es-dictionary
function readDictionary(value: unknown): Record<PropertyKey, unknown> {
  if (value == null) {
    return {};
  }
  if (!isObject(value)) {
    throw new TypeError("Expected a dictionary");
  }
  // SAFETY: the object check permits property reads; each member still needs conversion.
  return value as Record<PropertyKey, unknown>;
}

function readAnnotations(value: unknown): WebMCP.ToolAnnotations | undefined {
  if (value === undefined) {
    return undefined;
  }
  const dictionary = readDictionary(value);
  const annotations: WebMCP.ToolAnnotations = {};
  for (const name of annotationNames) {
    annotations[name] = Boolean(dictionary[name]);
  }
  return annotations;
}

// https://webidl.spec.whatwg.org/#es-DOMString
function toDOMString(value: unknown): string {
  if (typeof value === "symbol") {
    throw new TypeError("Cannot convert a Symbol to a string");
  }
  return String(value);
}

// https://webidl.spec.whatwg.org/#es-USVString
function toUSVString(value: unknown): string {
  return toDOMString(value).toWellFormed();
}

function requireMember(value: unknown, name: string): unknown {
  if (value === undefined) {
    throw new TypeError(`${name} is required`);
  }
  return value;
}

function serializeJSON(value: unknown): string {
  const result = JSON.stringify(value);
  if (result === undefined) {
    throw new TypeError("Value is not JSON-serializable");
  }
  return result;
}

function readAbortSignal(value: unknown): AbortSignal | undefined {
  if (value === undefined) {
    return undefined;
  }
  // SAFETY: any() validates the native brand across realms before we use the signal.
  // Composition also survives stopImmediatePropagation() on the original signal.
  return AbortSignal.any([value as AbortSignal]);
}

// https://webidl.spec.whatwg.org/#js-promise
// Resolving a new promise reads only a thenable's then, as Web IDL's conversion does;
// Promise.resolve() would also read a native promise's constructor. The promise stays private,
// so its own undefined constructor makes then() use %Promise% without a species lookup, like
// PerformPromiseThen.
function toPromise(value: unknown): Promise<unknown> {
  const promise = new NativePromise((resolve) => resolve(value));
  defineProperty(promise, "constructor", { value: undefined });
  return promise;
}

// https://webidl.spec.whatwg.org/#dfn-perform-steps-once-promise-is-settled
// Reacting marks the promise as handled, so a rejection is not reported as unhandled.
function reactToPromise(promise: Promise<unknown>, onSettled: () => void): void {
  Reflect.apply(promiseThen, promise, [onSettled, onSettled]);
}

// https://webidl.spec.whatwg.org/#es-sequence
function readOriginSequence(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (!isObject(value)) {
    throw new TypeError("Origins must be a sequence");
  }
  const getIterator = readDictionary(value)[Symbol.iterator];
  if (typeof getIterator !== "function") {
    throw new TypeError("Origins must be a sequence");
  }
  // Use the cached method and original receiver without reading the method's own properties.
  const iterable = {
    [Symbol.iterator]() {
      const iterator: unknown = Reflect.apply(getIterator, value, []);
      if (!isObject(iterator)) {
        throw new TypeError("Iterator must be an object");
      }
      const next = readDictionary(iterator).next;
      if (typeof next !== "function") {
        throw new TypeError("Iterator next must be a function");
      }
      // Web IDL does not close the iterator when an item's conversion fails.
      return {
        next() {
          return Reflect.apply(next, iterator, []);
        },
      };
    },
  };
  return Array.from(iterable, toUSVString);
}

function parseOrigins(origins: string[]): string[] {
  return origins.map((value) => {
    // A blob: URL carries its creator's origin.
    const origin = URL.parse(value)?.origin;
    if (origin === undefined) {
      throw new NativeDOMException("Invalid origin", "SecurityError");
    }
    // An opaque origin, such as a file: URL's, serializes as "null" and does not parse.
    const url = URL.parse(origin);
    if (!url || !isPotentiallyTrustworthy(url)) {
      throw new NativeDOMException("Origin is not potentially trustworthy", "SecurityError");
    }
    return origin;
  });
}

// https://w3c.github.io/webappsec-secure-contexts/#is-origin-trustworthy
// Scheme and host checks cannot recognize browser-specific trusted origins.
function isPotentiallyTrustworthy({ protocol, hostname }: URL): boolean {
  if (["https:", "wss:"].includes(protocol)) {
    return true;
  }
  const isLoopback =
    hostname === "[::1]" ||
    // URL canonicalizes numeric hosts; exclude domains such as 127.example.test.
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
  const isLocalhost =
    hostname === "localhost" ||
    hostname === "localhost." ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".localhost.");
  return ["http:", "ws:"].includes(protocol) && (isLoopback || isLocalhost);
}

function requireActiveWindow(owner: Document): Window {
  const view = activeWindow(owner);
  if (!view) {
    throw new NativeDOMException("The document is not active.", "InvalidStateError");
  }

  // Synchronous where the browser exposes the policy. waitForToolsUntil() also reads same-origin
  // ancestors, and FrameBridge.allowed() covers the rest for the asynchronous operations.
  if (readToolsPolicy(owner) === false) {
    throw new NativeDOMException(
      'Access to the feature "tools" is disallowed by permissions policy.',
      "NotAllowedError",
    );
  }
  return view;
}

// Message tasks approximate the WebMCP task source. Chained zero-delay timers are clamped to
// 4 ms, and one port keeps the tasks in order. Created on first use so an import stays inert.
let taskPort: MessagePort | undefined;
const queuedTasks: (() => void)[] = [];

function queueTask(callback: () => void): void {
  if (!taskPort) {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => queuedTasks.shift()?.();
    taskPort = channel.port2;
  }
  queuedTasks.push(callback);
  taskPort.postMessage(undefined);
}
