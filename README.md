# WebMCP polyfill

A polyfill for [WebMCP](https://webmachinelearning.github.io/webmcp/), the API that lets web pages expose tools to browser agents through `document.modelContext`. It follows the [WebMCP draft](https://webmachinelearning.github.io/webmcp/) from the [Web Machine Learning Community Group](https://www.w3.org/groups/cg/webmachinelearning/), uses types from [webmcp-types](https://github.com/webmachinelearning/webmcp-types), and has no runtime JavaScript dependencies.

WebMCP is a Community Group draft, not a W3C Standard, and it is still changing. Expect this package to change with it.

This project is part of the [W3C Open Source Program](https://github.com/w3c-oss/open-source-program) pilot. See its [project page](https://github.com/w3c-oss/open-source-program/blob/main/projects/webmcp-polyfill/README.md) for what that means.

## Install

```sh
npm install @w3c/webmcp-polyfill
```

## Usage

The API only exists in secure contexts, so serve your page over HTTPS or from localhost.

Load the polyfill before you register tools:

```ts
import "@w3c/webmcp-polyfill/auto";

const context = document.modelContext;
if (!context) {
  throw new Error("WebMCP requires a secure browser context");
}

const registration = new AbortController();
await context.registerTool(
  {
    name: "page-title",
    description: "Get the title of this page",
    execute() {
      return { title: document.title };
    },
  },
  { signal: registration.signal },
);

const tools = await context.getTools();
const pageTitleTool = tools.find((tool) => tool.name === "page-title");
if (!pageTitleTool) {
  throw new Error("The page-title tool is unavailable");
}

const result = await context.executeTool(pageTitleTool);
console.log(result);

// Remove the tool when it is no longer needed.
registration.abort();
```

If you'd rather install it yourself, call `installWebMCP()` from `@w3c/webmcp-polyfill`. Calling it more than once is fine. Neither entry point replaces a native `document.modelContext`, even a partial one.

### Script tag

The package also ships a standalone build at `dist/polyfill.js`. Load it before your app:

```html
<script src="/assets/polyfill.js"></script>
<script src="/assets/app.js"></script>
```

It installs `document.modelContext` as soon as it runs.

### Next.js

In Next.js 15.3+, add this to `instrumentation-client.ts` beside `app` (or `src/instrumentation-client.ts` beside `src/app`):

```ts
import "@w3c/webmcp-polyfill/auto";
```

Next.js runs [client instrumentation](https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation-client) before hydration. A Server Component import alone won't install the polyfill in the browser.

Both entry points are SSR-safe: installation does nothing without a document. Your pages can stay server-rendered; WebMCP runs in the browser.

The package needs no `"use client"` directive. Use it on your [Client Components](https://nextjs.org/docs/app/api-reference/directives/use-client) and access `document.modelContext` in effects or event handlers. Pass an `AbortSignal` when registering in an effect, then abort it during cleanup.

## Frames

Load the polyfill in each frame. Same-origin tools are visible by default, including those in parents and siblings. Pass the discovered descriptor to `executeTool()` so names shared by different frames reach the correct owner.

For cross-origin tools, delegate the `tools` permission on the iframe, register the tool with `exposedTo: [callerOrigin]`, and discover it with `getTools({ fromOrigins: [toolOrigin] })`. Same-origin tools are still included in that result.

```html
<iframe src="https://tools.example/app" allow="tools https://tools.example"></iframe>
```

Initial discovery waits up to 500 ms for existing frames. Requests use `MessageChannel` after checking the peer's source and origin; callbacks run in their owning frame. Cancellation preserves the caller's reason and sends the callback a default `AbortError`.

## Implementation status

The polyfill targets `webmcp-types@0.1.9` and covers registration, discovery, execution, cancellation and `toolchange`, including frame exposure and origin filtering. Declarative forms and the `toolactivated`/`toolcancel` events are not implemented yet. Talking to an actual browser agent needs support from the browser itself.

Native contexts do not join the polyfill's channels. [TESTING.md](https://github.com/w3c-oss/webmcp-polyfill/blob/main/TESTING.md) lists the known differences from the draft, the test commands, and the spec and WPT revisions we test against.

`executeTool()` accepts an object and returns a JSON-serialized result. Omitted or `undefined` input defaults to a fresh empty object. Callbacks must validate their inputs; schema inference provides TypeScript checks only.

A failed execution rejects with the draft's `DOMException` name, such as `NotFoundError` or `OperationError`, rather than the callback's own error.

Breaking API changes ship with notes: in minor releases while the version is 0.x, in majors after 1.0.

## Contributing

`src/` holds the polyfill, `tests/` the browser and package checks, and `wpt/` the [web-platform-tests](https://github.com/web-platform-tests/wpt/tree/master/webmcp) runner, pin, and expectations. To work on it, use Node.js 24 and pnpm:

```sh
pnpm install
pnpm test
```

Spec questions belong in the [WebMCP repository](https://github.com/webmachinelearning/webmcp/issues). See [CONTRIBUTING.md](CONTRIBUTING.md) for the contributor agreement and [GOVERNANCE.md](GOVERNANCE.md) for how the project is run.

## License

[Apache-2.0](LICENSE) © 2026 [World Wide Web Consortium](https://www.w3.org/)
