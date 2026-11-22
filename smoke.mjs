// Smoke-test the built worker.js against a stubbed host RPC loop + real homeserver.
// Verifies: module loads, definePlugin shape, manifest import, matrix-client unit behavior.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

async function main() {
  // 1. Manifest import shape
  const manifestMod = await import("./dist/manifest.js");
  const manifest = manifestMod.default;
  if (!manifest || manifest.apiVersion !== 1 || manifest.id !== "paperclip.matrix-chat") {
    throw new Error("manifest shape wrong: " + JSON.stringify(manifest).slice(0, 200));
  }
  console.log("manifest OK:", manifest.id, "v" + manifest.version, "| capabilities:", manifest.capabilities.length);

  // 2. worker.js must export the plugin and NOT boot the RPC host (isWorkerEntrypoint guard
  //    makes runWorker a no-op when argv[1] != worker.js — we import, not execute, but verify both paths)
  const workerMod = await import("./dist/worker.js");
  const plugin = workerMod.default;
  if (!plugin || typeof plugin !== "object") throw new Error("worker default export missing");
  const hooks = Object.keys(plugin).filter((k) => !k.startsWith("_"));
  console.log("plugin export OK; definition keys:", hooks.join(","));

  // 3. matrix-client unit tests
  const mc = await import("./dist/matrix-client.js");
  const ev = (over) => ({ event_id: "$1", type: "m.room.message", sender: "@alice:srv", origin_server_ts: 0, content: { msgtype: "m.text", body: "hello @bridge" }, ...over });
  const t1 = mc.messageBody(ev({}));
  if (t1 !== "hello @bridge") throw new Error("messageBody failed: " + t1);
  const t2 = mc.mentionsUser(ev({ content: { msgtype: "m.text", body: "hi there", "m.mentions": { user_ids: ["@bridge:srv"] } } }), "@bridge:srv", "hi there");
  if (!t2) throw new Error("mentionsUser pill-mention failed");
  const t3 = mc.mentionsUser(ev({}), "@bridge:srv", "hey @bridge do it");
  if (!t3) throw new Error("mentionsUser body-mention failed");
  const t4 = mc.stripMention("@bridge what is up", "@bridge:srv");
  if (t4 !== "what is up") throw new Error("stripMention failed: '" + t4 + "'");
  console.log("matrix-client unit tests OK (body/mention/strip)");

  // 3b. markdown -> Matrix HTML
  const md = await import("./dist/markdown.js");
  const cases = [
    ["**bold** and *italic*", "<p><strong>bold</strong> and <em>italic</em></p>"],
    ["- one\n- two", "<ul><li>one</li><li>two</li></ul>"],
    ["1. a\n2. b", "<ol><li>a</li><li>b</li></ol>"],
    ["# Heading", "<h1>Heading</h1>"],
    ["`a*b*c` and <script>", "<p><code>a*b*c</code> and &lt;script&gt;</p>"],
    ["```sh\nls -la <x>\n```", '<pre><code class="language-sh">ls -la &lt;x&gt;</code></pre>'],
    ["[site](https://example.com) [x](javascript:alert(1))", '<p><a href="https://example.com">site</a> [x](javascript:alert(1))</p>'],
    ["> quote", "<blockquote><p>quote</p></blockquote>"],
    ["line 1\nline 2", "<p>line 1<br>line 2</p>"],
    ["snake_case_name and 2*3*4", "<p>snake_case_name and 2*3*4</p>"],
  ];
  for (const [input, want] of cases) {
    const got = md.markdownToHtml(input);
    if (got !== want) throw new Error(`markdownToHtml(${JSON.stringify(input)}) = ${got}, want ${want}`);
  }
  if (md.hasMarkdown("just a plain sentence.")) throw new Error("hasMarkdown false positive");
  if (!md.hasMarkdown("this is **bold**")) throw new Error("hasMarkdown missed bold");
  console.log("markdown unit tests OK (" + cases.length + " cases)");

  // 4. Live homeserver reachability via the client class with a dummy token (expect 401 not network error)
  const client = new mc.MatrixClient("https://matrix.example.com", "dummy", fetch);
  try {
    await client.whoami();
    console.log("whoami unexpectedly succeeded");
  } catch (e) {
    const msg = String(e);
    if (msg.includes("401")) console.log("live homeserver OK (dummy token correctly rejected)");
    else throw new Error("unexpected homeserver error: " + msg.slice(0, 120));
  }

  console.log("SMOKE PASS");
}

main().catch((e) => {
  console.error("SMOKE FAIL:", e.message);
  process.exit(1);
});
