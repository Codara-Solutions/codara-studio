#!/usr/bin/env node
"use strict";

// Unit tests for the bundled free deep_search tool
// (resources/pi-cora/deep-search.ts): DDG SERP parsing including uddg redirect
// decoding and ad filtering, the lite endpoint's single-quoted markup, result
// capping, readable-text extraction, digest capping, endpoint fallback,
// same-origin redirect policy, and the guarantee that a failing page fetch
// degrades to the search snippet instead of failing the call. Every fetch is
// injected; nothing here touches the network.
//
//   node scripts/test-deep-search.cjs
//
// Exits non-zero on any failed assertion.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const ts = require("typescript");

function loadTypeScriptModule(sourcePath) {
  const source = fs.readFileSync(sourcePath, "utf8");
  const output = ts.transpileModule(source, {
    fileName: sourcePath,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const loaded = new Module(sourcePath, module);
  loaded.filename = sourcePath;
  loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  loaded._compile(output, sourcePath);
  return loaded.exports;
}

const deepSearch = loadTypeScriptModule(
  path.join(__dirname, "..", "resources", "pi-cora", "deep-search.ts"),
);

const {
  decodeDuckDuckGoRedirect,
  parseDuckDuckGoSerp,
  extractReadableText,
  buildPageDigest,
  normalizeMaxResults,
  executeDeepSearch,
  registerDeepSearch,
  DEEP_SEARCH_DESCRIPTION,
  DEEP_SEARCH_MAX_RESULTS,
} = deepSearch;

// ── uddg redirect decoding ──

assert.equal(
  decodeDuckDuckGoRedirect(
    "//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs%2Fapi%3Fv%3D2&rut=abc123",
  ),
  "https://example.com/docs/api?v=2",
);
// HTML attribute values arrive entity-encoded; &amp; must not hide the params.
assert.equal(
  decodeDuckDuckGoRedirect(
    "https://duckduckgo.com/l/?uddg=https%3A%2F%2Fnews.example.org%2Fa%2Fb&amp;rut=def",
  ),
  "https://news.example.org/a/b",
);
assert.equal(decodeDuckDuckGoRedirect("https://plain.example.com/page"), "https://plain.example.com/page");
assert.equal(decodeDuckDuckGoRedirect("//bare.example.com/x"), "https://bare.example.com/x");
assert.equal(decodeDuckDuckGoRedirect("   "), "");

// ── SERP parsing: html.duckduckgo.com markup ──

function htmlResult(target, title, snippet) {
  const wrapped = `//duckduckgo.com/l/?uddg=${encodeURIComponent(target)}&amp;rut=r`;
  return `
    <div class="result results_links results_links_deep web-result">
      <h2 class="result__title">
        <a rel="nofollow" class="result__a" href="${wrapped}">${title}</a>
      </h2>
      <a class="result__snippet" href="${wrapped}">${snippet}</a>
    </div>`;
}

const htmlSerp = `
  <html><body>
  <div class="result result--ad">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad_provider=x&amp;u3=target">Sponsored thing</a>
    </h2>
    <a class="result__snippet" href="#">Buy now</a>
  </div>
  ${htmlResult("https://example.com/one", "First <b>Result</b>", "Snippet one with &amp; entity")}
  ${htmlResult("https://example.org/two", "Second Result", "Snippet <b>two</b>")}
  ${htmlResult("https://example.com/one", "Duplicate of one", "dupe")}
  ${htmlResult("https://example.net/three", "Third Result", "Snippet three")}
  </body></html>`;

const parsed = parseDuckDuckGoSerp(htmlSerp, 8);
assert.equal(parsed.length, 3, "ad and duplicate rows are dropped");
assert.deepEqual(parsed[0], {
  title: "First Result",
  url: "https://example.com/one",
  snippet: "Snippet one with & entity",
});
assert.deepEqual(parsed[1], {
  title: "Second Result",
  url: "https://example.org/two",
  snippet: "Snippet two",
});
assert.equal(parsed[2].url, "https://example.net/three");

// The cap is respected while the ad row still does not count against it.
assert.equal(parseDuckDuckGoSerp(htmlSerp, 2).length, 2);
assert.equal(parseDuckDuckGoSerp(htmlSerp, 2)[1].url, "https://example.org/two");

// ── SERP parsing: lite.duckduckgo.com markup (single-quoted attributes) ──

const liteSerp = `
  <table>
    <tr><td>1.&nbsp;</td><td>
      <a rel='nofollow' href='https://lite-target.example.com/page' class='result-link'>Lite Title</a>
    </td></tr>
    <tr><td>&nbsp;</td><td class='result-snippet'>Lite snippet text</td></tr>
  </table>`;

const liteParsed = parseDuckDuckGoSerp(liteSerp, 5);
assert.equal(liteParsed.length, 1);
assert.deepEqual(liteParsed[0], {
  title: "Lite Title",
  url: "https://lite-target.example.com/page",
  snippet: "Lite snippet text",
});

// ── readable-text extraction ──

const pageHtml = `
  <html><head><title>ignored</title><style>body { color: red; }</style></head>
  <body>
    <script>var tracking = "noise";</script>
    <nav><a href="/">Home</a><a href="/about">About</a></nav>
    <article>
      <h1>Release   Notes</h1>
      <p>Version 2.0 adds &quot;fast mode&quot;.</p>
      <ul><li>Item one</li><li>Item two</li></ul>
    </article>
    <footer>Copyright 2026</footer>
  </body></html>`;

const readable = extractReadableText(pageHtml);
assert.doesNotMatch(readable, /tracking|color: red|Home|Copyright/);
assert.match(readable, /Release Notes/);
assert.match(readable, /Version 2.0 adds "fast mode"\./);
assert.match(readable, /Item one\s*\n\s*Item two/);
assert.doesNotMatch(readable, /\n{3,}/, "blank runs collapse to at most one empty line");

// ── digest capping ──

const longText = "word ".repeat(1000).trim();
const digest = buildPageDigest(longText);
assert.equal(digest.length <= 2000 + 60, true);
assert.match(digest, /\[digest truncated at 2000 characters\]/);
assert.equal(buildPageDigest("short text"), "short text");

// ── max_results normalization ──

assert.equal(normalizeMaxResults(undefined), 5);
assert.equal(normalizeMaxResults("nonsense"), 5);
assert.equal(normalizeMaxResults(1.9), 1);
assert.equal(normalizeMaxResults(99), DEEP_SEARCH_MAX_RESULTS);
assert.equal(normalizeMaxResults(0), 1);

// ── async paths, all with injected fetch ──

function response(overrides) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => "",
    ...overrides,
  };
}

