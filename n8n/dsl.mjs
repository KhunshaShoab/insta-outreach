// ---------------------------------------------------------------------------
// A tiny DSL for describing n8n workflows.
// Hand-writing 13 workflow JSON files means 13 places to make a typo in a node
// id or a connection name. Describing them here and generating the JSON keeps
// the wiring correct by construction, and lets the Code nodes share the same
// tested lib/ source instead of a copy that drifts.
// ---------------------------------------------------------------------------
import { createHash } from 'node:crypto';

const COLUMN_WIDTH = 240;
const ROW_HEIGHT = 190;

/** Deterministic ids: the same workflow definition always produces the same JSON. */
function idFor(workflowName, nodeName) {
  return createHash('sha1').update(`${workflowName}::${nodeName}`).digest('hex').slice(0, 24);
}

export function workflow(name, { description = '', tags = [] } = {}) {
  const nodes = [];
  const connections = {};
  const cursor = { column: 0, row: 0 };

  const api = {
    name,
    description,
    tags,

    /** Add a node. `at` overrides automatic placement. */
    add(node, { column = null, row = null } = {}) {
      const col = column ?? cursor.column;
      const r = row ?? cursor.row;
      if (column === null) cursor.column += 1;
      nodes.push({
        parameters: node.parameters ?? {},
        id: idFor(name, node.name),
        name: node.name,
        type: node.type,
        typeVersion: node.typeVersion ?? 1,
        position: [260 + col * COLUMN_WIDTH, 300 + r * ROW_HEIGHT],
        ...(node.credentials ? { credentials: node.credentials } : {}),
        ...(node.alwaysOutputData ? { alwaysOutputData: true } : {}),
        ...(node.continueOnFail ? { onError: 'continueRegularOutput' } : {}),
        ...(node.onError ? { onError: node.onError } : {}),
        ...(node.retryOnFail ? { retryOnFail: true, maxTries: node.maxTries ?? 3, waitBetweenTries: node.waitBetweenTries ?? 2000 } : {}),
        ...(node.notes ? { notes: node.notes } : {}),
        ...(node.executeOnce ? { executeOnce: true } : {}),
        ...(node.disabled ? { disabled: true } : {})
      });
      return node.name;
    },

    /** Connect two nodes. `from` may be "Node" or ["Node", outputIndex]. */
    connect(from, to, { type = 'main', index = 0 } = {}) {
      const [fromName, outputIndex] = Array.isArray(from) ? from : [from, 0];
      connections[fromName] ??= {};
      connections[fromName][type] ??= [];
      while (connections[fromName][type].length <= outputIndex) connections[fromName][type].push([]);
      connections[fromName][type][outputIndex].push({ node: Array.isArray(to) ? to[0] : to, type, index });
      return to;
    },

    /** Connect a linear run of nodes. */
    chain(...names) {
      for (let i = 0; i < names.length - 1; i += 1) api.connect(names[i], names[i + 1]);
      return names[names.length - 1];
    },

    /** Start a new visual row (used for error branches). */
    newRow(column = 0) {
      cursor.row += 1;
      cursor.column = column;
    },

    toJSON() {
      return {
        name,
        nodes,
        connections,
        active: false,
        settings: {
          executionOrder: 'v1',
          saveManualExecutions: true,
          saveDataErrorExecution: 'all',
          saveDataSuccessExecution: 'all',
          callerPolicy: 'workflowsFromSameOwner',
          errorWorkflow: ''
        },
        staticData: null,
        pinData: {},
        tags: tags.map((t) => ({ name: t })),
        meta: { description, generatedBy: 'n8n/build.mjs - edit n8n/src/*.mjs and rerun `npm run build:n8n`' },
        versionId: idFor(name, '__version')
      };
    }
  };
  return api;
}

// --- node factories --------------------------------------------------------

export const schedule = (name, cron) => ({
  name,
  type: 'n8n-nodes-base.scheduleTrigger',
  typeVersion: 1.2,
  parameters: { rule: { interval: [{ field: 'cronExpression', expression: cron }] } }
});

export const manualTrigger = (name = 'Manual Run') => ({
  name, type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {}
});

export const subWorkflowTrigger = (name = 'Called By Orchestrator') => ({
  name,
  type: 'n8n-nodes-base.executeWorkflowTrigger',
  typeVersion: 1,
  parameters: {},
  notes: 'Input: { campaign_id, batch_size?, execution_id? }'
});

export const webhook = (name, path, method = 'POST', options = {}) => ({
  name,
  type: 'n8n-nodes-base.webhook',
  typeVersion: 2,
  parameters: {
    httpMethod: method,
    path,
    responseMode: options.responseMode ?? 'responseNode',
    options: { rawBody: options.rawBody ?? false, ...(options.extra ?? {}) }
  },
  notes: options.notes
});

export const respond = (name, body = '={{ $json }}', code = 200) => ({
  name,
  type: 'n8n-nodes-base.respondToWebhook',
  typeVersion: 1.1,
  parameters: { respondWith: 'json', responseBody: body, options: { responseCode: code } }
});

export const code = (name, jsCode, { notes = null, runOnceForEachItem = false } = {}) => ({
  name,
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  parameters: { mode: runOnceForEachItem ? 'runOnceForEachItem' : 'runOnceForAllItems', jsCode },
  notes
});

/**
 * Supabase / PostgREST call. Every datastore touch goes through this, so
 * replacing the datastore means changing the base URL and this one factory.
 */
