import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  const hasNativeContext = await page.evaluate(() => "modelContext" in document);
  expect(hasNativeContext).toBe(false);
  await page.addScriptTag({ url: "/auto.js" });
});

test("ignores late results after cancellation, including serialization side effects", async ({
  page,
}) => {
  const outcome = await page.evaluate(async () => {
    const context = document.modelContext!;
    const { promise: started, resolve: entered } = Promise.withResolvers<void>();
    const { promise: completion, resolve: finish } = Promise.withResolvers<object>();
    let serialized = false;

    await context.registerTool({
      name: "late",
      description: "Late",
      execute() {
        entered();
        return completion;
      },
    });

    const tool = (await context.getTools())[0]!;
    const caller = new AbortController();
    const result = context.executeTool(tool, {}, { signal: caller.signal }).catch((error) => error);

    await started;
    caller.abort("cancelled");
    await result;
    finish({
      toJSON() {
        serialized = true;
        return {};
      },
    });
    await context.getTools();

    return serialized;
  });

  expect(outcome).toBe(false);
});

test("cancellation during result serialization wins over queued delivery", async ({ page }) => {
  const outcome = await page.evaluate(async () => {
    const context = document.modelContext!;
    const caller = new AbortController();
    let callbackSignal: AbortSignal | undefined;

    await context.registerTool({
      name: "serialization",
      description: "Serialization",
      execute(_input, { signal }) {
        callbackSignal = signal;
        return {
          toJSON() {
            caller.abort("cancelled during serialization");
            return "completed";
          },
        };
      },
    });

    const tool = (await context.getTools())[0]!;
    const reason = await context
      .executeTool(tool, {}, { signal: caller.signal })
      .catch((error) => error);
    await context.getTools();
    return { reason, callbackAborted: callbackSignal?.aborted };
  });

  expect(outcome).toEqual({
    reason: "cancelled during serialization",
    callbackAborted: false,
  });
});

test("concurrent calls to the same tool have independent cancellation", async ({ page }) => {
  const outcome = await page.evaluate(async () => {
    const context = document.modelContext!;
    const signals: AbortSignal[] = [];
    const { promise: bothStarted, resolve: start } = Promise.withResolvers<void>();
    const { promise: completion, resolve: finish } = Promise.withResolvers<object>();

    await context.registerTool({
      name: "concurrent",
      description: "Concurrent",
      execute(_input, { signal }) {
        signals.push(signal);
        if (signals.length === 2) {
          start();
        }
        return completion;
      },
    });

    const tool = (await context.getTools())[0]!;
    const caller = new AbortController();
    const first = context.executeTool(tool, {}, { signal: caller.signal }).catch((error) => error);
    const second = context.executeTool(tool, {});

    await bothStarted;
    const aborted = new Promise<void>((resolve) => {
      signals[0]!.addEventListener("abort", () => resolve(), { once: true });
    });
    caller.abort("first only");
    await aborted;
    finish({ second: true });
    return {
      first: await first,
      second: await second,
      aborted: signals.map((signal) => signal.aborted),
    };
  });

  expect(outcome).toEqual({
    first: "first only",
    second: '{"second":true}',
    aborted: [true, false],
  });
});

test("executes copied object and array inputs with a fresh callback signal", async ({ page }) => {
  const outcome = await page.evaluate(async () => {
    "use strict";
    const context = document.modelContext!;
    const input = { nested: { value: 1 } };
    const caller = new AbortController();

    await context.registerTool({
      name: "echo",
      description: "Echo",
      execute(args, { signal }) {
        return {
          args,
          fresh: signal instanceof AbortSignal && signal !== caller.signal,
          unbound: this === undefined,
        };
      },
    });

    const tool = (await context.getTools())[0]!;
    const pending = context.executeTool(tool, input, { signal: caller.signal });
    input.nested.value = 9;
    const objectResult = JSON.parse(await pending);
    const arrayResult = JSON.parse(await context.executeTool(tool, [1, 2]));
    return [objectResult, arrayResult];
  });

  expect(outcome).toEqual([
    { args: { nested: { value: 1 } }, fresh: true, unbound: true },
    { args: [1, 2], fresh: true, unbound: true },
  ]);
});

test("rejects legacy JSON strings and preserves input serialization errors", async ({ page }) => {
  const outcome = await page.evaluate(async () => {
    const context = document.modelContext!;

    await context.registerTool({ name: "x", description: "X", execute: () => null });

    const tool = (await context.getTools())[0]!;
    const errors = [];
    for (const input of [
      "{}",
      null,
      1,
      {
        toJSON() {
          throw new RangeError("input");
        },
      },
    ]) {
      try {
        // @ts-expect-error Exercise primitive inputs from JavaScript callers.
        await context.executeTool(tool, input);
        errors.push("resolved");
      } catch (error) {
        if (!(error instanceof Error)) {
          throw error;
        }
        errors.push(error.name);
      }
    }

    return errors;
  });

  expect(outcome).toEqual(["TypeError", "TypeError", "TypeError", "RangeError"]);
});

