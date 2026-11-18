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

### Declarative tools

A form with `toolname` and `tooldescription` attributes is a tool. Its named controls make up the input schema, each described by its `toolparamdescription`, label, or `aria-description`. Disabled controls and controls with an applicable `readonly` attribute are left out. When multiple checkboxes or multiple radio buttons share a name, they form one parameter, described by the `toolparamdescription` of the nearest `fieldset` around them:

```html
<form toolname="search-flights" tooldescription="Search for flights" toolautosubmit>
  <label>From <input name="from" required></label>
  <label>To <input name="to" required></label>
  <label>Date <input name="date" type="date"></label>
  <button>Search</button>
</form>
```

A call fills the form, then submits it if the form has `toolautosubmit`. Without that attribute, the form needs an enabled submit button: the call focuses it and waits for the form's next submission. A submission the page does not cancel resolves the call with `null`, as does `form.submit()`; one it cancels without responding rejects the call. To respond, call `preventDefault()` and then `respondWith()` in the `submit` listener:

```js
const form = document.querySelector('form[toolname="search-flights"]');
form.addEventListener("submit", (event) => {
  if (event.agentInvoked) {
    event.preventDefault();
    event.respondWith(searchFlights(new FormData(form)));
  }
});
```

The call resolves with the response: objects are JSON-serialized, and other values are converted to strings. A rejected response or a form reset rejects the call. So does removing the form or changing its tool attributes, unless the page does that during the agent's `submit` event.

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

Initial discovery waits up to 500 ms for existing frames. Callbacks run in their owning frame. Cancellation preserves the caller's reason and sends the callback a default `AbortError`.

## Implementation status

The polyfill targets `webmcp-types@0.1.10` and covers registration, discovery, execution, cancellation, `toolchange` and the `toolactivated`/`toolcancel` events, including frame exposure and origin filtering. It also implements declarative tools, which follow the [declarative API explainer](https://github.com/webmachinelearning/webmcp/blob/main/declarative-api-explainer.md) and Chromium because the draft leaves them unwritten. The `:tool-form-active` and `:tool-submit-active` pseudo-classes are not implemented. Talking to an actual browser agent needs support from the browser itself.

Native contexts do not join the polyfill's channels. [TESTING.md](https://github.com/w3c-oss/webmcp-polyfill/blob/main/TESTING.md) lists the known differences from the draft, the test commands, and the spec and WPT revisions we test against.

`executeTool()` accepts an object and returns a JSON-serialized result, or a declarative tool's response, which is `null` if its form navigates. Omitted or `undefined` input defaults to a fresh empty object. Callbacks must validate their inputs; schema inference provides TypeScript checks only.

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
