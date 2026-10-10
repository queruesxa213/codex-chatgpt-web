import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { getStaticTOMLValue, parseTOML, type AST } from "toml-eslint-parser";
import type { AppConfig } from "./config";
import { expandUserPath, getConfigDir, stripUtf8Bom } from "./config";
import {
  firstTableIndex, insertDocumentLine, installCompatibilityV1Features,
  parseDocument, readCodexModelContextOverride, removeDocumentLine, renderDocument,
  restoreCompatibilityV1Features, verifyCompatibilityV1Features,
} from "./codex-integration-document";
import {
  getCodexConfigPath, getCodexJournalPath, getCodexJournalRecoveryPath, getCodexModelsCachePath, routeUrl, sha256,
  snapshotFile, writeFilesWithCompensation,
  type InstalledCodexInterruptHook, type PreviousAssignment,
} from "./codex-integration-shared";
import {
  installCodexInterruptHook, installCodexInterruptHookCommand, restoreCodexInterruptHook,
  verifyCodexInterruptHook, verifyCodexInterruptHookRestored,
} from "./codex-interrupt-hook";
import { augmentNativeModelCatalog } from "./model-catalog";
import { validateCustomProviderConfig } from "./custom-provider";

/** Routing metadata only. Authentication remains in Codex's provider table/auth store. */
export interface CapturedCustomProviderConfig {
  providerId: string;
  baseUrl: string;
  catalogPath: string;
}

type CompatibilityFeatures = Omit<ReturnType<typeof installCompatibilityV1Features>, "text">;
type JsonObject = Record<string, unknown>;
type Assignment = { value: AST.TOMLContentNode; start: number; end: number; line: number };
const CATALOG_MARKER = "# Managed by codex-chatgpt-web: mixed custom and Web models.";
const MAX_CATALOG_BYTES = 16 * 1024 * 1024;

export interface CustomCodexIntegrationJournal {
  version: 1;
  kind: "custom-provider";
  active: boolean;
  configPath: string;
  providerId: string;
  baseUrl: string;
  originalModel: string;
  catalogPath: string;
  catalogSha256: string;
  previousBaseUrlLiteral: string;
  previous: Record<"model_provider" | "model_catalog_json" | "openai_base_url", PreviousAssignment>;
  installed: {
    base_url: string;
    /** Common status surface used by the native integration UI. */
    openai_base_url: string;
    subagent_protocol: AppConfig["subagentProtocol"];
    agent_max_depth?: number;
  };
  interruptHook: InstalledCodexInterruptHook;
  features?: CompatibilityFeatures;
  reconnectOnStartup?: true;
}

export interface CustomCodexIntegrationOptions {
  codexExecutable?: string;
  /** An authoritative offline catalog, used by validation/tests without invoking Codex. */
  nativeCatalog?: unknown;
  preserveDisconnectedRoute?: boolean;
  replaceExistingRoute?: boolean;
}

export function getCustomCodexJournalPath(): string {
  return join(getConfigDir(), "codex", "custom-integration-journal.json");
}

export function getCustomCodexCatalogPath(): string {
  return join(getConfigDir(), "codex", "custom-model-catalog.json");
}

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function document(text: string): JsonObject {
  try { return Bun.TOML.parse(stripUtf8Bom(text).replace(/\r\n?/g, "\n")) as JsonObject; }
  catch { throw new Error("Codex config.toml is not valid TOML; no configuration has been changed"); }
}

function ast(text: string): AST.TOMLProgram {
  try { return parseTOML(stripUtf8Bom(text).replace(/\r(?!\n)/g, "\n"), { tomlVersion: "1.0" }); }
  catch { throw new Error("Codex config.toml is not valid TOML; no configuration has been changed"); }
}

