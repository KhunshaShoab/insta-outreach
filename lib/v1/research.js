// ---------------------------------------------------------------------------
// Research: read a company's own public website and record what is actually
// there. Every finding carries the URL it came from, so a reviewer can check it.
//
// The rule this module exists to enforce: it collects EVIDENCE, never
// conclusions. "The site links to a Calendly booking page" is evidence. "They
// are missing calls" is not something a website can tell you, so nothing here
// produces a claim like that.
// ---------------------------------------------------------------------------

const USER_AGENT = 'Mozilla/5.0 (compatible; OptiFlowResearchBot/1.0; +contact: ops@optiflow.example)';
const MAX_BYTES = 900_000;

// Paths worth trying, in priority order. Most sites answer two or three.
export const PAGES = [
  { path: '/', label: 'homepage' },
  { path: '/contact', label: 'contact' },
  { path: '/about', label: 'about' },
  { path: '/careers', label: 'careers' },
  { path: '/faq', label: 'faq' }
];

const TECHNOLOGIES = [
  // e-commerce platforms
  { name: 'Shopify', re: /cdn\.shopify\.com|shopify\.com\/s\/files|Shopify\.theme|myshopify\.com/i, kind: 'ecommerce' },
  { name: 'WooCommerce', re: /woocommerce|wc-ajax|wp-content\/plugins\/woocommerce/i, kind: 'ecommerce' },
  { name: 'BigCommerce', re: /bigcommerce\.com|cdn\d*\.bigcommerce/i, kind: 'ecommerce' },
  { name: 'Magento', re: /\/static\/version\d+\/frontend|Magento_/i, kind: 'ecommerce' },
  { name: 'Squarespace Commerce', re: /squarespace.*commerce|sqs-add-to-cart/i, kind: 'ecommerce' },
  // site builders
  { name: 'WordPress', re: /wp-content|wp-includes|wp-json/i, kind: 'cms' },
  { name: 'Squarespace', re: /squarespace\.com|static1\.squarespace/i, kind: 'cms' },
  { name: 'Wix', re: /wix\.com|wixstatic\.com|_wixCssStates/i, kind: 'cms' },
  { name: 'Webflow', re: /webflow\.com|webflow\.js/i, kind: 'cms' },
  { name: 'GoDaddy Website Builder', re: /godaddysites\.com|img1\.wsimg\.com/i, kind: 'cms' },
  // live chat / helpdesk - a support channel that exists today
  { name: 'Intercom', re: /intercom\.io|intercomcdn/i, kind: 'support' },
  { name: 'Zendesk', re: /zendesk\.com|zdassets\.com/i, kind: 'support' },
  { name: 'Gorgias', re: /gorgias\.(com|chat)/i, kind: 'support' },
  { name: 'Tidio', re: /tidio\.co|tidiochat/i, kind: 'support' },
  { name: 'Drift', re: /drift\.com|driftt\.com/i, kind: 'support' },
  { name: 'LiveChat', re: /livechatinc\.com|livechat\.com/i, kind: 'support' },
  { name: 'Crisp', re: /crisp\.chat/i, kind: 'support' },
  { name: 'HubSpot', re: /hs-scripts\.com|hubspot\.com/i, kind: 'support' },
  { name: 'Podium', re: /podium\.com/i, kind: 'support' },
  { name: 'Birdeye', re: /birdeye\.com/i, kind: 'support' },
  // booking / scheduling - relevant to reception workload
  { name: 'Calendly', re: /calendly\.com/i, kind: 'booking' },
  { name: 'Acuity Scheduling', re: /acuityscheduling\.com|squarespacescheduling\.com/i, kind: 'booking' },
  { name: 'Vagaro', re: /vagaro\.com/i, kind: 'booking' },
  { name: 'Booksy', re: /booksy\.com/i, kind: 'booking' },
  { name: 'Mindbody', re: /mindbodyonline\.com|mindbody\.io/i, kind: 'booking' },
  { name: 'Square Appointments', re: /squareup\.com\/appointments|square\.site/i, kind: 'booking' },
  { name: 'Aesthetic Record', re: /aestheticrecord\.com/i, kind: 'booking' },
  { name: 'Boulevard', re: /joinboulevard\.com/i, kind: 'booking' },
  { name: 'Zocdoc', re: /zocdoc\.com/i, kind: 'booking' },
  { name: 'SimplePractice', re: /simplepractice\.com/i, kind: 'booking' },
  { name: 'Jane', re: /janeapp\.com/i, kind: 'booking' }
];

