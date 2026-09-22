// ---------------------------------------------------------------------------
// Instagram adapter: official Graph API (Instagram Messaging + Business
// Discovery).
//
// Scope, stated plainly:
//   - It CAN receive inbound messages to your own professional account through
//     the `messages` webhook, and reply inside the conversation window the
//     platform allows (24h standard messaging; the human_agent tag extends this
//     for human-handled replies where your app is approved for it).
//   - It CANNOT initiate a conversation with a prospect who has never messaged
//     you. Cold first-touch DMs go through instagram.manual.js.
//   - Business Discovery reads public profile fields for other professional
//     accounts, within the limits of your app's permissions.
//
// Requires: an Instagram Professional account linked to a Facebook Page, an app
// with instagram_manage_messages + pages_messaging, and webhook verification.
// ---------------------------------------------------------------------------
import { request } from './http.js';
import { createHmac, timingSafeEqual } from 'node:crypto';

const GRAPH = 'https://graph.facebook.com/v21.0';

export function create(env = {}) {
  const token = env.IG_PAGE_ACCESS_TOKEN;
  const igUserId = env.IG_BUSINESS_ACCOUNT_ID;
  const appSecret = env.IG_APP_SECRET;

  return {
    mode: 'graph_api',
    can_initiate: false,

    /**
     * Reply inside an open conversation. `threadRef.recipient_id` is the IGSID
     * carried by the inbound webhook - without it there is no conversation to
     * reply to, and the call is refused rather than attempted.
     */
    async send(threadRef, message, ctx = {}) {
      const recipientId = threadRef?.recipient_id ?? threadRef?.igsid;
      if (!recipientId) {
        return {
          sent: false,
          manual: true,
          reason: 'no_open_conversation',
          detail: 'The Messaging API can only reply to someone who messaged this account first. Send this first-touch message manually.'
        };
      }
      const body = {
        recipient: { id: recipientId },
        message: { text: message },
        ...(ctx.human_agent ? { messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT' } : {})
      };
      const { data } = await request({
        url: `${GRAPH}/${igUserId}/messages?access_token=${token}`,
        method: 'POST',
        body,
        provider: 'instagram_graph',
        operation: 'send_message',
        onCall: ctx.onCall
      });
      return { sent: true, manual: false, external_message_id: data?.message_id ?? null, raw: data };
    },

    /** Public profile fields for another professional account. */
    async fetchProfile(handle, ctx = {}) {
      const fields = 'business_discovery.username(' + handle + '){username,name,biography,website,followers_count,follows_count,media_count,profile_picture_url,media.limit(3){timestamp,caption}}';
      const { data } = await request({
        url: `${GRAPH}/${igUserId}?fields=${encodeURIComponent(fields)}&access_token=${token}`,
        provider: 'instagram_graph',
        operation: 'business_discovery',
        onCall: ctx.onCall
      });
      const profile = data?.business_discovery;
      if (!profile) return null;
      return {
        instagram_handle: profile.username,
        business_name: profile.name,
        bio: profile.biography,
        website: profile.website,
        ig_followers: profile.followers_count,
        ig_following: profile.follows_count,
        ig_posts: profile.media_count,
        ig_is_business: true,
        ig_last_post_at: profile.media?.data?.[0]?.timestamp ?? null,
        raw: profile
      };
    },

    /** Webhook signature check. Reject anything that fails it. */
    verifySignature(rawBody, signatureHeader) {
      if (!appSecret || !signatureHeader) return false;
      const expected = `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
      const a = Buffer.from(expected);
      const b = Buffer.from(String(signatureHeader));
      return a.length === b.length && timingSafeEqual(a, b);
    },

    /** Normalise the messages webhook into InboundMessage[]. */
    parseWebhook(payload = {}) {
      const out = [];
      for (const entry of payload.entry ?? []) {
        for (const event of entry.messaging ?? []) {
          if (!event.message || event.message.is_echo) continue;
          out.push({
            external_message_id: event.message.mid ?? null,
            sender_igsid: event.sender?.id ?? null,
            recipient_igsid: event.recipient?.id ?? null,
            body: event.message.text ?? '',
            attachments: event.message.attachments ?? [],
            sent_at: event.timestamp ? new Date(Number(event.timestamp)).toISOString() : new Date().toISOString(),
            source: 'graph_webhook',
            raw: event
          });
        }
      }
      return out;
    }
  };
}
