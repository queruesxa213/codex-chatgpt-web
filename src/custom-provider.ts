import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, win32 } from "node:path";
import { readJsonRequestBody } from "./http-body";
import { fetchNativeCodex } from "./native-network";
import { scrubBridgeArtifactsForNative, type NativeCodexEndpoint, type NativeFetch } from "./native-passthrough";
import { expandPreviousResponseInput } from "./responses/state";

/** Only routing metadata is persisted here. Codex continues to own provider credentials. */
export interface CustomProviderConfig {
  providerId: string;
  baseUrl: string;
  catalogPath: string;
}

const MAX_CATALOG_BYTES = 16 * 1024 * 1024;
const EXCLUDED_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade", "host", "content-length", "cookie", "cookie2", "set-cookie",
  "origin", "referer", "x-codex-chatgpt-web-control-token",
]);

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function loopbackHost(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
}

export function validateCustomProviderConfig(value: unknown): CustomProviderConfig {
  if (!object(value)) throw new Error("Custom provider configuration must be an object");
  if (typeof value.providerId !== "string" || !value.providerId.trim() || value.providerId.length > 128
    || /[\u0000-\u001f\u007f/\\]/.test(value.providerId)
    || ["openai", "ollama", "lmstudio", "amazon-bedrock"].includes(value.providerId)) {
    throw new Error("Custom provider requires a non-official provider identifier");
  }
  let url: URL;
  try {
    if (typeof value.baseUrl !== "string" || value.baseUrl !== value.baseUrl.trim()) throw new Error();
    url = new URL(value.baseUrl);
  } catch {
    throw new Error("Custom provider base URL must be an absolute HTTPS or loopback HTTP URL");
  }
  const loopback = loopbackHost(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error("Custom provider base URL requires HTTPS or loopback HTTP, without credentials, query or fragment");
  }
  if (typeof value.catalogPath !== "string" || !value.catalogPath.trim()
    || !(isAbsolute(value.catalogPath) || win32.isAbsolute(value.catalogPath))) {
    throw new Error("Custom provider catalog path must be absolute");
  }
  return { providerId: value.providerId, baseUrl: url.href.replace(/\/+$/, ""), catalogPath: value.catalogPath };
}

/** The installer already merged both rosters. Discovery never contacts an authenticated backend. */
export function readCustomProviderCatalog(value: CustomProviderConfig): Record<string, unknown> {
  const config = validateCustomProviderConfig(value);
  let fd: number | undefined;
  let text: string;
  try {
    fd = openSync(config.catalogPath, "r");
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_CATALOG_BYTES) throw new Error();
    // Bound both allocation and total reads, and reject a file that changes size while reading.
    const buffer = Buffer.alloc(stat.size);
    let read = 0;
    while (read < buffer.length) {
      const count = readSync(fd, buffer, read, buffer.length - read, read);
      if (!count) break;
      read += count;
    }
    if (read !== stat.size || fstatSync(fd).size !== stat.size) throw new Error();
    text = new TextDecoder("utf8", { fatal: true }).decode(buffer.subarray(0, read));
  } catch {
    throw new Error("Custom provider model catalog could not be read within the 16 MiB limit");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  let catalog: unknown;
  try { catalog = JSON.parse(text); } catch { throw new Error("Custom provider model catalog must be valid JSON"); }
  if (!object(catalog) || !Array.isArray(catalog.models)
    || catalog.models.some(model => !object(model) || typeof model.slug !== "string" || !model.slug)) {
    throw new Error("Custom provider model catalog must contain a models array with model slugs");
  }
  return catalog;
}

function endToEndHeaders(source: Headers): Headers {
  const excluded = new Set(EXCLUDED_HEADERS);
  // RFC 9110: Connection may name additional hop-specific fields, including private proxy auth.
  for (const name of (source.get("connection") ?? "").split(",")) excluded.add(name.trim().toLowerCase());
  const headers = new Headers();
  for (const [name, value] of source) {
    if (!excluded.has(name.toLowerCase())) headers.append(name, value);
  }
  return headers;
}

function customHistory(body: unknown): { value: unknown; changed: boolean } {
  const expanded = expandPreviousResponseInput(body);
  const scrubbed = scrubBridgeArtifactsForNative(expanded);
  if (expanded === body) return scrubbed;
  // The continuation cache contains locally produced Web responses. A known local response id
  // cannot refer to a response stored by the custom gateway, even when it has no reasoning item.
  const clean = { ...(scrubbed.value as Record<string, unknown>) };
  delete clean.previous_response_id;
  if (Array.isArray(clean.input)) clean.input = clean.input.map(item => {
    if (!object(item)) return item;
    const copy = { ...item };
    delete copy.id;
    return copy;
  });
  return { value: clean, changed: true };
}

export async function forwardCustomProviderRequest(
  request: Request,
  value: CustomProviderConfig,
  endpoint: NativeCodexEndpoint,
  fetchUpstream: NativeFetch = fetchNativeCodex,
  decodedBody?: unknown,
): Promise<Response> {
  request.signal.throwIfAborted();
  const config = validateCustomProviderConfig(value);
  const incomingUrl = new URL(request.url);
  const target = new URL(`${config.baseUrl}/${endpoint}`);
  const port = (url: URL) => url.port || (url.protocol === "https:" ? "443" : "80");
  if (target.origin === incomingUrl.origin
    || (loopbackHost(target.hostname) && loopbackHost(incomingUrl.hostname) && port(target) === port(incomingUrl))) {
    throw new Error("Custom provider cannot forward back to the local bridge");
  }
  target.search = incomingUrl.search;
  const headers = endToEndHeaders(request.headers);
  const method = endpoint === "models" ? "GET" : "POST";
  let body: BodyInit | undefined;
  if (method === "POST") {
    const parseRequest = decodedBody === undefined ? request.clone() : undefined;
    const original = await request.arrayBuffer();
    // Standalone images and search retain their own protocol; only Responses has replay history.
    if (endpoint === "responses" || endpoint === "responses/compact") {
      const decoded = decodedBody === undefined ? await readJsonRequestBody(parseRequest!) : decodedBody;
      const history = customHistory(decoded);
      if (history.changed) {
        headers.delete("content-encoding");
        body = JSON.stringify(history.value);
      } else body = original;
    } else body = original;
  }
  const upstreamRequest = new Request(target, {
    method, headers, ...(body !== undefined ? { body } : {}), signal: request.signal,
    // Following a gateway redirect could disclose the existing API key to another destination.
    redirect: "error",
  });
  let upstream: Response;
  try {
    request.signal.throwIfAborted();
    upstream = await fetchUpstream(upstreamRequest);
  } catch (error) {
    if (request.signal.aborted) throw request.signal.reason ?? new DOMException("Request cancelled", "AbortError");
    // Fetch errors can contain the destination URL/query. Never echo provider credentials.
    throw new Error("Custom provider request failed; no fallback was attempted", { cause: error });
  }
  const responseHeaders = endToEndHeaders(upstream.headers);
  // Bun fetch exposes decoded bytes. Preserve the stream, status, and provider error body while
  // dropping wire encoding metadata so Codex does not decompress those bytes a second time.
  responseHeaders.delete("content-encoding");
  return new Response(upstream.body, {
    status: upstream.status, statusText: upstream.statusText, headers: responseHeaders,
  });
}
