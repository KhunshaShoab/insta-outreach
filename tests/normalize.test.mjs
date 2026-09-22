import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeBusinessName, normalizeHandle, normalizeUrl, normalizeDomain,
  normalizePhone, normalizeEmail, normalizeState, normalizeCity,
  parseCount, toProductList, normalizeRawLead, isAggregatorDomain
} from '../lib/normalize.js';

test('business names collapse to a comparable key', () => {
  assert.equal(normalizeBusinessName('Glow Med Spa, LLC'), 'glow medspa');
  assert.equal(normalizeBusinessName('  The Glow  Medspa Inc. '), 'glow medspa');
  assert.equal(normalizeBusinessName('GLOW MEDSPA 💫'), 'glow medspa');
  assert.notEqual(normalizeBusinessName('Glow Medspa'), normalizeBusinessName('Grow Medspa'));
  assert.equal(normalizeBusinessName(''), null);
});

test('instagram handles are extracted from any form', () => {
  assert.equal(normalizeHandle('@GlowMedSpa'), 'glowmedspa');
  assert.equal(normalizeHandle('https://instagram.com/GlowMedSpa/?hl=en'), 'glowmedspa');
  assert.equal(normalizeHandle('https://www.instagram.com/glow.med_spa/'), 'glow.med_spa');
  assert.equal(normalizeHandle('instagram.com/p/Cxyz123'), null, 'post URLs are not handles');
  assert.equal(normalizeHandle('not a handle!'), null);
});

test('urls are normalised and tracking parameters dropped', () => {
  assert.equal(normalizeUrl('WWW.GlowMedSpa.com/about?utm_source=ig&id=3'), 'https://www.glowmedspa.com/about?id=3');
  assert.equal(normalizeUrl('n/a'), null);
  assert.equal(normalizeDomain('https://www.GlowMedSpa.com/'), 'glowmedspa.com');
});

test('link-in-bio aggregators never become a website identity', () => {
  assert.ok(isAggregatorDomain('linktr.ee'));
  assert.equal(normalizeDomain('https://linktr.ee/glowmedspa'), null);
  assert.equal(normalizeDomain('https://www.instagram.com/glowmedspa'), null);
});

test('phones normalise to E.164 and junk is rejected', () => {
  assert.equal(normalizePhone('(310) 555-1234'), '+13105551234');
  assert.equal(normalizePhone('1-310-555-1234'), '+13105551234');
  assert.equal(normalizePhone('+44 20 7946 0958'), '+442079460958');
  assert.equal(normalizePhone('555-5555'), null, 'too short');
  assert.equal(normalizePhone('0005551234'), null, 'invalid area code');
  assert.equal(normalizePhone('5555555555'), null, 'repeated-digit junk');
});

test('emails are lowercased and role addresses that cannot receive mail are dropped', () => {
  assert.equal(normalizeEmail(' Hello@GlowMedSpa.com '), 'hello@glowmedspa.com');
  assert.equal(normalizeEmail('noreply@glowmedspa.com'), null);
  assert.equal(normalizeEmail('not-an-email'), null);
});

test('states and cities normalise', () => {
  assert.equal(normalizeState('california'), 'CA');
  assert.equal(normalizeState('CA'), 'CA');
  assert.equal(normalizeState('New York'), 'NY');
  assert.equal(normalizeState('Nowhere'), null);
  assert.equal(normalizeCity('  los  angeles '), 'Los Angeles');
});

test('counts parse from abbreviated forms', () => {
  assert.equal(parseCount('12.3k'), 12300);
  assert.equal(parseCount('1,234'), 1234);
  assert.equal(parseCount('2.1M'), 2100000);
  assert.equal(parseCount(''), null);
  assert.equal(parseCount('abc'), null);
});

test('product lists deduplicate and reject noise', () => {
  assert.deepEqual(toProductList('Botox, Filler , botox'), ['Botox', 'Filler']);
  assert.deepEqual(toProductList([{ name: 'Facial' }, { title: 'Peel' }]), ['Facial', 'Peel']);
  assert.deepEqual(toProductList(null), []);
});

test('a provider row maps onto the canonical lead shape', () => {
  const lead = normalizeRawLead({
    title: 'Glow Med Spa LLC',
    instagram: 'https://instagram.com/GlowMedSpa',
    website: 'glowmedspa.com',
    phoneNumber: '(310) 555-1234',
    city: 'los angeles',
    state: 'California',
    followersCount: '4.2k',
    categoryName: 'Medical spa',
    categories: ['Botox', 'Filler', 'Botox']
  });
  assert.equal(lead.business_name, 'Glow Med Spa LLC');
  assert.equal(lead.name_normalized, 'glow medspa');
  assert.equal(lead.instagram_handle, 'glowmedspa');
  assert.equal(lead.website_domain, 'glowmedspa.com');
  assert.equal(lead.phone_e164, '+13105551234');
  assert.equal(lead.state, 'CA');
  assert.equal(lead.city, 'Los Angeles');
  assert.equal(lead.ig_followers, 4200);
  assert.deepEqual(lead.products_services, ['Botox', 'Filler']);
  assert.equal(lead.products_count, 2);
});
