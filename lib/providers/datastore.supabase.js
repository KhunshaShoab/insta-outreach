// ---------------------------------------------------------------------------
// Datastore adapter: Supabase (PostgREST).
// Thin wrapper - the schema, the constraints and the functions in db/ are the
// real datastore contract. Moving to plain Postgres means swapping this file
// for datastore.postgres.js; the migrations are identical.
// ---------------------------------------------------------------------------
import { request } from './http.js';

export function create(env = {}) {
  const base = String(env.SUPABASE_URL ?? '').replace(/\/+$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_ANON_KEY;
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json'
  };

  async function call(path, { method = 'GET', body = null, prefer = null, ctx = {} } = {}) {
    const { data } = await request({
      url: `${base}${path}`,
      method,
      headers: prefer ? { ...headers, Prefer: prefer } : headers,
      body,
      provider: 'supabase',
      operation: `${method} ${path.split('?')[0]}`,
      onCall: ctx.onCall,
      timeoutMs: ctx.timeoutMs ?? 30000
    });
    return data;
  }

  return {
    /** Call a Postgres function (claim_leads, advance_lead, resolve_company, ...). */
    rpc(fn, args = {}, ctx = {}) {
      return call(`/rest/v1/rpc/${fn}`, { method: 'POST', body: args, ctx });
    },

    select(table, query = '', ctx = {}) {
      const q = query.startsWith('?') ? query : query ? `?${query}` : '';
      return call(`/rest/v1/${table}${q}`, { ctx });
    },

    insert(table, rows, { upsert = false, onConflict = null, ctx = {} } = {}) {
      const prefer = [`return=representation`, upsert ? 'resolution=merge-duplicates' : null].filter(Boolean).join(',');
      const q = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : '';
      return call(`/rest/v1/${table}${q}`, { method: 'POST', body: Array.isArray(rows) ? rows : [rows], prefer, ctx });
    },

    update(table, query, patch, ctx = {}) {
      const q = query.startsWith('?') ? query : `?${query}`;
      return call(`/rest/v1/${table}${q}`, { method: 'PATCH', body: patch, prefer: 'return=representation', ctx });
    },

    // Convenience wrappers around the functions the workflows use most.
    claimLeads(campaignId, stage, limit, worker, ctx) {
      return this.rpc('claim_leads', { p_campaign_id: campaignId, p_stage: stage, p_limit: limit, p_worker: worker }, ctx);
    },
    advanceLead(leadId, toStage, status, step, detail, executionId, ctx) {
      return this.rpc('advance_lead', { p_lead_id: leadId, p_to_stage: toStage, p_status: status, p_step: step, p_detail: detail ?? {}, p_execution_id: executionId ?? null }, ctx);
    },
    failLead(args, ctx) {
      return this.rpc('fail_lead', args, ctx);
    },
    resolveCompany(args, ctx) {
      return this.rpc('resolve_company', args, ctx);
    },
    markSent(outreachId, sentBy, mode, externalId, ctx) {
      return this.rpc('mark_outreach_sent', { p_outreach_id: outreachId, p_sent_by: sentBy, p_send_mode: mode, p_external_message_id: externalId ?? null }, ctx);
    },
    dailyReport(day, campaignId, ctx) {
      return this.rpc('daily_report', { p_day: day, p_campaign_id: campaignId ?? null }, ctx);
    }
  };
}
