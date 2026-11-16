import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  expect(await page.evaluate(() => "modelContext" in document)).toBe(false);
});

test("operations reject invalid receivers before reading arguments", async ({ page }) => {
  await page.addScriptTag({ url: "/auto.js" });
  const outcome = await page.evaluate(async () => {
    const context = document.modelContext!;
    let reads = 0;
    const argument = {
      get annotations() {
        reads++;
        throw new Error("Read annotations before checking the receiver");
      },
      get fromOrigins() {
        reads++;
        throw new Error("Read fromOrigins before checking the receiver");
      },
    };
    const errors = [];
    const receivers = [{}, Object.create(Object.getPrototypeOf(context)), null, undefined];
    for (const method of [context.registerTool, context.getTools, context.executeTool]) {
      for (const receiver of receivers) {
        try {
          await Reflect.apply(method, receiver, [argument, {}]);
          errors.push("resolved");
        } catch (error) {
          if (!(error instanceof Error)) {
            throw error;
          }
          errors.push(error.name);
        }
      }
    }
    return { reads, errors };
  });

  expect(outcome).toEqual({ reads: 0, errors: Array(12).fill("TypeError") });
});

test("origin filters accept only potentially trustworthy origins", async ({ page }) => {
  await page.addScriptTag({ url: "/auto.js" });
  const outcome = await page.evaluate(async () => {
    const context = document.modelContext!;
    const results: [string, string][] = [];
    for (const origin of [
      "https://example.test",
      "blob:https://example.test/id",
      "blob:http://localhost:8793/id",
      "wss://example.test",
      "file:///tmp",
      "http://127.0.0.1:8793",
      "http://[::1]:8793",
      "http://localhost:8793",
      "http://localhost.:8793",
      "http://app.localhost:8793",
      "ws://localhost:8793",
      "http://example.test",
      "blob:http://example.test/id",
      "ws://example.test",
      "ftp://localhost",
      "http://127.example.test",
      "not a url",
    ]) {
      try {
        await context.getTools({ fromOrigins: [origin] });
        results.push([origin, "resolved"]);
      } catch (error) {
        if (!(error instanceof Error)) {
          throw error;
        }
        results.push([origin, error.name]);
      }
    }
    return results;
  });

  expect(outcome).toEqual([
    ["https://example.test", "resolved"],
    ["blob:https://example.test/id", "resolved"],
    ["blob:http://localhost:8793/id", "resolved"],
    ["wss://example.test", "resolved"],
    ["file:///tmp", "SecurityError"],
    ["http://127.0.0.1:8793", "resolved"],
    ["http://[::1]:8793", "resolved"],
    ["http://localhost:8793", "resolved"],
    ["http://localhost.:8793", "resolved"],
    ["http://app.localhost:8793", "resolved"],
    ["ws://localhost:8793", "resolved"],
    ["http://example.test", "SecurityError"],
    ["blob:http://example.test/id", "SecurityError"],
    ["ws://example.test", "SecurityError"],
    ["ftp://localhost", "SecurityError"],
    ["http://127.example.test", "SecurityError"],
    ["not a url", "SecurityError"],
  ]);
});

test("a cross-origin frame is denied without tools permission", async ({ page }) => {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const iframe = document.createElement("iframe");
        iframe.src = "http://127.0.0.1:8793/";
        iframe.onload = () => resolve();
        document.body.append(iframe);
      }),
  );
  const frame = page.frames().find((candidate) => candidate.url() === "http://127.0.0.1:8793/");
  expect(frame, "the cross-origin child frame must be attached").toBeTruthy();
  await frame!.addScriptTag({ url: "http://127.0.0.1:8793/auto.js" });
  const outcome = await frame!.evaluate(async () => {
    try {
      await document.modelContext!.getTools();
      return "resolved";
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
      return error.name;
    }
  });

  expect(outcome).toBe("NotAllowedError");
});

