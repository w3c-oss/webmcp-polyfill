import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const wptRoot = process.env.WPT_ROOT;
if (!wptRoot) {
  throw new Error("Set WPT_ROOT to a WPT checkout");
}

const browser = process.env.WPT_BROWSER ?? "chrome";
const browserArguments: string[] = [];
switch (browser) {
  case "chrome": {
    const binary = process.env.CHROME_BIN;
    assert.ok(binary, "Set CHROME_BIN to Chrome Canary");
    browserArguments.push(
      "--channel=canary",
      "--binary",
      binary,
      "--install-webdriver",
      "--headless",
      "--no-enable-experimental",
      "--binary-arg=--disable-features=WebMCP",
    );
    break;
  }
  case "firefox": {
    const binary = process.env.FIREFOX_BIN;
    browserArguments.push("--headless");
    browserArguments.push(
      ...(binary
        ? ["--channel=stable", "--binary", binary]
        : ["--channel=nightly", "--install-browser"]),
    );
    break;
  }
  case "safari":
    browserArguments.push("--channel=stable");
    break;
  default:
    throw new Error(`Unsupported WPT_BROWSER: ${browser}; use chrome, firefox, or safari`);
}

const pinnedRevision = readFileSync(new URL("./revision.txt", import.meta.url), "utf8").trim();
const checkoutRevision = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: wptRoot,
  encoding: "utf8",
});
if (checkoutRevision.error) {
  throw checkoutRevision.error;
}
if (checkoutRevision.status !== 0 || checkoutRevision.stdout.trim() !== pinnedRevision) {
  throw new Error(
    `Check out WPT ${pinnedRevision}; review upstream changes before changing the pin`,
  );
}

const checkoutDiff = spawnSync("git", ["diff", "--quiet", "HEAD", "--"], { cwd: wptRoot });
if (checkoutDiff.error) {
  throw checkoutDiff.error;
}
if (checkoutDiff.status !== 0) {
  throw new Error("WPT has tracked changes; restore the pinned sources before running conformance");
}

const reportPath = fileURLToPath(new URL(`../wpt-results/${browser}.json`, import.meta.url));
mkdirSync(dirname(reportPath), { recursive: true });
rmSync(reportPath, { force: true });

const polyfillPath = fileURLToPath(new URL("../dist/polyfill.js", import.meta.url));

// /common/blank.html is empty, and wptserve's inject_script() leaves a document unchanged when
// it finds no insertion point, so helper frames would run without the polyfill. Serve it with
// the markup the injector produces for other pages. wptrunner reads server overrides only from
// config.json in the WPT root, which WPT's .gitignore lists.
const serverConfigPath = resolve(wptRoot, "config.json");
if (existsSync(serverConfigPath)) {
  throw new Error(`Remove ${serverConfigPath}; the runner writes its own server configuration`);
}
const helperRoot = mkdtempSync(resolve(tmpdir(), "webmcp-wpt-"));
const injectedBlankPage =
  "<script>\n" +
  readFileSync(polyfillPath, "utf8") +
  "\n// Remove the injected script tag from the DOM.\ndocument.currentScript.remove();\n</script>\n";
writeFileSync(resolve(helperRoot, "blank.html"), injectedBlankPage);
writeFileSync(
  serverConfigPath,
  JSON.stringify({ aliases: [{ "url-path": "/common/blank.html", "local-dir": helperRoot }] }),
);

let wptRun: ReturnType<typeof spawnSync>;
try {
  wptRun = spawnSync(
    process.env.WPT_PYTHON ?? "python3",
    [
      resolve(wptRoot, "wpt"),
      "--venv",
      process.env.WPT_VENV ?? resolve(wptRoot, "_venv_polyfill"),
      "run",
      ...browserArguments,
      "--yes",
      "--test-types",
      "testharness",
      "--inject-script",
      polyfillPath,
      "--manifest",
      resolve(wptRoot, "MANIFEST.json"),
      "--metadata",
      fileURLToPath(new URL("./metadata", import.meta.url)),
      "--log-mach=-",
      "--log-wptreport",
      reportPath,
      "--no-pause-after-test",
      "--processes",
      browser === "safari" ? "1" : "4",
      "--retry-unexpected=0",
      "--no-manifest-download",
      "--include",
      "/webmcp",
      ...process.argv.slice(2),
      browser,
    ],
    { cwd: wptRoot, stdio: "inherit" },
  );
} finally {
  rmSync(serverConfigPath, { force: true });
  rmSync(helperRoot, { recursive: true, force: true });
}
if (wptRun.error) {
  throw wptRun.error;
}
const reportContents = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "";
if (!reportContents.trim()) {
  throw new Error("WPT produced no report");
}

const { results }: WptReport = JSON.parse(reportContents);
const subtests = results.flatMap((fileResult) => fileResult.subtests);
const uniqueFiles = new Set(results.map((fileResult) => fileResult.test));

// These counts belong to the pinned revision; an incomplete run must not pass.
assert.equal(results.length, 80, "Expected all 80 WebMCP testharness files at the pin");
assert.equal(uniqueFiles.size, results.length, "WPT repeated a test file");
assert.equal(
  subtests.length,
  243,
  "WPT subtest count changed; inspect the report and expectations",
);
const statusCounts = { PASS: 0, FAIL: 0, TIMEOUT: 0, NOTRUN: 0, PRECONDITION_FAILED: 0 };
for (const { status } of subtests) {
  statusCounts[status] += 1;
}
console.log(
  `WPT (${browser}): ${results.length} files; subtests ${JSON.stringify(statusCounts)}.` +
    ` Report: ${reportPath}`,
);
if (wptRun.status !== 0) {
  throw new Error(`WPT reported unexpected results (exit ${wptRun.status})`);
}

interface WptReport {
  results: {
    test: string;
    subtests: { status: "PASS" | "FAIL" | "TIMEOUT" | "NOTRUN" | "PRECONDITION_FAILED" }[];
  }[];
}
