/*!
 * Copyright (c) 2026 World Wide Web Consortium
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WebMCP } from "webmcp-types";
import { activeWindow } from "./frames.js";

/** One registration found by getTools(), and the document that registered it. */
export interface ToolSnapshot {
  /** The registration's tool id. Script never sees it. */
  id: string;
  /** Identifies the registering document, so a navigated window is not mistaken for it. */
  documentId: string;
  name: string;
  title: string;
  description: string;
  inputSchema: object | null;
  outputSchema: object | null;
  annotations: WebMCP.ToolAnnotations | null;
  /** The serialized origin of the registering document. */
  origin: string;
  source: Window;
  /** The registering document, when this document can read it; cross-origin ones cannot be read. */
  sourceDocument: Document | undefined;
}

/** A reference that WeakRef satisfies; see referToSource() for when it is strong instead. */
interface SourceReference {
  deref(): Window | undefined;
}

/** A Tool's associated members. The source document is a weak reference. */
export interface ToolState extends Omit<ToolSnapshot, "source" | "sourceDocument"> {
  source: SourceReference;
  sourceDocument: WeakRef<Document> | undefined;
}

// A registered symbol, so the polyfills of other realms in this agent use the same key. Only
// same-origin script can pass this realm an object, and the tool's owner still checks the
// registration, its exposure and its document, so a forged object grants nothing.
const foreignStateKey: unique symbol = Symbol.for("webmcp-polyfill.tool-state");

/**
 * A tool that has been registered and exposed to a document for execution.
 *
 * @see https://webmachinelearning.github.io/webmcp/#tool-interface
 */
class ToolPolyfill implements WebMCP.Tool {
  readonly #state: ToolState;

  constructor(state: ToolState) {
    this.#state = state;
  }

  get name(): string {
    return this.#state.name;
  }

  get title(): string {
    return this.#state.title;
  }

  get description(): string {
    return this.#state.description;
  }

  get inputSchema(): object | null {
    return this.#state.inputSchema;
  }

  get outputSchema(): object | null {
    return this.#state.outputSchema;
  }

  get source(): WindowProxy | null {
    return activeSource(this.#state) ?? null;
  }

  get origin(): string {
    return this.#state.origin;
  }

  get annotations(): WebMCP.ToolAnnotations | null {
    return this.#state.annotations;
  }

  // The polyfill in another realm reads a genuine Tool's members here. The getter lives on the
  // prototype, so a spread copy of a Tool does not carry it.
  get [foreignStateKey](): ToolState {
    return this.#state;
  }

  static stateOf(value: object): ToolState | undefined {
    return #state in value ? value.#state : undefined;
  }
}

/** Creates a Tool in this realm. Each call creates a new object, even for the same registration. */
export function createTool(snapshot: ToolSnapshot): WebMCP.Tool {
  const { source, sourceDocument, ...members } = snapshot;
  // Script can reach this record through the cross-realm getter, so it must not change what the
  // read-only attributes return or which registration executes. The schemas and annotations stay
  // mutable: the draft returns the same object from each read.
  const state: ToolState = Object.freeze({
    ...members,
    source: referToSource(source),
    sourceDocument: sourceDocument && new WeakRef(sourceDocument),
  });
  return new ToolPolyfill(state);
}

// https://webidl.spec.whatwg.org/#es-interface
// A Tool created in any realm converts, as Web IDL allows; anything else is a TypeError.
export function readToolState(value: unknown): ToolState {
  const isObject = (typeof value === "object" && value !== null) || typeof value === "function";
  if (!isObject) {
    throw notToolError();
  }
  const localState = ToolPolyfill.stateOf(value);
  if (localState) {
    return localState;
  }

  // Each realm loads its own polyfill, so its Tools carry another class's private brand.
  let foreignState: unknown;
  try {
    foreignState = Reflect.get(value, foreignStateKey);
  } catch {
    // This realm's getter throws for an object without its brand, such as Object.create(Tool.prototype).
    throw notToolError();
  }
  if (!isToolState(foreignState)) {
    throw notToolError();
  }
  return foreignState;
}

/**
 * The registering document's window, or undefined if that document is gone or no longer active.
 *
 * Only a document this one can read is checked. For a cross-origin one, the window is returned
 * until it closes, even after it navigates.
 */
export function activeSource(state: ToolState): Window | undefined {
  const view = state.source.deref();
  if (!view || view.closed) {
    return undefined;
  }
  if (!state.sourceDocument) {
    return view;
  }
  const sourceDocument = state.sourceDocument.deref();
  return sourceDocument && activeWindow(sourceDocument) === view ? view : undefined;
}

// Web IDL exposes a non-constructible interface with enumerable prototype attributes.
export const toolConstructor = function Tool(): never {
  throw new TypeError("Illegal constructor");
};
// Preserve the public name through minification.
Object.defineProperty(toolConstructor, "name", { value: "Tool" });
Object.defineProperty(toolConstructor, "prototype", {
  value: ToolPolyfill.prototype,
  writable: false,
});
Object.defineProperties(ToolPolyfill.prototype, {
  constructor: { value: toolConstructor, configurable: true, writable: true },
  [Symbol.toStringTag]: { value: "Tool", configurable: true },
  name: { enumerable: true },
  title: { enumerable: true },
  description: { enumerable: true },
  inputSchema: { enumerable: true },
  outputSchema: { enumerable: true },
  source: { enumerable: true },
  origin: { enumerable: true },
  annotations: { enumerable: true },
});

// The draft holds the source weakly. Firefox refuses a WeakRef to a cross-origin WindowProxy
// ("Permission denied to access object"), so that one is held strongly. A WindowProxy follows its
// browsing context's active Window, so it does not keep a navigated-away document alive.
function referToSource(source: Window): SourceReference {
  try {
    return new WeakRef(source);
  } catch {
    return Object.freeze({ deref: () => source });
  }
}

function notToolError(): TypeError {
  return new TypeError("parameter 1 is not of type 'Tool'.");
}

// Another realm's getter can be replaced by its page, so check what this realm relies on.
function isToolState(value: unknown): value is ToolState {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const state: Partial<Record<keyof ToolState, unknown>> = value;
  const isWeakRef = (reference: unknown): boolean =>
    typeof reference === "object" &&
    reference !== null &&
    typeof Reflect.get(reference, "deref") === "function";
  return (
    typeof state.id === "string" &&
    typeof state.documentId === "string" &&
    typeof state.origin === "string" &&
    isWeakRef(state.source) &&
    (state.sourceDocument === undefined || isWeakRef(state.sourceDocument))
  );
}
