import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forwardCustomProviderRequest, readCustomProviderCatalog, validateCustomProviderConfig, type CustomProviderConfig } from "../src/custom-provider";
import { encodeCompactionSummary, SUMMARY_PREFIX } from "../src/responses/compaction";
import { flushResponseState, rememberResponseState } from "../src/responses/state";

const provider: CustomProviderConfig = {
  providerId: "custom", baseUrl: "https://gateway.example/v1", catalogPath: join(tmpdir(), "mixed-provider-models.json"),
};

function request(body: unknown, endpoint = "responses", headers?: Record<string, string>): Request {
  return new Request(`http://127.0.0.1:17841/v1/${endpoint}?api-version=fixture`, {
    method: "POST", body: JSON.stringify(body),
    headers: { authorization: "Bearer custom-fixture-token", "content-type": "application/json", ...headers },
  });
}

test("custom routing configuration accepts HTTPS and loopback only, without inline secrets", () => {
  for (const baseUrl of ["https://gateway.example/v1/", "http://127.0.0.1:8000/v1", "http://localhost:8000", "http://[::1]:8000/v1"]) {
    expect(validateCustomProviderConfig({ ...provider, baseUrl }).baseUrl).toBe(baseUrl.replace(/\/+$/, ""));
  }
  for (const baseUrl of ["http://gateway.example/v1", "ftp://gateway.example", "https://user:secret@gateway.example", "https://gateway.example?key=secret", "https://gateway.example#secret", "invalid"]) {
    expect(() => validateCustomProviderConfig({ ...provider, baseUrl })).toThrow();
  }
  for (const patch of [{ providerId: "openai" }, { providerId: "bad/id" }, { catalogPath: "relative.json" }]) {
    expect(() => validateCustomProviderConfig({ ...provider, ...patch })).toThrow();
  }
});