test("registration rejects a signal option that is not an AbortSignal", async ({ page }) => {
  await page.addScriptTag({ url: "/auto.js" });
  const outcome = await page.evaluate(async () => {
    const context = document.modelContext!;
    const results: [string, string][] = [];
    const tool = { name: "x", description: "X", execute: () => null };
    for (const signal of [1, {}, null, "abort"]) {
      const label = JSON.stringify(signal);
      try {
        // @ts-expect-error Exercise invalid JavaScript callers at the Web IDL boundary.
        await context.registerTool(tool, { signal });
        results.push([label, "resolved"]);
      } catch (error) {
        if (!(error instanceof Error)) {
          throw error;
        }
        results.push([label, error.name]);
      }
    }
    return results;
  });

  expect(outcome).toEqual([
    ["1", "TypeError"],
    ["{}", "TypeError"],
    ["null", "TypeError"],
    ['"abort"', "TypeError"],
  ]);
});

test("an already-aborted registration signal registers nothing and fires no toolchange", async ({
  page,
}) => {
  await page.addScriptTag({ url: "/auto.js" });
  const outcome = await page.evaluate(async () => {
    const context = document.modelContext!;
    let changes = 0;
    context.ontoolchange = () => changes++;
    let reason: unknown;
    try {
      await context.registerTool(
        { name: "x", description: "X", execute: () => null },
        { signal: AbortSignal.abort("already aborted") },
      );
    } catch (error) {
      reason = error;
    }
    // getTools() resolves from a queued task, so awaiting it drains any pending toolchange.
    const tools = await context.getTools();
    return { reason, count: tools.length, changes };
  });

  expect(outcome).toEqual({ reason: "already aborted", count: 0, changes: 0 });
});

test("registration converts every dictionary member in Web IDL order", async ({ page }) => {
  await page.addScriptTag({ url: "/auto.js" });
  const outcome = await page.evaluate(async () => {
    const reads: string[] = [];
    const record = <T>(name: string, value: T): T => {
      reads.push(name);
      return value;
    };
    await document.modelContext!.registerTool(
      {
        // @ts-expect-error Web IDL accepts undefined annotation members from JavaScript.
        get annotations() {
          return record("annotations", {
            get consequentialHint() {
              return record("consequentialHint", undefined);
            },
            get debugging() {
              return record("debugging", undefined);
            },
            get readOnlyHint() {
              return record("readOnlyHint", undefined);
            },
            get untrustedContentHint() {
              return record("untrustedContentHint", undefined);
            },
          });
        },
        get description() {
          return record("description", "D");
        },
        get execute() {
          return record("execute", () => null);
        },
        get inputSchema() {
          return record("inputSchema", undefined);
        },
        get name() {
          return record("name", "ordered");
        },
        get outputSchema() {
          return record("outputSchema", undefined);
        },
        get title() {
          return record("title", "Ordered");
        },
      },
      {
        get exposedTo() {
          return record("exposedTo", undefined);
        },
        get signal() {
          return record("signal", undefined);
        },
      },
    );
    return reads;
  });

  expect(outcome).toEqual([
    "annotations",
    "consequentialHint",
    "debugging",
    "readOnlyHint",
    "untrustedContentHint",
    "description",
    "execute",
    "inputSchema",
    "name",
    "outputSchema",
    "title",
    "exposedTo",
    "signal",
  ]);
});

test("origin conversion gets an iterator only once and preserves its receiver", async ({
  page,
}) => {
  await page.addScriptTag({ url: "/auto.js" });
  const outcome = await page.evaluate(async () => {
    const context = document.modelContext!;
    const results = [];
    for (const operation of ["registration", "discovery"]) {
      let reads = 0;
      let receiver = false;
      const origins = {
        get [Symbol.iterator]() {
          reads++;
          if (reads > 1) {
            throw new Error("Iterator getter was read twice");
          }
          const getIterator = function (this: typeof origins) {
            receiver = this === origins;
            return [][Symbol.iterator]();
          };
          // Invocation must not consult the method's call, apply, bind, name, or length.
          return new Proxy(getIterator, {
            get() {
              throw new Error("Iterator method properties must not be read");
            },
          });
        },
      };
      if (operation === "registration") {
        await context.registerTool(
          { name: "iterable", description: "Iterable origins", execute: () => null },
          // @ts-expect-error Web IDL accepts iterables; the published types use arrays.
          { exposedTo: origins },
        );
      } else {
        // @ts-expect-error Web IDL accepts iterables; the published types use arrays.
        await context.getTools({ fromOrigins: origins });
      }
      results.push({ operation, reads, receiver });
    }
    return results;
  });

  expect(outcome).toEqual([
    { operation: "registration", reads: 1, receiver: true },
    { operation: "discovery", reads: 1, receiver: true },
  ]);
});