const SOCIALS = {
  instagram: /(?:https?:\/\/)?(?:www\.)?instagram\.com\/([A-Za-z0-9._]{1,30})/gi,
  facebook: /(?:https?:\/\/)?(?:www\.)?facebook\.com\/([A-Za-z0-9._\-/]{2,60})/gi,
  linkedin: /(?:https?:\/\/)?(?:www\.)?linkedin\.com\/(company\/[A-Za-z0-9._\-]{2,60}|in\/[A-Za-z0-9._\-]{2,60})/gi,
  twitter: /(?:https?:\/\/)?(?:www\.)?(?:twitter|x)\.com\/([A-Za-z0-9_]{1,15})/gi,
  tiktok: /(?:https?:\/\/)?(?:www\.)?tiktok\.com\/@([A-Za-z0-9._]{1,30})/gi,
  youtube: /(?:https?:\/\/)?(?:www\.)?youtube\.com\/(channel\/[\w-]+|@[\w.-]+|c\/[\w-]+)/gi
};

const SUPPORT_ROLE_WORDS = /(customer (support|service|experience|care)|support (rep|representative|agent|specialist|advisor)|client services|patient coordinator|front desk|receptionist|call cent(er|re)|dispatcher|help desk|service advisor)/i;
const HIRING_WORDS = /(we'?re hiring|now hiring|join our team|careers?|open positions?|job openings?|apply now|employment opportunities)/i;
const BOOKING_WORDS = /(book (now|online|an? appointment|a consultation)|schedule (now|online|an? appointment|a consultation)|request an? appointment|make an appointment|reserve your spot|book your)/i;
const CALL_WORDS = /(call (us|now|today|to book|for)|give us a call|speak (to|with) (us|our team)|phone us|call our|tap to call)/i;
// "24/7" on its own is unreliable: it frequently describes a financing portal,
// an app or online ordering rather than the business being reachable. The phrase
// only counts when it sits next to a word about reaching a person.
// The coverage verbs need word boundaries on both sides. Without them "steam
// rooms" matched `team` and "typically" matched `call`, so a medspa's aftercare
// page - "avoid saunas for at least 24 hours", "back to your routine in 24
// hours" - registered as advertised after-hours coverage and lifted its AI voice
// score. Same class of bug as a stem with a trailing \b that can never match.
const COVERAGE_WORDS = String.raw`\b(answers?|answering|calls?|phones?|reach|staff(ed)?|teams?|support|service|open|available|assist|help)\b`;
const HOURS_WORDS = String.raw`(24\/7|24 hours|around the clock|available anytime|nights and weekends)`;
const AFTER_HOURS_WORDS = new RegExp(
  `(${HOURS_WORDS}[^.!?]{0,60}${COVERAGE_WORDS}` +
  `|${COVERAGE_WORDS}[^.!?]{0,60}(24\\/7|24 hours|around the clock|after hours|nights and weekends)` +
  `|after[- ]hours \\b(answer\\w*|call\\w*|phone|service|line|support|coverage)\\b` +
  `|emergency \\b(service|line|call|number)\\b)`, 'i');

// Aftercare and recovery text is the other way a "24 hours" match arrives: it
// describes how long a treatment takes to settle, not when anyone picks up.
const AFTER_HOURS_EXCLUDE = /(portal|app|online (access|account|ordering|booking|store)|self[- ]serve|website|dashboard|financing|loan|payment plan|chatbot|aftercare|downtime|recovery|swelling|bruising|numbing|avoid |refrain|strenuous|sauna|steam room|for at least|within \d+ hours?|in only \d+ hours?|results? (can|may|will|take)|post[- ](treatment|procedure|op)|return to (your|their) (normal|everyday|regular|routine|daily)|notice|cancel|resched|within the next|we('ll| will) (call|contact|respond|get back)|respon(d|se) (within|time)|access available|book online 24)/i;
const RETURNS_WORDS = /(returns?|refunds?|exchange)/i;
const HELP_WORDS = /(help cent(er|re)|knowledge base|support cent(er|re)|customer service)/i;

const NAMED_ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", reg: '(R)',
  trade: '(TM)', copy: '(C)', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"',
  mdash: '-', ndash: '-', hellip: '...', deg: ' degrees', eacute: 'e', bull: '-'
};

/** Visible text, with entities decoded - these snippets are quoted to a human. */
function stripTags(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (match, name) => NAMED_ENTITIES[name.toLowerCase()] ?? match)
    .replace(/\s+/g, ' ')
    .trim();
}

function safeCodePoint(code) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return ' ';
  }
}