async function main() {
  // quick mode: one SERP fetch against the html endpoint with a browser UA.
  {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return response({ text: async () => htmlSerp });
    };
    const text = await executeDeepSearch(
      { query: "release notes", max_results: 2 },
      { fetchImpl },
    );
    assert.equal(calls.length, 1, "quick mode fetches the SERP exactly once");
    assert.match(calls[0].url, /^https:\/\/html\.duckduckgo\.com\/html\/\?q=release%20notes$/);
    assert.match(calls[0].init.headers["User-Agent"], /Mozilla\/5\.0/);
    assert.match(text, /1\. First Result/);
    assert.match(text, /https:\/\/example\.com\/one/);
    assert.match(text, /Snippet one with & entity/);
    assert.match(text, /2\. Second Result/);
    assert.doesNotMatch(text, /Third Result/, "max_results caps the quick listing");
  }

  // The html endpoint failing falls back to the lite endpoint.
  {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      if (url.startsWith("https://html.duckduckgo.com/")) {
        return response({ ok: false, status: 503 });
      }
      return response({ text: async () => liteSerp });
    };
    const text = await executeDeepSearch({ query: "fallback" }, { fetchImpl });
    assert.equal(calls.length, 2);
    assert.match(calls[1], /^https:\/\/lite\.duckduckgo\.com\/lite\/\?q=fallback$/);
    assert.match(text, /Lite Title/);
  }

  // Both endpoints failing raises one actionable error, with no retries.
  {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      throw new Error("network unreachable");
    };
    await assert.rejects(
      executeDeepSearch({ query: "offline" }, { fetchImpl }),
      /DuckDuckGo search failed .*network unreachable/,
    );
    assert.equal(calls, 2, "one attempt per endpoint, no retry loop");
  }

  // deep mode: pages are fetched, digested, and a failing page degrades to its
  // snippet while the others still return full digests.
  {
    const pageCalls = [];
    const fetchImpl = async (url, init) => {
      if (url.includes("duckduckgo.com")) return response({ text: async () => htmlSerp });
      pageCalls.push({ url, init });
      if (url === "https://example.org/two") throw new Error("connection reset");
      return response({ text: async () => pageHtml });
    };
    const text = await executeDeepSearch(
      { query: "release notes", mode: "deep", max_results: 2 },
      { fetchImpl },
    );
    assert.equal(pageCalls.length, 2, "deep mode fetches each listed page once");
    assert.equal(pageCalls[0].init.redirect, "manual", "page fetches keep redirect control");
    assert.match(text, /1\. First Result[\s\S]*Release Notes/);
    assert.match(text, /2\. Second Result[\s\S]*\[page fetch failed: connection reset\]/);
    assert.match(text, /Search snippet: Snippet two/);
  }

  // deep mode: a same-origin redirect is followed; a cross-origin redirect is
  // refused and that page degrades to its snippet.
  {
    const fetched = [];
    const fetchImpl = async (url) => {
      fetched.push(url);
      if (url.includes("duckduckgo.com")) return response({ text: async () => htmlSerp });
      if (url === "https://example.com/one") {
        return response({ status: 301, ok: false, headers: { get: () => "/moved" } });
      }
      if (url === "https://example.com/moved") {
        return response({ text: async () => pageHtml });
      }
      if (url === "https://example.org/two") {
        return response({ status: 302, ok: false, headers: { get: () => "https://evil.example.net/" } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    const text = await executeDeepSearch(
      { query: "redirects", mode: "deep", max_results: 2 },
      { fetchImpl },
    );
    assert.equal(fetched.includes("https://example.com/moved"), true, "same-origin redirect followed");
    assert.equal(fetched.includes("https://evil.example.net/"), false, "cross-origin redirect not followed");
    assert.match(text, /1\. First Result[\s\S]*Release Notes/);
    assert.match(text, /2\. Second Result[\s\S]*\[page fetch failed: .*not followed\]/);
  }

  // Long pages are digest-capped in the rendered output.
  {
    const hugePage = `<html><body><p>${"repeated content ".repeat(2000)}</p></body></html>`;
    const fetchImpl = async (url) =>
      url.includes("duckduckgo.com")
        ? response({ text: async () => htmlSerp })
        : response({ text: async () => hugePage });
    const text = await executeDeepSearch(
      { query: "big", mode: "deep", max_results: 1 },
      { fetchImpl },
    );
    assert.match(text, /\[digest truncated at 2000 characters\]/);
  }

  // Bad params fail fast without touching the network.
  {
    const fetchImpl = async () => {
      throw new Error("must not be called");
    };
    await assert.rejects(executeDeepSearch({}, { fetchImpl }), /non-empty query/);
    await assert.rejects(executeDeepSearch({ query: "   " }, { fetchImpl }), /non-empty query/);
  }

  // ── tool registration contract ──

  const registered = [];
  registerDeepSearch({ registerTool: (tool) => registered.push(tool) });
  assert.equal(registered.length, 1);
  const tool = registered[0];
  assert.equal(tool.name, "deep_search");
  assert.equal(tool.description, DEEP_SEARCH_DESCRIPTION);
  assert.deepEqual(tool.parameters.required, ["query"]);
  assert.deepEqual(tool.parameters.properties.mode.enum, ["quick", "deep"]);
  assert.equal(tool.parameters.properties.max_results.maximum, DEEP_SEARCH_MAX_RESULTS);
  // The description must stay honest about the backend and its place in the
  // fallback order, and must obey the punctuation rule like every prompt
  // surface (test-prompt-punctuation.cjs guards the whole file too).
  assert.match(tool.description, /DuckDuckGo/);
  assert.match(tool.description, /web_search/);
  assert.doesNotMatch(tool.description, /[\u2013\u2014]/);

  // Both Pi entrypoints must actually register the tool.
  for (const entry of ["worker.ts", "index.ts"]) {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "resources", "pi-cora", entry),
      "utf8",
    );
    assert.match(source, /registerDeepSearch\(pi\)/, `${entry} registers deep_search`);
  }

  console.log("deep search tool: ok");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
