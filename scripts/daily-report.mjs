#!/usr/bin/env node
// Print the daily report from the terminal, without n8n and without the model.
//   node scripts/daily-report.mjs [YYYY-MM-DD] [campaign_id]
//
// Reports what was measured. It never ranks niches, states or angles unless you
// pass --rank-by, and it says so when a segment's sample is too small to read.
async function main() {
  const [, , dayArg, campaignArg] = process.argv;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(dayArg ?? '') ? dayArg : new Date().toISOString().slice(0, 10);
  const campaignId = campaignArg && !campaignArg.startsWith('--') ? campaignArg : null;
  const rankBy = process.argv.find((a) => a.startsWith('--rank-by='))?.split('=')[1] ?? null;
  const MIN_SAMPLE = 20;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY).');
    process.exit(1);
  }

  const response = await fetch(`${url.replace(/\/+$/, '')}/rest/v1/rpc/daily_report`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_day: day, p_campaign_id: campaignId })
  });

  if (!response.ok) {
    console.error(`daily_report failed (HTTP ${response.status}): ${(await response.text()).slice(0, 300)}`);
    process.exit(1);
  }

  const report = await response.json();
  const r = Array.isArray(report) ? report[0] : report;

  const rate = (a, b) => (b ? `${Math.round((a / b) * 1000) / 10}%` : 'n/a');
  const line = (label, value) => console.log(`${label.padEnd(24)} ${String(value ?? 0).padStart(6)}`);

  console.log(`\nOptiFlow Instagram Outreach - ${r.day}${campaignId ? ` - ${campaignId}` : ''}\n${'-'.repeat(48)}`);
  line('Leads discovered', r.leads_discovered);
  line('Leads enriched', r.leads_enriched);
  line('Leads evaluated', r.leads_evaluated);
  line('Qualified', r.leads_qualified);
  line('Qualification rate', rate(r.leads_qualified, r.leads_evaluated));
  line('Messages generated', r.messages_generated);
  line('Messages approved', r.messages_approved);
  line('Messages sent', r.messages_sent);
  line('Replies', r.replies);
  line('Reply rate', rate(r.replies, r.messages_sent));
  line('Positive replies', r.positive_replies);
  line('Positive reply rate', rate(r.positive_replies, r.messages_sent));
  line('Follow-ups due', r.followups_due);
  line('Interested', r.interested_total);
  line('Nurture', r.nurture_total);
  line('Not interested', r.not_interested_total);
  line('Open errors', r.errors_open);

  function segment(title, rows, keyName) {
    if (!rows?.length) return;
    console.log(`\n${title}`);
    let list = [...rows];
    if (rankBy) {
      if (!(rankBy in (list[0] ?? {}))) {
        console.log(`  (cannot rank by "${rankBy}" - not a column here)`);
      } else {
        list.sort((a, b) => (b[rankBy] ?? -1) - (a[rankBy] ?? -1));
        console.log(`  (ordered by ${rankBy}, as requested)`);
      }
    }
    for (const row of list) {
      const label = String(row[keyName] ?? 'unknown').padEnd(22);
      if (!row.sent) {
        console.log(`  ${label} nothing sent yet`);
        continue;
      }
      const note = row.sent < MIN_SAMPLE ? `  <- only ${row.sent} sent, too small to read` : '';
      console.log(`  ${label} ${String(row.reply_rate ?? 0).padStart(5)}% reply rate (${row.replies ?? 0}/${row.sent})${note}`);
    }
  }

  segment('By niche (measured, not ranked):', r.by_niche, 'niche_id');
  segment('By state (measured, not ranked):', r.by_state, 'state');
  segment('By outreach angle (measured, not ranked):', r.by_angle, 'outreach_angle');

  if (r.reply_categories?.length) {
    console.log('\nReply categories:');
    for (const row of r.reply_categories) console.log(`  ${String(row.classification).padEnd(22)} ${row.count}`);
  }
  if (r.objections?.length) {
    console.log('\nObjections:');
    for (const row of r.objections) console.log(`  ${String(row.objection_type).padEnd(22)} ${row.count}`);
  }
  console.log(rankBy ? '' : '\nNo ranking applied. Pass --rank-by=reply_rate to order the segments above.\n');

}

// Importing this file (the linter does) must not run it.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  await main();
}