test("failed origin conversion leaves the author's iterator open", async ({ page }) => {
  await page.addScriptTag({ url: "/auto.js" });
  const outcome = await page.evaluate(async () => {
    const context = document.modelContext!;
    const results = [];
    for (const operation of ["registration", "discovery"]) {
      let closed = false;
      function* origins() {
        try {
          yield Symbol("invalid origin");
          yield "https://example.test";
        } finally {
          closed = true;
        }
      }
      const iterator = origins();
      let errorName = "";
      try {
        if (operation === "registration") {
          await context.registerTool(
            { name: "iterable", description: "Iterable origins", execute: () => null },
            // @ts-expect-error Exercise an iterable with an invalid USVString item.
            { exposedTo: iterator },
          );
        } else {
          // @ts-expect-error Exercise an iterable with an invalid USVString item.
          await context.getTools({ fromOrigins: iterator });
        }
      } catch (error) {
        if (!(error instanceof Error)) {
          throw error;
        }
        errorName = error.name;
      }
      results.push({ operation, errorName, closed, next: iterator.next() });
      iterator.return();
    }
    return results;
  });

  expect(outcome).toEqual(
    ["registration", "discovery"].map((operation) => ({
      operation,
      errorName: "TypeError",
      closed: false,
      next: { value: "https://example.test", done: false },
    })),
  );
});

test("operations on a real detached frame reject in the frame's realm", async ({ page }) => {
  // The /app iframe installs the polyfill; this document deliberately does not.
  const frame = await page.evaluate(async () => {
    const iframe = document.createElement("iframe");
    iframe.src = "/app";
    const loaded = new Promise<void>((resolve) => {
      iframe.onload = () => resolve();
    });
    document.body.append(iframe);
    await loaded;
    const context = iframe.contentDocument!.modelContext!;
    const tool = (await context.getTools())[0]!;
    const FrameException = iframe.contentDocument!.defaultView!.DOMException;
    iframe.remove();
    const errors = [];
    for (const operation of [
      () => context.getTools(),
      () =>
        context.registerTool({ name: "detached", description: "Detached", execute: () => null }),
      () => context.executeTool(tool, {}),
    ]) {
      try {
        await operation();
        errors.push("resolved");
      } catch (error) {
        errors.push(error instanceof FrameException ? error.name : "wrong realm");
      }
    }
    return errors;
  });
  expect(frame).toEqual(["InvalidStateError", "InvalidStateError", "InvalidStateError"]);
});

