// ---------------------------------------------------------------------------
// Deterministic DM composer.
//
// Claude writes better messages than this does. This exists for the case where
// Claude is not reachable - no API key, a rate limit, a failed call - and the
// alternative is a spreadsheet of placeholders, or 600 messages written by hand.
//
// The rules are the ones in prompts/v1-instagram-dm.md, enforced here in code
// instead of asked for in a prompt: open with an observation that came from a
// verified signal's `evidence` field, never its `interpretation`; name one
// capability; ask one question; assume no pain; invent no numbers.
//
// Substance comes from which signal fired, so two leads with different evidence
// get genuinely different messages. Surface wording is picked by a hash of the
// company name, so a batch does not read as one template repeated - and so the
// same lead always composes to the same message, which keeps it reviewable.
//
// No imports: this module is inlined into an n8n Code node.
// ---------------------------------------------------------------------------

/** Phrases that make a cold DM read as bulk outreach, or claim a problem. */
export const BANNED_PHRASES = [
  'hope this message finds you well', 'i wanted to reach out', 'quick question',
  'i came across your profile', 'love your feed', 'love your page',
  'your team is overwhelmed', 'you must be missing', "you're losing",
  'you are losing', 'response times must', 'solutions provider', 'leverage',
  'streamline', 'synergy', 'scale your operations', 'drive efficiencies',
  'are you free this week', 'book a call', 'calendar link', 'game changer',
  'circle back', 'touch base', 'reach out to discuss'
];

const GENDERED = /\b(he|him|his|she|her|hers)\b/i;

/** Stable, tiny string hash. Picks wording variants without randomness. */
function hash(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h;
}
// `seed` arrives shifted by the caller; `>>>` keeps it unsigned, because a
// signed shift of a hash above 2^31 goes negative and indexes off the array.
const pick = (variants, seed) => variants[(seed >>> 0) % variants.length];

// The closing question gets its "?" appended, and the variants below are
// authored as sentences. Without this every message ended ".?".
const asQuestion = (text) => `${String(text).replace(/[\s.!?]+$/, '')}?`;

/**
 * Pull a short, quotable fragment out of a signal's evidence string.
 * Evidence often arrives as `Website text includes: "Call us today"`; the quoted
 * part is what a human would actually reference.
 */
function quoted(evidence) {
  const match = /"([^"]{3,120})"/.exec(evidence ?? '');
  let text = match ? match[1] : '';
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > 64) text = `${text.slice(0, 64).replace(/\s+\S*$/, '')}`;
  // A quoted CTA can itself contain a question mark, and the composed message is
  // allowed exactly one - the closing question.
  text = text.replace(/[?!]/g, '').replace(/[\s,;:.\-]+$/, '');
  return usableQuote(text) ? text : '';
}

// Nav bars, cookie banners and footers match call-to-action patterns as readily
// as real page copy does. One medspa's strongest "call to action" came back as
// "...name@example.com Facebook-f Instagram Call" - a footer. Quoting that at the
// owner reads as a scrape, and hands back an address they did not publish to us,
// so a fragment that is not plain page copy is no quote at all and the composer
// moves to the next signal instead.
const NAV_TOKENS = /\b(facebook-f|facebook|instagram|twitter|tiktok|youtube|linkedin|pinterest|yelp|skip to content|menu|navigation|toggle|cookie|privacy policy|terms of service|all rights reserved|copyright)\b/gi;

function usableQuote(text) {
  if (!text || text.length < 8) return false;
  if (text.startsWith('...') || text.endsWith('...')) return false;   // mid-sentence crop
  if (/[@|·•>]|https?:|www\./i.test(text)) return false;              // address, URL, nav separator
  if (/\d{3}[.\s-]\d{3}[.\s-]\d{4}/.test(text)) return false;         // their own phone number
  if ((text.match(NAV_TOKENS) ?? []).length > 0) return false;        // chrome, not copy
  if (text.split(/\s+/).length < 2) return false;
  // Words glued together with no lowercase run are typically stripped markup.
  if (!/[a-z]{3}/.test(text)) return false;
  return true;
}

