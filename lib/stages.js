// ---------------------------------------------------------------------------
// The pipeline state machine, mirrored from the lead_stages table.
// Keeping it here too lets workflows compute the next stage without a round
// trip, and lets tests assert the ordering.
// ---------------------------------------------------------------------------

export const STAGES = [
  // `workflow` is the workflow that PROCESSES leads sitting at this stage and
  // moves them onward - the same value claim_leads() is called with.
  { stage: 'SCRAPED',            position: 10,  label: 'Scraped',            workflow: 'wf02-clean-dedupe' },
  { stage: 'CLEANED',            position: 20,  label: 'Cleaned',            workflow: 'wf03-enrichment' },
  { stage: 'ENRICHED',           position: 30,  label: 'Enriched',           workflow: 'wf04-qualification' },
  { stage: 'QUALIFIED',          position: 40,  label: 'AI Qualified',       workflow: 'wf05-research' },
  { stage: 'RESEARCHED',         position: 50,  label: 'AI Research',        workflow: 'wf06-outreach-generation' },
  { stage: 'MESSAGE_GENERATED',  position: 60,  label: 'Message Generated',  workflow: 'wf07-approval-queue' },
  { stage: 'PENDING_APPROVAL',   position: 70,  label: 'Pending Approval',   workflow: 'wf07-approval-queue' },
  { stage: 'READY_FOR_OUTREACH', position: 80,  label: 'Ready For Outreach', workflow: 'wf08-outreach-log' },
  { stage: 'DM_SENT',            position: 90,  label: 'DM Sent',            workflow: 'wf11-followup-engine' },
  { stage: 'REPLIED',            position: 100, label: 'Replied',            workflow: 'wf09-reply-processing' },
  { stage: 'CONVERSATION',       position: 110, label: 'Conversation',       workflow: 'wf10-response-assistant' },
  { stage: 'INTERESTED',         position: 120, label: 'Interested',         workflow: 'wf10-response-assistant' },
  { stage: 'NURTURE',            position: 130, label: 'Nurture',            workflow: 'wf11-followup-engine' },
  { stage: 'NOT_INTERESTED',     position: 140, label: 'Not Interested',     terminal: true },
  { stage: 'CLOSED',             position: 150, label: 'Closed',             terminal: true },
  { stage: 'DISQUALIFIED',       position: 160, label: 'Disqualified',       terminal: true }
];

const BY_NAME = new Map(STAGES.map((s) => [s.stage, s]));

/** The linear "happy path" the orchestrator walks. */
export const PIPELINE = [
  'SCRAPED', 'CLEANED', 'ENRICHED', 'QUALIFIED', 'RESEARCHED',
  'MESSAGE_GENERATED', 'PENDING_APPROVAL', 'READY_FOR_OUTREACH', 'DM_SENT'
];

export function stageInfo(stage) {
  return BY_NAME.get(stage) ?? null;
}

export function position(stage) {
  return BY_NAME.get(stage)?.position ?? -1;
}

export function isTerminal(stage) {
  return Boolean(BY_NAME.get(stage)?.terminal);
}

/** Next stage on the happy path, or null at the end / off the path. */
export function nextStage(stage) {
  const i = PIPELINE.indexOf(stage);
  return i === -1 || i === PIPELINE.length - 1 ? null : PIPELINE[i + 1];
}

/** Which workflow is responsible for moving a lead out of this stage. */
export function workflowFor(stage) {
  return BY_NAME.get(stage)?.workflow ?? null;
}

/** Stage never moves backwards - the guard used by advance_lead(). */
export function canAdvance(from, to) {
  return position(to) >= position(from);
}

/**
 * Resume point for a lead after a crash: the stage whose work has not been
 * completed, derived from the timestamps rather than trusting `status`.
 */
export function resumeStage(lead = {}) {
  if (!lead.cleaned_at) return 'CLEANED';
  if (!lead.enriched_at) return 'ENRICHED';
  if (!lead.qualified_at) return 'QUALIFIED';
  if (lead.qualified === false) return null;
  if (!lead.researched_at) return 'RESEARCHED';
  if (!lead.message_generated_at) return 'MESSAGE_GENERATED';
  if (!lead.approved_at) return 'PENDING_APPROVAL';
  if (!lead.first_sent_at) return 'READY_FOR_OUTREACH';
  return null;
}

/** Progress checklist for the dashboard / "Lead 182" view. */
export function progressOf(lead = {}) {
  return [
    { step: 'Scraped', done: Boolean(lead.discovered_at) },
    { step: 'Cleaned', done: Boolean(lead.cleaned_at) },
    { step: 'Enriched', done: Boolean(lead.enriched_at) },
    { step: 'Qualified', done: Boolean(lead.qualified_at) },
    { step: 'AI Research', done: Boolean(lead.researched_at) },
    { step: 'Message Generated', done: Boolean(lead.message_generated_at) },
    { step: 'Approved', done: Boolean(lead.approved_at) },
    { step: 'Sent', done: Boolean(lead.first_sent_at) },
    { step: 'Replied', done: Boolean(lead.replied_at) }
  ];
}