test("local catalog reads are bounded and do not accept missing or malformed model rows", () => {
  const root = mkdtempSync(join(tmpdir(), "mixed-provider-catalog-"));
  const config = { ...provider, catalogPath: join(root, "models.json") };
  try {
    expect(() => readCustomProviderCatalog(config)).toThrow("could not be read");
    for (const value of ["invalid", JSON.stringify({ data: [] }), JSON.stringify({ models: [{}] })]) {
      writeFileSync(config.catalogPath, value);
      expect(() => readCustomProviderCatalog(config)).toThrow();
    }
    const catalog = { models: [{ slug: "custom-model" }, { slug: "chatgpt-web/pro" }] };
    writeFileSync(config.catalogPath, JSON.stringify(catalog));
    expect(readCustomProviderCatalog(config)).toEqual(catalog);
    truncateSync(config.catalogPath, 16 * 1024 * 1024 + 1);
    expect(() => readCustomProviderCatalog(config)).toThrow("16 MiB");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("custom Responses preserves body, auth, provider headers/query and exact SSE bytes", async () => {
  const original = JSON.stringify({ model: "custom-model", input: "hello", stream: true });
  const chunks = ["event: response.created\r\n", "data: {\"id\":\"custom\"}\r\n\r\n", "data: [DONE]\n\n"];
  let forwarded: Request | undefined;
  const result = await forwardCustomProviderRequest(new Request("http://127.0.0.1:17841/v1/responses?api-version=fixture&key=query-fixture", {
    method: "POST", body: original, headers: {
      authorization: "Bearer custom-fixture-token", "x-provider-key": "header-fixture",
      cookie: "session=must-not-forward", host: "localhost:17841", connection: "keep-alive, x-private-hop",
      "x-private-hop": "hop-fixture", "x-codex-chatgpt-web-control-token": "control-fixture",
    },
  }), provider, "responses", async input => {
    forwarded = input;
    return new Response(new ReadableStream({ start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    } }), { headers: { "content-type": "text/event-stream", "x-request-id": "gateway-fixture", connection: "x-private-hop", "x-private-hop": "private", "set-cookie": "drop" } });
  });
  expect(forwarded!.url).toBe("https://gateway.example/v1/responses?api-version=fixture&key=query-fixture");
  expect(forwarded!.redirect).toBe("error");
  expect(forwarded!.headers.get("authorization")).toBe("Bearer custom-fixture-token");
  expect(forwarded!.headers.get("x-provider-key")).toBe("header-fixture");
  for (const name of ["host", "cookie", "connection", "x-private-hop", "x-codex-chatgpt-web-control-token"]) {
    expect(forwarded!.headers.get(name)).toBeNull();
  }
  expect(await forwarded!.text()).toBe(original);
  expect(await result.text()).toBe(chunks.join(""));
  expect(result.headers.get("x-request-id")).toBe("gateway-fixture");
  expect(result.headers.get("set-cookie")).toBeNull();
  expect(result.headers.get("x-private-hop")).toBeNull();
});

test("custom compact preserves the selected model and opaque gateway envelopes", async () => {
  const payload = { model: "custom-model", input: [{ type: "compaction", encrypted_content: "opaque-custom-summary" }] };
  const compressed = Bun.zstdCompressSync(Buffer.from(JSON.stringify(payload)));
  const encoded = new ArrayBuffer(compressed.byteLength);
  new Uint8Array(encoded).set(compressed);
  const req = new Request("http://127.0.0.1:17841/v1/responses/compact", {
    method: "POST", body: encoded, headers: { authorization: "Bearer fixture", "content-encoding": "zstd" },
  });
  const response = await forwardCustomProviderRequest(req, provider, "responses/compact", async forwarded => {
    expect(forwarded.url).toBe("https://gateway.example/v1/responses/compact");
    expect(Buffer.from(await forwarded.arrayBuffer())).toEqual(Buffer.from(compressed));
    expect(forwarded.headers.get("content-encoding")).toBe("zstd");
    return Response.json({ output: payload.input });
  }, payload);
  expect(await response.json()).toEqual({ output: payload.input });
});

test("Web checkpoints become plain history while tool call linkage survives provider switch", async () => {
  const payload = { model: "custom-model", previous_response_id: "resp_web", input: [
    { type: "compaction", id: "cmp_web", encrypted_content: encodeCompactionSummary("Keep the user's constraints") },
    { type: "reasoning", id: "rs_11111111111111111111111111111111", summary: [], encrypted_content: "ocxr1:fixture" },
    { type: "function_call", id: "fc_web", call_id: "call_keep", name: "exec_command", arguments: "{}" },
    { type: "function_call_output", call_id: "call_keep", output: "done" },
  ] };
  await forwardCustomProviderRequest(request(payload), provider, "responses", async forwarded => {
    const body = await forwarded.json();
    expect(body.model).toBe("custom-model");
    expect(body).not.toHaveProperty("previous_response_id");
    expect(body.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\n\nKeep the user's constraints` }] },
      { type: "function_call", call_id: "call_keep", name: "exec_command", arguments: "{}" },
      { type: "function_call_output", call_id: "call_keep", output: "done" },
    ]);
    return Response.json({ output: [] });
  });
});

test("known Web previous_response_id expands locally; unknown custom ids remain untouched", async () => {
  const root = mkdtempSync(join(tmpdir(), "mixed-provider-replay-"));
  const oldHome = process.env.CODEX_CHATGPT_WEB_HOME;
  process.env.CODEX_CHATGPT_WEB_HOME = root;
  try {
    const previousId = `resp_mixed_web_${crypto.randomUUID()}`;
    rememberResponseState({ input: [{ type: "message", id: "msg_old", role: "user", content: "old requirement" }] }, {
      id: previousId, status: "completed", output: [{ type: "message", id: "msg_web", role: "assistant", content: "web answer" }],
    });
    for (const previous_response_id of [previousId, "resp_unknown_custom"]) {
      await forwardCustomProviderRequest(request({ model: "custom-model", previous_response_id, input: "continue" }), provider, "responses", async forwarded => {
        const body = await forwarded.json();
        if (previous_response_id === previousId) {
          expect(body).not.toHaveProperty("previous_response_id");
          expect(body.input).toEqual([
            { type: "message", role: "user", content: "old requirement" },
            { type: "message", role: "assistant", content: "web answer" },
            { role: "user", content: "continue" },
          ]);
        } else expect(body).toEqual({ model: "custom-model", previous_response_id, input: "continue" });
        return Response.json({ output: [] });
      });
    }
  } finally {
    flushResponseState();
    if (oldHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
    else process.env.CODEX_CHATGPT_WEB_HOME = oldHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("custom upstream rejection and transport failure never retry or fall back", async () => {
  let calls = 0;
  const failed = await forwardCustomProviderRequest(request({ model: "custom-model" }), provider, "responses", async req => {
    calls++;
    expect(new URL(req.url).origin).toBe("https://gateway.example");
    return new Response("provider denied", { status: 429, headers: { "retry-after": "10" } });
  });
  expect(failed.status).toBe(429);
  expect(failed.headers.get("retry-after")).toBe("10");
  expect(await failed.text()).toBe("provider denied");
  await expect(forwardCustomProviderRequest(request({ model: "custom-model" }), provider, "responses", async () => {
    calls++;
    throw new Error("https://gateway.example?key=PRIVATE");
  })).rejects.toThrow("no fallback was attempted");
  expect(calls).toBe(2);
});

test("request cancellation and downstream reader cancellation reach the original transport", async () => {
  const abort = new AbortController();
  let cancelReason: unknown;
  let upstreamSignal: AbortSignal | undefined;
  const response = await forwardCustomProviderRequest(new Request(request({ model: "custom-model" }), { signal: abort.signal }), provider, "responses", async forwarded => {
    upstreamSignal = forwarded.signal;
    return new Response(new ReadableStream<Uint8Array>({ cancel(reason) { cancelReason = reason; } }));
  });
  abort.abort(new DOMException("fixture cancel", "AbortError"));
  expect(upstreamSignal!.aborted).toBe(true);
  await response.body!.cancel("client-reader-cancel");
  expect(cancelReason).toBe("client-reader-cancel");
});

test("cancelled requests and local bridge aliases cannot start an upstream call", async () => {
  let calls = 0;
  const fetchUpstream = async () => { calls++; return new Response("unexpected"); };
  const abort = new AbortController();
  abort.abort(new DOMException("cancelled before forwarding", "AbortError"));
  await expect(forwardCustomProviderRequest(new Request(request({ model: "custom-model" }), { signal: abort.signal }), provider, "responses", fetchUpstream)).rejects.toThrow("cancelled before forwarding");
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    await expect(forwardCustomProviderRequest(request({ model: "custom-model" }), {
      ...provider, baseUrl: `http://${host}:17841/v1`,
    }, "responses", fetchUpstream)).rejects.toThrow("local bridge");
  }
  expect(calls).toBe(0);
});

test("a redirect cannot disclose auth to a second local endpoint", async () => {
  let targetCalls = 0;
  const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { targetCalls++; return new Response("unexpected"); } });
  const gateway = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response(null, { status: 307, headers: { location: `${target.url}responses` } }); } });
  try {
    await expect(forwardCustomProviderRequest(request({ model: "custom-model" }), { ...provider, baseUrl: gateway.url.origin }, "responses", req => fetch(req))).rejects.toThrow("no fallback");
    expect(targetCalls).toBe(0);
  } finally { gateway.stop(true); target.stop(true); }
});
