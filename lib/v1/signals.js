// ---------------------------------------------------------------------------
// Opportunity signals.
//
// Each signal is a four-part record: what was OBSERVED, what it MIGHT mean, how
// confident that reading is, and where it came from. The separation is the whole
// point - "9 click-to-call links on the homepage" is a fact, "inbound calls
// appear to matter to this business" is a reading of it, and neither is
// "they are missing calls", which no website can tell you.
//
// Interpretations here use "may", "appears to" and "suggests" deliberately.
// ---------------------------------------------------------------------------

const HIGH = 'HIGH';
const MEDIUM = 'MEDIUM';
const LOW = 'LOW';

// Categories whose customer journey is normally phone-and-appointment shaped.
const PHONE_HEAVY = /(spa|medical spa|aesthet|dental|dentist|orthodont|clinic|physician|doctor|chiropract|veterinar|salon|funeral|cremat|mortuar|cemeter|real estate|realtor|insurance|law|attorney|plumb|hvac|electric|roofing|contractor|landscap|pest|locksmith|garage|auto repair|towing|dealership|moving|storage|logistics|trucking|courier|freight|dispatch|hotel|resort|restaurant|catering)/i;
const APPOINTMENT_LED = /(spa|aesthet|dental|dentist|orthodont|clinic|salon|barber|tattoo|physician|doctor|therap|chiropract|veterinar|consultan|studio|fitness|gym|yoga)/i;

function signal(name, evidence, interpretation, confidence, source) {
  return { signal: name, evidence, interpretation, confidence, source };
}

/**
 * Build the evidence-backed signal list for one lead.
 * @returns {Array<{signal, evidence, interpretation, confidence, source}>}
 */
