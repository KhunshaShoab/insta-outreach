// ---------------------------------------------------------------------------
// Enrichment fallback: the company's own website.
// Reads the About / Team / Contact pages for names, roles, emails and the
// product/service list. Always runs when the paid provider finds nothing, which
// is the rule that keeps small founder-led businesses in the pipeline.
// ---------------------------------------------------------------------------
import { request } from './http.js';
import { normalizeEmail, normalizePhone, toProductList, collapseWhitespace } from '../normalize.js';
import { classifyRole } from '../decision-maker.js';

const CANDIDATE_PATHS = ['', '/about', '/about-us', '/our-team', '/team', '/meet-the-team', '/contact', '/contact-us', '/pages/about', '/pages/contact'];
const ROLE_WORDS = 'founder|co-?founder|owner|ceo|president|director|head of [a-z ]+|manager|partner|dr\\.?';

export function create(env = {}) {
  return {
    async enrich(company, ctx = {}) {
      const domain = company?.website_domain;
      if (!domain) return { provider: 'website_scrape', found: false, contacts: [], company: {}, reason: 'no website' };

      const contacts = new Map();
      const emails = new Set();
      const phones = new Set();
      let description = null;
      const products = new Set();
      const pagesRead = [];

      for (const path of CANDIDATE_PATHS.slice(0, ctx.maxPages ?? 5)) {
        let html;
        try {
          const res = await request({
            url: `https://${domain}${path}`,
            timeoutMs: ctx.timeoutMs ?? 15000,
            maxRetries: 1,
            provider: 'website_scrape',
            operation: path || '/',
            onCall: ctx.onCall,
            headers: { 'User-Agent': ctx.userAgent ?? 'OptiFlowResearchBot/1.0 (+contact: ops@optiflow.example)' }
          });
          html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
        } catch {
          continue;   // a missing About page is normal, not an error
        }
        pagesRead.push(path || '/');
        const text = stripHtml(html);

        if (!description) description = metaDescription(html);
        for (const email of text.match(/[\w.+-]+@[\w-]+\.[\w.]{2,}/g) ?? []) {
          const clean = normalizeEmail(email);
          if (clean) emails.add(clean);
        }
        for (const phone of text.match(/\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g) ?? []) {
          const clean = normalizePhone(phone);
          if (clean) phones.add(clean);
        }
        for (const person of findPeople(text)) {
          if (!contacts.has(person.full_name.toLowerCase())) contacts.set(person.full_name.toLowerCase(), person);
        }
        for (const item of findProducts(html)) products.add(item);
      }

      const contactList = [...contacts.values()].map((c) => ({
        ...c,
        email: [...emails].find((e) => matchesName(e, c.full_name)) ?? null,
        source: 'website_scrape',
        source_confidence: 0.55
      }));

      return {
        provider: 'website_scrape',
        found: contactList.length > 0 || emails.size > 0,
        contacts: contactList,
        company: {
          email: [...emails][0] ?? null,
          phone_e164: [...phones][0] ?? null,
          website_description: description,
          products_services: toProductList([...products]),
          pages_read: pagesRead
        }
      };
    }
  };
}

function stripHtml(html) {
  return collapseWhitespace(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
  );
}

function metaDescription(html) {
  const m = String(html).match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
  return m ? collapseWhitespace(m[1]).slice(0, 400) : null;
}

/** "Sarah Mitchell, Founder" / "Founder - Sarah Mitchell" */
function findPeople(text) {
  const out = [];
  const patterns = [
    new RegExp(`([A-Z][a-z]+(?:\\s+[A-Z][a-z]+){1,2})\\s*[,|\\-–—]\\s*((?:${ROLE_WORDS})[a-z ]*)`, 'gi'),
    new RegExp(`((?:${ROLE_WORDS})[a-z ]*)\\s*[:|\\-–—]\\s*([A-Z][a-z]+(?:\\s+[A-Z][a-z]+){1,2})`, 'gi')
  ];
  for (const [i, re] of patterns.entries()) {
    let match;
    while ((match = re.exec(text)) !== null) {
      const name = collapseWhitespace(i === 0 ? match[1] : match[2]);
      const title = collapseWhitespace(i === 0 ? match[2] : match[1]);
      if (name.split(' ').length > 3) continue;
      out.push({
        full_name: name,
        first_name: name.split(' ')[0],
        last_name: name.split(' ').slice(-1)[0],
        title: title.replace(/^\W+|\W+$/g, ''),
        role_category: classifyRole(title)
      });
    }
  }
  return out;
}

function findProducts(html) {
  const out = [];
  for (const m of String(html).matchAll(/<(?:h2|h3|a)[^>]*class=["'][^"']*(?:product|service|treatment|collection)[^"']*["'][^>]*>([^<]{3,80})</gi)) {
    out.push(collapseWhitespace(m[1]));
  }
  for (const m of String(html).matchAll(/"(?:product_?name|title)"\s*:\s*"([^"]{3,80})"/gi)) {
    out.push(collapseWhitespace(m[1]));
  }
  return out;
}

function matchesName(email, name) {
  const local = email.split('@')[0].toLowerCase();
  const parts = String(name).toLowerCase().split(/\s+/);
  return parts.some((p) => p.length > 2 && local.includes(p));
}
