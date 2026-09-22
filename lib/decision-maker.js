// ---------------------------------------------------------------------------
// Decision-maker identification.
// Small businesses: the founder/owner is the buyer. Larger ones: the person who
// owns the support queue is. The ranking below encodes that, and every choice
// carries a reason string that goes straight into the outreach prompt.
// ---------------------------------------------------------------------------

export const ROLE_PATTERNS = [
  { role: 'founder',            re: /\b(founder|co[-\s]?founder|founding partner)\b/i },
  { role: 'owner',              re: /\b(owner|proprietor|principal|practice owner)\b/i },
  { role: 'ceo',                re: /\b(chief executive|ceo|managing director|president)\b/i },
  { role: 'head_of_operations', re: /\b(head of (operations|ops)|operations (director|manager|lead)|coo|director of operations)\b/i },
  { role: 'cx_director',        re: /\b(customer experience|cx (director|lead|manager)|head of customer)\b/i },
  { role: 'support_manager',    re: /\b(customer (support|service)|support (manager|lead)|service manager|patient coordinator|front office manager)\b/i },
  { role: 'marketing_director', re: /\b(marketing (director|manager|lead|head)|cmo|growth (lead|manager))\b/i }
];

/** Priority by company size. Index 0 is the strongest target. */
export const PRIORITY_SMALL = ['founder', 'owner', 'co_founder', 'ceo', 'head_of_operations', 'support_manager', 'cx_director', 'marketing_director'];
export const PRIORITY_LARGE = ['head_of_operations', 'cx_director', 'support_manager', 'marketing_director', 'ceo', 'founder', 'owner', 'co_founder'];

/** Fewer than this many employees counts as "small" for targeting purposes. */
export const SMALL_COMPANY_MAX_EMPLOYEES = 25;

export function classifyRole(title) {
  if (!title) return 'unknown';
  const t = String(title);
  if (/\bco[-\s]?founder\b/i.test(t)) return 'co_founder';
  for (const { role, re } of ROLE_PATTERNS) if (re.test(t)) return role;
  return 'other';
}

export function isSmallBusiness({ employee_count = null, company_size = null, ig_followers = null, business_model = null } = {}) {
  if (typeof employee_count === 'number') return employee_count <= SMALL_COMPANY_MAX_EMPLOYEES;
  if (company_size) {
    const m = String(company_size).match(/(\d+)/);
    if (m) return Number(m[1]) <= SMALL_COMPANY_MAX_EMPLOYEES;
    if (/^(1-10|11-20|11-50|small|micro)$/i.test(company_size)) return true;
  }
  // No size signal: an account in our follower band is almost always small.
  if (ig_followers != null && ig_followers <= 25000) return true;
  return business_model === 'local_service';
}

function contactCompleteness(contact) {
  let n = 0;
  if (contact.email) n += 3;
  if (contact.linkedin_url) n += 2;
  if (contact.instagram_handle) n += 2;
  if (contact.phone) n += 1;
  if (contact.full_name) n += 2;
  return n;
}

/**
 * Pick the person to address in the DM.
 * @returns {{ contact, role, why, ranked, confidence }}
 */
export function selectDecisionMaker(contacts = [], company = {}) {
  const small = isSmallBusiness(company);
  const priority = small ? PRIORITY_SMALL : PRIORITY_LARGE;

  const scored = contacts
    .filter((c) => c && (c.full_name || c.title))
    .map((c) => {
      const role = c.role_category && c.role_category !== 'unknown' ? c.role_category : classifyRole(c.title);
      const rank = priority.indexOf(role);
      return {
        ...c,
        role_category: role,
        _rank: rank === -1 ? priority.length + (role === 'other' ? 1 : 0) : rank,
        _completeness: contactCompleteness(c),
        _confidence: typeof c.source_confidence === 'number' ? c.source_confidence : 0.5
      };
    })
    .sort((a, b) =>
      a._rank - b._rank ||
      b._confidence - a._confidence ||
      b._completeness - a._completeness
    );

  if (!scored.length) {
    return {
      contact: null,
      role: null,
      why: 'No named person could be verified from public sources. Outreach will address the business account directly without using a name.',
      ranked: [],
      confidence: 0
    };
  }

  const chosen = scored[0];
  return {
    contact: chosen,
    role: chosen.role_category,
    why: explainChoice(chosen, company, small),
    ranked: scored.map((c) => ({ full_name: c.full_name, title: c.title, role_category: c.role_category, rank: c._rank })),
    confidence: Number((chosen._confidence * (chosen._rank < priority.length ? 1 : 0.6)).toFixed(2))
  };
}

function explainChoice(contact, company, small) {
  const name = contact.full_name ?? 'this contact';
  const title = contact.title ?? contact.role_category?.replace(/_/g, ' ');
  const size = company.employee_count
    ? `${company.employee_count} employees`
    : company.company_size ?? (small ? 'a small team' : 'a larger team');
  if (small && ['founder', 'owner', 'co_founder', 'ceo'].includes(contact.role_category)) {
    return `${name} is listed as ${title}. At ${size}, the founder/owner is normally the person who still answers the DMs and decides whether to hand that off.`;
  }
  if (['head_of_operations', 'cx_director', 'support_manager'].includes(contact.role_category)) {
    return `${name} is listed as ${title}. At ${size}, this is the person who owns the support queue and feels the volume directly.`;
  }
  if (contact.role_category === 'marketing_director') {
    return `${name} is listed as ${title}. No operations or support lead was found publicly, and marketing usually owns the social inbox where these inquiries land.`;
  }
  return `${name} (${title ?? 'role unclear'}) is the most senior contact that could be verified publicly for this business.`;
}