/** Fetch one page. Never throws - a failure is itself a recorded fact. */
export async function fetchPage(url, { timeoutMs = 15000, fetchImpl = globalThis.fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' }
    });
    const text = (await response.text()).slice(0, MAX_BYTES);
    return { url, ok: response.ok, status: response.status, html: response.ok ? text : '', final_url: response.url ?? url };
  } catch (error) {
    return { url, ok: false, status: null, html: '', error: String(error?.name === 'AbortError' ? 'timeout' : error?.message ?? error).slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Research one lead from its website.
 * @returns evidence object - facts only, with a source URL on each group
 */
export async function researchLead(lead, { pages = PAGES, timeoutMs = 15000, fetchImpl = globalThis.fetch } = {}) {
  if (!lead.domain) {
    const evidence = createEvidence();
    evidence.notes = 'No website in the source file, so no website research was possible.';
    return evidence;
  }

  const base = `https://${lead.domain}`;
  const fetched = [];
  let homepageHtml = '';

  for (const { path, label } of pages) {
    // Only chase sub-pages the homepage actually links to, plus contact, which
    // nearly always exists. Guessing at paths wastes requests and time.
    if (path !== '/' && path !== '/contact' && homepageHtml && !new RegExp(`href=["'][^"']*${path.slice(1)}`, 'i').test(homepageHtml)) {
      continue;
    }
    const result = await fetchPage(base + path, { timeoutMs, fetchImpl });
    if (result.ok && result.html && path === '/') homepageHtml = result.html;
    fetched.push({ url: result.final_url ?? result.url, label, html: result.html, ok: result.ok && Boolean(result.html), status: result.status, error: result.error ?? null });
  }

  return extractEvidence(fetched, { domain: lead.domain });
}

function extractInto(evidence, html, sourceUrl, label) {
  const text = stripTags(html);
  const lower = html.toLowerCase();

  if (label === 'homepage') {
    evidence.meta.title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim().slice(0, 200) ?? evidence.meta.title;
    evidence.meta.description = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1]?.trim().slice(0, 400) ?? evidence.meta.description;
  }

  for (const tech of TECHNOLOGIES) {
    if (tech.re.test(html)) {
      evidence.technologies.push(tech.name);
      if (tech.kind === 'ecommerce') {
        evidence.ecommerce.detected = true;
        evidence.ecommerce.signals.push(`${tech.name} detected on ${sourceUrl}`);
      }
      if (tech.kind === 'support') {
        evidence.support.channels.push('live chat');
        evidence.support.chat_widget ??= tech.name;
      }
      if (tech.kind === 'booking') {
        evidence.booking.detected = true;
        evidence.booking.platform ??= tech.name;
      }
    }
  }

  // e-commerce structure, independent of the platform fingerprint.
  const productLinks = (lower.match(/href="[^"]*\/(product|products|shop|store|collections|item)\//g) ?? []).length;
  evidence.ecommerce.product_links += productLinks;
  if (/add to cart|add-to-cart|addtocart|\/cart|checkout/i.test(html)) {
    evidence.ecommerce.has_cart = true;
    evidence.ecommerce.signals.push(`cart or checkout markup present on ${sourceUrl}`);
  }
  if (RETURNS_WORDS.test(text) && /href="[^"]*(return|refund|exchange)/i.test(lower)) {
    evidence.ecommerce.has_returns_page = true;
    evidence.support.channels.push('returns/refunds policy');
  }

  // Support channels that demonstrably exist.
  const mailtos = [...html.matchAll(/mailto:([^"'?\s>]+)/gi)].map((m) => m[1].toLowerCase());
  evidence.support.mailto_count += mailtos.length;
  if (mailtos.length) {
    evidence.support.channels.push('email');
    evidence.support.emails.push(...mailtos);
  }
  if (/<form[\s\S]{0,600}(email|message|enquiry|inquiry|contact)/i.test(html)) {
    evidence.support.contact_form = true;
    evidence.support.channels.push('contact form');
  }
  if (HELP_WORDS.test(text)) {
    evidence.support.help_center = true;
    evidence.support.channels.push('help centre or customer service page');
  }

  // Phone prominence.
  const telLinks = [...html.matchAll(/href="tel:([^"]+)"/gi)].map((m) => m[1]);
  evidence.phone.tel_links += telLinks.length;
  if (telLinks.length) {
    evidence.support.channels.push('phone');
    evidence.phone.numbers.push(...telLinks.map((t) => t.replace(/[^\d+]/g, '')));
  }
  const callMatch = text.match(CALL_WORDS);
  if (callMatch) {
    evidence.phone.call_to_action = true;
    evidence.phone.cta_examples.push(snippet(text, callMatch.index));
  }

  // Booking language.
  const bookMatch = text.match(BOOKING_WORDS);
  if (bookMatch) {
    evidence.booking.call_to_action = true;
    evidence.booking.cta_examples.push(snippet(text, bookMatch.index));
  }

  // Hiring, and specifically support-shaped roles.
  if (label === 'careers' || /href="[^"]*(careers?|jobs|employment|work-with-us)/i.test(lower)) {
    evidence.hiring.page_found = true;
  }
  const hiringMatch = text.match(HIRING_WORDS);
  if (hiringMatch) evidence.hiring.examples.push(snippet(text, hiringMatch.index));
  const roleMatch = text.match(SUPPORT_ROLE_WORDS);
  if (roleMatch && (evidence.hiring.page_found || hiringMatch)) {
    evidence.hiring.support_roles = true;
    evidence.hiring.examples.push(snippet(text, roleMatch.index));
  }

  const hoursMatch = text.match(AFTER_HOURS_WORDS);
  if (hoursMatch) {
    const context = snippet(text, hoursMatch.index);
    // Reject the match if the surrounding text is about a portal or an app.
    if (!AFTER_HOURS_EXCLUDE.test(context)) {
      evidence.after_hours.mentioned = true;
      evidence.after_hours.examples.push(context);
    }
  }

  for (const [network, pattern] of Object.entries(SOCIALS)) {
    const found = [...html.matchAll(pattern)].map((m) => m[1]).filter(Boolean);
    if (found.length) (evidence.socials[network] ??= []).push(...found);
  }
}

/** An empty evidence object. Exported so callers can build one without fetching. */
export function createEvidence() {
  return {
    website_reachable: false,
    pages_read: [],
    pages_failed: [],
    technologies: [],
    ecommerce: { detected: false, signals: [], product_links: 0, has_cart: false, has_returns_page: false },
    support: { channels: [], chat_widget: null, help_center: false, contact_form: false, emails: [], mailto_count: 0 },
    phone: { tel_links: 0, call_to_action: false, cta_examples: [], numbers: [] },
    booking: { detected: false, platform: null, call_to_action: false, cta_examples: [] },
    hiring: { page_found: false, support_roles: false, examples: [] },
    after_hours: { mentioned: false, examples: [] },
    socials: {},
    meta: { title: null, description: null },
    evidence_sources: []
  };
}

/**
 * Turn already-fetched pages into evidence. Pure - no network, no I/O - so the
 * same extractor runs in the CLI and inside an n8n Code node, where the HTTP
 * Request node does the fetching.
 *
 * @param {Array<{url, label, html, ok?, status?, error?}>} pages
 */
export function extractEvidence(pages = [], { domain = null } = {}) {
  const evidence = createEvidence();
  for (const page of pages) {
    if (!page?.ok || !page.html) {
      evidence.pages_failed.push({ url: page?.url ?? null, status: page?.status ?? null, error: page?.error ?? null });
      continue;
    }
    if (page.label === 'homepage') evidence.website_reachable = true;
    evidence.pages_read.push({ url: page.url, label: page.label });
    evidence.evidence_sources.push(page.url);
    extractInto(evidence, page.html, page.url, page.label);
  }
  // Any readable page proves the site is up, even if the homepage itself failed.
  if (!evidence.website_reachable && evidence.pages_read.length) evidence.website_reachable = true;
  finalise(evidence, domain);
  return evidence;
}

/** Deduplicate the accumulated lists and add the unreadable-site note. */
function finalise(evidence, domain) {
  evidence.technologies = [...new Set(evidence.technologies)];
  evidence.support.channels = [...new Set(evidence.support.channels)];
  evidence.support.emails = [...new Set(evidence.support.emails)].slice(0, 5);
  evidence.phone.numbers = [...new Set(evidence.phone.numbers)].slice(0, 5);
  evidence.phone.cta_examples = [...new Set(evidence.phone.cta_examples)].slice(0, 3);
  evidence.booking.cta_examples = [...new Set(evidence.booking.cta_examples)].slice(0, 3);
  evidence.hiring.examples = [...new Set(evidence.hiring.examples)].slice(0, 3);
  evidence.after_hours.examples = [...new Set(evidence.after_hours.examples)].slice(0, 3);
  for (const [network, values] of Object.entries(evidence.socials)) {
    evidence.socials[network] = [...new Set(values)].slice(0, 5);
  }
  if (!evidence.website_reachable && evidence.pages_failed.length) {
    const first = evidence.pages_failed[0];
    evidence.notes = `Website did not return a readable page (${first.status ?? first.error}). Many small-business sites block automated requests; this is not evidence about the business itself.`;
  }
  return evidence;
}

/** A quotable fragment: starts and ends on a word, so a human can read it. */
function snippet(text, index, width = 130) {
  let start = Math.max(0, index - 25);
  if (start > 0) {
    const boundary = text.lastIndexOf(' ', start);
    start = boundary === -1 ? start : boundary + 1;
  }
  let end = Math.min(text.length, start + width);
  if (end < text.length) {
    const boundary = text.indexOf(' ', end);
    end = boundary === -1 || boundary - end > 15 ? end : boundary;
  }
  const fragment = text.slice(start, end).trim();
  return `${start > 0 ? '...' : ''}${fragment}${end < text.length ? '...' : ''}`;
}

/** A short factual paragraph for the reviewer. No interpretation. */
export function researchSummary(lead, evidence) {
  if (!lead.domain) return `No website listed in ${lead.source_file}, so only the spreadsheet's own fields were available.`;
  if (!evidence.website_reachable) return evidence.notes ?? `${lead.domain} could not be read.`;

  const parts = [];
  parts.push(`${evidence.meta.title ? `"${evidence.meta.title}"` : lead.domain} - read ${evidence.pages_read.length} page(s).`);
  if (evidence.technologies.length) parts.push(`Technologies detected: ${evidence.technologies.join(', ')}.`);
  if (evidence.support.channels.length) parts.push(`Contact channels present: ${[...new Set(evidence.support.channels)].join(', ')}.`);
  if (evidence.phone.tel_links) parts.push(`${evidence.phone.tel_links} click-to-call link(s) on the pages read.`);
  if (evidence.booking.detected) parts.push(`Online booking via ${evidence.booking.platform ?? 'an on-site form'}.`);
  else if (evidence.booking.call_to_action) parts.push('Booking language present but no booking platform identified.');
  if (evidence.ecommerce.detected) parts.push(`E-commerce platform present${evidence.ecommerce.product_links ? ` with ${evidence.ecommerce.product_links} product link(s)` : ''}.`);
  if (evidence.hiring.page_found) parts.push(`Careers or jobs page found${evidence.hiring.support_roles ? ', mentioning customer-facing roles' : ''}.`);
  if (evidence.after_hours.mentioned) parts.push('After-hours or 24/7 availability mentioned.');
  const socials = Object.keys(evidence.socials);
  if (socials.length) parts.push(`Social links: ${socials.join(', ')}.`);
  return parts.join(' ');
}