test("installs once, exposes only standard members, and keeps document identity", async ({
  page,
}) => {
  await page.addScriptTag({ url: "/auto.js" });
  const initial = await page.evaluateHandle(() => document.modelContext);
  const result = await page.evaluate(() => {
    const context = document.modelContext!;
    const constructor = "ModelContext" in window ? window.ModelContext : undefined;
    if (typeof constructor !== "function") {
      throw new Error("ModelContext constructor is missing");
    }
    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, "modelContext")!;
    let constructionError = "";
    try {
      Reflect.construct(constructor, []);
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
      constructionError = error.name;
    }
    const getterErrors = [];
    for (const receiver of [{}, Object.create(Document.prototype), null, undefined, 1]) {
      try {
        descriptor.get!.call(receiver);
        getterErrors.push("resolved");
      } catch (error) {
        if (!(error instanceof Error)) {
          throw error;
        }
        getterErrors.push(error.name);
      }
    }
    return {
      same: context === document.modelContext,
      members: Object.keys(Object.getPrototypeOf(context)).sort(),
      own: Object.keys(context),
      brand: Object.prototype.toString.call(context),
      instance: context instanceof constructor && context instanceof EventTarget,
      constructorParent: Object.getPrototypeOf(constructor) === EventTarget,
      constructorName: constructor.name,
      writable: descriptor.set !== undefined,
      alias: "modelContext" in navigator,
      testing: "modelContextTesting" in navigator,
      lengths: [context.registerTool.length, context.getTools.length, context.executeTool.length],
      constructionError,
      getterErrors,
    };
  });
  expect(result).toEqual({
    same: true,
    members: [
      "executeTool",
      "getTools",
      "ontoolactivated",
      "ontoolcancel",
      "ontoolchange",
      "registerTool",
    ],
    own: [],
    brand: "[object ModelContext]",
    instance: true,
    constructorParent: true,
    constructorName: "ModelContext",
    writable: false,
    alias: false,
    testing: false,
    lengths: [1, 0, 1],
    constructionError: "TypeError",
    getterErrors: ["TypeError", "TypeError", "TypeError", "TypeError", "TypeError"],
  });
  const getter = await page.evaluateHandle(
    () => Object.getOwnPropertyDescriptor(Document.prototype, "modelContext")!.get,
  );
  await page.addScriptTag({ url: "/auto.js" });
  const outcome = await page.evaluate(
    ([previous, previousGetter]) => ({
      context: document.modelContext === previous,
      getter:
        Object.getOwnPropertyDescriptor(Document.prototype, "modelContext")!.get === previousGetter,
    }),
    [initial, getter] as const,
  );

  expect(outcome).toEqual({ context: true, getter: true });
});

test("snapshots registration metadata and returns sorted, independent copies", async ({ page }) => {
  await page.addScriptTag({ url: "/auto.js" });
  const result = await page.evaluate(async () => {
    const context = document.modelContext!;
    const schema = { type: "object", properties: { query: { type: "string" } } };
    const annotations = { consequentialHint: true, debugging: true };
    await context.registerTool({
      name: "z",
      description: "Z",
      inputSchema: schema,
      annotations,
      execute: () => null,
    });
    await context.registerTool({ name: "a", description: "A", execute: () => null });
    schema.properties.query.type = "number";
    annotations.consequentialHint = false;
    annotations.debugging = false;
    const tools = await context.getTools();
    const first = tools[1]!;
    const firstSchema = JSON.stringify(first.inputSchema);
    Object.assign(first.inputSchema!, { mutated: true });
    first.annotations!.consequentialHint = false;
    first.annotations!.debugging = false;
    const again = await context.getTools();
    const empty = again[0]!;
    const copied = again[1]!;
    return {
      names: tools.map((tool) => tool.name),
      keys: tools.map((tool) => Object.keys(tool)),
      firstSchema,
      nextSchema: JSON.stringify(copied.inputSchema),
      annotations: copied.annotations,
      hasSchema: Object.hasOwn(empty, "inputSchema"),
      hasOutputSchema: Object.hasOwn(empty, "outputSchema"),
      hasAnnotations: Object.hasOwn(empty, "annotations"),
      origin: empty.origin,
      window: empty.window === window,
    };
  });
  expect(result.names).toEqual(["a", "z"]);
  expect(result.keys).toEqual([
    ["description", "name", "origin", "title", "window"],
    ["annotations", "description", "inputSchema", "name", "origin", "title", "window"],
  ]);
  expect(result.firstSchema).toBe(result.nextSchema);
  expect(JSON.parse(result.nextSchema!)).toEqual({
    type: "object",
    properties: { query: { type: "string" } },
  });
  expect(result.annotations).toEqual({
    consequentialHint: true,
    debugging: true,
    readOnlyHint: false,
    untrustedContentHint: false,
  });
  expect(result).toMatchObject({
    hasSchema: false,
    hasOutputSchema: false,
    hasAnnotations: false,
    origin: "http://localhost:8793",
    window: true,
  });
});

