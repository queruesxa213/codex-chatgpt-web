import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, type AppConfig } from "../src/config";
import * as configModule from "../src/config";
import {
  activateCustomCodexIntegration, captureCustomProviderConfig, deactivateCustomCodexIntegration,
  getCustomCodexCatalogPath, getCustomCodexJournalPath, inspectCustomCodexIntegration,
  installCustomCodexIntegration, preflightCustomCodexIntegration, uninstallCustomCodexIntegration,
} from "../src/custom-codex-integration";

const roots: string[] = [];
const originalEnv = { codex: process.env.CODEX_HOME, bridge: process.env.CODEX_CHATGPT_WEB_HOME, profile: process.env.CODEX_PROFILE };
const original = [
  '# existing channel',
  'model_provider = "custom"',
  'model = "gpt-6-astra"',
  'model_reasoning_effort = "ultra"',
  'model_context_window = 600000',
  'model_auto_compact_token_limit = 500000',
  'service_tier = "fast"',
  '',
  '[model_providers.custom]',
  'name = "Existing channel"',
  "base_url = 'https://provider.example/v1' # keep exact quoting",
  'wire_api = "responses"',
  'env_key = "ORIGINAL_PROVIDER_KEY"',
  'requires_openai_auth = false',
  'http_headers = { "X-Existing" = "secret-header-value" }',
  '',
  '[mcp_servers.user_service]',
  'url = "https://tools.example/mcp"',
  '',
].join("\r\n");

function catalog() {
  return { models: [{
    slug: "gpt-6-astra", display_name: "6 Astra", description: "actual native metadata",
    supported_in_api: false, visibility: "list", priority: 1, tool_mode: "code_mode_only",
    context_window: 300000, max_context_window: 320000, auto_compact_token_limit: 270000,
    supported_reasoning_levels: [{ effort: "ultra", description: "Ultra" }], multi_agent_version: "v2",
    base_instructions: "real model instructions", input_modalities: ["text", "image"],
  }] };
}

function fixture(text = original) {
  const root = mkdtempSync(join(tmpdir(), "mixed-custom-codex-"));
  roots.push(root);
  const codexHome = join(root, "codex");
  const bridgeHome = join(root, "bridge");
  mkdirSync(codexHome);
  process.env.CODEX_HOME = codexHome;
  process.env.CODEX_CHATGPT_WEB_HOME = bridgeHome;
  delete process.env.CODEX_PROFILE;
  const configPath = join(codexHome, "config.toml");
  const authPath = join(codexHome, "auth.json");
  const auth = '{"auth_mode":"apikey","OPENAI_API_KEY":"secret-original-api-key"}\n';
  writeFileSync(configPath, text);
  writeFileSync(authPath, auth);
  const config: AppConfig = { ...defaultConfig("full"), subagentProtocol: "native",
    customProvider: captureCustomProviderConfig() };
  return { root, codexHome, bridgeHome, configPath, authPath, auth, config };
}