/** Locate semantic keys, including quoted provider IDs, dotted keys and inline tables. */
function assignment(text: string, path: string[]): Assignment | undefined {
  const offset = text.startsWith("\uFEFF") ? 1 : 0;
  const same = (key: unknown[]) => key.length === path.length && key.every((part, index) => part === path[index]);
  const visit = (entry: AST.TOMLKeyValue, prefix: string[]): Assignment | undefined => {
    const key = [...prefix, ...getStaticTOMLValue(entry.key)];
    if (same(key)) return {
      value: entry.value, start: entry.value.range[0] + offset,
      end: entry.value.range[1] + offset, line: entry.loc.start.line - 1,
    };
    if (entry.value.type === "TOMLInlineTable") {
      for (const child of entry.value.body) {
        const found = visit(child, key);
        if (found) return found;
      }
    }
  };
  for (const node of ast(text).body[0].body) {
    if (node.type === "TOMLTable") {
      if (node.resolvedKey.some(part => typeof part !== "string")) continue;
      for (const entry of node.body) {
        const found = visit(entry, node.resolvedKey as string[]);
        if (found) return found;
      }
    } else {
      const found = visit(node, []);
      if (found) return found;
    }
  }
}

function replaceValue(text: string, path: string[], literal: string): string {
  const found = assignment(text, path);
  if (!found) throw new Error("A managed Codex configuration field is missing; refusing to overwrite configuration");
  return text.slice(0, found.start) + literal + text.slice(found.end);
}

function topAssignment(text: string, key: string): PreviousAssignment {
  const found = assignment(text, [key]);
  if (!found) return { present: false };
  const value = getStaticTOMLValue(found.value);
  if (typeof value !== "string" || found.value.loc.start.line !== found.value.loc.end.line) {
    throw new Error(`Codex ${key} must be a single-line string for reversible mixed-provider setup`);
  }
  return { present: true, value, rawLine: parseDocument(text).lines[found.line], index: found.line };
}

function selectedProvider(text: string): { providerId: string; model: string; baseUrl: string } {
  const config = document(text);
  if (config.profile !== undefined || process.env.CODEX_PROFILE?.trim()) {
    throw new Error("Mixed custom-provider setup requires the unambiguous top-level Codex provider; disable the selected profile first");
  }
  const providerId = config.model_provider;
  if (typeof providerId !== "string" || !providerId || providerId === "openai" || providerId === "oss") {
    throw new Error("Select an existing non-built-in Codex model_provider before enabling mixed custom/Web models");
  }
  if (typeof config.model !== "string" || !config.model) throw new Error("The custom Codex provider must have a selected model");
  const providers = config.model_providers;
  const provider = object(providers) ? providers[providerId] : undefined;
  if (!object(provider) || provider.wire_api !== "responses") {
    throw new Error("Mixed custom/Web models require an existing provider with wire_api = \"responses\"");
  }
  if (typeof provider.base_url !== "string" || !provider.base_url) throw new Error("The custom Codex provider must have an explicit base_url");
  validateCustomProviderConfig({ providerId, baseUrl: provider.base_url, catalogPath: getCustomCodexCatalogPath() });
  return { providerId, model: config.model, baseUrl: provider.base_url };
}

function validateBaseUrl(value: string, bridgeUrl?: string): void {
  validateCustomProviderConfig({ providerId: "custom", baseUrl: value, catalogPath: getCustomCodexCatalogPath() });
  const url = new URL(value);
  const bridge = bridgeUrl ? new URL(bridgeUrl) : undefined;
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (bridge && (url.origin === bridge.origin || (loopback && url.port === bridge.port))) {
    throw new Error("The original custom provider cannot point back to this local bridge");
  }
}

function configText(): string {
  const snapshot = snapshotFile(getCodexConfigPath(), { followSymlink: true });
  if (!snapshot.exists) throw new Error("Codex config.toml is missing; configure the custom provider first");
  return snapshot.data!.toString("utf8");
}

function validateDestination(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Managed custom integration destination is not a regular file");
}