test("serializes results as JSON and rejects callback or serialization failures", async ({
  page,
}) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  const results = await page.evaluate(async () => {
    const context = document.modelContext!;
    const circular = {};
    Object.assign(circular, { self: circular });

    await context.registerTool({
      name: "x",
      description: "X",
      execute({ value }) {
        if (value === "throw") {
          throw new Error("callback");
        }
        if (value === "circular") {
          return circular;
        }
        if (value === "undefined") {
          return undefined;
        }
        return value;
      },
    });

    const tool = (await context.getTools())[0]!;
    const output = [];
    for (const value of ["hello", null, 42, { success: true }, "throw", "circular", "undefined"]) {
      try {
        output.push(await context.executeTool(tool, { value }));
      } catch (error) {
        if (!(error instanceof Error)) {
          throw error;
        }
        output.push(error.name);
      }
    }

    return output;
  });

  expect(results).toEqual([
    '"hello"',
    "null",
    "42",
    '{"success":true}',
    "OperationError",
    "OperationError",
    "OperationError",
  ]);
  expect(pageErrors).toEqual([]);
});

test("cancels the caller immediately and sends a default AbortError to the callback", async ({
  page,
}) => {
  const outcome = await page.evaluate(async () => {
    const context = document.modelContext!;
    const { promise: started, resolve: entered } = Promise.withResolvers<void>();
    const { promise: callbackAborted, resolve: observed } = Promise.withResolvers<string>();

    await context.registerTool({
      name: "pending",
      description: "Pending",
      execute(_input, { signal }) {
        entered();
        return new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              observed(signal.reason.name);
              resolve("late result");
            },
            { once: true },
          );
        });
      },
    });

    const tool = (await context.getTools())[0]!;
    const controller = new AbortController();
    controller.signal.addEventListener("abort", (event) => event.stopImmediatePropagation());
    const result = context
      .executeTool(tool, {}, { signal: controller.signal })
      .catch((error) => error);

    await started;
    controller.abort("caller reason");
    return [await result, await callbackAborted];
  });

  expect(outcome).toEqual(["caller reason", "AbortError"]);
});

test("unregistration leaves an already-running invocation alive", async ({ page }) => {
  const outcome = await page.evaluate(async () => {
    const context = document.modelContext!;
    const registration = new AbortController();
    const { promise: started, resolve: entered } = Promise.withResolvers<AbortSignal>();
    const { promise: completion, resolve: complete } = Promise.withResolvers<string>();

    await context.registerTool(
      {
        name: "pending",
        description: "Pending",
        execute(_input, { signal }) {
          entered(signal);
          return completion;
        },
      },
      { signal: registration.signal },
    );

    const tool = (await context.getTools())[0]!;
    const pending = context.executeTool(tool, {});
    const callbackSignal = await started;
    registration.abort();
    const count = (await context.getTools()).length;
    complete("finished");
    return { count, aborted: callbackSignal.aborted, result: await pending };
  });

  expect(outcome).toEqual({ count: 0, aborted: false, result: '"finished"' });
});

// Native task ordering can differ (see TESTING.md).
test("aborting before the dispatch task rejects without starting the callback", async ({
  page,
}) => {
  const outcome = await page.evaluate(async () => {
    const context = document.modelContext!;
    let executions = 0;

    await context.registerTool({
      name: "x",
      description: "X",
      execute() {
        executions++;
      },
    });

    const tool = (await context.getTools())[0]!;
    const controller = new AbortController();
    const pending = context
      .executeTool(tool, {}, { signal: controller.signal })
      .catch((error) => error);
    controller.abort("before dispatch");
    const reason = await pending;
    await context.getTools();
    return [executions, reason];
  });

  expect(outcome).toEqual([0, "before dispatch"]);
});

test("execution accepts only Tool objects returned by getTools()", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const context = document.modelContext!;
    let calls = 0;

    await context.registerTool({
      name: "x",
      description: "X",
      execute() {
        return ++calls;
      },
    });

    const tool = (await context.getTools())[0]!;
    const toolInterface = Reflect.get(window, "Tool");
    // Copies an attribute value onto a plain object for every Tool attribute.
    const attributes = Object.fromEntries(
      Object.keys(toolInterface.prototype).map((key) => [key, Reflect.get(tool, key)]),
    );
    const notTools = [{ ...tool }, attributes, Object.create(toolInterface.prototype), null, "x"];
    const errors = [];
    for (const notTool of notTools) {
      try {
        await context.executeTool(notTool, {});
        errors.push("resolved");
      } catch (error) {
        if (!(error instanceof Error)) {
          throw error;
        }
        errors.push(error.name);
      }
    }
    const invalidCalls = calls;
    return { errors, invalidCalls, result: await context.executeTool(tool, {}) };
  });

  expect(result).toEqual({
    errors: ["TypeError", "TypeError", "TypeError", "TypeError", "TypeError"],
    invalidCalls: 0,
    result: "1",
  });
});

