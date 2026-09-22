// ---------------------------------------------------------------------------
// AI adapter: deterministic mock.
// Lets the entire pipeline run end to end in tests and dry runs without an API
// key or a cent of spend. Responses are derived from the input so assertions
// stay stable.
// ---------------------------------------------------------------------------

export function create(env = {}, spec = {}) {
  const fixtures = spec.fixtures ?? {};

  return {
    async complete({ prompt, schema = null, model = 'mock' } = {}) {
      const kind = detectKind(prompt);
      const data = fixtures[kind] ?? build(kind, prompt);
      return { data, raw: JSON.stringify(data), usage: { input_tokens: 0, output_tokens: 0 }, model, latency_ms: 0, repaired: false, mock_kind: kind };
    }
  };
}

function detectKind(prompt = '') {
  const p = String(prompt).toLowerCase();
  if (p.includes('icp qualification analyst')) return 'qualification';
  if (p.includes('decision-maker')) return 'decision_maker';
  if (p.includes('research analyst')) return 'research';
  if (p.includes('reply classification')) return 'reply_classification';
  if (p.includes('response assistant')) return 'suggested_response';
  if (p.includes('conversation analysis') || p.includes('analyse a full instagram conversation')) return 'conversation_analysis';
  if (p.includes('daily') && p.includes('report')) return 'daily_report_summary';
  if (p.includes('follow-up')) return 'followup_message';
  if (p.includes('outreach angle')) return 'outreach_angle';
  if (p.includes('outreach writer')) return 'outreach_message';
  return 'unknown';
}

function build(kind) {
  switch (kind) {
    case 'qualification':
      return {
        ai_scores: { niche_fit: 90, business_quality: 80, website_quality: 70, cx_need: 85, outreach_potential: 88 },
        reason: 'Mock qualification: the business sits squarely in the target niche and shows visible inbound inquiry volume in its bio and comments.',
        potential_pain_points: ['Pricing inquiries answered slowly during business hours', 'No coverage for inquiries arriving after closing time'],
        recommended_service: 'Social media inbox support',
        recommended_outreach_angle: 'speed_to_lead',
        decision_maker_found: true,
        confidence: 0.8,
        disqualify: false,
        disqualify_reason: null
      };
    case 'decision_maker':
      return {
        target_contact: 'Sarah Mitchell',
        address_as: 'Sarah',
        contact_role: 'Founder',
        role_category: 'founder',
        why_this_person: 'Mock: a founder-led business of this size, where the founder still handles day-to-day operations.',
        confidence: 0.8,
        alternative_contacts: [],
        no_contact_strategy: null
      };
    case 'research':
      return {
        business_summary: 'Mock research brief. The business sells a small range of products directly to consumers and uses Instagram as its main storefront and support channel.',
        what_they_sell: 'A short line of consumer products',
        who_their_customers_are: 'Direct-to-consumer buyers found through Instagram',
        instagram_focus: 'Product photography and launch announcements',
        business_model: 'ecommerce_brand',
        likely_decision_maker: { name: 'Sarah Mitchell', role: 'Founder', why: 'Mock.' },
        cx_needs: ['Order status questions answered outside working hours'],
        operational_pain_points: ['Order and shipping questions handled personally by the founder'],
        specific_observations: ['Their bio routes product questions to DMs'],
        why_optiflow_relevant: 'Mock relevance: the founder currently absorbs the inbound order questions that a dedicated support agent would handle.',
        recommended_service: 'E-commerce customer support',
        recommended_angle: 'order_questions',
        confidence: 0.7,
        evidence: ['bio', 'products_services']
      };
    case 'outreach_angle':
      return {
        angle_id: 'order_questions',
        why_this_angle: 'Mock: the bio routes order questions to DMs, which is exactly what this angle addresses.',
        supporting_observation: 'Their bio routes product questions to DMs',
        runner_up_angle_id: 'returns',
        confidence: 0.75
      };
    case 'outreach_message':
      return {
        variations: [
          { variation: 'conversational', message: 'Mock conversational message that opens with a specific observation and ends with a question?', char_count: 88 },
          { variation: 'professional', message: 'Mock professional message that opens with a specific observation and ends with a question?', char_count: 87 },
          { variation: 'concise', message: 'Mock concise message ending in a question?', char_count: 41 }
        ],
        recommended_variation: 'conversational',
        recommendation_reason: 'Mock: the brand voice is informal.',
        outreach_angle: 'order_questions',
        personalisation_used: ['Their bio routes product questions to DMs'],
        self_check: {
          opens_with_specific_detail: true,
          no_service_list: true,
          ends_with_one_question: true,
          under_max_chars: true,
          no_banned_phrases: true
        }
      };
    case 'reply_classification':
      return {
        classification: 'interested',
        intent: 'wants to understand how it would work',
        sentiment: 'positive',
        urgency: 'high',
        objection_type: null,
        recommended_action: 'continue_conversation',
        stop_followups: true,
        requires_human: false,
        suggested_stage: 'CONVERSATION',
        confidence: 0.85,
        reasoning: 'Mock: the reply asks a direct how-it-works question.',
        extracted: { redirect_to: null, timeframe: null, constraints: [], other: null }
      };
    case 'suggested_response':
      return {
        suggested_response: 'Mock suggested reply that answers the question directly and asks one follow-up question.',
        char_count: 87,
        reason: 'Mock: they asked how it works, so the reply explains the mechanics before anything else.',
        next_action: 'continue_conversation',
        alternatives: [],
        requires_human_review: true,
        flags: [],
        self_check: { answers_their_question: true, no_invented_facts: true, under_900_chars: true, matches_their_register: true }
      };
    case 'followup_message':
      return {
        message: 'Mock follow-up that approaches the same idea from a different side.',
        char_count: 67,
        reason_for_this_followup: 'Mock: re-frames the original observation without repeating it.',
        references: ['initial message'],
        self_check: {
          not_just_following_up: true,
          adds_new_information: true,
          different_opening_from_previous: true,
          under_max_chars: true,
          no_pressure_language: true
        }
      };
    case 'conversation_analysis':
      return {
        summary: 'Mock analysis: one question asked and answered, awaiting their reply.',
        current_state: 'awaiting_them',
        buying_signals: ['"how exactly would you guys help us?"'],
        risk_signals: [],
        open_questions: [],
        commitments: [],
        objections_raised: [],
        recommended_stage: 'CONVERSATION',
        recommended_next_step: 'Wait two working days, then re-engage with the unused observation.',
        stalled: false,
        confidence: 0.7
      };
    case 'daily_report_summary':
      return {
        headline: 'Mock: 100 leads discovered, 42 qualified, 30 messages sent, 2 replies.',
        observations: ['Mock observation with numbers attached (2/30 replies).'],
        segments_too_small_to_read: ['medspas x CA (30 sent)'],
        questions_seen: [],
        objections_seen: [],
        attention: [],
        notes_for_tomorrow: []
      };
    default:
      return {};
  }
}
