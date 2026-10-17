import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import { createWebFetchTool, FETCH_MAX_CHARS } from "../../src/tools/webfetch.js";
import { isBlockedAddress, isBlockedHostname, resolvePublic } from "../../src/tools/netguard.js";
import { htmlToText, decodeEntities } from "../../src/tools/htmltext.js";

// ---------------------------------------------------------------- a small local web server for the tests

const PAGE = `<!doctype html><html><head><title>Docs &amp; Guide</title><style>.x{color:red}</style><script>var secret = "SCRIPTBODY";</script></head>
<body><nav><a href="/home">NAVIGATION</a></nav>
<main><h1>Getting started</h1><p>Install the <code>tool</code> first. See <a href="/guide/next">the next page</a> or <a href="https://example.com/x">outside</a>.</p>
<h2>Steps</h2><ul><li>One</li><li>Two<ul><li>Two-A</li></ul></li></ul><ol><li>First</li><li>Second</li></ol>
<pre>line 1
  indented</pre><blockquote>Quote me</blockquote>
<p>Arabic: <strong>مرحبا بالعالم</strong> &mdash; ok &#8364; &#x41;</p>
<table><tr><th>Name</th><th>Value</th></tr><tr><td>a</td><td>1</td></tr></table>
<img src="x.png" alt="Logo"><a href="javascript:alert(1)">bad link</a>
<p>${"filler text ".repeat(30)}</p></main><footer>FOOTERTEXT</footer></body></html>`;

