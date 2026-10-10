const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { verifyMixedProviderCatalog } = require("../electron/mixed-provider.cjs");

function catalogFixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-mixed-catalog-"));
  const catalogPath = path.join(root, "models.json");
  const config = { customProvider: { providerId: "custom", catalogPath } };
  try {
    return run(config, models => fs.writeFileSync(catalogPath, JSON.stringify({ models })));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("local catalogue verification requires both sources and API-visible Web models", () => {
  catalogFixture((config, write) => {
    const api = { slug: "gpt-custom" };
    const web = { slug: "chatgpt-web/pro", supported_in_api: true };
    write([api, web]);
    assert.deepEqual(verifyMixedProviderCatalog(config), { apiModels: 1, webModels: 1 });
    write([api]);
    assert.throws(() => verifyMixedProviderCatalog(config), /include API and Web models/);
    write([web]);
    assert.throws(() => verifyMixedProviderCatalog(config), /include API and Web models/);
    write([api, { ...web, supported_in_api: false }]);
    assert.throws(() => verifyMixedProviderCatalog(config), /not enabled for API-key login/);
    write([api, api, web]);
    assert.throws(() => verifyMixedProviderCatalog(config), /duplicate/);
    fs.writeFileSync(config.customProvider.catalogPath, "invalid");
    assert.throws(() => verifyMixedProviderCatalog(config), /unreadable/);
  });
});

test("mixed provider preference cannot change an installed integration or login state", () => {
  const source = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
  const handlerSource = source.slice(source.indexOf('handle("launcher:set-preference",'), source.indexOf('handle("launcher:sidebar-state",'));
  const state = { mixedProvider: false };
  let installed = false;
  let busy = false;
  let handler;
  vm.runInNewContext(handlerSource, {
    IS_DEV_PROFILE: false,
    handle: (_name, callback) => { handler = callback; },
    stateStore: { update: patch => Object.assign(state, patch) },
    runtimeHost: { currentOperation: () => busy ? "setup" : null, runtimeConfigSnapshot: () => ({ configured: installed }) },
  });
  handler({}, "mixedProvider", true);
  assert.deepEqual(state, { mixedProvider: true });
  assert.throws(() => handler({}, "mixedProvider", "true"), /boolean/);
  installed = true;
  assert.throws(() => handler({}, "mixedProvider", false), /Remove the Codex integration/);
  assert.deepEqual(state, { mixedProvider: true });
  installed = false;
  busy = true;
  assert.throws(() => handler({}, "mixedProvider", false), /Finish the current operation/);
});

test("offline catalogue readiness never claims Codex loaded models or browser tools ran", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
  const start = source.indexOf("function startCatalogVerificationMonitor(");
  const monitorSource = source.slice(start, source.indexOf("\nfunction ", start + 1));
  const state = { coreSetupComplete: true, codexCatalogVerified: false, codexRestartRequired: true };
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  let reads = 0;
  vm.runInNewContext(monitorSource + "\nstartCatalogVerificationMonitor({ logger, stateStore });", {
    catalogVerificationInFlight: false, catalogVerificationTimer: null, lastOperation: null,
    stopCatalogVerificationMonitor() {},
    runtimeSupervisor: {
      readConfig: () => ({ customProvider: { providerId: "custom" } }),
      proxyHealthPayload: () => { throw new Error("API-key local catalogue must not wait for /models"); },
    },
    verifyMixedProviderCatalog: () => { reads++; return { apiModels: 1, webModels: 1 }; },
    stateStore: { read: () => state, update: patch => Object.assign(state, patch) },
    setInterval: () => ({ unref() {} }),
    logger: { info() {}, debug() {} }, send: () => resolveReady(), publishOperation() {},
  });
  await ready;
  assert.equal(reads, 1);
  assert.equal(state.codexLocalCatalogReady, true);
  assert.equal(state.codexCatalogVerified, false);
  assert.equal(state.codexRestartRequired, true);
  assert.equal(state.mcpSetupComplete, undefined);
});
