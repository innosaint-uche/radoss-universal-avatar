import http from "node:http";

export async function startMemuBrowserFixture(python) {
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const { input } = JSON.parse(Buffer.concat(chunks));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: input.map((text, index) => ({ index, embedding: /bicycle|cycle|bike/i.test(text) ? [1, 0] : [0, 1] })), usage: { total_tokens: input.length } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  process.env.NAAVOS_BROWSER_EMBEDDING_KEY = "synthetic-local-test";
  const { runSetup } = await import("../lib/setup-runtime.mjs");
  const { saveAvatarProfile } = await import("../lib/avatar-profile.mjs");
  const { configureMemu } = await import("../lib/memu-memory.mjs");
  await runSetup({ provider: "local", openAuth: false });
  saveAvatarProfile({ name: "Browser Fixture", tone: "Direct", structure: "Paragraphs", verbosity: "Concise", rules: ["Ask before publishing"] });
  await configureMemu({ mode: "local", python, provider: "jina", model: "fixture", api_key_env: "NAAVOS_BROWSER_EMBEDDING_KEY", base_url: `http://127.0.0.1:${server.address().port}`, allow_network: true }, { confirm: true });
  return server;
}