test("rejects invalid descriptors, duplicates and unserializable schemas", async ({ page }) => {
  await page.addScriptTag({ url: "/auto.js" });
  const { rejections, registered } = await page.evaluate(async () => {
    const context = document.modelContext!;
    const good = { name: "valid", description: "Valid", execute: () => null };
    await context.registerTool(good);
    const circular = {};
    Object.assign(circular, { self: circular });
    const cases = [
      ["null descriptor", null],
      ["execute is not callable", { ...good, execute: 1 }],
      ["name is a Symbol", { ...good, name: Symbol() }],
      ["name is already registered", good],
      ["name is empty", { ...good, name: "" }],
      ["name has a disallowed character", { ...good, name: "invalid name" }],
      ["name exceeds 128 characters", { ...good, name: "a".repeat(129) }],
      ["description is empty", { ...good, description: "" }],
      ["inputSchema is not an object", { ...good, name: "bad-schema", inputSchema: null }],
      ["inputSchema is circular", { ...good, name: "circular", inputSchema: circular }],
      [
        "inputSchema serializes to undefined",
        { ...good, name: "undefined", inputSchema: { toJSON: () => undefined } },
      ],
      ["outputSchema is not an object", { ...good, name: "bad-output", outputSchema: null }],
      ["outputSchema is circular", { ...good, name: "circular-output", outputSchema: circular }],
      [
        "outputSchema serializes to undefined",
        { ...good, name: "undefined-output", outputSchema: { toJSON: () => undefined } },
      ],
      ["outputSchema is a BigInt", { ...good, name: "bigint-output", outputSchema: BigInt(42) }],
    ] as const;
    const results: [string, string][] = [];
    for (const [label, descriptor] of cases) {
      try {
        // @ts-expect-error Exercise invalid JavaScript callers at the Web IDL boundary.
        await context.registerTool(descriptor);
        results.push([label, "resolved"]);
      } catch (error) {
        if (!(error instanceof Error)) {
          throw error;
        }
        results.push([label, error.name]);
      }
    }
    const tools = await context.getTools();
    return { rejections: results, registered: tools.map((tool) => tool.name) };
  });
  expect(rejections).toEqual([
    ["null descriptor", "TypeError"],
    ["execute is not callable", "TypeError"],
    ["name is a Symbol", "TypeError"],
    ["name is already registered", "InvalidStateError"],
    ["name is empty", "InvalidStateError"],
    ["name has a disallowed character", "InvalidStateError"],
    ["name exceeds 128 characters", "InvalidStateError"],
    ["description is empty", "InvalidStateError"],
    ["inputSchema is not an object", "TypeError"],
    ["inputSchema is circular", "TypeError"],
    ["inputSchema serializes to undefined", "TypeError"],
    ["outputSchema is not an object", "TypeError"],
    ["outputSchema is circular", "TypeError"],
    ["outputSchema serializes to undefined", "TypeError"],
    ["outputSchema is a BigInt", "TypeError"],
  ]);
  expect(registered).toEqual(["valid"]);
});

