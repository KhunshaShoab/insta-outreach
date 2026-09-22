// ---------------------------------------------------------------------------
// Instagram adapter: human-operated (the default, and the only compliant path
// for cold outreach).
//
// Instagram's official Messaging API cannot start a conversation with someone
// who has not messaged you first. A first-touch prospecting DM therefore has to
// be sent by a person, from their own account, in the Instagram app or web
// client. This adapter does not try to work around that: it prepares everything
// the operator needs, hands it over, and records what was actually sent.
//
// What this system automates is the research, the writing, the queueing and the
// tracking. The send itself stays human.
// ---------------------------------------------------------------------------

export function create(env = {}) {
  return {
    mode: 'manual',
    can_initiate: false,

    /**
     * "Sending" here means producing a work item for the operator. The caller
     * records the real send by calling mark_outreach_sent() once the operator
     * confirms in the approval console.
     */
    async send(threadRef, message, ctx = {}) {
      return {
        manual: true,
        sent: false,
        instructions: 'Open the profile, paste the message, send it, then press "Mark as sent" in the console.',
        profile_url: threadRef?.instagram_url ?? (threadRef?.instagram_handle ? `https://www.instagram.com/${threadRef.instagram_handle}/` : null),
        direct_url: threadRef?.instagram_handle ? `https://www.instagram.com/direct/new/?username=${threadRef.instagram_handle}` : null,
        message,
        outreach_id: ctx.outreach_id ?? null,
        pacing: {
          min_seconds_between_sends: ctx.min_seconds_between_sends ?? 45,
          remaining_today: ctx.remaining_today ?? null
        }
      };
    },

    /**
     * Replies pasted into the console arrive in the same shape the webhook
     * produces, so downstream classification is identical either way.
     */
    parseWebhook(payload = {}) {
      const items = Array.isArray(payload) ? payload : [payload];
      return items.map((item) => ({
        external_message_id: item.external_message_id ?? null,
        sender_handle: item.instagram_handle ?? item.sender_handle ?? null,
        lead_id: item.lead_id ?? null,
        body: item.body ?? item.message ?? '',
        sent_at: item.sent_at ?? new Date().toISOString(),
        source: 'manual_entry',
        raw: item
      }));
    }
  };
}