export function readCustomCodexIntegrationJournal(): CustomCodexIntegrationJournal | undefined {
  const path = getCustomCodexJournalPath();
  if (!existsSync(path)) return undefined;
  validateDestination(path);
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error("The custom integration journal is invalid; refusing to overwrite Codex configuration"); }
  if (!object(value) || value.version !== 1 || value.kind !== "custom-provider"
    || typeof value.active !== "boolean" || typeof value.providerId !== "string"
    || typeof value.baseUrl !== "string" || typeof value.originalModel !== "string"
    || typeof value.previousBaseUrlLiteral !== "string" || typeof value.catalogSha256 !== "string"
    || !object(value.previous) || !object(value.installed) || !object(value.interruptHook)
    || value.configPath !== getCodexConfigPath() || value.catalogPath !== getCustomCodexCatalogPath()
    || typeof value.installed.base_url !== "string" || value.installed.openai_base_url !== value.installed.base_url
    || !["native", "compatibility-v1"].includes(String(value.installed.subagent_protocol))) {
    throw new Error("The custom integration journal is invalid or belongs to another configuration; refusing to overwrite configuration");
  }
  validateBaseUrl(value.baseUrl, value.installed.base_url);
  if (!/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(value.installed.base_url)) {
    throw new Error("The custom integration journal has an invalid installed loopback route");
  }
  try {
    const literal = document(`value = ${value.previousBaseUrlLiteral}`);
    if (Object.keys(literal).length !== 1 || literal.value !== value.baseUrl) throw new Error();
  } catch { throw new Error("The custom integration journal has an invalid original base_url literal"); }
  for (const key of ["model_provider", "model_catalog_json", "openai_base_url"]) {
    const previous = value.previous[key];
    if (!object(previous) || typeof previous.present !== "boolean"
      || (previous.present && (typeof previous.rawLine !== "string" || typeof previous.value !== "string"))) {
      throw new Error("The custom integration journal has invalid prior assignments");
    }
    if (previous.present) {
      try {
        const parsed = document(previous.rawLine as string);
        if (/[\r\n]/.test(previous.rawLine as string) || Object.keys(parsed).length !== 1
          || parsed[key] !== previous.value) throw new Error();
      } catch { throw new Error("The custom integration journal has an invalid original assignment"); }
    }
  }
  if (value.installed.subagent_protocol === "compatibility-v1" && !object(value.features)) {
    throw new Error("The custom integration journal is missing Compatibility V1 restoration metadata");
  }
  return value as unknown as CustomCodexIntegrationJournal;
}

function verifyCatalog(journal: CustomCodexIntegrationJournal): void {
  validateDestination(journal.catalogPath);
  if (!existsSync(journal.catalogPath) || sha256(readFileSync(journal.catalogPath)) !== journal.catalogSha256) {
    throw new Error("The managed mixed-model catalog is missing or changed; refusing to overwrite newer data");
  }
}

function verifyState(text: string, journal: CustomCodexIntegrationJournal): void {
  const selected = selectedProvider(text);
  if (selected.providerId !== journal.providerId) throw new Error("Codex model_provider changed after mixed setup; refusing to overwrite the selected provider");
  const expectedUrl = journal.active ? journal.installed.base_url : journal.baseUrl;
  if (selected.baseUrl !== expectedUrl) throw new Error("The custom provider base_url changed after mixed setup; refusing to overwrite the newer route");
  const catalog = topAssignment(text, "model_catalog_json");
  const expectedCatalog = journal.active ? journal.catalogPath : journal.previous.model_catalog_json.value;
  if (catalog.present !== (journal.active || journal.previous.model_catalog_json.present) || catalog.value !== expectedCatalog) {
    throw new Error("Codex model_catalog_json changed after mixed setup; refusing to overwrite the newer catalog");
  }
  if (journal.active) {
    verifyCodexInterruptHook(stripUtf8Bom(text), journal.interruptHook);
    if (journal.features) verifyCompatibilityV1Features(text, journal.features.previousMultiAgentV2, journal.features.installedAgentMaxDepth);
  } else {
    verifyCodexInterruptHookRestored(stripUtf8Bom(text));
  }
  verifyCatalog(journal);
}

function restore(text: string, journal: CustomCodexIntegrationJournal): string {
  verifyState(text, journal);
  if (!journal.active) return text;
  let restored = (text.startsWith("\uFEFF") ? "\uFEFF" : "")
    + restoreCodexInterruptHook(stripUtf8Bom(text), journal.interruptHook);
  if (journal.features) {
    const f = journal.features;
    restored = restoreCompatibilityV1Features(restored, f.previousMultiAgent, f.previousMultiAgentV2,
      f.previousAgentMaxDepth, f.installedAgentMaxDepth);
  }
  restored = replaceValue(restored, ["model_providers", journal.providerId, "base_url"], journal.previousBaseUrlLiteral);
  const previous = journal.previous.model_catalog_json;
  if (previous.present) {
    // Restore the complete original assignment, including the user's comment and quoting.
    const found = assignment(restored, ["model_catalog_json"]);
    if (!found) throw new Error("Managed model_catalog_json is missing");
    const doc = parseDocument(restored);
    doc.lines[found.line] = previous.rawLine!;
    restored = renderDocument(doc);
  } else {
    const found = assignment(restored, ["model_catalog_json"]);
    if (!found) throw new Error("Managed model_catalog_json is missing");
    const doc = parseDocument(restored);
    if (!doc.lines[found.line]?.includes(CATALOG_MARKER)) throw new Error("The managed model_catalog_json assignment changed after setup");
    removeDocumentLine(doc, found.line);
    restored = renderDocument(doc);
  }
  return restored;
}

