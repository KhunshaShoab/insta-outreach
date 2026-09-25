// The composer writes the messages whenever Claude is unreachable, so the rules
// in prompts/v1-instagram-dm.md have to hold as assertions, not as good intent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeDm, BANNED_PHRASES } from '../lib/v1/compose-dm.js';

const signal = (name, evidence, confidence = 'HIGH') =>
  ({ signal: name, evidence, interpretation: 'should never appear in a message', confidence, source: 'https://example.com' });

const lead = (overrides = {}) => ({
  company_name: 'Glow Medspa',
  city: 'Austin',
  state: 'TX',
  category: 'Medical spa',
  business_instagram: 'glowmedspa',
  recommended_offer: 'AI_VOICE',
  signals: [signal('Call-to-action asks customers to phone', 'Website text includes: "Call us today to book"')],
  ...overrides
});

test('opens on the evidence, not the interpretation', () => {
  const out = composeDm(lead());
  assert.match(out.personalized_instagram_dm, /Call us today to book/);
  assert.ok(!out.personalized_instagram_dm.includes('should never appear'));
  assert.equal(out.self_check.opens_with_verified_observation, true);
});

test('ends with exactly one question', () => {
  for (const name of ['After-hours availability advertised', 'Appointment booking in use', 'Live chat already in place']) {
    const evidence = {
      'After-hours availability advertised': 'Website text includes: "open until 9pm"',
      'Appointment booking in use': 'Booking platform detected: Boulevard.',
      'Live chat already in place': 'Intercom chat widget detected.'
    }[name];
    const out = composeDm(lead({ signals: [signal(name, evidence)] }));
    const dm = out.personalized_instagram_dm;
    assert.ok(dm.endsWith('?'), `${name}: does not end with a question`);
    assert.equal((dm.match(/\?/g) ?? []).length, 1, `${name}: more than one question mark`);
  }
});

test('a question mark inside the quoted evidence does not become a second question', () => {
  const out = composeDm(lead({
    signals: [signal('Call-to-action asks customers to phone', 'Website text includes: "Ready to book? Call us"')]
  }));
  assert.equal((out.personalized_instagram_dm.match(/\?/g) ?? []).length, 1);
  assert.equal(out.self_check.ends_with_question, true);
});

test('the closing question is punctuated once', () => {
  // The question variants are authored as sentences and the "?" is appended, so
  // without normalising them every message ended ".?".
  const cases = [
    lead(),
    lead({ signals: [signal('Appointment booking in use', 'Booking platform detected: Boulevard.')] }),
    lead({ signals: [signal('After-hours availability advertised', 'Website text includes: "open late"')] }),
    lead({ signals: [signal('Phone-heavy business category', 'Category "Medical spa".', 'LOW')] })
  ];
  for (const record of cases) {
    const dm = composeDm(record).personalized_instagram_dm;
    assert.ok(!/[.!,;:]\?/.test(dm), `double punctuation before the question mark: ${dm}`);
    assert.ok(!/\.\s*\.|\s\./.test(dm.slice(0, -1).replace(/\S\./g, '')), `stray full stop: ${dm}`);
  }
});

test('no banned phrase, no gendered pronoun, under the limit', () => {
  const cases = [
    lead(),
    lead({ recommended_offer: 'CUSTOMER_SUPPORT', signals: [signal('Multiple customer contact channels', 'Channels present on the website: phone, email, contact form.', 'MEDIUM')] }),
    lead({ owner_name: 'Dana Whitfield' }),
    lead({ signals: [signal('Appointment-based business category', 'The source file lists the category as "Medical spa".', 'LOW')] })
  ];
  for (const record of cases) {
    const dm = composeDm(record).personalized_instagram_dm.toLowerCase();
    for (const phrase of BANNED_PHRASES) assert.ok(!dm.includes(phrase), `contains "${phrase}": ${dm}`);
    assert.ok(!/\b(he|him|his|she|her|hers)\b/.test(dm), `gendered pronoun in: ${dm}`);
    assert.ok(dm.length <= 500 && dm.length > 60, `bad length ${dm.length}`);
  }
});

test('low-confidence-only leads get a general message and say so', () => {
  const out = composeDm(lead({
    signals: [signal('Phone-heavy business category', 'Category "Medical spa".', 'LOW')]
  }));
  assert.equal(out.self_check.opens_with_verified_observation, false);
  assert.match(out.why_this_message, /No medium or high confidence signal/);
  assert.ok(out.personalized_instagram_dm.endsWith('?'));
  // It must not quote a fact about this business it cannot support.
  assert.ok(!out.personalized_instagram_dm.includes('Category "Medical spa"'));
});