afterEach(() => {
  for (const [key, value] of [["CODEX_HOME", originalEnv.codex], ["CODEX_CHATGPT_WEB_HOME", originalEnv.bridge],
    ["CODEX_PROFILE", originalEnv.profile]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("mixed custom-provider integration lifecycle", () => {
  test("preflight is read-only and install/uninstall preserve API login, auth fields, MCP and exact config", () => {
    const f = fixture();
    const options = { nativeCatalog: catalog() };
    preflightCustomCodexIntegration(f.config, options);
    expect(readFileSync(f.configPath, "utf8")).toBe(original);
    expect(existsSync(f.bridgeHome)).toBe(false);
    const journal = installCustomCodexIntegration(f.config, options);
    expect(journal.providerId).toBe("custom");
    expect(journal.baseUrl).toBe("https://provider.example/v1");
    expect(readFileSync(f.authPath, "utf8")).toBe(f.auth);
    const installed = readFileSync(f.configPath, "utf8");
    expect(installed).toContain('model_provider = "custom"');
    expect(installed).toContain('base_url = "http://127.0.0.1:17841/v1" # keep exact quoting');
    expect(installed).toContain('env_key = "ORIGINAL_PROVIDER_KEY"');
    expect(installed).toContain('requires_openai_auth = false');
    expect(installed).toContain('http_headers = { "X-Existing" = "secret-header-value" }');
    expect(installed).toContain('[mcp_servers.user_service]');
    expect(installed).toContain('model_auto_compact_token_limit = 500000');
    const journalText = readFileSync(getCustomCodexJournalPath(), "utf8");
    expect(journalText).not.toContain("secret-original-api-key");
    expect(journalText).not.toContain("secret-header-value");
    const models = (JSON.parse(readFileSync(getCustomCodexCatalogPath(), "utf8")) as ReturnType<typeof catalog>).models;
    expect(models.find(row => row.slug === "gpt-6-astra")).toMatchObject({ supported_in_api: true,
      max_context_window: 600000, base_instructions: "real model instructions" });
    expect(models.some(row => row.slug.startsWith("chatgpt-web/"))).toBe(true);
    expect(inspectCustomCodexIntegration().errors).toEqual([]);
    expect(uninstallCustomCodexIntegration()).toEqual({ changed: true });
    expect(readFileSync(f.configPath, "utf8")).toBe(original);
    expect(readFileSync(f.authPath, "utf8")).toBe(f.auth);
    expect(existsSync(getCustomCodexCatalogPath())).toBe(false);
    expect(existsSync(getCustomCodexJournalPath())).toBe(false);
    expect(uninstallCustomCodexIntegration()).toEqual({ changed: false });
  });

  test("manual disconnect persists through capability refresh, recovery reconnect remains opt-in", () => {
    const f = fixture();
    installCustomCodexIntegration(f.config, { nativeCatalog: catalog() });
    const initialCatalog = readFileSync(getCustomCodexCatalogPath(), "utf8");
    expect(deactivateCustomCodexIntegration()).toEqual({ changed: true, active: false });
    expect(readFileSync(f.configPath, "utf8")).toBe(original);
    expect(activateCustomCodexIntegration({ recoveryOnly: true })).toEqual({ changed: false, active: false });
    const updated = { ...f.config, proAvailable: true };
    const journal = installCustomCodexIntegration(updated, { nativeCatalog: catalog(), preserveDisconnectedRoute: true });
    expect(journal.active).toBe(false);
    expect(readFileSync(f.configPath, "utf8")).toBe(original);
    expect(readFileSync(getCustomCodexCatalogPath(), "utf8")).not.toBe(initialCatalog);
    expect(activateCustomCodexIntegration()).toEqual({ changed: true, active: true });
    expect(activateCustomCodexIntegration()).toEqual({ changed: false, active: true });
    expect(inspectCustomCodexIntegration().errors).toEqual([]);
    expect(deactivateCustomCodexIntegration({ forRuntimeRecovery: true })).toEqual({ changed: true, active: false });
    expect(activateCustomCodexIntegration({ recoveryOnly: true })).toEqual({ changed: true, active: true });
    uninstallCustomCodexIntegration();
    expect(readFileSync(f.configPath, "utf8")).toBe(original);
  });

  test("explicit disconnect cancels automatic runtime recovery and reinstall updates the route reversibly", () => {
    const f = fixture();
    installCustomCodexIntegration(f.config, { nativeCatalog: catalog() });
    const updated = { ...f.config, port: f.config.port + 1 };
    installCustomCodexIntegration(updated, { nativeCatalog: catalog() });
    expect(readFileSync(f.configPath, "utf8")).toContain(`base_url = "http://127.0.0.1:${updated.port}/v1"`);
    deactivateCustomCodexIntegration({ forRuntimeRecovery: true });
    expect(deactivateCustomCodexIntegration()).toEqual({ changed: true, active: false });
    expect(activateCustomCodexIntegration({ recoveryOnly: true })).toEqual({ changed: false, active: false });
    activateCustomCodexIntegration();
    uninstallCustomCodexIntegration();
    expect(readFileSync(f.configPath, "utf8")).toBe(original);
  });

  test("Compatibility V1 hooks and flags restore exact user lines and preserve unrelated edits", () => {
    const before = original + '[features]\r\nmulti_agent = false # user\r\nmulti_agent_v2 = true # user\r\ngoals = true\r\n';
    const f = fixture(before);
    const config = { ...f.config, subagentProtocol: "compatibility-v1" as const };
    installCustomCodexIntegration(config, { nativeCatalog: catalog() });
    expect(readFileSync(f.configPath, "utf8")).toContain("multi_agent_v2 = false # Managed by codex-chatgpt-web");
    expect(inspectCustomCodexIntegration().errors).toEqual([]);
    writeFileSync(f.configPath, readFileSync(f.configPath, "utf8").replace("goals = true", "goals = false # newer edit"));
    deactivateCustomCodexIntegration();
    const expected = before.replace("goals = true", "goals = false # newer edit");
    expect(readFileSync(f.configPath, "utf8")).toBe(expected);
    activateCustomCodexIntegration();
    uninstallCustomCodexIntegration();
    expect(readFileSync(f.configPath, "utf8")).toBe(expected);
  });

  test("uses and restores a user's authoritative custom catalog without modifying it", () => {
    const f = fixture();
    const sourcePath = join(f.codexHome, "original-models.json");
    const source = JSON.stringify(catalog());
    writeFileSync(sourcePath, source);
    const before = original.replace('model = "gpt-6-astra"', `model = "gpt-6-astra"\r\nmodel_catalog_json = ${JSON.stringify(sourcePath)} # original catalog`);
    writeFileSync(f.configPath, before);
    installCustomCodexIntegration(f.config);
    expect(readFileSync(sourcePath, "utf8")).toBe(source);
    uninstallCustomCodexIntegration();
    expect(readFileSync(f.configPath, "utf8")).toBe(before);
    expect(readFileSync(sourcePath, "utf8")).toBe(source);
  });

  test.skipIf(!Bun.which("codex"))("the installed Codex accepts both model rosters with the original custom provider and API-key auth", () => {
    const f = fixture();
    const executable = Bun.which("codex")!;
    installCustomCodexIntegration(f.config, { codexExecutable: executable });
    // These local debug commands never perform inference or contact a model backend.
    const result = spawnSync(executable, ["debug", "models"], {
      encoding: "utf8", timeout: 15000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
      env: { ...process.env, CODEX_HOME: f.codexHome },
    });
    expect(result.status).toBe(0);
    const models = (JSON.parse(result.stdout) as { models: Array<{ slug: string; supported_in_api: boolean }> }).models;
    expect(models.find(model => model.slug === "gpt-6-astra")?.supported_in_api).toBe(true);
    expect(models.some(model => model.slug.startsWith("chatgpt-web/"))).toBe(true);
    expect(readFileSync(f.authPath, "utf8")).toBe(f.auth);
    uninstallCustomCodexIntegration();
    expect(readFileSync(f.configPath, "utf8")).toBe(original);
  });

  test("normalization of routing metadata preserves the provider's exact original trailing slash", () => {
    const before = original.replace("https://provider.example/v1", "https://provider.example/v1/");
    const f = fixture(before);
    f.config.customProvider!.baseUrl = "https://provider.example/v1";
    installCustomCodexIntegration(f.config, { nativeCatalog: catalog() });
    deactivateCustomCodexIntegration();
    expect(readFileSync(f.configPath, "utf8")).toBe(before);
    activateCustomCodexIntegration();
    uninstallCustomCodexIntegration();
    expect(readFileSync(f.configPath, "utf8")).toBe(before);
  });

  test("quoted provider IDs and inline provider tables edit only the base_url string", () => {
    const before = '\uFEFFmodel_provider = "channel.with.dot"\nmodel = "gpt-6-astra"\n'
      + '[model_providers]\n"channel.with.dot" = { name = "Channel", base_url = "https://provider.example/v1", wire_api = "responses", env_key = "KEY" }\n';
    const f = fixture(before);
    installCustomCodexIntegration(f.config, { nativeCatalog: catalog() });
    expect(readFileSync(f.configPath, "utf8")).toContain('"channel.with.dot" = { name = "Channel", base_url = "http://127.0.0.1:17841/v1", wire_api = "responses", env_key = "KEY" }');
    uninstallCustomCodexIntegration();
    expect(readFileSync(f.configPath, "utf8")).toBe(before);
  });

  test.each(["provider", "route", "catalog", "hook", "catalog-file"])("refuses %s drift without modifying config or auth", kind => {
    const f = fixture();
    installCustomCodexIntegration(f.config, { nativeCatalog: catalog() });
    let text = readFileSync(f.configPath, "utf8");
    if (kind === "provider") text = text.replace('model_provider = "custom"', 'model_provider = "other"');
    if (kind === "route") text = text.replace('base_url = "http://127.0.0.1:17841/v1"', 'base_url = "https://new-provider.example/v1"');
    if (kind === "catalog") text = text.replace(/^model_catalog_json = .+$/m, 'model_catalog_json = "elsewhere.json"');
    if (kind === "hook") text = text.replace('timeout = 3', 'timeout = 4');
    if (kind === "catalog-file") writeFileSync(getCustomCodexCatalogPath(), '{"models":[]}\n');
    writeFileSync(f.configPath, text);
    expect(() => uninstallCustomCodexIntegration()).toThrow();
    expect(() => installCustomCodexIntegration(f.config, { nativeCatalog: catalog(), replaceExistingRoute: true })).toThrow();
    expect(readFileSync(f.configPath, "utf8")).toBe(text);
    expect(readFileSync(f.authPath, "utf8")).toBe(f.auth);
    expect(inspectCustomCodexIntegration().errors.length).toBeGreaterThan(0);
  });

  test("rejects ambiguous profiles, unsupported wire APIs, credential URLs, recursive bridges and unknown model metadata", () => {
    const f = fixture();
    for (const text of [
      original.replace('model_provider = "custom"', 'profile = "alternate"\r\nmodel_provider = "custom"'),
      original.replace('wire_api = "responses"', 'wire_api = "chat"'),
      original.replace("https://provider.example/v1", "https://secret:password@provider.example/v1"),
      original.replace("https://provider.example/v1", "https://provider.example/v1?key=secret"),
      original.replace("https://provider.example/v1", "http://remote-provider.example/v1"),
    ]) {
      writeFileSync(f.configPath, text);
      expect(() => captureCustomProviderConfig()).toThrow();
      expect(readFileSync(f.configPath, "utf8")).toBe(text);
    }
    writeFileSync(f.configPath, original.replace("https://provider.example/v1", "http://127.0.0.1:17841/v1"));
    const recursive = { ...f.config, customProvider: captureCustomProviderConfig() };
    expect(() => installCustomCodexIntegration(recursive, { nativeCatalog: catalog() })).toThrow("point back");
    writeFileSync(f.configPath, original);
    expect(() => installCustomCodexIntegration(f.config, { nativeCatalog: { models: [{ slug: "another" }] } })).toThrow("authoritative");
    expect(existsSync(f.bridgeHome)).toBe(false);
  });

  test("a failed later write compensates earlier catalog/config writes", () => {
    const f = fixture();
    const write = configModule.atomicWriteFile;
    const written: string[] = [];
    const failure = spyOn(configModule, "atomicWriteFile").mockImplementation((path, data, options) => {
      if (path === getCustomCodexJournalPath()) throw new Error("injected journal write failure");
      written.push(path);
      write(path, data, options);
    });
    try {
      expect(() => installCustomCodexIntegration(f.config, { nativeCatalog: catalog() })).toThrow("injected journal");
    } finally { failure.mockRestore(); }
    expect(written).toContain(getCustomCodexCatalogPath());
    expect(written.filter(path => path === f.configPath).length).toBe(2);
    expect(readFileSync(f.configPath, "utf8")).toBe(original);
    expect(readFileSync(f.authPath, "utf8")).toBe(f.auth);
    expect(existsSync(getCustomCodexCatalogPath())).toBe(false);
    expect(existsSync(getCustomCodexJournalPath())).toBe(false);
  });

  test("rejects managed directory destinations before changing config", () => {
    const f = fixture();
    mkdirSync(getCustomCodexCatalogPath(), { recursive: true });
    expect(() => installCustomCodexIntegration(f.config, { nativeCatalog: catalog() })).toThrow("regular file");
    expect(readFileSync(f.configPath, "utf8")).toBe(original);
    expect(existsSync(getCustomCodexJournalPath())).toBe(false);
  });

  test("rejects orphan catalog data and invalid journal restoration metadata without overwriting either", () => {
    const f = fixture();
    mkdirSync(join(f.bridgeHome, "codex"), { recursive: true });
    writeFileSync(getCustomCodexCatalogPath(), "orphan data");
    expect(() => installCustomCodexIntegration(f.config, { nativeCatalog: catalog() })).toThrow("without its journal");
    expect(readFileSync(getCustomCodexCatalogPath(), "utf8")).toBe("orphan data");
    expect(readFileSync(f.configPath, "utf8")).toBe(original);
    rmSync(getCustomCodexCatalogPath());
    const journal = installCustomCodexIntegration(f.config, { nativeCatalog: catalog() });
    const before = readFileSync(f.configPath, "utf8");
    writeFileSync(getCustomCodexJournalPath(), JSON.stringify({ ...journal,
      previousBaseUrlLiteral: '"https://provider.example/v1"\nnew_setting = true' }));
    expect(() => uninstallCustomCodexIntegration()).toThrow("invalid original base_url literal");
    expect(readFileSync(f.configPath, "utf8")).toBe(before);
  });

  test.skipIf(process.platform === "win32")("rejects managed symlink destinations without following or replacing them", () => {
    const f = fixture();
    const target = join(f.root, "outside.json");
    writeFileSync(target, "untouched");
    mkdirSync(join(f.bridgeHome, "codex"), { recursive: true });
    symlinkSync(target, getCustomCodexCatalogPath());
    expect(() => installCustomCodexIntegration(f.config, { nativeCatalog: catalog() })).toThrow("regular file");
    expect(readFileSync(target, "utf8")).toBe("untouched");
    expect(readFileSync(f.configPath, "utf8")).toBe(original);
  });
});