function baseCatalog(text: string, options: CustomCodexIntegrationOptions): unknown {
  if (options.nativeCatalog !== undefined) return options.nativeCatalog;
  const previous = topAssignment(text, "model_catalog_json");
  if (previous.present) {
    const configured = expandUserPath(previous.value!);
    const path = isAbsolute(configured) ? configured : resolve(join(getCodexConfigPath(), ".."), configured);
    try {
      const stat = statSync(path);
      if (!stat.isFile() || stat.size > MAX_CATALOG_BYTES) throw new Error();
      const data = readFileSync(path);
      if (data.byteLength > MAX_CATALOG_BYTES) throw new Error();
      return JSON.parse(data.toString("utf8"));
    }
    catch { throw new Error("The configured original model catalog could not be read as JSON; no configuration has been changed"); }
  }
  const executable = options.codexExecutable ?? Bun.which("codex") ?? "codex";
  const result = spawnSync(executable, ["debug", "models", "--bundled"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000,
    maxBuffer: 16 * 1024 * 1024, windowsHide: true,
  });
  if (result.status !== 0 || result.error) {
    // Never include stderr: Codex may print configuration credentials in its diagnostics.
    throw new Error("Could not load the installed Codex bundled model catalog; supply a working Codex executable or an explicit model_catalog_json");
  }
  try { return JSON.parse(result.stdout); }
  catch { throw new Error("The installed Codex bundled model catalog is not valid JSON"); }
}