test("a stale Tool does not run a tool registered again under its name", async ({ page }) => {
  const outcome = await page.evaluate(async () => {
    const context = document.modelContext!;
    const registration = new AbortController();
    const executed: string[] = [];

    await context.registerTool(
      {
        name: "reused",
        description: "First",
        execute: () => executed.push("first"),
      },
      { signal: registration.signal },
    );
    const [staleTool] = await context.getTools();

    registration.abort();
    await context.registerTool({
      name: "reused",
      description: "Second",
      execute: () => executed.push("second"),
    });

    const staleExecution = await context.executeTool(staleTool!, {}).then(
      () => "resolved",
      (error: Error) => error.name,
    );
    const executedBefore = [...executed];
    const [freshTool] = await context.getTools();
    await context.executeTool(freshTool!, {});
    return {
      staleDescription: staleTool!.description,
      staleExecution,
      executedBefore,
      executed,
    };
  });

  expect(outcome).toEqual({
    staleDescription: "First",
    staleExecution: "NotFoundError",
    executedBefore: [],
    executed: ["second"],
  });
});

test("Tools registered by an opaque-origin document cannot be executed", async ({ page }) => {
  await page.goto("/opaque");
  const outcome = await page.evaluate(async () => {
    const context = document.modelContext!;
    await context.registerTool({ name: "opaque", description: "Opaque", execute: () => null });
    const [tool] = await context.getTools();
    return {
      origin: tool!.origin,
      execution: await context.executeTool(tool!, {}).then(
        () => "resolved",
        (error: Error) => error.name,
      ),
    };
  });

  expect(outcome).toEqual({ origin: "null", execution: "NotSupportedError" });
});

test("execution rejects a signal option that is not an AbortSignal", async ({ page }) => {
  const outcome = await page.evaluate(async () => {
    const context = document.modelContext!;

    await context.registerTool({ name: "x", description: "X", execute: () => null });

    const tool = (await context.getTools())[0]!;
    const results: [string, string][] = [];
    for (const signal of [1, {}, null, "abort"]) {
      const label = JSON.stringify(signal);
      try {
        // @ts-expect-error Exercise invalid JavaScript callers at the Web IDL boundary.
        await context.executeTool(tool, {}, { signal });
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

test("unregistering before dispatch rejects without running the callback", async ({ page }) => {
  const outcome = await page.evaluate(async () => {
    const context = document.modelContext!;
    const registration = new AbortController();
    let executions = 0;

    await context.registerTool(
      { name: "x", description: "X", execute: () => ++executions },
      { signal: registration.signal },
    );

    const tool = (await context.getTools())[0]!;
    const pending = context.executeTool(tool, {}).catch((error: Error) => error.name);
    registration.abort();
    return [await pending, executions];
  });

  expect(outcome).toEqual(["NotFoundError", 0]);
});

test("input that serializes to a non-object rejects before the callback runs", async ({ page }) => {
  const outcome = await page.evaluate(async () => {
    const context = document.modelContext!;
    let executions = 0;

    await context.registerTool({
      name: "x",
      description: "X",
      execute: () => ++executions,
    });

    const tool = (await context.getTools())[0]!;
    const name = await context.executeTool(tool, { toJSON: () => 5 }).then(
      () => "resolved",
      (error: Error) => error.name,
    );
    return [name, executions];
  });

  expect(outcome).toEqual(["DataError", 0]);
});

test("chained calls are not slowed by nested timer clamping", async ({ page }) => {
  const elapsed = await page.evaluate(async () => {
    const context = document.modelContext!;
    await context.registerTool({ name: "x", description: "X", execute: () => null });
    const tool = (await context.getTools())[0]!;
    const time = async (step: () => Promise<unknown>) => {
      const start = performance.now();
      for (let index = 0; index < 40; index++) {
        await step();
      }
      return performance.now() - start;
    };
    return {
      timers: await time(() => new Promise((resolve) => setTimeout(resolve, 0))),
      calls: await time(() => context.executeTool(tool, {})),
    };
  });

  expect(elapsed.timers).toBeGreaterThan(40);
  expect(elapsed.calls).toBeLessThan(elapsed.timers / 2);
});