test("snapshots outputSchema, omits it when absent, and does not validate results", async ({
  page,
}) => {
  await page.addScriptTag({ url: "/auto.js" });
  const result = await page.evaluate(async () => {
    const context = document.modelContext!;
    const inputSchema = { type: "object", properties: { query: { type: "string" } } };
    const outputSchema = {
      type: "object",
      properties: { result: { type: "string", description: "The result string" } },
      required: ["result"],
    };
    // Declared as ModelContextTool: the result deliberately does not match outputSchema.
    const shaped: WebMCP.ModelContextTool = {
      name: "shaped",
      description: "Shaped",
      inputSchema,
      outputSchema,
      execute: () => "not an object",
    };
    await context.registerTool(shaped);
    const outputOnly = {
      name: "output-only",
      description: "Output only",
      outputSchema: {
        type: "object",
        properties: { result: { type: "string", description: "The result string" } },
        required: ["result"],
      },
      execute: () => ({ result: "hello" }),
    };
    await context.registerTool(outputOnly);
    await context.registerTool({ name: "plain", description: "Plain", execute: () => null });
    inputSchema.properties.query.type = "number";
    outputSchema.properties.result.type = "number";
    outputSchema.required.push("extra");

    const tools = await context.getTools();
    const outputTool = tools[0]!;
    const plain = tools[1]!;
    const shapedTool = tools[2]!;
    const returnedOutput = shapedTool.outputSchema;
    if (
      typeof returnedOutput !== "object" ||
      returnedOutput === null ||
      !("properties" in returnedOutput)
    ) {
      throw new Error("shaped outputSchema was not returned");
    }
    const properties = Reflect.get(returnedOutput, "properties");
    if (typeof properties !== "object" || properties === null) {
      throw new Error("shaped outputSchema has no properties");
    }
    const resultProperty = Reflect.get(properties, "result");
    if (typeof resultProperty !== "object" || resultProperty === null) {
      throw new Error("shaped outputSchema has no result property");
    }
    Reflect.set(resultProperty, "type", "boolean");
    const again = await context.getTools();
    const copied = again[2]!;
    return {
      names: tools.map((tool) => tool.name),
      plainKeys: Object.keys(plain),
      outputKeys: Object.keys(outputTool),
      shapedKeys: Object.keys(shapedTool),
      hasPlainOutput: Object.hasOwn(plain, "outputSchema"),
      hasOutputOnlyInput: Object.hasOwn(outputTool, "inputSchema"),
      outputOnly: outputTool.outputSchema,
      shapedInput: copied.inputSchema,
      shapedOutput: copied.outputSchema,
      execution: await context.executeTool(shapedTool, {}),
    };
  });

  expect(result.names).toEqual(["output-only", "plain", "shaped"]);
  expect(result.plainKeys).toEqual(["description", "name", "origin", "title", "window"]);
  expect(result.outputKeys).toEqual([
    "description",
    "name",
    "origin",
    "outputSchema",
    "title",
    "window",
  ]);
  expect(result.shapedKeys).toEqual([
    "description",
    "inputSchema",
    "name",
    "origin",
    "outputSchema",
    "title",
    "window",
  ]);
  expect(result.hasPlainOutput).toBe(false);
  expect(result.hasOutputOnlyInput).toBe(false);
  expect(result.outputOnly).toEqual({
    type: "object",
    properties: { result: { type: "string", description: "The result string" } },
    required: ["result"],
  });
  expect(result.shapedInput).toEqual({
    type: "object",
    properties: { query: { type: "string" } },
  });
  expect(result.shapedOutput).toEqual({
    type: "object",
    properties: { result: { type: "string", description: "The result string" } },
    required: ["result"],
  });
  expect(result.execution).toBe('"not an object"');
});

test("rejects an unserializable outputSchema before an aborted signal", async ({ page }) => {
  await page.addScriptTag({ url: "/auto.js" });
  const outcome = await page.evaluate(async () => {
    const context = document.modelContext!;
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const invalid: WebMCP.ModelContextTool = {
      name: "aborted-output",
      description: "Aborted output",
      outputSchema: { type: "object", properties: { prop: circular } },
      execute: () => null,
    };
    let rejection: unknown;
    try {
      await context.registerTool(invalid, { signal: AbortSignal.abort("aborted") });
      rejection = "resolved";
    } catch (error) {
      rejection = error instanceof Error ? error.name : error;
    }

    let outputSerialized = false;
    const ordering = {
      name: "ordering",
      description: "Ordering",
      inputSchema: {
        toJSON() {
          throw new TypeError("bad input schema");
        },
      },
      outputSchema: {
        toJSON() {
          outputSerialized = true;
          return {};
        },
      },
      execute: () => null,
    };
    let orderingError = "";
    try {
      await context.registerTool(ordering);
    } catch (error) {
      orderingError = error instanceof Error ? error.name : "not an error";
    }

    const stringSchema = {
      name: "string-undefined",
      description: "String undefined",
      outputSchema: { toJSON: () => "undefined" },
      execute: () => null,
    };
    await context.registerTool(stringSchema);
    const tools = await context.getTools();
    const registered = tools.find((tool) => tool.name === "string-undefined");
    return {
      rejection,
      orderingError,
      outputSerialized,
      names: tools.map((tool) => tool.name),
      stringSchema: registered ? registered.outputSchema : "missing",
    };
  });

  expect(outcome).toEqual({
    rejection: "TypeError",
    orderingError: "TypeError",
    outputSerialized: false,
    names: ["string-undefined"],
    stringSchema: "undefined",
  });
});

