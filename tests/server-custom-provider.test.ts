import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config";
import { compactRequest, modelsRequest, responseRequest, startServer } from "../src/server";

function fixtureConfig() {
  return { ...defaultConfig("browser-only"), customProvider: {
    providerId: "custom", baseUrl: "https://gateway.example/v1", catalogPath: join(tmpdir(), "fixture-model-catalog.json"),
  } };
}

test("mixed model discovery reads the installed catalog and never sends API auth to official models", async () => {
  const root = mkdtempSync(join(tmpdir(), "mixed-server-models-"));
  const config = fixtureConfig();
  config.customProvider.catalogPath = join(root, "models.json");
  const catalog = { models: [{ slug: "custom-model" }, { slug: "chatgpt-web/gpt-6-pro" }] };
  writeFileSync(config.customProvider.catalogPath, JSON.stringify(catalog));
  let calls = 0;
  const upstream = async () => { calls++; throw new Error("API auth must not reach model discovery"); };
  try {
    const req = () => new Request("http://127.0.0.1:17841/v1/models?key=private", { headers: { authorization: "Bearer fixture-key" } });
    const response = await modelsRequest(req(), config, upstream);
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toMatch(/^W\//);
    expect(await response.json()).toEqual(catalog);
    rmSync(config.customProvider.catalogPath);
    const missing = await modelsRequest(req(), config, upstream);
    expect(missing.status).toBe(502);
    expect(await missing.text()).not.toContain("fixture-key");
    expect(calls).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("mixed HTTP endpoints forward to the selected custom gateway including compact, image and search", async () => {
  const seen: string[] = [];
  let adapterCalls = 0;
  const server = startServer({ ...fixtureConfig(), port: 0 }, {
    adapterFactory: () => { adapterCalls++; throw new Error("ordinary models must not open the web adapter"); },
    fetchUpstream: async req => {
      seen.push(req.url);
      expect(req.headers.get("authorization")).toBe("Bearer custom-fixture");
      expect(req.headers.get("x-provider-auth")).toBe("fixture-header");
      expect(req.headers.get("cookie")).toBeNull();
      const body = await req.json();
      expect(body.model).toBe("custom-model");
      return Response.json({ gateway: true, output: [] });
    },
  });
  try {
    for (const endpoint of ["responses", "responses/compact", "images/generations", "images/edits", "alpha/search"]) {
      const response = await fetch(`http://127.0.0.1:${server.port}/v1/${endpoint}?api-version=fixture`, {
        method: "POST", headers: { authorization: "Bearer custom-fixture", "x-provider-auth": "fixture-header", cookie: "drop", "content-type": "application/json" },
        body: JSON.stringify({ model: "custom-model", input: [] }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ gateway: true, output: [] });
    }
    expect(seen).toEqual(["responses", "responses/compact", "images/generations", "images/edits", "alpha/search"]
      .map(endpoint => `https://gateway.example/v1/${endpoint}?api-version=fixture`));
    expect(adapterCalls).toBe(0);
  } finally { await server.stop(true); }
});

test("Web model selection keeps adapter execution and does not pass third-party auth upstream", async () => {
  const config = fixtureConfig();
  config.proAvailable = true;
  let upstreamCalls = 0;
  let adapterCalls = 0;
  const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST", headers: { authorization: "Bearer custom-fixture" },
    body: JSON.stringify({ model: "chatgpt-web/gpt-6-pro", input: "test the web route", stream: false }),
  }), config, () => ({ name: "web-fixture", async runTurn(parsed, _incoming, emit) {
    adapterCalls++;
    expect(parsed.modelId).toBe("gpt-5.6-sol");
    expect(parsed._chatgptModelFamily).toBe("6");
    expect(parsed.options.reasoning).toBe("max");
    emit({ type: "text_delta", text: "Web completed", phase: "final_answer" });
    emit({ type: "done", endTurn: true, stopReason: "stop" });
  } }), { rememberState: false, fetchUpstream: async () => { upstreamCalls++; throw new Error("No gateway call expected"); } });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("Web completed");
  expect(adapterCalls).toBe(1);
  expect(upstreamCalls).toBe(0);
});

test("custom responses and compact transport failures are sanitized and have no native fallback", async () => {
  const config = fixtureConfig();
  for (const endpoint of ["responses", "responses/compact"]) {
    let calls = 0;
    const req = new Request(`http://127.0.0.1:17841/v1/${endpoint}`, {
      method: "POST", body: JSON.stringify({ model: "custom-model", input: [] }),
    });
    const options = { fetchUpstream: async (forwarded: Request) => {
      calls++;
      expect(new URL(forwarded.url).origin).toBe("https://gateway.example");
      throw new Error("fixture-private-upstream-url?key=private");
    } };
    const response = endpoint === "responses"
      ? await responseRequest(req, config, undefined, options)
      : await compactRequest(req, config, undefined, options);
    expect(response.status).toBe(502);
    const message = await response.text();
    expect(message).toContain("no fallback");
    expect(message).not.toContain("private");
    expect(calls).toBe(1);
  }
});

test("invalid mixed routing prevents the listener from starting", () => {
  const config = fixtureConfig();
  config.customProvider.baseUrl = "http://remote.example/v1";
  expect(() => startServer({ ...config, port: 0 })).toThrow("requires HTTPS");
});

test("switching opaque custom compaction into Web fails explicitly before browser execution", async () => {
  const config = fixtureConfig();
  config.proAvailable = true;
  let calls = 0;
  const adapter = () => { calls++; throw new Error("No browser should start"); };
  const request = (endpoint: string) => new Request(`http://127.0.0.1:17841/v1/${endpoint}`, {
    method: "POST", body: JSON.stringify({ model: "chatgpt-web/gpt-6-pro",
      input: [{ type: "compaction", encrypted_content: "private-upstream-ciphertext" }], stream: false }),
  });
  for (const result of [await responseRequest(request("responses"), config, adapter),
    await compactRequest(request("responses/compact"), config, adapter)]) {
    expect(result.status).toBe(409);
    const text = await result.text();
    expect(text).toContain("context_handoff_required");
    expect(text).not.toContain("private-upstream-ciphertext");
  }
  expect(calls).toBe(0);
});
