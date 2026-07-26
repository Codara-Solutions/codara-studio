#!/usr/bin/env node
"use strict";

// Unit tests for the bundled free deep_search tool
// (resources/pi-cora/deep-search.ts): DDG SERP parsing including uddg redirect
// decoding and ad filtering, the lite endpoint's single-quoted markup, the Bing
// HTML fallback backend with its ck/a redirect unwrapping and nested deep-link
// rows, bot-challenge vs genuinely-empty classification (a 202 wall, marker
// pages, container-less bodies, 429/403 status walls), the mixed verdict when
// one backend walls and another answers with zero results, result capping,
// readable-text extraction, digest capping, endpoint fallback, same-origin
// redirect policy, and the guarantee that a failing page fetch degrades to the
// search snippet instead of failing the call. Every fetch is injected; nothing
// here touches the network.
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
  decodeBingRedirect,
  parseDuckDuckGoSerp,
  parseBingSerp,
  classifySerpBody,
  DDG_CONTAINER_PATTERN,
  BING_CONTAINER_PATTERN,
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

// ── challenge and empty-SERP fixtures ──

// DDG's anomaly wall: no result rows, an anomaly script, and a human check.
// Served as HTTP 202 in the wild, which response.ok reports as success.
const ddgChallengePage = `
  <html><head><title>DuckDuckGo</title><script src="/dist/anomaly.js"></script></head>
  <body><div id="anomaly-modal"><p>Please verify you are human to continue.</p></div></body></html>`;
assert.equal(parseDuckDuckGoSerp(ddgChallengePage, 5).length, 0, "the wall page parses to zero rows");

// A real SERP that simply matched nothing: the results container is present and
// DDG says so in words.
const emptyDdgSerp = `
  <html><body><div class="results">
    <div class="no-results">No results found for that query.</div>
  </div></body></html>`;
assert.equal(parseDuckDuckGoSerp(emptyDdgSerp, 5).length, 0);

// ── SERP parsing: Bing HTML fallback backend ──

