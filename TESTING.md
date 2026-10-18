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
[`fe52996`](https://github.com/web-platform-tests/wpt/commit/fe52996d4465f23617bce91927bdd58e6ce8f541).
The [CI workflow](.github/workflows/test.yml) has the sparse-checkout and dependency setup.

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

## Draft alignment and limitations

Checked against [draft `eada13b`](https://github.com/webmachinelearning/webmcp/blob/eada13b575187ba9a523adc0c52e294ebdb6b597/index.bs).

- **Missing APIs:** lifecycle events (`toolactivated`, `toolcancel`),
  declarative `<form toolname>` registration, `SubmitEvent.agentInvoked`,
  `SubmitEvent.respondWith()`, and `:tool-form-active` / `:tool-submit-active`.
- **Draft differences:** results are JSON-serialized; some pinned tests expect raw
  strings. Omitted or `undefined` input becomes `{}`; `null` and primitives reject.
- **Execution errors:** failures reject with the draft's `NotFoundError`, `DataError`,
  `OperationError`, `AbortError`, or `InvalidStateError`, with Chromium's messages.
  Six pinned subtests still expect `UnknownError` and are expected failures; upstream WPT
  updated or removed them by `22b4a4d`. Failures of the polyfill's own frame messages,
  such as a malformed reply, have no draft counterpart and reject with `OperationError`.
- **Timing:** MessagePorts approximate native task ordering. Aborting before
  dispatch skips the callback; the draft dispatches and then aborts its signal.
  Delegated permission checks are asynchronous, so argument errors can precede
  `NotAllowedError`.
- **Frames:** each participating document must load the polyfill. Native contexts
  and WPT's uninstrumented blank helper documents cannot answer its messages.
  Opaque-origin handshakes and inaccessible cross-origin shadow frames are
  unsupported; closed shadow trees limit discovery and ordering.
- **Deadlines:** initial discovery, handshakes, and discovery or permission replies
  wait up to 500 ms. Late peers can be absent from results, and executing a tool in a
  frame that misses the handshake deadline rejects with `NotFoundError`. Callbacks and
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