test("uses dictionary coercion without retaining or binding the tool object", async ({ page }) => {
  await page.addScriptTag({ url: "/auto.js" });
  const result = await page.evaluate(async () => {
    "use strict";
    const context = document.modelContext!;
    const descriptor = {
      name: 123,
      title: "\ud800",
      description: true,
      annotations: { readOnlyHint: 1 },
      execute() {
        return this === undefined;
      },
    };
    // @ts-expect-error Web IDL coerces the deliberately non-string fields.
    await context.registerTool(descriptor);
    const tool = (await context.getTools())[0]!;
    return {
      name: tool.name,
      title: tool.title,
      description: tool.description,
      annotations: tool.annotations,
      result: await context.executeTool(tool, {}),
    };
  });
  expect(result).toEqual({
    name: "123",
    title: "\ufffd",
    description: "true",
    annotations: {
      consequentialHint: false,
      debugging: false,
      readOnlyHint: true,
      untrustedContentHint: false,
    },
    result: "true",
  });
});

test("queues toolchange and resolves registration after notification; abort unregisters", async ({
  page,
}) => {
  await page.addScriptTag({ url: "/auto.js" });
  const result = await page.evaluate(async () => {
    const context = document.modelContext!;
    const registration = new AbortController();
    const events: string[] = [];
    context.ontoolchange = () => events.push("change");
    const pending = context.registerTool(
      { name: "x", description: "X", execute: () => null },
      { signal: registration.signal },
    );
    events.push("sync");
    await Promise.resolve();
    events.push("microtask");
    await pending;
    events.push("registered");
    registration.abort();
    const tools = await context.getTools();
    return { events, count: tools.length };
  });
  expect(result).toEqual({
    events: ["sync", "microtask", "change", "registered", "change"],
    count: 0,
  });
});

test("ontoolchange ignores a handler's own call property", async ({ page }) => {
  await page.addScriptTag({ url: "/auto.js" });
  const events = await page.evaluate(async () => {
    const context = document.modelContext!;
    const notifications: string[] = [];
    context.ontoolchange = function (event) {
      notifications.push(this === context ? event.type : "wrong receiver");
    };
    Object.defineProperty(context.ontoolchange, "call", { value: null });

    await context.registerTool({ name: "event", description: "Event", execute: () => null });
    return notifications;
  });

  expect(events).toEqual(["toolchange"]);
});

test("ontoolchange keeps a non-callable object and treats other values as null", async ({
  page,
}) => {
  await page.addScriptTag({ url: "/auto.js" });
  const outcome = await page.evaluate(async () => {
    const context = document.modelContext!;
    const failures: string[] = [];
    window.addEventListener("error", (event) => failures.push(event.message));
    const handler = {};
    Reflect.set(context, "ontoolchange", handler);
    const kept = Reflect.get(context, "ontoolchange") === handler;
    await context.registerTool({ name: "x", description: "X", execute: () => null });
    const coerced = [1, "handler", true].map((value) => {
      Reflect.set(context, "ontoolchange", value);
      return Reflect.get(context, "ontoolchange");
    });
    return { kept, coerced, failures };
  });

  expect(outcome).toEqual({ kept: true, coerced: [null, null, null], failures: [] });
});

test("returning false from ontoolchange cancels a cancelable event", async ({ page }) => {
  await page.addScriptTag({ url: "/auto.js" });
  const outcome = await page.evaluate(() => {
    const context = document.modelContext!;
    context.ontoolchange = () => false;
    const event = new Event("toolchange", { cancelable: true });
    const dispatched = context.dispatchEvent(event);
    return { dispatched, defaultPrevented: event.defaultPrevented };
  });

  expect(outcome).toEqual({ dispatched: false, defaultPrevented: true });
});

