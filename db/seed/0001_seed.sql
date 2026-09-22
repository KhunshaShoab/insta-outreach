-- ===========================================================================
-- Seed: default scoring profile. Niches and campaigns are loaded from the
-- JSON in config/ by scripts/load-config.mjs so the files stay the source of
-- truth for configuration (and stay diffable in git).
-- ===========================================================================

insert into scoring_profiles (id, name, config) values (
  'default', 'OptiFlow default ICP scoring',
  '{"weights":{"location_fit":14,"niche_fit":15,"follower_fit":12,"products_fit":10,"business_quality":12,"instagram_activity":8,"website_quality":5,"decision_maker":8,"cx_need":10,"outreach_potential":6}}'::jsonb
) on conflict (id) do nothing;

insert into suppressions (key_type, key_value, reason, created_by) values
  ('instagram_handle', 'optiflowsolutions', 'own account', 'seed')
on conflict do nothing;