export function buildSignals(lead, evidence = {}) {
  const signals = [];
  const site = evidence.pages_read?.[0]?.url ?? (lead.domain ? `https://${lead.domain}` : null);
  const file = `${lead.source_file} row ${lead.original_row}`;
  const category = `${lead.category ?? ''} ${lead.industry ?? ''}`.trim();

  // --- AI voice receptionist territory -------------------------------------
  if (evidence.phone?.tel_links > 0) {
    const n = evidence.phone.tel_links;
    signals.push(signal(
      'Phone is a prominent contact channel',
      `${n} click-to-call link${n === 1 ? '' : 's'} across the ${evidence.pages_read.length} page(s) read.`,
      'Phone appears to be an important way customers reach this business.',
      n >= 3 ? HIGH : MEDIUM,
      site
    ));
  } else if (lead.phone_e164 && !evidence.website_reachable) {
    signals.push(signal(
      'Phone number published',
      `A phone number is listed in the source data (${lead.phone}), and the website could not be read to say more.`,
      'Phone may be a customer contact channel; this has not been confirmed on the website.',
      LOW,
      file
    ));
  }

  if (evidence.phone?.call_to_action) {
    signals.push(signal(
      'Call-to-action asks customers to phone',
      `Website text includes: "${evidence.phone.cta_examples[0]}"`,
      'The business directs customers to the phone as a primary next step.',
      HIGH,
      site
    ));
  }

  if (evidence.booking?.detected) {
    signals.push(signal(
      'Appointment booking in use',
      `Booking platform detected: ${evidence.booking.platform}.`,
      'The business runs on scheduled appointments, so booking and rescheduling enquiries are part of its normal workload.',
      HIGH,
      site
    ));
  } else if (evidence.booking?.call_to_action) {
    signals.push(signal(
      'Appointment-led customer journey',
      `Website text includes: "${evidence.booking.cta_examples[0]}"`,
      'Appointments appear central to how customers transact, though no booking platform was identified.',
      MEDIUM,
      site
    ));
  } else if (APPOINTMENT_LED.test(category)) {
    signals.push(signal(
      'Appointment-based business category',
      `The source file lists the category as "${lead.category}".`,
      'Businesses of this type are usually appointment-led, which normally implies inbound booking enquiries.',
      LOW,
      file
    ));
  }

  if (evidence.after_hours?.mentioned) {
    signals.push(signal(
      'After-hours availability advertised',
      `Website text includes: "${evidence.after_hours.examples[0]}"`,
      'The business advertises availability outside standard hours, so coverage outside office hours is part of its offer.',
      HIGH,
      site
    ));
  }

  if (PHONE_HEAVY.test(category) && !evidence.phone?.tel_links) {
    signals.push(signal(
      'Phone-heavy business category',
      `Category "${lead.category}" in ${file}.`,
      'This category typically handles a meaningful share of enquiries by phone.',
      LOW,
      file
    ));
  }

  // --- Customer support outsourcing territory -------------------------------
  if (evidence.ecommerce?.detected) {
    signals.push(signal(
      'Sells online',
      evidence.ecommerce.signals.slice(0, 2).join('; ') || 'E-commerce platform detected.',
      'Online selling normally brings order, delivery and returns enquiries.',
      HIGH,
      site
    ));
  }
  if (evidence.ecommerce?.product_links >= 10) {
    signals.push(signal(
      'Sizeable product catalogue',
      `${evidence.ecommerce.product_links} product or collection links found on the pages read.`,
      'A broader catalogue tends to generate more pre-purchase and post-purchase questions.',
      MEDIUM,
      site
    ));
  }
  if (evidence.ecommerce?.has_returns_page) {
    signals.push(signal(
      'Published returns or refunds policy',
      'A returns, refunds or exchanges page is linked from the site.',
      'Returns handling is an established part of this business\'s customer operations.',
      MEDIUM,
      site
    ));
  }

  const channels = [...new Set(evidence.support?.channels ?? [])];
  if (channels.length >= 3) {
    signals.push(signal(
      'Multiple customer contact channels',
      `Channels present on the website: ${channels.join(', ')}.`,
      'Enquiries arrive through several channels at once, which is harder to cover consistently than a single inbox.',
      MEDIUM,
      site
    ));
  }
  if (evidence.support?.chat_widget) {
    signals.push(signal(
      'Live chat already in place',
      `${evidence.support.chat_widget} chat widget detected.`,
      'The business already staffs a real-time channel, so it has an existing response-time commitment.',
      HIGH,
      site
    ));
  }
  if (evidence.support?.help_center) {
    signals.push(signal(
      'Help centre or customer service page',
      'The site publishes a help centre, knowledge base or customer service page.',
      'The business has enough recurring customer questions to justify documenting them.',
      MEDIUM,
      site
    ));
  }
  if (evidence.hiring?.support_roles) {
    signals.push(signal(
      'Customer-facing hiring',
      `Careers content mentions customer-facing roles: "${evidence.hiring.examples[0] ?? ''}"`,
      'The business may be increasing its customer-facing capacity.',
      HIGH,
      site
    ));
  } else if (evidence.hiring?.page_found) {
    signals.push(signal(
      'Actively hiring',
      'A careers or jobs page is published on the site.',
      'The business appears to be growing its team; whether that includes support roles is not established.',
      LOW,
      site
    ));
  }

  // --- Interaction volume, from the source data ----------------------------
  if (lead.review_count != null && lead.review_count >= 100) {
    signals.push(signal(
      'High public review volume',
      `${lead.review_count} reviews${lead.rating ? ` at ${lead.rating} stars` : ''} in ${file}.`,
      'A large review count indicates substantial customer throughput; it is a proxy for interaction volume, not a measure of it.',
      lead.review_count >= 400 ? MEDIUM : LOW,
      file
    ));
  }

  // --- Things that argue against this being a prospect ----------------------
  if (lead.domain && !evidence.website_reachable) {
    signals.push(signal(
      'Website could not be read',
      `${evidence.pages_failed?.length ?? 0} request(s) to ${lead.domain} failed (${evidence.pages_failed?.[0]?.status ?? evidence.pages_failed?.[0]?.error ?? 'no response'}).`,
      'No website evidence is available for this lead. Scores below rest on the spreadsheet fields alone and should be treated as provisional.',
      HIGH,
      lead.domain
    ));
  }
  if (!lead.domain) {
    signals.push(signal(
      'No website on file',
      `No website value in ${file}.`,
      'Without a website there is little public evidence to work from, and no reliable way to confirm an Instagram account.',
      HIGH,
      file
    ));
  }

  return signals;
}

/** Signals that support each service, for the scorer and the offer decision. */
export function splitSignals(signals) {
  const voiceNames = new Set([
    'Phone is a prominent contact channel', 'Call-to-action asks customers to phone',
    'Appointment booking in use', 'Appointment-led customer journey',
    'Appointment-based business category', 'After-hours availability advertised',
    'Phone-heavy business category', 'Phone number published'
  ]);
  const supportNames = new Set([
    'Sells online', 'Sizeable product catalogue', 'Published returns or refunds policy',
    'Multiple customer contact channels', 'Live chat already in place',
    'Help centre or customer service page', 'Customer-facing hiring', 'Actively hiring'
  ]);
  return {
    voice: signals.filter((s) => voiceNames.has(s.signal)),
    support: signals.filter((s) => supportNames.has(s.signal)),
    caveats: signals.filter((s) => s.signal === 'Website could not be read' || s.signal === 'No website on file')
  };
}
