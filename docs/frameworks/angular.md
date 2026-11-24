# Angular

These steps apply to Angular apps with or without server-side rendering. They were tested with Angular 22.3 and `@angular/ssr`.

## Load the polyfill

Import the polyfill at the top of `src/main.ts`, before `bootstrapApplication()`:

```ts
import "@w3c/webmcp-polyfill/auto";

import { bootstrapApplication } from "@angular/platform-browser";
import { appConfig } from "./app/app.config";
import { App } from "./app/app";

bootstrapApplication(App, appConfig).catch((err) => console.error(err));
```

`main.ts` is the browser entry point. The server build starts from `main.server.ts`, so the polyfill stays out of the server bundle. Installation does nothing without a document anyway, but there is no reason to ship it there.

## Register a tool

`document` does not exist during server rendering. Register inside [`afterNextRender`](https://angular.dev/api/core/afterNextRender), which only runs in the browser:

```ts
import { Component, DestroyRef, afterNextRender, inject } from "@angular/core";

@Component({
  selector: "app-page-title-tool",
  template: `<p>The page-title tool is registered while this component is on screen.</p>`,
})
export class PageTitleTool {
  constructor() {
    const registration = new AbortController();
    inject(DestroyRef).onDestroy(() => registration.abort());

    afterNextRender(() => {
      document.modelContext?.registerTool(
        {
          name: "page-title",
          description: "Get the title of this page",
          execute() {
            return { title: document.title };
          },
        },
        { signal: registration.signal },
      );
    });
  }
}
```

Aborting the signal unregisters the tool. [`DestroyRef`](https://angular.dev/api/core/DestroyRef) does that when the component is destroyed, for example when the user navigates to another route.

`document.modelContext` is undefined outside secure contexts, so serve the app over HTTPS or from localhost.

Tool names are unique per document: `registerTool()` rejects if the name is already registered. Use this pattern in components that are on screen at most once at a time, or register from a root service instead.

## Angular's experimental WebMCP APIs

Angular 22 ships its own [WebMCP support](https://angular.dev/ai/webmcp). It is experimental, so it can change outside major versions.

`provideExperimentalWebMcpTools()` from `@angular/core` registers tools from the application providers. It registers them on `document.modelContext` and does not provide that object: in a browser without WebMCP it registers nothing. The two fit together. Load the polyfill in `main.ts` as above, and tools provided this way are registered through it.

Angular also has `declareExperimentalWebMcpTool()` and a Signal Forms integration. See the [Angular docs](https://angular.dev/ai/webmcp) for both.

Use Angular's APIs when you want Angular to manage registration for you and you accept experimental APIs. Use `document.modelContext` directly, as on this page, when you want to depend only on the WebMCP draft API.
