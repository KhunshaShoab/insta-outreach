// ---------------------------------------------------------------------------
// Follow-up scheduling.
// One rule dominates: a reply at any stage stops the sequence. That is enforced
// in three places - here, in the follow-up workflow's guard, and in a database
// trigger - because getting it wrong means messaging someone who already
// answered.
// ---------------------------------------------------------------------------

export const STOP_STATUSES = ['REPLIED', 'INTERESTED', 'NOT_INTERESTED', 'NURTURE', 'CLOSED', 'OPTED_OUT'];
export const FOLLOWUP_KINDS = ['followup_1', 'followup_2', 'followup_3_final'];

/** Should the sequence keep running for this lead? */
export function shouldStopSequence(lead = {}) {
  if (lead.replied_at) return { stop: true, reason: 'reply_received' };
  if (STOP_STATUSES.includes(lead.status)) return { stop: true, reason: `status_${String(lead.status).toLowerCase()}` };
  if (['REPLIED', 'CONVERSATION', 'INTERESTED', 'NURTURE', 'NOT_INTERESTED', 'CLOSED'].includes(lead.stage)) {
    return { stop: true, reason: `stage_${String(lead.stage).toLowerCase()}` };
  }
  if (lead.suppressed) return { stop: true, reason: 'suppressed' };
  return { stop: false, reason: null };
}

/** Day offsets for a campaign, falling back to the global default. */
export function offsetsFor(campaign, defaults) {
  const fromCampaign = campaign?.followups?.day_offsets;
  if (Array.isArray(fromCampaign) && fromCampaign.length) return fromCampaign;
  return (defaults?.steps ?? []).filter((s) => s.step > 0).map((s) => s.day_offset);
}

/**
 * Build the schedule for a lead whose initial DM was just sent.
 * @returns [{ step, kind, due_at }]
 */
export function buildSchedule(sentAt, campaign, defaults) {
  if (campaign?.followups?.enabled === false) return [];
  const offsets = offsetsFor(campaign, defaults);
  const window = campaign?.followups?.send_window ?? defaults?.send_window;
  const base = sentAt instanceof Date ? sentAt : new Date(sentAt);
  return offsets.slice(0, FOLLOWUP_KINDS.length).map((days, i) => {
    const due = new Date(base.getTime() + days * 86400000);
    return {
      step: i + 1,
      kind: FOLLOWUP_KINDS[i],
      day_offset: days,
      due_at: nextSendSlot(due, window).toISOString()
    };
  });
}

/**
 * Move a timestamp to the next allowed sending slot.
 * Interpreted in the campaign's timezone by the caller - here we work on the
 * date object's local-equivalent parts supplied in `window`.
 */
export function nextSendSlot(date, window) {
  if (!window) return date;
  const out = new Date(date.getTime());
  const days = window.days ?? [1, 2, 3, 4, 5];
  const start = window.start_hour ?? 9;
  const end = window.end_hour ?? 18;

  for (let guard = 0; guard < 14; guard += 1) {
    const dow = out.getUTCDay();
    const hour = out.getUTCHours();
    if (!days.includes(dow)) {
      out.setUTCDate(out.getUTCDate() + 1);
      out.setUTCHours(start, 0, 0, 0);
      continue;
    }
    if (hour < start) { out.setUTCHours(start, 0, 0, 0); return out; }
    if (hour >= end) {
      out.setUTCDate(out.getUTCDate() + 1);
      out.setUTCHours(start, 0, 0, 0);
      continue;
    }
    return out;
  }
  return out;
}

/** The step config (intent, char limit) for a given follow-up kind. */
export function stepConfig(kind, defaults) {
  return (defaults?.steps ?? []).find((s) => s.kind === kind) ?? null;
}

/**
 * Daily release gate. The queue never hands out more than the campaign allows,
 * so a backlog cannot turn into a burst.
 */
export function applyDailyLimits(items, { sentToday = 0, limit = 30 } = {}) {
  const remaining = Math.max(0, limit - sentToday);
  return { release: items.slice(0, remaining), held: items.slice(remaining), remaining };
}

/** What happens once the final follow-up went out without a reply. */
export function afterFinal(defaults) {
  return defaults?.after_final ?? { status: 'NO_RESPONSE', move_to_stage: 'NURTURE', nurture_recheck_days: 90 };
}