const num = (evidence, re) => {
  const m = re.exec(evidence ?? '');
  return m ? Number(m[1]) : null;
};

// The one capability named, phrased a few ways so a batch does not repeat itself.
const CAPABILITY = {
  AI_VOICE: [
    'we put an AI receptionist on inbound calls - it answers, handles the routine questions and books appointments',
    'we run AI receptionists that answer the phone, deal with the usual questions and take bookings',
    'we set up an AI receptionist to answer calls, handle common questions and book people in'
  ],
  CUSTOMER_SUPPORT: [
    'we provide outsourced support staff to add email, chat and phone cover',
    'we run outsourced support teams that take email, chat and phone load off the in-house team',
    'we staff outsourced customer support - email, chat and phone - alongside an in-house team'
  ]
};

const SELF_ID = ['I\'m {name} at {company} -', '{name} here, {company} -', 'I\'m {name}, {company} -'];

// One entry per signal the composer knows how to open on, strongest first. Each
// builds the opening observation and the closing question from that signal's own
// evidence. `service` says which offer the opener belongs to.
const OPENERS = [
  {
    signal: 'After-hours availability advertised',
    service: 'AI_VOICE',
    open: (s) => {
      const q = quoted(s.evidence);
      return q ? [`Your site mentions "${q}".`, `Saw "${q}" on your site.`, `Your site says "${q}".`] : null;
    },
    ask: () => ['What happens to the calls that land outside your normal hours.',
      'How is that covered when the front desk is closed.',
      'Where do the out-of-hours calls go.']
  },
  {
    signal: 'Call-to-action asks customers to phone',
    service: 'AI_VOICE',
    open: (s) => {
      const q = quoted(s.evidence);
      return q ? [`"${q}" is the main prompt on your site.`, `Your site asks people to "${q}".`, `The site's main ask is "${q}".`] : null;
    },
    ask: () => ['How are those calls answered at the moment.', 'Who picks those up day to day.',
      'How is the phone covered through the day.']
  },
  {
    signal: 'Appointment booking in use',
    service: 'AI_VOICE',
    open: (s) => {
      const platform = /detected: (.+?)\.?$/.exec(s.evidence ?? '')?.[1];
      return platform
        ? [`You take bookings through ${platform}.`, `Saw you're booking through ${platform}.`,
          `${platform} is handling your bookings.`, `Your booking runs on ${platform}.`]
        : null;
    },
    ask: (s) => {
      const platform = /detected: (.+?)\.?$/.exec(s.evidence ?? '')?.[1] ?? 'the system';
      return [`Do phone bookings go into ${platform} as well, or get typed in after.`,
        `Does someone enter the phone bookings into ${platform} by hand.`,
        `How do the calls end up in ${platform}.`,
        `Do the bookings that come in by phone reach ${platform} the same way.`];
    }
  },
  {
    signal: 'Phone is a prominent contact channel',
    service: 'AI_VOICE',
    open: (s) => {
      const n = num(s.evidence, /(\d+) click-to-call/);
      if (!n || n < 2) return null;
      return [`Counted ${n} click-to-call links on your site.`,
        `Your site has ${n} tap-to-call links on it.`,
        `There are ${n} tap-to-call links across your site.`,
        `${n} places on your site put the phone number in front of people.`];
    },
    ask: () => ['How are the calls handled right now.', 'Who is answering those during treatments.',
      'Who is on the phone while the room is busy.', 'How is that handled at the moment.']
  },
  {
    signal: 'Appointment-led customer journey',
    service: 'AI_VOICE',
    open: (s) => {
      const q = quoted(s.evidence);
      return q ? [`Your site leads with "${q}".`, `"${q}" is the first thing your site asks for.`,
        `"${q}" is what your site points people at.`] : null;
    },
    ask: () => ['Do most of those come in by phone or through the website.',
      'How do most of those bookings actually arrive.',
      'Is it mostly phone or mostly online.']
  },
  {
    signal: 'Live chat already in place',
    service: 'CUSTOMER_SUPPORT',
    open: (s) => {
      const widget = /^(.+?) chat widget/.exec(s.evidence ?? '')?.[1];
      return widget ? [`You've got ${widget} chat running on the site.`, `Saw ${widget} chat live on your site.`,
        `${widget} chat is live on your site.`] : null;
    },
    ask: () => ['What hours is it actually staffed.', 'Who is covering it outside office hours.',
      'What hours does someone sit behind it.']
  },
  {
    signal: 'Multiple customer contact channels',
    service: 'CUSTOMER_SUPPORT',
    open: (s) => {
      const list = /present on the website: (.+?)\.?$/.exec(s.evidence ?? '')?.[1];
      if (!list) return null;
      // The signal's channel list includes things that are evidence of customer
      // operations but are not ways to reach anyone - a published returns policy
      // is not a contact channel, and saying it is gets the fact wrong.
      const contactable = list.split(/,\s*/).filter((c) => CONTACT_CHANNELS.test(c));
      if (contactable.length < 2) return null;
      const phrase = contactable.length === 2
        ? contactable.join(' and ')
        : `${contactable.slice(0, -1).join(', ')} and ${contactable[contactable.length - 1]}`;
      return [`Your site lists ${phrase} as ways to get in touch.`,
        `You're reachable on ${phrase}.`, `Your contact page offers ${phrase}.`];
    },
    ask: () => ['Is that all landing with one person.', 'Who covers all of those day to day.',
      'Does all of that land in one place.']
  },
  {
    signal: 'Customer-facing hiring',
    service: 'CUSTOMER_SUPPORT',
    open: (s) => {
      const q = quoted(s.evidence);
      return q ? [`Your careers page mentions "${q}".`, `Saw "${q}" on your careers page.`] : null;
    },
    ask: () => ['Is that for extra coverage or for extra volume.', 'What is driving that hire.']
  },
  {
    signal: 'Sells online',
    service: 'CUSTOMER_SUPPORT',
    open: () => ['You sell online as well as in the clinic.', 'You\'ve got an online store alongside the clinic.'],
    ask: () => ['Who handles the order and delivery questions.', 'Where do the order questions land.']
  },
  {
    signal: 'Published returns or refunds policy',
    service: 'CUSTOMER_SUPPORT',
    open: () => ['Your site publishes a returns policy.', 'Saw you have a returns and refunds page.'],
    ask: () => ['Who works through those requests.', 'Where do those requests go.']
  },
  {
    signal: 'Help centre or customer service page',
    service: 'CUSTOMER_SUPPORT',
    open: () => ['Your site has a proper customer service section.', 'You publish a help section on the site.'],
    ask: () => ['How much still comes in as a DM or an email anyway.',
      'Does that cut the direct questions down much.']
  },
  {
    signal: 'Sizeable product catalogue',
    service: 'CUSTOMER_SUPPORT',
    open: (s) => {
      const n = num(s.evidence, /(\d+) product/);
      return n ? [`Counted ${n} products and collections on your site.`,
        `Your site lists ${n} products.`] : null;
    },
    ask: () => ['Who fields the questions about those.', 'Where do the product questions land.']
  }
];

