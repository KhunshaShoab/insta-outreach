#!/usr/bin/env node
// What this costs to run, per month, at a volume you choose.
//
//   node scripts/cost-estimate.mjs                        # defaults below
//   node scripts/cost-estimate.mjs --leads=2000 --sent=600
//   node scripts/cost-estimate.mjs --profile=economy --have-list
//
// Token counts are measured from this repo's actual rendered prompts, not
// guessed. Prices are Anthropic list rates as of 2026-06; check the pricing
// page before committing to a budget, and use messages.count_tokens for exact
// token figures on your own data.

const MODELS = {
  'claude-opus-5':   { in: 5.00, out: 25.00, label: 'Opus 5' },
  'claude-sonnet-5': { in: 2.00, out: 10.00, label: 'Sonnet 5' },
  'claude-haiku-4-5':{ in: 1.00, out:  5.00, label: 'Haiku 4.5' }
};

// Measured: rendered prompt length / ~3.8 chars per token, on a realistic
// medspa lead. Output estimates are from the schemas' size limits.
const STEPS = {
  qualification: { in: 1968, out: 400, per: 'lead',      label: 'AI qualification' },
  research:      { in: 1601, out: 700, per: 'qualified', label: 'Business research' },
  outreach:      { in: 1457, out: 600, per: 'qualified', label: 'DM writing (3 variations)' },
  followup:      { in: 1084, out: 250, per: 'followup',  label: 'Follow-up writing' },
  classify:      { in: 1262, out: 300, per: 'reply',     label: 'Reply classification' },
  suggest:       { in: 1800, out: 500, per: 'reply',     label: 'Suggested reply' }
};

// Which model each step runs on. "quality" matches the shipped defaults.
const PROFILES = {
  quality: {
    label: 'Shipped defaults - Opus for anything a prospect reads',
    qualification: 'claude-sonnet-5', research: 'claude-opus-5', outreach: 'claude-opus-5',
    followup: 'claude-opus-5', classify: 'claude-sonnet-5', suggest: 'claude-opus-5'
  },
  economy: {
    label: 'Cheaper - Sonnet everywhere, Haiku for classification',
    qualification: 'claude-haiku-4-5', research: 'claude-sonnet-5', outreach: 'claude-sonnet-5',
    followup: 'claude-sonnet-5', classify: 'claude-haiku-4-5', suggest: 'claude-sonnet-5'
  },
  cheapest: {
    label: 'Cheapest that still reads well - Haiku for judgement, Sonnet for writing',
    qualification: 'claude-haiku-4-5', research: 'claude-haiku-4-5', outreach: 'claude-sonnet-5',
    followup: 'claude-sonnet-5', classify: 'claude-haiku-4-5', suggest: 'claude-sonnet-5'
  }
};

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const money = (n) => (n < 10 ? `$${n.toFixed(2)}` : `$${Math.round(n).toLocaleString()}`);
const row = (label, value, note = '') =>
  console.log(`  ${label.padEnd(34)} ${value.padStart(9)}  ${note}`);

