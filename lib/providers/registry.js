// ---------------------------------------------------------------------------
// Provider registry.
// config/providers.json says which adapter is active for each capability; this
// resolves that to a module and returns an instance. Replacing Apify, Apollo,
// Claude, Sheets, Supabase or the Instagram integration means editing that JSON
// and writing one adapter that implements the capability's interface.
// ---------------------------------------------------------------------------

/** The contract each capability's adapters must satisfy. */
export const INTERFACES = {
  discovery: ['discover'],
  instagram_profile: ['fetchProfile'],
  enrichment: ['enrich'],
  ai: ['complete'],
  datastore: ['rpc', 'select', 'insert', 'update'],
  mirror: ['upsertRows'],
  instagram_messaging: ['send'],
  reply_ingest: ['parseWebhook']
};

/**
 * @param {string} capability
 * @param {object} options
 *   config   parsed config/providers.json
 *   env      process.env or an n8n credential bag
 *   modules  { 'lib/providers/x.js': moduleNamespace } - pre-imported adapters
 *   override force a specific adapter name
 */
export function resolveProvider(capability, { config, env = {}, modules = {}, override = null } = {}) {
  const spec = config?.capabilities?.[capability];
  if (!spec) throw new Error(`registry: unknown capability "${capability}"`);

  const name = override ?? env[`${capability.toUpperCase()}_PROVIDER`] ?? spec.active;
  const adapterSpec = spec.adapters?.[name];
  if (!adapterSpec) throw new Error(`registry: capability "${capability}" has no adapter "${name}"`);

  const module = modules[adapterSpec.module];
  if (!module) {
    throw new Error(
      `registry: adapter module "${adapterSpec.module}" was not supplied. ` +
      `Import it and pass it in \`modules\` (n8n Code nodes cannot import at runtime).`
    );
  }

  const missing = (adapterSpec.credentials ?? []).filter((key) => !env[key]);
  const factory = module.create ?? module.default;
  if (typeof factory !== 'function') {
    throw new Error(`registry: adapter "${name}" must export create(env, spec)`);
  }

  const instance = factory(env, adapterSpec);
  for (const method of INTERFACES[capability] ?? []) {
    if (typeof instance[method] !== 'function') {
      throw new Error(`registry: adapter "${name}" for "${capability}" is missing ${method}()`);
    }
  }

  return { name, instance, spec: adapterSpec, missing_credentials: missing };
}

/** Fallback chain for capabilities that declare one (enrichment). */
export function resolveChain(capability, options) {
  const spec = options?.config?.capabilities?.[capability];
  const names = [spec?.active, ...(spec?.fallback ?? [])].filter(Boolean);
  return names.map((name) => resolveProvider(capability, { ...options, override: name }));
}