test("preserves event-handler listener order when the handler is replaced", async ({ page }) => {
  await page.addScriptTag({ url: "/auto.js" });
  const outcome = await page.evaluate(async () => {
    const context = document.modelContext!;
    const order: string[] = [];
    context.addEventListener("toolchange", () => order.push("first"));
    context.ontoolchange = () => order.push("old");
    context.addEventListener("toolchange", () => order.push("last"));
    context.ontoolchange = function () {
      order.push(this === context ? "new" : "wrong-this");
    };
    await context.registerTool({ name: "x", description: "X", execute: () => null });
    // Clearing the handler removes its listener, so setting one again appends at the end.
    context.ontoolchange = null;
    context.ontoolchange = () => order.push("reassigned");
    await context.registerTool({ name: "y", description: "Y", execute: () => null });
    return order;
  });

  expect(outcome).toEqual(["first", "new", "last", "first", "last", "reassigned"]);
});

test("rejects aborted registration and permits reusing its name", async ({ page }) => {
  await page.addScriptTag({ url: "/auto.js" });
  const outcome = await page.evaluate(async () => {
    const context = document.modelContext!;
    const descriptor = { name: "x", description: "X", execute: () => null };
    const controller = new AbortController();
    controller.signal.addEventListener("abort", (event) => event.stopImmediatePropagation());
    const pending = context
      .registerTool(descriptor, { signal: controller.signal })
      .catch((error) => error);
    controller.abort("cancel-registration");
    const reason = await pending;
    await context.registerTool(descriptor);
    const tools = await context.getTools();
    return [reason, tools.length];
  });

  expect(outcome).toEqual(["cancel-registration", 1]);
});

test("exposedTo rejects an untrustworthy origin and accepts a cross-origin one", async ({
  page,
}) => {
  await page.addScriptTag({ url: "/auto.js" });
  const outcome = await page.evaluate(async () => {
    const context = document.modelContext!;
    const tool = { name: "x", description: "X", execute: () => null };
    const untrustworthy = await context
      .registerTool(tool, { exposedTo: ["http://untrusted.test"] })
      .then(
        () => "resolved",
        (error: Error) => error.name,
      );
    await context.registerTool(tool, { exposedTo: ["https://other.test"] });
    return { untrustworthy, names: (await context.getTools()).map(({ name }) => name) };
  });

  expect(outcome).toEqual({ untrustworthy: "SecurityError", names: ["x"] });
});

test("inactive documents get their own context but cannot register tools", async ({ page }) => {
  await page.addScriptTag({ url: "/auto.js" });
  const outcome = await page.evaluate(async () => {
    const inactive = document.implementation.createHTMLDocument();
    const context = inactive.modelContext!;
    let errorName = "";
    try {
      await context.registerTool({ name: "x", description: "X", execute() {} });
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
      errorName = error.name;
    }
    return {
      same: context === inactive.modelContext,
      distinct: context !== document.modelContext,
      errorName,
    };
  });

  expect(outcome).toEqual({ same: true, distinct: true, errorName: "InvalidStateError" });
});

test("a detached frame rejects even when its exception constructor was never read", async ({
  page,
}) => {
  // The /app iframe installs the polyfill; this document deliberately does not.
  const result = await page.evaluate(async () => {
    const iframe = document.createElement("iframe");
    iframe.src = "/app";
    const loaded = new Promise<void>((resolve) => {
      iframe.onload = () => resolve();
    });
    document.body.append(iframe);
    await loaded;
    const context = iframe.contentDocument!.modelContext!;
    iframe.remove();
    try {
      await context.getTools();
      return "resolved";
    } catch (error) {
      if (!error || typeof error !== "object" || !("name" in error)) {
        throw error;
      }
      return { name: error.name, type: Object.prototype.toString.call(error) };
    }
  });
  expect(result).toEqual({ name: "InvalidStateError", type: "[object DOMException]" });
});
