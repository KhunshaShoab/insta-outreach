import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const readJson = (relative) => JSON.parse(readFileSync(join(ROOT, relative), 'utf8'));
export const readText = (relative) => readFileSync(join(ROOT, relative), 'utf8');

export const scoringProfile = readJson('config/scoring.default.json');
export const cleaningRules = readJson('config/cleaning.json');
export const followupDefaults = readJson('config/followups.default.json');
export const niches = readJson('config/niches.json').niches;
export const nicheById = (id) => niches.find((n) => n.id === id);
export const campaign = readJson('config/campaigns/california-medspas.json');

/** A realistic, fully populated medspa lead that should qualify. */
export const goodMedspa = {
  business_name: 'Glow Med Spa',
  name_normalized: 'glow medspa',
  instagram_handle: 'glowmedspa',
  instagram_url: 'https://www.instagram.com/glowmedspa/',
  website: 'https://glowmedspa.com',
  website_domain: 'glowmedspa.com',
  website_description: 'Medical spa in Los Angeles offering botox, fillers, laser hair removal and facials.',
  email: 'hello@glowmedspa.com',
  phone_e164: '+13105551234',
  city: 'Los Angeles',
  state: 'CA',
  category: 'Medical spa',
  bio: 'Medical spa in LA. Botox, filler, laser. DM us for pricing and availability.',
  products_services: ['Botox', 'Dermal fillers', 'Laser hair removal', 'HydraFacial', 'Microneedling'],
  products_count: 5,
  ig_followers: 4200,
  ig_following: 800,
  ig_posts: 430,
  ig_is_business: true,
  ig_is_private: false,
  days_since_last_post: 3,
  flags: { niche_hits: ['medspa', 'botox'] }
};

export const founderContact = {
  full_name: 'Sarah Mitchell',
  first_name: 'Sarah',
  title: 'Founder',
  role_category: 'founder',
  email: 'sarah@glowmedspa.com',
  linkedin_url: 'https://linkedin.com/in/sarahmitchell',
  source: 'apollo',
  source_confidence: 0.9
};

/** A personal account that must be filtered out at the cleaning stage. */
export const personalAccount = {
  business_name: 'Jessica Adams',
  instagram_handle: 'jess.adams',
  bio: "I'm a content creator and mom of two sharing my skincare journey",
  products_services: [],
  ig_followers: 5400,
  ig_posts: 220,
  ig_is_business: false,
  city: 'Los Angeles',
  state: 'CA'
};

/** A competitor that must never be pitched. */
export const competitor = {
  business_name: 'PeakSupport BPO',
  instagram_handle: 'peaksupportbpo',
  bio: 'Leading BPO and call center services for e-commerce brands.',
  website: 'https://peaksupportbpo.com',
  website_domain: 'peaksupportbpo.com',
  products_services: ['Customer support', 'Live chat'],
  ig_followers: 3100,
  ig_posts: 190,
  ig_is_business: true,
  city: 'Los Angeles',
  state: 'CA'
};

export const aiScores = {
  niche_fit: 95,
  business_quality: 82,
  website_quality: 78,
  cx_need: 88,
  outreach_potential: 90
};
