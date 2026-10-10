const fs = require("node:fs");
const path = require("node:path");

// This verifies only the installed local model list. It is deliberately separate
// from evidence that Codex loaded the list or a live browser/tool run succeeded.
function verifyMixedProviderCatalog(config) {
  const custom = config?.customProvider;
  if (!custom || typeof custom !== "object" || Array.isArray(custom)
    || typeof custom.providerId !== "string" || !custom.providerId.trim()
    || typeof custom.catalogPath !== "string" || !path.isAbsolute(custom.catalogPath)) {
    throw new Error("Mixed provider configuration has no valid local model catalog");
  }
  let catalog;
  try {
    const stat = fs.statSync(custom.catalogPath);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error("invalid catalog file");
    catalog = JSON.parse(fs.readFileSync(custom.catalogPath, "utf8"));
  } catch {
    throw new Error("Mixed provider local model catalog is missing or unreadable; reinstall models");
  }
  if (!catalog || typeof catalog !== "object" || !Array.isArray(catalog.models) || !catalog.models.length) {
    throw new Error("Mixed provider local model catalog has no models; reinstall models");
  }
  const slugs = catalog.models.map(model => model?.slug);
  if (slugs.some(slug => typeof slug !== "string" || !slug.trim())
    || new Set(slugs).size !== slugs.length) {
    throw new Error("Mixed provider local model catalog has invalid or duplicate model names; reinstall models");
  }
  const webModels = catalog.models.filter(model => model.slug.startsWith("chatgpt-web/"));
  const apiModels = catalog.models.filter(model => !model.slug.startsWith("chatgpt-web/"));
  if (!apiModels.length || !webModels.length) {
    throw new Error("Mixed provider local model catalog must include API and Web models; reinstall models");
  }
  if (webModels.some(model => model.supported_in_api !== true)) {
    throw new Error("Mixed provider Web models are not enabled for API-key login; reinstall models");
  }
  return { apiModels: apiModels.length, webModels: webModels.length };
}

module.exports = { verifyMixedProviderCatalog };