test('NONE never gets a message', () => {
  const out = composeDm(lead({ recommended_offer: 'NONE' }));
  assert.equal(out.personalized_instagram_dm, '');
  assert.match(out.why_this_message, /does not support an approach/);
});

test('BOTH leads with the voice capability', () => {
  const out = composeDm(lead({ recommended_offer: 'BOTH' }));
  assert.equal(out.capability_mentioned, 'AI voice receptionist');
});

test('the same lead always composes to the same message', () => {
  const a = composeDm(lead()).personalized_instagram_dm;
  const b = composeDm(lead()).personalized_instagram_dm;
  assert.equal(a, b);
});

test('a batch does not read as one template repeated', () => {
  // Same signal, different businesses: the surface wording must vary, or 400
  // recipients receive a message that is obviously bulk.
  const names = ['Glow Medspa', 'Radiance Aesthetics', 'Lumen Skin Bar', 'Ember Med Spa',
    'Vivid Aesthetics', 'Halo Skin Clinic', 'Nova Medspa', 'Saga Aesthetics'];
  const openings = new Set(names.map((company_name) =>
    composeDm(lead({ company_name })).personalized_instagram_dm.split(' -')[0]));
  assert.ok(openings.size >= 2, 'every message opened identically');
  const fulls = new Set(names.map((company_name) => composeDm(lead({ company_name })).personalized_instagram_dm));
  assert.ok(fulls.size >= 4, `only ${fulls.size} distinct messages across ${names.length} businesses`);
});

test('the owner first name is used only when it looks like a name', () => {
  assert.match(composeDm(lead({ owner_name: 'Dana Whitfield' })).personalized_instagram_dm, /^Dana - /);
  // A blank or junk owner value must not produce a dangling greeting.
  for (const owner of ['', null, '   ', '1234']) {
    const dm = composeDm(lead({ owner_name: owner })).personalized_instagram_dm;
    assert.ok(!dm.startsWith(' - ') && !dm.startsWith('-'), `dangling greeting for ${JSON.stringify(owner)}`);
  }
});

test('every self_check passes on a normal evidence-backed lead', () => {
  const out = composeDm(lead());
  for (const [check, value] of Object.entries(out.self_check)) {
    assert.equal(value, true, `${check} failed: ${out.personalized_instagram_dm}`);
  }
});

test('a scraped nav or footer fragment is not quoted at the prospect', () => {
  // Real evidence from the medspa run: the strongest "call to action" on one site
  // was its footer. Quoting it reads as a scrape and hands back their own address.
  const junk = [
    '...glowmedspa.co@gmail.com Facebook-f Instagram Call',
    'Website text includes: "Skip to content Menu Home About Call"',
    'Website text includes: "Call 512-555-0199"',
    'Website text includes: "Book | Shop | Call"'
  ];
  for (const evidence of junk) {
    const out = composeDm(lead({
      signals: [signal('Call-to-action asks customers to phone', evidence),
        signal('Appointment booking in use', 'Booking platform detected: Boulevard.')]
    }));
    const dm = out.personalized_instagram_dm;
    assert.ok(!dm.includes('@'), `email leaked: ${dm}`);
    assert.ok(!/Facebook|Instagram|Skip to content|512-555/.test(dm), `nav or phone quoted: ${dm}`);
    // It must fall through to the next usable signal, not go silent.
    assert.match(dm, /Boulevard/);
  }
});

test('only real contact channels are called ways to get in touch', () => {
  const out = composeDm(lead({
    recommended_offer: 'CUSTOMER_SUPPORT',
    signals: [signal('Multiple customer contact channels',
      'Channels present on the website: returns/refunds policy, email, phone, contact form.', 'MEDIUM')]
  }));
  const dm = out.personalized_instagram_dm;
  assert.ok(!dm.includes('returns/refunds policy'), `a returns policy is not a contact channel: ${dm}`);
  assert.match(dm, /email, phone and contact form/);
});

test('a channel signal with nothing contactable in it is skipped', () => {
  const out = composeDm(lead({
    recommended_offer: 'CUSTOMER_SUPPORT',
    signals: [signal('Multiple customer contact channels',
      'Channels present on the website: returns/refunds policy, help centre or customer service page.', 'MEDIUM')]
  }));
  assert.equal(out.self_check.opens_with_verified_observation, false);
});