let server, base, hits;
before(async () => {
  hits = [];
  server = http.createServer((req, res) => {
    hits.push({ url: req.url, host: req.headers.host, ua: req.headers["user-agent"] });
    const send = (status, headers, body) => { res.writeHead(status, headers); res.end(body); };
    const url = new URL(req.url, "http://x");
    switch (url.pathname) {
      case "/page": return send(200, { "content-type": "text/html; charset=utf-8" }, PAGE);
      case "/plain": return send(200, { "content-type": "text/plain" }, "just text\nsecond line\n");
      case "/json": return send(200, { "content-type": "application/json" }, '{"a":1}');
      case "/r1": return send(302, { location: "/r2" }, "");
      case "/r2": return send(301, { location: "/plain" }, "");
      case "/loop": return send(302, { location: "/loop" }, "");
      case "/to-metadata": return send(302, { location: "http://169.254.169.254/latest/meta-data/" }, "");
      case "/to-private": return send(302, { location: "http://10.0.0.5/admin" }, "");
      case "/to-file": return send(302, { location: "file:///etc/passwd" }, "");
      case "/to-creds": return send(302, { location: "http://user:pw@example.com/" }, "");
      case "/404": return send(404, { "content-type": "text/html" }, "<html><body>Nothing here</body></html>");
      case "/500": return send(500, { "content-type": "text/plain" }, "kaput");
      case "/png": return send(200, { "content-type": "image/png" }, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
      case "/gzip": return send(200, { "content-type": "text/plain", "content-encoding": "gzip" }, zlib.gzipSync("zipped hello"));
      case "/deflate": return send(200, { "content-type": "text/plain", "content-encoding": "deflate" }, zlib.deflateSync("deflated hello"));
      case "/br": return send(200, { "content-type": "text/plain", "content-encoding": "br" }, zlib.brotliCompressSync("brotli hello"));
      case "/cp1256": return send(200, { "content-type": "text/plain; charset=windows-1256" }, Buffer.from([0xe3, 0xd1, 0xcd, 0xc8, 0xc7]));
      case "/big": return send(200, { "content-type": "text/plain" }, "a".repeat(3 * 1024 * 1024));
      case "/long": return send(200, { "content-type": "text/plain" }, "b".repeat(50_000));
      case "/hang": return; // never answers
      case "/slow-body": res.writeHead(200, { "content-type": "text/plain" }); res.write("start"); return;
      default: return send(404, {}, "");
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections?.(); server.close(); });

const local = (opts = {}) => createWebFetchTool({ allowLoopback: true, ...opts });
const fetchUrl = (tool, url, extra = {}) => tool.run({ url, ...extra }, { signal: undefined });

// ---------------------------------------------------------------- conversion

test("HTML becomes readable text with light markdown; scripts, styles, nav and footer are dropped", async () => {
  const r = await fetchUrl(local(), `${base}/page`, { prompt: "How do I install it?" });
  assert.equal(r.ok, true);
  const c = r.content;
  assert.match(c, /^URL: http:\/\/127\.0\.0\.1:\d+\/page\nStatus: 200 OK\nContent-Type: text\/html\nTitle: Docs & Guide/);
  assert.match(c, /\n# Getting started\n/);
  assert.match(c, /\n## Steps\n/);
  assert.match(c, /Install the `tool` first\./);
  assert.match(c, /\[the next page\]\(http:\/\/127\.0\.0\.1:\d+\/guide\/next\)/);
  assert.match(c, /\[outside\]\(https:\/\/example\.com\/x\)/);
  assert.match(c, /\n- One\n- Two\n  - Two-A\n/);
  assert.match(c, /\n1\. First\n2\. Second\n/);
  assert.match(c, /```\nline 1\n  indented\n```/);
  assert.match(c, /> Quote me/);
  assert.match(c, /\*\*مرحبا بالعالم\*\* — ok € A/);
  assert.match(c, /Name \| Value\na \| 1/);
  assert.match(c, /\[image: Logo\]/);
  for (const gone of ["SCRIPTBODY", "NAVIGATION", "FOOTERTEXT", "color:red", "javascript:"]) assert.ok(!c.includes(gone), gone);
  assert.match(c, /Your question about this page: How do I install it\?/);
  assert.match(c, /untrusted data from the internet/);
  assert.match(r.display.summary, /^\d+ characters$/);
  assert.match(hits.at(-1).ua, /^firas-code\/\S+ \(page reader\)$/);
});

test("plain text and JSON are returned as they are; errors and binary types are described", async () => {
  const tool = local();
  assert.match((await fetchUrl(tool, `${base}/plain`)).content, /Content-Type: text\/plain\n\njust text\nsecond line/);
  assert.match((await fetchUrl(tool, `${base}/json`)).content, /\{"a":1\}/);
  const nf = await fetchUrl(tool, `${base}/404`);
  assert.equal(nf.ok, false);
  assert.match(nf.content, /Status: 404/);
  assert.match(nf.content, /The server answered with an error\.\nNothing here/);
  assert.equal(nf.display.summary, "Server replied 404");
  assert.equal((await fetchUrl(tool, `${base}/500`)).ok, false);
  const png = await fetchUrl(tool, `${base}/png`);
  assert.equal(png.ok, true);
  assert.match(png.content, /not a text page \(image\/png/);
});

test("compressed bodies and legacy Arabic charsets are decoded", async () => {
  const tool = local();
  assert.match((await fetchUrl(tool, `${base}/gzip`)).content, /zipped hello/);
  assert.match((await fetchUrl(tool, `${base}/deflate`)).content, /deflated hello/);
  assert.match((await fetchUrl(tool, `${base}/br`)).content, /brotli hello/);
  assert.match((await fetchUrl(tool, `${base}/cp1256`)).content, /مرحبا/);
});

test("size limits: 2 MB of body, 40000 characters back", async () => {
  const tool = local();
  const big = await fetchUrl(tool, `${base}/big`);
  assert.equal(big.ok, true);
  assert.match(big.content, /larger than 2 MB; only the first part was read/);
  assert.match(big.content, new RegExp(`cut after ${FETCH_MAX_CHARS} characters`));
  assert.ok(big.content.length < FETCH_MAX_CHARS + 1500);
  const long = await fetchUrl(tool, `${base}/long`);
  assert.match(long.content, /cut after 40000 characters \(10000 more\)/);
});

// ---------------------------------------------------------------- redirects

test("redirects are followed (up to 5) and reported", async () => {
  const r = await fetchUrl(local(), `${base}/r1`);
  assert.equal(r.ok, true);
  assert.match(r.content, /URL: .*\/plain\n/);
  assert.match(r.content, /Redirected from: .*\/r1/);
  assert.match(r.content, /just text/);
  const loop = await fetchUrl(local(), `${base}/loop`);
  assert.equal(loop.ok, false);
  assert.match(loop.content, /Too many redirects \(more than 5\)/);
});

test("every redirect hop is checked again: metadata, private ranges, files and credentials are refused", async () => {
  const tool = local();
  const before = hits.length;
  const meta = await fetchUrl(tool, `${base}/to-metadata`);
  assert.equal(meta.ok, false);
  assert.match(meta.content, /Refused: 169\.254\.169\.254 is on this machine or a private network/);
  assert.match((await fetchUrl(tool, `${base}/to-private`)).content, /Refused: 10\.0\.0\.5/);
  assert.match((await fetchUrl(tool, `${base}/to-file`)).content, /non-web address/);
  assert.match((await fetchUrl(tool, `${base}/to-creds`)).content, /credentials/);
  assert.equal(hits.length - before, 4, "only the four first hops reached the server; the dangerous targets were never contacted");
});

// ---------------------------------------------------------------- the guard

test("in production mode the loopback test server itself is refused", async () => {
  const prod = createWebFetchTool();
  const r = await prod.run({ url: `${base}/plain` }, {});
  assert.equal(r.ok, false);
  assert.match(r.content, /Refused: 127\.0\.0\.1:\d+ is on this machine/);
  assert.equal(r.display.summary, "Local and private addresses are blocked");
  assert.equal(prod.validate({ url: `${base}/plain` }), "That address belongs to this machine or a private network and cannot be fetched.");
});

test("blocked destinations (production mode)", async () => {
  const prod = createWebFetchTool();
  const blocked = [
    "http://localhost/", "http://localhost:3000/x", "http://app.localhost/", "http://127.0.0.1/", "http://127.1/", "http://2130706433/", "http://0x7f.0.0.1/",
    "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:7f00:1]/", "http://0.0.0.0/", "http://10.1.2.3/", "http://172.16.0.1/", "http://172.31.255.255/",
    "http://192.168.1.1/", "http://169.254.169.254/latest/meta-data/", "http://100.64.0.1/", "http://metadata.google.internal/", "http://printer.local/",
    "http://intranet/", "http://[fe80::1]/", "http://[fd00::1]/", "http://224.0.0.1/", "http://[::]/", "http://[64:ff9b::7f00:1]/", "http://[2002:7f00:1::]/",
  ];
  for (const url of blocked) {
    const r = await prod.run({ url }, {});
    assert.equal(r.ok, false, url);
    assert.match(r.content, /Refused: .* is on this machine or a private network/, url);
  }
});

test("addresses that are fine", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "11.0.0.1", "2606:4700:4700::1111", "2001:4860:4860::8888", "100.128.0.1"]) assert.equal(isBlockedAddress(ip), false, ip);
  for (const ip of ["127.0.0.1", "10.0.0.1", "192.168.0.1", "169.254.1.1", "::1", "::", "fe80::1", "fc00::1", "ff02::1", "::ffff:10.0.0.1", "not-an-ip"]) assert.equal(isBlockedAddress(ip), true, ip);
  assert.equal(isBlockedAddress("127.0.0.1", { allowLoopback: true }), false);
  assert.equal(isBlockedAddress("10.0.0.1", { allowLoopback: true }), true);
  assert.equal(isBlockedHostname("example.com"), false);
  assert.equal(isBlockedHostname("Localhost."), true);
  assert.equal(isBlockedHostname("docs.python.org"), false);
});

test("DNS: every answer is checked, and the checked address is the one connected to", async () => {
  const prod = createWebFetchTool();
  const mixed = async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.8", family: 4 }];
  assert.deepEqual(await resolvePublic("mixed.example", { lookup: mixed }), { ok: false, reason: "blocked" });
  const privateOnly = createWebFetchTool({ lookup: async () => [{ address: "192.168.1.9", family: 4 }] });
  assert.match((await privateOnly.run({ url: "http://rebind.example/" }, {})).content, /Refused: rebind\.example/);
  const failing = createWebFetchTool({ lookup: async () => { throw new Error("ENOTFOUND"); } });
  const dnsFail = await failing.run({ url: "https://nowhere.example/" }, {});
  assert.equal(dnsFail.ok, false);
  assert.match(dnsFail.content, /Could not find the server nowhere\.example/);

  let lookups = 0;
  const pinned = createWebFetchTool({ allowLoopback: true, lookup: async () => { lookups++; return [{ address: "127.0.0.1", family: 4 }]; } });
  const port = server.address().port;
  const r = await pinned.run({ url: `http://pinned.example:${port}/plain` }, {});
  assert.equal(r.ok, true);
  assert.match(r.content, /just text/);
  assert.equal(lookups, 1, "one resolution per hop, then the socket is pinned to it");
  assert.equal(hits.at(-1).host, `pinned.example:${port}`, "the Host header keeps the name");
});

test("validation and permission", () => {
  const tool = createWebFetchTool();
  assert.match(tool.validate({}), /url is required/);
  assert.match(tool.validate({ url: "ftp://example.com/f" }), /Only http and https/);
  assert.match(tool.validate({ url: "not a url" }), /not a valid URL/);
  assert.match(tool.validate({ url: "https://user:pass@example.com/" }), /user name or password/);
  assert.equal(tool.validate({ url: "https://example.com/docs" }), null);
  assert.equal(tool.validate({ url: "https://مثال.com/" }), null);
  assert.equal(tool.validate({ url: "http://[2606:4700:4700::1111]/" }), null, "a public IPv6 address is fine");
  assert.equal(tool.validate({ url: "http://93.184.216.34:8080/x" }), null);
  assert.match(tool.validate({ url: "http://[::1]/" }), /private network/);
  assert.match(tool.validate({ url: "http://10.0.0.1/" }), /private network/);
  assert.match(tool.validate({ url: "http://localhost:8080/" }), /private network/);
  const p = tool.permission({ url: "https://docs.example.com/a/b?q=1" });
  assert.equal(p.decision, "ask");
  assert.equal(p.risk, "low");
  assert.equal(p.sessionKey, "WebFetch:docs.example.com");
  assert.match(p.sessionLabel, /docs\.example\.com/);
  assert.equal(p.detail, "https://docs.example.com/a/b?q=1");
  assert.equal(tool.permission({ url: "gopher://x" }).decision, "deny");
  assert.equal(tool.readOnly, true);
  assert.deepEqual(Object.keys(tool.input_schema.properties).sort(), ["prompt", "url"]);
  assert.equal(tool.input_schema.properties.allowLoopback, undefined, "no way to switch the guard off from input");
});

test("timeouts and aborts", async () => {
  const quick = local({ timeoutMs: 400 });
  const started = Date.now();
  const r = await fetchUrl(quick, `${base}/hang`);
  assert.equal(r.ok, false);
  assert.match(r.content, /did not answer within 0\.4 seconds/);
  assert.ok(Date.now() - started < 3000);
  const stuck = await fetchUrl(quick, `${base}/slow-body`);
  assert.equal(stuck.ok, false);
  assert.match(stuck.content, /did not finish sending the page/);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150);
  const aborted = await local().run({ url: `${base}/hang` }, { signal: controller.signal });
  assert.equal(aborted.ok, false);
  assert.match(aborted.content, /cancelled/);
  const refused = await local().run({ url: "http://127.0.0.1:1/" }, {});
  assert.equal(refused.ok, false);
  assert.match(refused.content, /refused the connection/);
});

// ---------------------------------------------------------------- HTML conversion unit tests

test("htmlToText survives broken markup and keeps what matters", () => {
  assert.equal(htmlToText("<p>one<p>two").text, "one\n\ntwo");
  assert.equal(htmlToText("<div>a<br>b</div>").text, "a\nb");
  assert.equal(htmlToText("<script>alert(1)").text, "", "an unclosed script is dropped to the end");
  assert.equal(htmlToText("<!-- hidden --><p>shown</p>").text, "shown");
  assert.equal(htmlToText("<p>a   \n  b\t c</p>").text, "a b c");
  assert.equal(htmlToText("text with < and > signs & more").text, "text with < and > signs & more");
  assert.equal(htmlToText('<a href="/x">rel</a>', "https://site.example/dir/page").text, "[rel](https://site.example/x)");
  assert.equal(htmlToText('<a href="#top">anchor</a>').text, "anchor");
  assert.equal(htmlToText("<h3>Small</h3>text").text, "### Small\n\ntext");
  assert.equal(htmlToText("<ul><li>a<li>b</ul>").text, "- a\n- b");
  assert.equal(htmlToText("<p>نص عربي <em>مائل</em></p>").text, "نص عربي *مائل*");
  assert.equal(htmlToText("<title>T</title><body>b</body>").title, "T");
  const main = htmlToText(`<body><div>sidebar junk</div><main>${"x ".repeat(150)}</main></body>`);
  assert.ok(!main.text.includes("sidebar"), "<main> is preferred when it holds the content");
  assert.equal(decodeEntities("&lt;b&gt; &amp;amp; &unknown; &#128512; &#xD800;"), "<b> &amp; &unknown; \u{1F600} ");
  assert.doesNotThrow(() => htmlToText("<<<>>><a<b>&&&;;;<table><tr><td>"));
});
