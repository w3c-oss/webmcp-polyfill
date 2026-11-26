# Testing

## What runs

`pnpm test` runs lint, build, type checking, and real-browser tests in Chromium,
Firefox, and Playwright WebKit. `pnpm test:package` checks imports, types, SSR, and
tarball contents. CI runs both plus WPT in Chrome Canary, Firefox Nightly, and
Safari on `macos-26`; its logs have the current counts and browser versions.

`pnpm test:wpt` runs every WebMCP testharness file at the pinned revision and prints
the subtest tally. [Expectations](wpt/metadata/) record each known failure and its
reason. Expected failures are still failures, and `NOTRUN` means an earlier timeout
prevented the test from running. This is not full conformance.

## Run locally

Use Node.js 24 and pnpm. Leave port 8793 free for the fixture server.

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install --with-deps chromium firefox webkit
pnpm test
pnpm test:package
```

Polyfill tests disable native WebMCP. A separate Chromium test uses
`--enable-features=WebMCP` to check that loading the polyfill preserves the native
context and its tools.

WPT needs Python 3.11+ and a clean checkout at
[`74d6562`](https://github.com/web-platform-tests/wpt/commit/74d6562a288190d1a8d3c40033a07036ecf30fa6).
The [CI workflow](.github/workflows/release.yml) has the sparse-checkout and dependency setup.

```sh
WPT_ROOT=../wpt CHROME_BIN=/path/to/chrome-canary pnpm test:wpt
WPT_ROOT=../wpt WPT_BROWSER=firefox pnpm test:wpt
WPT_ROOT=../wpt WPT_BROWSER=safari pnpm test:wpt
```

Firefox downloads Nightly unless `FIREFOX_BIN` is set.
Safari requires macOS, [Remote Automation, and WPT hosts-file setup](https://web-platform-tests.org/running-tests/safari.html).

Set `WPT_PYTHON` or `WPT_VENV` to use an existing Python environment. Extra arguments
go to WPT. On macOS, Firefox may need `--certutil-binary` pointing to a wrapper that
unsets `DYLD_LIBRARY_PATH` before calling Homebrew's `certutil`.

Reports go to `wpt-results/<browser>.json`. Upstream tests stay unmodified;
[expectations](wpt/metadata/) record known failures and their reasons. Unexpected
passes, unexpected failures, and incomplete runs fail the command. Crashtests and
other non-testharness files are outside this suite.

WPT injection skips empty pages, so the runner serves the empty `/common/blank.html` with
the markup from `tools/serve/serve.py`, through a temporary `config.json` in the WPT root
(listed in WPT's `.gitignore`); it never replaces an existing one. Documents WPT does not
serve, such as `javascript:` URL results, still run without the polyfill.

## Draft alignment and limitations

Checked against [draft `eada13b`](https://github.com/webmachinelearning/webmcp/blob/eada13b575187ba9a523adc0c52e294ebdb6b597/index.bs).
`outputSchema` follows [webmcp#254](https://github.com/webmachinelearning/webmcp/pull/254)
(draft `6cd745a`), lifecycle event timing follows
[webmcp#371](https://github.com/webmachinelearning/webmcp/pull/371) (draft `f2f2ae2`), and
the `Tool` interface follows [webmcp#348](https://github.com/webmachinelearning/webmcp/pull/348)
(draft `14b6d53`), and `waitForToolsUntil()` follows
[webmcp#373](https://github.com/webmachinelearning/webmcp/pull/373) (draft `47e2b99`); the
other draft changes since `eada13b` are not yet reviewed. Rejecting descriptions that are empty
after stripping leading and trailing ASCII whitespace follows the resolution of
[webmcp#372](https://github.com/webmachinelearning/webmcp/issues/372) and the open
[webmcp#393](https://github.com/webmachinelearning/webmcp/pull/393); WPT
[#65719](https://github.com/web-platform-tests/wpt/pull/65719) covers it.

- **Missing APIs:** declarative forms and CSS states are not implemented. The pinned WPT
  also covers `resumeTool()`, which is not in the draft; those
  subtests are expected failures.
- **waitForToolsUntil():** the draft's tools ready state is read only by browser agent
  observations, which the polyfill has no counterpart for, so it records no state and sets
  no timeout. It converts the argument, throws the draft's errors, and reacts to the promise,
  which marks a rejection as handled. A synchronous method cannot wait for a cross-origin
  ancestor's permission reply, so it throws `NotAllowedError` only when native policy
  introspection or a same-origin ancestor's `allow` attribute denies `tools`; the
  cross-origin WPT subtest is an expected failure.
- **Draft differences:** results are JSON-serialized; some pinned tests expect raw
  strings. Omitted or `undefined` input becomes `{}`; `null` and primitives reject.
- **Lifecycle events:** script-dispatched events cannot be
  [trusted](https://dom.spec.whatwg.org/#dom-event-istrusted), so `isTrusted` is false.
- **Tool:** `getTools()` returns `Tool` objects, and `executeTool()` rejects anything
  else with `TypeError`. A `Tool` targets one registration by an id hidden from script,
  so it never runs a tool registered later under the same name. Absent `inputSchema`,
  `outputSchema`, and `annotations` are `null`. Each realm loads its own polyfill, so a
  `Tool` from another realm is read through a getter under the registered symbol
  `webmcp-polyfill.tool-state`, which appears on `Tool.prototype`. A cross-origin
  document cannot be read, so `source` stays non-null after it navigates until its
  window closes; executing such a `Tool` still rejects with `InvalidStateError` when the
  new document answers. Firefox throws "Permission denied to access object" for a
  `WeakRef` to a cross-origin `WindowProxy`, so there the source is held strongly.
- **Opaque origins:** the draft rejects executing a tool registered by an opaque-origin
  document with `NotSupportedError` ([webmcp#349](https://github.com/webmachinelearning/webmcp/issues/349)).
  WPT [`3dad33b`](https://github.com/web-platform-tests/wpt/commit/3dad33b2b3ab95240876eb2f83bd57b320da035e) follows
  Chromium, which executes it; that subtest is an expected failure.
- **Execution errors:** failures reject with the draft's `NotFoundError`, `DataError`,
  `OperationError`, `AbortError`, or `InvalidStateError`, with Chromium's messages.
  Failures of the polyfill's own frame messages,
  such as a malformed reply, have no draft counterpart and reject with `OperationError`.
- **Timing:** MessagePorts approximate native task ordering. Aborting before
  dispatch skips the callback; the draft dispatches and then aborts its signal.
  Delegated permission checks are asynchronous, so argument errors can precede
  `NotAllowedError`.
- **Frames:** each participating document must load the polyfill. Native contexts
  and documents WPT does not serve, such as `javascript:` URL results, cannot answer its messages.
  Opaque-origin handshakes and inaccessible cross-origin shadow frames are
  unsupported; closed shadow trees limit discovery and ordering.
- **Deadlines:** initial discovery, handshakes, and discovery or permission replies
  wait up to 500 ms. Late peers can be absent from results, and executing a tool in a
  frame that misses the handshake deadline rejects with `InvalidStateError`, as the
  document that registered it is treated as gone. Callbacks and
  `toolchange` listeners have no deadline, so an unresponsive peer can leave a call
  pending. Navigation cleanup depends on `pagehide`; removed frames are polled
  every 100 ms. Background suspension affects timing.
- **Tool removal:** a disappearing frame emits no `toolchange`; later discovery
  excludes it.
- **Policy and origins:** without native policy introspection, only accessible
  iframe delegation can be checked, not HTTP Permissions Policy. Cross-origin
  ancestors must also load the polyfill. Navigation inheritance is approximate;
  browser-specific trusted schemes and opaque execution origins are unsupported.

When updating the pins, compare the [draft](https://webmachinelearning.github.io/webmcp/),
[WPT](https://github.com/web-platform-tests/wpt/tree/master/webmcp), and
[types](https://github.com/webmachinelearning/webmcp-types). Update `wpt/revision.txt`,
the counts in `wpt/run.ts`, and each affected expectation after reviewing the changes.
[Blink source](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/script_tools/)
is a reference for Chromium behavior.