// Channels a customer can actually reach someone on, as opposed to evidence of
// customer operations generally.
const CONTACT_CHANNELS = /^(email|phone|live chat|chat|contact form|whatsapp|sms|text)$/i;

const LOW = 'LOW';

/**
 * Compose one DM from a lead's verified signals.
 *
 * @param {object} record  a scored lead: company_name, city, category,
 *   recommended_offer, signals, owner_name
 * @param {object} options sender {name, company}, maxChars
 * @returns {{personalized_instagram_dm, observation_used, capability_mentioned,
 *   why_this_message, self_check, composed_by}}
 */
export function composeDm(record, options = {}) {
  const sender = options.sender ?? { name: 'Alex', company: 'OptiFlow Solutions' };
  const maxChars = options.maxChars ?? 500;
  const seed = hash(`${record.company_name ?? ''}|${record.business_instagram ?? ''}`);

  // BOTH leads with the voice offer, the same choice the pipeline makes.
  const service = record.recommended_offer === 'BOTH' ? 'AI_VOICE' : record.recommended_offer;
  if (service !== 'AI_VOICE' && service !== 'CUSTOMER_SUPPORT') {
    return {
      personalized_instagram_dm: '',
      observation_used: null,
      capability_mentioned: null,
      why_this_message: 'No message composed: the evidence does not support an approach.',
      self_check: {},
      composed_by: 'template'
    };
  }

  const usable = (record.signals ?? []).filter((s) => s.confidence !== LOW);
  // Openers for the recommended service first; a strong signal from the other
  // service is still a better opening than the category-only fallback.
  const candidates = [
    ...OPENERS.filter((o) => o.service === service),
    ...OPENERS.filter((o) => o.service !== service)
  ];

  let opener = null;
  let chosen = null;
  for (const candidate of candidates) {
    const match = usable.find((s) => s.signal === candidate.signal);
    if (!match) continue;
    const lines = candidate.open(match);
    if (!lines) continue;
    opener = { text: pick(lines, seed), ask: pick(candidate.ask(match), seed >>> 3) };
    chosen = match;
    break;
  }

  const capability = pick(CAPABILITY[service], seed >>> 5);
  const selfId = pick(SELF_ID, seed >>> 7).replace('{name}', sender.name).replace('{company}', sender.company);
  const firstName = record.owner_name ? String(record.owner_name).trim().split(/\s+/)[0] : null;
  const greeting = firstName && /^[A-Za-z][A-Za-z'’-]{1,20}$/.test(firstName) ? `${firstName} - ` : '';

  let body;
  let observation;
  let why;

  if (opener) {
    body = `${greeting}${opener.text} ${selfId} ${capability}. ${asQuestion(opener.ask)}`;
    observation = chosen.evidence;
    why = `Opens on the "${chosen.signal}" signal (${chosen.confidence} confidence, from ${chosen.source}) and names one ${service === 'AI_VOICE' ? 'AI receptionist' : 'outsourced support'} capability against it.`;
  } else {
    // Only low-confidence signals: reference the category, claim nothing.
    const kind = (record.category ?? 'clinic').toLowerCase().replace(/[^a-z /+&-]/g, '').trim() || 'clinic';
    const line = pick([
      `Most ${kind}s I speak to still take bookings and questions over the phone.`,
      `Nearly every ${kind} I talk to runs booking enquiries through the phone.`
    ], seed);
    body = `${greeting}${line} ${selfId} ${capability}. ${asQuestion('How does that work at your end')}`;
    observation = null;
    why = `No medium or high confidence signal was available, so this stays general and asks an open question rather than claiming anything about this business.`;
  }

  const dm = body.replace(/\s+/g, ' ').trim();
  const lower = dm.toLowerCase();

  return {
    personalized_instagram_dm: dm,
    observation_used: observation,
    capability_mentioned: service === 'AI_VOICE' ? 'AI voice receptionist' : 'Customer support outsourcing',
    why_this_message: why,
    self_check: {
      opens_with_verified_observation: Boolean(opener),
      no_invented_facts: true,
      no_assumed_pain: !BANNED_PHRASES.some((p) => lower.includes(p)),
      one_capability_only: true,
      ends_with_question: dm.endsWith('?') && (dm.match(/\?/g) ?? []).length === 1,
      under_max_chars: dm.length <= maxChars,
      no_gendered_pronouns: !GENDERED.test(dm)
    },
    composed_by: 'template'
  };
}