function mergedCatalog(text: string, config: AppConfig, model: string, options: CustomCodexIntegrationOptions): string {
  const source = baseCatalog(text, options);
  if (!object(source) || !Array.isArray(source.models)) throw new Error("The original model catalog must contain a models array");
  const cloned = structuredClone(source);
  const models = cloned.models as unknown[];
  const selected = models.find(row => object(row) && row.slug === model);
  if (!object(selected) || !Array.isArray(selected.supported_reasoning_levels)
    || typeof selected.context_window !== "number" || !Number.isSafeInteger(selected.context_window) || selected.context_window <= 0) {
    throw new Error("The selected custom model has no authoritative reasoning/context metadata in the original catalog; add its actual metadata to model_catalog_json first");
  }
  // The user already selected this model on a Responses provider. Advertise its existing
  // metadata in API-key mode rather than fabricating a different model's capabilities.
  selected.supported_in_api = true;
  selected.visibility = "list";
  const serialized = `${JSON.stringify(augmentNativeModelCatalog(cloned, config, readCodexModelContextOverride()), null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_CATALOG_BYTES) throw new Error("The merged model catalog exceeds the 16 MiB runtime limit");
  return serialized;
}

function installText(baseline: string, config: AppConfig, installedUrl: string,
  providerId: string, catalogPath: string, interruptCommand?: string): {
  text: string; interruptHook: InstalledCodexInterruptHook; features?: CompatibilityFeatures;
} {
  let text = replaceValue(baseline, ["model_providers", providerId, "base_url"], JSON.stringify(installedUrl));
  if (assignment(text, ["model_catalog_json"])) {
    text = replaceValue(text, ["model_catalog_json"], JSON.stringify(catalogPath));
  } else {
    const doc = parseDocument(text);
    insertDocumentLine(doc, firstTableIndex(doc.lines), `model_catalog_json = ${JSON.stringify(catalogPath)} ${CATALOG_MARKER}`);
    text = renderDocument(doc);
  }
  let features: CompatibilityFeatures | undefined;
  if (config.subagentProtocol === "compatibility-v1") {
    const result = installCompatibilityV1Features(text);
    text = result.text;
    const { text: _text, ...metadata } = result;
    features = metadata;
  }
  const hook = interruptCommand
    ? installCodexInterruptHookCommand(stripUtf8Bom(text), getCodexConfigPath(), interruptCommand)
    : installCodexInterruptHook(stripUtf8Bom(text), getCodexConfigPath(), config);
  return { text: (text.startsWith("\uFEFF") ? "\uFEFF" : "") + hook.text,
    interruptHook: hook.installed, ...(features ? { features } : {}) };
}

export function captureCustomProviderConfig(_codexExecutable?: string): CapturedCustomProviderConfig {
  if (existsSync(getCodexJournalPath()) || existsSync(getCodexJournalRecoveryPath())) {
    throw new Error("Uninstall the existing native Codex integration before enabling mixed custom/Web models");
  }
  const text = configText();
  const existing = readCustomCodexIntegrationJournal();
  if (existing) {
    verifyState(text, existing);
    return { providerId: existing.providerId, baseUrl: existing.baseUrl, catalogPath: existing.catalogPath };
  }
  const selected = selectedProvider(text);
  validateBaseUrl(selected.baseUrl);
  if (selected.model.startsWith("chatgpt-web/")) throw new Error("Select an original custom-provider model before first installing mixed custom/Web models");
  return { providerId: selected.providerId, baseUrl: selected.baseUrl, catalogPath: getCustomCodexCatalogPath() };
}

function prepared(config: AppConfig, options: CustomCodexIntegrationOptions): {
  journal: CustomCodexIntegrationJournal; text: string; catalog: string;
} {
  const custom = config.customProvider;
  if (!custom) throw new Error("Mixed custom/Web models require explicit customProvider configuration");
  const captured = captureCustomProviderConfig(options.codexExecutable);
  const canonicalUrl = (value: string) => new URL(value).href.replace(/\/+$/, "");
  if (captured.providerId !== custom.providerId || canonicalUrl(captured.baseUrl) !== canonicalUrl(custom.baseUrl)
    || custom.catalogPath !== getCustomCodexCatalogPath()) {
    throw new Error("The custom provider snapshot no longer matches Codex; recapture it before installing");
  }
  validateBaseUrl(custom.baseUrl, routeUrl(config));
  validateDestination(getCustomCodexCatalogPath());
  validateDestination(getCustomCodexJournalPath());
  const current = configText();
  const existing = readCustomCodexIntegrationJournal();
  if (!existing && existsSync(custom.catalogPath)) {
    throw new Error("The generated mixed-model catalog already exists without its journal; recover or move it before installing");
  }
  const baseline = existing ? restore(current, existing) : current;
  const selected = selectedProvider(baseline);
  const originalModel = existing?.originalModel ?? selected.model;
  const catalog = mergedCatalog(baseline, config, originalModel, options);
  const installed = installText(baseline, config, routeUrl(config), custom.providerId, custom.catalogPath);
  const previous = existing?.previous ?? {
    model_provider: topAssignment(baseline, "model_provider"),
    model_catalog_json: topAssignment(baseline, "model_catalog_json"),
    // This native-only field is never owned by mixed integration or copied to its journal.
    openai_base_url: { present: false },
  };
  const previousBaseUrlLiteral = existing?.previousBaseUrlLiteral
    ?? (() => { const key = assignment(baseline, ["model_providers", custom.providerId, "base_url"])!;
      return baseline.slice(key.start, key.end); })();
  const active = !(existing?.active === false && options.preserveDisconnectedRoute !== false);
  const journal: CustomCodexIntegrationJournal = {
    version: 1, kind: "custom-provider", active, configPath: getCodexConfigPath(),
    providerId: custom.providerId, baseUrl: captured.baseUrl, originalModel, catalogPath: custom.catalogPath,
    catalogSha256: sha256(catalog), previousBaseUrlLiteral, previous,
    installed: { base_url: routeUrl(config), openai_base_url: routeUrl(config), subagent_protocol: config.subagentProtocol,
      ...(installed.features ? { agent_max_depth: installed.features.installedAgentMaxDepth } : {}) },
    interruptHook: installed.interruptHook,
    ...(installed.features ? { features: installed.features } : {}),
    ...(existing?.reconnectOnStartup && !active ? { reconnectOnStartup: true } : {}),
  };
  return { journal, text: active ? installed.text : baseline, catalog };
}

export function preflightCustomCodexIntegration(config: AppConfig, options: CustomCodexIntegrationOptions = {}): void {
  prepared(config, options);
}

export function installCustomCodexIntegration(config: AppConfig, options: CustomCodexIntegrationOptions = {}): CustomCodexIntegrationJournal {
  const result = prepared(config, options);
  writeFilesWithCompensation([
    { path: result.journal.catalogPath, data: result.catalog },
    { path: result.journal.configPath, data: result.text, followSymlink: true },
    { path: getCustomCodexJournalPath(), data: `${JSON.stringify(result.journal, null, 2)}\n` },
  ], [getCodexModelsCachePath()]);
  return result.journal;
}

function writeState(journal: CustomCodexIntegrationJournal, text?: string): void {
  validateDestination(getCustomCodexJournalPath());
  writeFilesWithCompensation([
    ...(text === undefined ? [] : [{ path: journal.configPath, data: text, followSymlink: true }]),
    { path: getCustomCodexJournalPath(), data: `${JSON.stringify(journal, null, 2)}\n` },
  ], text === undefined ? [] : [getCodexModelsCachePath()]);
}

export function deactivateCustomCodexIntegration(options: { forRuntimeRecovery?: boolean } = {}): { changed: boolean; active: boolean } {
  const journal = readCustomCodexIntegrationJournal();
  if (!journal) return { changed: false, active: false };
  const current = configText();
  verifyState(current, journal);
  if (!journal.active) {
    if (!options.forRuntimeRecovery && journal.reconnectOnStartup) {
      delete journal.reconnectOnStartup;
      writeState(journal);
      return { changed: true, active: false };
    }
    return { changed: false, active: false };
  }
  const restored = restore(current, journal);
  journal.active = false;
  if (options.forRuntimeRecovery) journal.reconnectOnStartup = true;
  else delete journal.reconnectOnStartup;
  writeState(journal, restored);
  return { changed: true, active: false };
}

export function activateCustomCodexIntegration(options: { recoveryOnly?: boolean } = {}): { changed: boolean; active: boolean } {
  const journal = readCustomCodexIntegrationJournal();
  if (!journal) throw new Error("Mixed custom/Web integration is not installed");
  const current = configText();
  verifyState(current, journal);
  if (journal.active) return { changed: false, active: true };
  if (options.recoveryOnly && !journal.reconnectOnStartup) return { changed: false, active: false };
  // Reuse the installed command and protocol; reconnect does not need a browser or a Codex login.
  const config = { subagentProtocol: journal.installed.subagent_protocol } as AppConfig;
  const installed = installText(current, config, journal.installed.base_url, journal.providerId,
    journal.catalogPath, journal.interruptHook.command);
  journal.active = true;
  journal.interruptHook = installed.interruptHook;
  journal.features = installed.features;
  if (installed.features) journal.installed.agent_max_depth = installed.features.installedAgentMaxDepth;
  else delete journal.installed.agent_max_depth;
  delete journal.reconnectOnStartup;
  writeState(journal, installed.text);
  return { changed: true, active: true };
}

export function uninstallCustomCodexIntegration(): { changed: boolean } {
  const journal = readCustomCodexIntegrationJournal();
  if (!journal) return { changed: false };
  const current = configText();
  const restored = restore(current, journal);
  writeFilesWithCompensation([{ path: journal.configPath, data: restored, followSymlink: true }],
    [journal.catalogPath, getCustomCodexJournalPath(), getCodexModelsCachePath()]);
  return { changed: true };
}

export function inspectCustomCodexIntegration(): {
  installed: boolean; active: boolean; configPath: string; routeUrl?: string;
  journal?: CustomCodexIntegrationJournal; errors: string[];
} {
  let journal: CustomCodexIntegrationJournal | undefined;
  const errors: string[] = [];
  try {
    journal = readCustomCodexIntegrationJournal();
    if (journal) verifyState(configText(), journal);
  } catch (error) { errors.push(error instanceof Error ? error.message : "Custom integration validation failed"); }
  return { installed: Boolean(journal) || existsSync(getCustomCodexJournalPath()), active: journal?.active ?? false,
    configPath: getCodexConfigPath(), ...(journal ? { routeUrl: journal.installed.base_url, journal } : {}), errors };
}