export const supabase = (name, { method = 'POST', path, body = null, query = '', notes = null, retry = true, continueOnFail = false, errorOutput = false }) => ({
  name,
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.2,
  retryOnFail: retry,
  maxTries: 3,
  waitBetweenTries: 2000,
  continueOnFail,
  onError: errorOutput ? 'continueErrorOutput' : undefined,
  notes,
  parameters: {
    method,
    url: `={{ $env.SUPABASE_URL }}/rest/v1/${path}${query}`,
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'apikey', value: '={{ $env.SUPABASE_SERVICE_ROLE_KEY }}' },
        { name: 'Content-Type', value: 'application/json' },
        { name: 'Prefer', value: 'return=representation' }
      ]
    },
    ...(body ? { sendBody: true, specifyBody: 'json', jsonBody: body } : {}),
    options: { timeout: 30000, response: { response: { neverError: false } } }
  },
  credentials: { httpHeaderAuth: { id: 'supabase-service-role', name: 'Supabase Service Role' } }
});

/** Call a Postgres function through PostgREST. */
export const rpc = (name, fn, body, options = {}) =>
  supabase(name, { method: 'POST', path: `rpc/${fn}`, body, ...options });

export const anthropic = (name, { modelField = '$json.model', maxTokensField = '$json.max_tokens', promptField = '$json.prompt', temperatureField = '$json.temperature', notes = null } = {}) => ({
  name,
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.2,
  retryOnFail: true,
  maxTries: 3,
  waitBetweenTries: 5000,
  onError: 'continueErrorOutput',
  notes: notes ?? 'Node-level retries cover 429 and 5xx. A malformed or schema-invalid response is handled by the parser node, which sends one correction turn before failing the item.',
  parameters: {
    method: 'POST',
    url: 'https://api.anthropic.com/v1/messages',
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'x-api-key', value: '={{ $env.ANTHROPIC_API_KEY }}' },
        { name: 'anthropic-version', value: '2023-06-01' },
        { name: 'Content-Type', value: 'application/json' }
      ]
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: `={{ JSON.stringify({ model: ${modelField}, max_tokens: ${maxTokensField}, temperature: ${temperatureField}, messages: [{ role: 'user', content: ${promptField} }] }) }}`,
    options: { timeout: 120000 }
  },
  credentials: { httpHeaderAuth: { id: 'anthropic-api-key', name: 'Anthropic API Key' } }
});

export const http = (name, { method = 'GET', url, body = null, headers = [], notes = null, timeout = 60000, retry = true, continueOnFail = false, errorOutput = true }) => ({
  name,
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.2,
  retryOnFail: retry,
  maxTries: 3,
  waitBetweenTries: 3000,
  continueOnFail,
  onError: errorOutput ? 'continueErrorOutput' : undefined,
  notes,
  parameters: {
    method,
    url,
    ...(headers.length ? { sendHeaders: true, headerParameters: { parameters: headers } } : {}),
    ...(body ? { sendBody: true, specifyBody: 'json', jsonBody: body } : {}),
    options: { timeout }
  }
});

export const ifNode = (name, condition, { notes = null } = {}) => ({
  name,
  type: 'n8n-nodes-base.if',
  typeVersion: 2.2,
  notes,
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      combinator: 'and',
      conditions: [
        {
          id: 'c1',
          leftValue: condition.left,
          rightValue: condition.right ?? '',
          operator: condition.operator ?? { type: 'boolean', operation: 'true', singleValue: true }
        }
      ]
    },
    options: {}
  }
});

export const switchNode = (name, valueExpression, outputs, { notes = null } = {}) => ({
  name,
  type: 'n8n-nodes-base.switch',
  typeVersion: 3.2,
  notes,
  parameters: {
    rules: {
      values: outputs.map((output, i) => ({
        conditions: {
          options: { caseSensitive: true, typeValidation: 'loose', version: 2 },
          combinator: 'and',
          conditions: [{
            id: `r${i}`,
            leftValue: valueExpression,
            rightValue: output.value,
            operator: { type: 'string', operation: 'equals' }
          }]
        },
        renameOutput: true,
        outputKey: output.name
      }))
    },
    options: { fallbackOutput: 'extra', renameFallbackOutput: 'other' }
  }
});

export const splitInBatches = (name, batchSize = 1) => ({
  name,
  type: 'n8n-nodes-base.splitInBatches',
  typeVersion: 3,
  parameters: { batchSize, options: {} }
});

export const noop = (name) => ({ name, type: 'n8n-nodes-base.noOp', typeVersion: 1, parameters: {} });

export const executeWorkflow = (name, workflowName, { waitForCompletion = true, notes = null } = {}) => ({
  name,
  type: 'n8n-nodes-base.executeWorkflow',
  typeVersion: 1.2,
  continueOnFail: true,
  notes: notes ?? `Runs "${workflowName}". continueOnFail is deliberate: one failing stage must not stop the campaign.`,
  parameters: {
    workflowId: { __rl: true, value: workflowName, mode: 'list', cachedResultName: workflowName },
    workflowInputs: { mappingMode: 'defineBelow', value: { campaign_id: '={{ $json.campaign_id }}', execution_id: '={{ $execution.id }}' } },
    options: { waitForSubWorkflow: waitForCompletion }
  }
});

export const sticky = (name, content, { column = 0, row = 0, width = 420, height = 180 } = {}) => ({
  name,
  type: 'n8n-nodes-base.stickyNote',
  typeVersion: 1,
  parameters: { content, height, width, color: 4 },
  _sticky: { column, row }
});
