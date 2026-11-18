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

Use WPT for shared conformance cases. Local tests cover installation, documented
polyfill differences, and assertions that WPT does not make or reach. Compare
individual assertions and recorded results before adding coverage: the pinned
manual-submit, reset, and abort tests stop at unsupported pseudo-class checks,
so local tests still exercise the behavior beyond those failures.

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
Safari 26.6.2 opens a native confirmation sheet when the HTTPS tests submit to
`about:blank`. It prevents WebDriver from closing four test tabs, so WPT discards
five subtest results and fails the completeness check at 185/190. The current
warning does not honor `AskBeforeSubmittingInsecureForms`. Using an HTTPS form
destination avoids the warning; WPT made that repair in
[`6275ce0`](https://github.com/web-platform-tests/wpt/commit/6275ce039362b0e256e40b21d6c6f0dda3fa2481),
after the pinned revision.

Set `WPT_PYTHON` or `WPT_VENV` to use an existing Python environment. Extra arguments
go to WPT. On macOS, Firefox may need `--certutil-binary` pointing to a wrapper that
unsets `DYLD_LIBRARY_PATH` before calling Homebrew's `certutil`.

Reports go to `wpt-results/<browser>.json`. Upstream tests stay unmodified;
[expectations](wpt/metadata/) record known failures and their reasons. Unexpected
passes, unexpected failures, and incomplete runs fail the command. Crashtests and
other non-testharness files are outside this suite.

## Draft alignment and limitations

Checked against [draft `eada13b`](https://github.com/webmachinelearning/webmcp/blob/eada13b575187ba9a523adc0c52e294ebdb6b597/index.bs).
`outputSchema` follows [webmcp#254](https://github.com/webmachinelearning/webmcp/pull/254)
(draft `6cd745a`) and lifecycle event timing follows
[webmcp#371](https://github.com/webmachinelearning/webmcp/pull/371) (draft `f2f2ae2`);
the other draft changes since `eada13b` are not yet reviewed.

- **Missing APIs:** scripts cannot add selectors, so the `:tool-form-active` and
  `:tool-submit-active` pseudo-classes are unsupported.
- **Draft differences:** results are JSON-serialized; some pinned tests expect raw
  strings. Omitted or `undefined` input becomes `{}`; `null` and primitives reject.
- **Lifecycle events:** script-dispatched events cannot be
  [trusted](https://dom.spec.whatwg.org/#dom-event-istrusted), so `isTrusted` is false.
- **outputSchema:** `registerTool()` accepts an optional `outputSchema`, and `getTools()`
  returns a deep copy on `RegisteredTool`, converted and snapshotted like `inputSchema`.
  This follows
  [draft `6cd745a`](https://github.com/webmachinelearning/webmcp/blob/6cd745ac8a186122bd3f4aeaeb1d6cfa820251d2/index.bs).
  An omitted schema is absent (`undefined`). WPT
  [`9bde5b3`](https://github.com/web-platform-tests/wpt/commit/9bde5b3372c351a82884e2cc06b1a9e7e3c26185)
  expects `null`, which matches Chromium's nullable `Tool.outputSchema` attribute, not the
  draft dictionary.
- **Execution errors:** failures reject with the draft's `NotFoundError`, `DataError`,
  `OperationError`, `AbortError`, or `InvalidStateError`, with Chromium's messages.
  Declarative tools follow Chromium: input that cannot fill the form rejects with
  `DataError`, a submission that fails or is prevented without a response with
  `OperationError`, and a call cancelled by a reset or removal with `AbortError`, as is an
  older call that a newer one replaces. Thirteen pinned subtests fail only because they
  expect `UnknownError`; upstream WPT moved them to these names in `22b4a4d`. Failures of
  the polyfill's own frame messages, such as a malformed reply, have no draft counterpart
  and reject with `OperationError`.
- **Declarative tools:** the draft does not define them, so they follow the
  [explainer](https://github.com/webmachinelearning/webmcp/blob/d61d0e6d297ddb6bff3510b1330dbb215c6ef43c/declarative-api-explainer.md)
  and Chromium at [`dbdbb13`](https://chromium.googlesource.com/chromium/src/+/dbdbb13fd74c9411ca2e39ba087fa2e031184ff5/third_party/blink/renderer/core/html/forms/).
  Schemas match the cases in Chromium's `html_form_mcp_tool_test.cc` at that revision,
  except those behind its file-input and custom-element flags; those controls are
  unsupported. As in Chromium and the pinned tests, a submission that navigates
  resolves `executeTool()` with `null`, although the draft and `webmcp-types` declare a
  string. Installation adds `agentInvoked` and `respondWith()` to
  `SubmitEvent.prototype` and wraps `HTMLFormElement.prototype.submit()`. Differences
  from Chromium:
  - `toolactivated` fires once the form is filled, before it submits or waits for
    the user, as the explainer describes; Chromium fires it afterwards, even when
    filling fails.
  - From the agent's submit event until the polyfill settles the submission in a
    later task, a removal or tool attribute change keeps the call, and
    `respondWith()` is accepted; Chromium allows both only during the event's
    dispatch, which includes microtasks that listeners queue.
  - With `toolautosubmit`, the polyfill submits from script, so those microtasks run
    after the dispatch, and `preventDefault()` after an `await` no longer stops the
    submission; Chromium submits natively and honors it.
  - A change to the form's controls replaces the tool without cancelling a call that
    waits for the user; Chromium cancels it.
  - Moving a form that waits for the user, which mutation observers see as no
    change, keeps its call; Chromium cancels it.
  - A reset cancels a call only if it reaches the polyfill's window listener
    uncanceled. Chromium also cancels the call when a listener stops the reset's
    propagation, and keeps it when a later window listener cancels the reset.
  - A newer call rejects an older one that waits for the user, while one that
    waits for the page's response still settles; Chromium leaves the older call
    pending.
  - Only a call's first submission is the agent's; Chromium also counts a later
    submission while the page's response is pending.
  - A window capture listener that the page added before installation can stop the
    agent's `submit` event before the polyfill sees it, unless the listener reads
    `agentInvoked` or calls `respondWith()` first.
  - When a name frees up, the first form in document order that claims it
    registers; Chromium registers a form whose name was taken only when that form
    changes.
  - A submission that fails validation keeps a call that waits for the user;
    Chromium rejects it.
  - Numbers fill controls as `String()` converts them; Chromium formats those that
    are not 32-bit integers with six significant digits, and rejects them for
    checkboxes.
  - Numeric schema values use JavaScript numbers. Step-base divisibility uses the
    raw decimal attributes, up to 18 coefficient digits and exponents from -1023
    to 1023. Beyond those bounds, `multipleOf` is omitted instead of reproducing
    Blink's Decimal rounding. Its conversion to a schema number can also round
    differently from JavaScript.
  - The fill's `input` and `change` events are untrusted.
  - `SubmitEventInit` has no `agentInvoked` member, as in the explainer.
  - Forms in shadow trees are unsupported; Chromium registers them, including in
    closed shadow roots.
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
  ancestors must also load the polyfill; if they load it after a frame's startup
  wait, that frame's forms register at its next API call. Navigation inheritance is
  approximate; browser-specific trusted schemes and opaque execution origins are
  unsupported.

When updating the pins, compare the [draft](https://webmachinelearning.github.io/webmcp/),
[WPT](https://github.com/web-platform-tests/wpt/tree/master/webmcp), and
[types](https://github.com/webmachinelearning/webmcp-types). Update `wpt/revision.txt`,
the counts in `wpt/run.ts`, and each affected expectation after reviewing the changes.
[Blink source](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/script_tools/)
is a reference for Chromium behavior.