function main() {
  const profileName = (process.argv.find((a) => a.startsWith('--profile=')) ?? '').split('=')[1] || 'quality';
  const profile = PROFILES[profileName];
  if (!profile) {
    console.error(`Unknown profile "${profileName}". Choose: ${Object.keys(PROFILES).join(', ')}`);
    process.exit(1);
  }

  // Volume assumptions - override any of them on the command line.
  const leads = arg('leads', 2000);               // new businesses processed / month
  const qualRate = arg('qual-rate', 0.40);        // share that pass qualification
  const sent = arg('sent', 600);                  // DMs actually sent / month
  const replyRate = arg('reply-rate', 0.06);      // share that reply
  const followupsPer = arg('followups-per-lead', 2.2); // avg follow-ups before a reply or the end
  const haveList = flag('have-list');             // skip paid discovery
  const batch = flag('batch');                    // Batch API on the non-urgent steps

  const qualified = Math.round(leads * qualRate);
  const replies = Math.round(sent * replyRate);
  const followups = Math.round(sent * followupsPer);

  const volume = { lead: leads, qualified, reply: replies, followup: followups };

  console.log(`\nMonthly cost estimate - ${profile.label}`);
  console.log('='.repeat(72));
  console.log(`\nVolume assumed (override with --leads= --sent= --qual-rate= etc.)`);
  row('New businesses processed', leads.toLocaleString());
  row('Pass qualification', qualified.toLocaleString(), `${Math.round(qualRate * 100)}%`);
  row('DMs sent', sent.toLocaleString(), 'you send these by hand');
  row('Replies received', replies.toLocaleString(), `${Math.round(replyRate * 100)}% reply rate`);
  row('Follow-ups written', followups.toLocaleString());

  console.log(`\nClaude API${batch ? ' (Batch API: 50% off the non-urgent steps)' : ''}`);
  let aiTotal = 0;
  for (const [key, step] of Object.entries(STEPS)) {
    const model = MODELS[profile[key]];
    const n = volume[step.per];
    // Batch discount applies to work with no person waiting on it.
    const batchable = batch && ['qualification', 'research', 'outreach'].includes(key);
    const discount = batchable ? 0.5 : 1;
    const cost = ((step.in * model.in) + (step.out * model.out)) / 1e6 * n * discount;
    aiTotal += cost;
    row(step.label, money(cost), `${n.toLocaleString()} x ${model.label}${batchable ? ' (batch)' : ''}`);
  }
  row('Claude subtotal', money(aiTotal), '');

  console.log('\nData providers');
  let dataTotal = 0;
  if (haveList) {
    row('Business discovery', '$0', 'you already have the list');
  } else {
    const discovery = leads * 0.007;   // ~$7 per 1,000 Google Maps places on Apify
    dataTotal += discovery;
    row('Business discovery (Apify)', money(discovery), `${leads.toLocaleString()} places @ ~$7/1k`);
  }
  // Instagram profile data is the ICP gate - follower count and bio decide
  // whether a business qualifies at all, and a plain business list has neither.
  const igLookup = leads * 0.0023;     // ~$2.30 per 1,000 profiles
  dataTotal += igLookup;
  row('Instagram profile lookups', money(igLookup), `${leads.toLocaleString()} profiles @ ~$2.30/1k`);

  const apollo = Math.min(qualified, 1000) > 0 ? 49 : 0;
  dataTotal += apollo;
  row('Apollo (contact enrichment)', money(apollo), 'entry paid plan, optional');

  console.log('\nInfrastructure');
  const supabase = 25;
  const n8n = 24;
  const infra = supabase + n8n;
  row('Supabase (database)', money(supabase), 'free tier works to start');
  row('n8n cloud', money(n8n), '$0 if you self-host');

  const total = aiTotal + dataTotal + infra;
  console.log('\n' + '='.repeat(72));
  row('TOTAL PER MONTH', money(total), '');
  row('Cost per DM sent', `$${(total / Math.max(sent, 1)).toFixed(2)}`, '');
  row('Cost per reply', `$${(total / Math.max(replies, 1)).toFixed(2)}`, '');
  console.log('='.repeat(72));

  console.log('\nWhat is NOT in this number');
  console.log('  - Your time. At 600 DMs a month you are sending ~30 a day by hand,');
  console.log('    roughly 1-2 hours daily including replies. That is the real cost.');
  console.log('  - Instagram: nothing. No paid API is involved in sending.');
  console.log('  - Anything you sign up for and forget: check Apify and Apollo monthly.');

  if (!batch) {
    const batchSaving = Object.entries(STEPS)
      .filter(([k]) => ['qualification', 'research', 'outreach'].includes(k))
      .reduce((sum, [k, s]) => sum + ((s.in * MODELS[profile[k]].in) + (s.out * MODELS[profile[k]].out)) / 1e6 * volume[s.per] * 0.5, 0);
    console.log(`\n  Tip: --batch would save about ${money(batchSaving)}/month. Qualification,`);
    console.log('  research and DM writing have nobody waiting on them, so the Batch API');
    console.log('  (50% off, results within 24h) fits them well.');
  }

  console.log('\nPrices: Anthropic list rates cached 2026-06 (Opus 5 $5/$25, Sonnet 5 $2/$10,');
  console.log('Haiku 4.5 $1/$5 per million in/out tokens). Provider prices are list rates and');
  console.log('move - confirm before budgeting. Token counts are measured from this repo\'s');
  console.log('prompts on a realistic lead; your mix will vary.\n');
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main();
}