function base64Url(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

assert.equal(
  decodeBingRedirect(`https://www.bing.com/ck/a?!&amp;&amp;p=1&amp;u=a1${base64Url("https://wrapped.example.org/b?x=1")}&amp;ntb=1`),
  "https://wrapped.example.org/b?x=1",
);
assert.equal(decodeBingRedirect("https://direct.example.com/page"), "https://direct.example.com/page");
// A ck/a wrapper whose payload does not decode to an http(s) URL keeps the raw
// href rather than inventing one.
assert.equal(
  decodeBingRedirect("https://www.bing.com/ck/a?u=a1bm90YXVybA"),
  "https://www.bing.com/ck/a?u=a1bm90YXVybA",
);

function bingRow(target, title, snippet) {
  return `<li class="b_algo b_algoBorder"><h2><a href="${target}" h="ID=SERP,5000.1">${title}</a></h2><div class="b_caption"><p>${snippet}</p></div></li>`;
}

const bingSerp = `
  <html><body><ol id="b_results">
    <li class="b_ad"><h2><a href="https://ads.example.com/buy">Sponsored</a></h2></li>
    ${bingRow("https://bing-target.example.com/a", "Bing <strong>First</strong>", "Bing snippet one &amp; more")}
    ${bingRow(`https://www.bing.com/ck/a?!&amp;&amp;p=2&amp;u=a1${base64Url("https://wrapped.example.org/b")}`, "Bing Second", "Bing snippet two")}
    ${bingRow("https://bing-target.example.com/a", "Duplicate row", "dupe")}
    ${bingRow("https://www.bing.com/search?q=related", "Related searches", "internal")}
    ${bingRow("https://bing-target.example.net/c", "Bing Third", "Bing snippet three")}
  </ol></body></html>`;

const bingParsed = parseBingSerp(bingSerp, 8);
assert.equal(bingParsed.length, 3, "ad rows, duplicates, and bing-internal links are dropped");
assert.deepEqual(bingParsed[0], {
  title: "Bing First",
  url: "https://bing-target.example.com/a",
  snippet: "Bing snippet one & more",
});
assert.equal(bingParsed[1].url, "https://wrapped.example.org/b", "ck/a wrappers are unwrapped");
assert.equal(bingParsed[2].url, "https://bing-target.example.net/c");
assert.equal(parseBingSerp(bingSerp, 2).length, 2, "the cap is respected");
assert.deepEqual(parseBingSerp("<html><body>nothing here</body></html>", 5), []);

// A row whose attribution or deep-link list nests <li> elements before the
// <h2> must not be truncated at that nested </li>: the row is sliced between
// b_algo openings, so title, url, and snippet all survive.
const bingNestedSerp = `
  <html><body><ol id="b_results">
    <li class="b_algo"><div class="b_attribution"><ul><li>example.com</li><li>Cached</li></ul></div><h2><a href="https://nested.example.com/p">Nested Title</a></h2><div class="b_caption"><p>Nested snippet</p></div></li>
    ${bingRow("https://after.example.com/z", "Row After", "Snippet after")}
  </ol></body></html>`;
const bingNested = parseBingSerp(bingNestedSerp, 5);
assert.equal(bingNested.length, 2, "a nested deep-link list does not swallow its row");
assert.deepEqual(bingNested[0], {
  title: "Nested Title",
  url: "https://nested.example.com/p",
  snippet: "Nested snippet",
});
assert.deepEqual(bingNested[1], {
  title: "Row After",
  url: "https://after.example.com/z",
  snippet: "Snippet after",
});

// The last row stops at its own </li> and at the list close, so page chrome
// after the results list is never mistaken for that row's snippet.
const bingTrailingChrome = `
  <ol id="b_results"><li class="b_algo"><h2><a href="https://nosnippet.example.com/a">No Snippet Row</a></h2></li></ol>
  <div class="b_footer"><p>Footer paragraph</p></div>`;
assert.deepEqual(parseBingSerp(bingTrailingChrome, 5), [
  { title: "No Snippet Row", url: "https://nosnippet.example.com/a", snippet: "" },
]);

// ── challenge vs empty classification ──

const ddgContainer = DDG_CONTAINER_PATTERN;
assert.ok(ddgContainer instanceof RegExp, "the module exports the container pattern it classifies with");

// Parsed rows always win: a SERP whose snippets happen to discuss captchas is
// not a challenge page.
assert.equal(classifySerpBody(200, "<html>captcha anomaly</html>", 3, ddgContainer), "results");
// DDG serves its wall as 202, which response.ok reports as success.
assert.equal(classifySerpBody(202, htmlSerp, 0, ddgContainer), "challenge");
assert.equal(
  classifySerpBody(202, '<div class="no-results">No results found.</div>', 0, ddgContainer),
  "challenge",
  "202 outranks a no-results marker",
);
// A 200 wall page is caught by its markers.
assert.equal(
  classifySerpBody(200, '<html><head><script src="/dist/anomaly.js"></script></head><body></body></html>', 0, ddgContainer),
  "challenge",
);
assert.equal(
  classifySerpBody(200, "<html><body><p>Verifying you are human before continuing.</p></body></html>", 0, ddgContainer),
  "challenge",
);
// A genuine zero-result SERP says so, and is not a challenge.
assert.equal(
  classifySerpBody(200, '<div class="results"><div class="no-results">No results found for that.</div></div>', 0, ddgContainer),
  "empty",
);
// Ordinary SERP chrome may reference the same anomaly or captcha scripts a wall
// page does. A body that says it found nothing is a real answer, so the
// explicit statement outranks the generic marker.
assert.equal(
  classifySerpBody(
    200,
    '<html><head><script src="/dist/anomaly.js"></script></head><body><div class="results_links"></div><div class="no-results">No results found.</div></body></html>',
    0,
    ddgContainer,
  ),
  "empty",
);
// The bare phrasing counts too: a table-only lite SERP that just says "No
// results." must not be reported as a wall.
assert.equal(
  classifySerpBody(200, "<html><body><table><tr><td>No results.</td></tr></table></body></html>", 0, ddgContainer),
  "empty",
);
// The result container present with zero usable rows means every row was an ad
// or a duplicate: empty, not walled.
assert.equal(
  classifySerpBody(200, '<a class="result__a" href="https://duckduckgo.com/y.js?ad_provider=x">Ad</a>', 0, ddgContainer),
  "empty",
);
// Same, with a marker word in the page: result-row markup outranks the generic
// markers, so an ad row about captchas plus an anomaly script stays empty.
assert.equal(
  classifySerpBody(
    200,
    '<html><head><script src="/dist/anomaly.js"></script></head><body><a class="result__a" href="https://duckduckgo.com/y.js?ad_provider=x">Ad about captcha</a></body></html>',
    0,
    ddgContainer,
  ),
  "empty",
);
// The container check is markup, not a mention: a wall page that merely ships
// the SERP stylesheet is still a wall.
assert.equal(
  classifySerpBody(
    200,
    '<html><head><style>.result__a { color: #333; }</style></head><body><p>Please verify you are human.</p></body></html>',
    0,
    ddgContainer,
  ),
  "challenge",
);
// No container, no markers, nothing: an interstitial, not a search answer.
assert.equal(classifySerpBody(200, "<html><body><div id=\"pane\"></div></body></html>", 0, ddgContainer), "challenge");

// The Bing backend is classified with its own container pattern.
assert.equal(classifySerpBody(200, bingSerp, 0, BING_CONTAINER_PATTERN), "empty");
assert.equal(
  classifySerpBody(200, '<html><body><div id="b_content">loading</div></body></html>', 0, BING_CONTAINER_PATTERN),
  "challenge",
  "a JS-only Bing shell has no result rows and no answer: a wall",
);

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

  // Every backend failing raises one actionable error, with no retries.
  {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      throw new Error("network unreachable");
    };
    await assert.rejects(
      executeDeepSearch({ query: "offline" }, { fetchImpl }),
      /Free web search failed .*network unreachable/,
    );
    assert.equal(calls.length, 3, "one attempt per backend, no retry loop");
    assert.match(calls[2], /^https:\/\/www\.bing\.com\/search\?q=offline$/);
  }

  // Both DDG endpoints walled: the Bing fallback answers and the header names
  // the backend that actually served the results.
  {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      if (url.includes("duckduckgo.com")) {
        return response({ status: 202, text: async () => ddgChallengePage });
      }
      return response({ text: async () => bingSerp });
    };
    const text = await executeDeepSearch({ query: "walled", max_results: 2 }, { fetchImpl });
    assert.equal(calls.length, 3, "the alternate backend is tried after both DDG endpoints");
    assert.match(text, /^Bing quick results for "walled" \(2 results, public endpoint\):/);
    assert.match(text, /1\. Bing First/);
    assert.match(text, /https:\/\/wrapped\.example\.org\/b/);
  }

  // Every backend challenging: the error must say "challenge", must NOT reuse
  // the generic empty/parse wording, and must NOT tell the agent to rephrase
  // and retry, which cannot clear a bot wall.
  {
    const seen = [];
    const fetchImpl = async (url) => {
      seen.push(url);
      // 202 wall on html, marker wall on lite, status wall on the fallback.
      if (url.includes("html.duckduckgo.com")) {
        return response({ status: 202, text: async () => ddgChallengePage });
      }
      if (url.includes("lite.duckduckgo.com")) {
        return response({ text: async () => ddgChallengePage });
      }
      return response({ ok: false, status: 429 });
    };
    let thrown;
    try {
      await executeDeepSearch({ query: "pi harness release notes" }, { fetchImpl });
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown, "a fully challenged search still throws");
    const message = thrown.message;
    assert.equal(seen.length, 3);
    assert.match(message, /bot-challenged, not merely empty/);
    assert.match(message, /html\.duckduckgo\.com: bot challenge page \(HTTP 202, no result rows\)/);
    assert.match(message, /lite\.duckduckgo\.com: bot challenge page \(HTTP 200, no result rows\)/);
    assert.match(message, /bing\.com: HTTP 429 \(blocked or rate limited\)/);
    assert.match(message, /use the provider web_search tool/);
    assert.match(message, /RSS or Atom feeds/);
    assert.doesNotMatch(message, /no parseable results/);
    assert.doesNotMatch(message, /Try again with different terms/);
  }

  // A challenge on one endpoint does not poison a later endpoint that answers.
  {
    const fetchImpl = async (url) => {
      if (url.includes("html.duckduckgo.com")) {
        return response({ status: 202, text: async () => ddgChallengePage });
      }
      return response({ text: async () => liteSerp });
    };
    const text = await executeDeepSearch({ query: "recovers" }, { fetchImpl });
    assert.match(text, /^DuckDuckGo quick results for "recovers"/);
    assert.match(text, /Lite Title/);
  }

  // Genuinely empty SERPs keep the old, rephrase-friendly wording and must not
  // be reported as a challenge.
  {
    const fetchImpl = async (url) =>
      url.includes("bing.com")
        ? response({ text: async () => '<ol id="b_results"><li class="b_no">There are no results for this.</li></ol>' })
        : response({ text: async () => emptyDdgSerp });
    let thrown;
    try {
      await executeDeepSearch({ query: "zqxjklw nonexistent term" }, { fetchImpl });
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown);
    assert.match(thrown.message, /Free web search failed/);
    assert.match(thrown.message, /html\.duckduckgo\.com: zero results for this query/);
    assert.match(thrown.message, /bing\.com: zero results for this query/);
    assert.match(thrown.message, /Try again with different terms/);
    assert.doesNotMatch(thrown.message, /challenge/i);
  }

  // Mixed chain: DDG answers with a genuinely empty SERP while the alternate
  // backend serves a JS-only shell. One walled backend must not turn the whole
  // verdict into "bot-challenged", because a backend did answer and rephrasing
  // is still the right next move.
  {
    const fetchImpl = async (url) =>
      url.includes("bing.com")
        ? response({ text: async () => '<html><body><div id="b_content">loading</div></body></html>' })
        : response({ text: async () => emptyDdgSerp });
    let thrown;
    try {
      await executeDeepSearch({ query: "zqxjklw" }, { fetchImpl });
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown);
    assert.match(thrown.message, /html\.duckduckgo\.com: zero results for this query/);
    assert.match(thrown.message, /lite\.duckduckgo\.com: zero results for this query/);
    assert.match(thrown.message, /bing\.com: bot challenge page \(HTTP 200, no result rows\)/);
    assert.match(thrown.message, /Some backends were walled .* while others answered with zero results/);
    assert.match(thrown.message, /one rephrase is worth trying/);
    assert.doesNotMatch(thrown.message, /not merely empty/);
    assert.doesNotMatch(thrown.message, /will not clear it/);
  }

  // Same rule for a status wall: a 429 on the first backend while the others
  // answer with zero results is a mixed verdict, not a full bot wall.
  {
    const fetchImpl = async (url) =>
      url.includes("html.duckduckgo.com")
        ? response({ ok: false, status: 429 })
        : response({ text: async () => emptyDdgSerp });
    let thrown;
    try {
      await executeDeepSearch({ query: "rate limited then empty" }, { fetchImpl });
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown);
    assert.match(thrown.message, /html\.duckduckgo\.com: HTTP 429 \(blocked or rate limited\)/);
    assert.match(thrown.message, /lite\.duckduckgo\.com: zero results for this query/);
    assert.doesNotMatch(thrown.message, /not merely empty/);
    assert.doesNotMatch(thrown.message, /will not clear it/);
  }

  // A 403 status wall is a challenge too, even with no body to inspect.
  {
    const fetchImpl = async () => response({ ok: false, status: 403 });
    await assert.rejects(
      executeDeepSearch({ query: "forbidden" }, { fetchImpl }),
      /bot-challenged.*HTTP 403 \(blocked or rate limited\)/s,
    );
  }

  // A plain server error stays a plain server error: not every failure is a wall.
  {
    const fetchImpl = async () => response({ ok: false, status: 503 });
    await assert.rejects(
      executeDeepSearch({ query: "down" }, { fetchImpl }),
      /Free web search failed .*HTTP 503/,
    );
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
  assert.match(tool.description, /Bing/);
  assert.match(tool.description, /web_search/);
  // The challenge verdict is only useful if the model is told what it means.
  assert.match(tool.description, /bot-challeng/i);
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
