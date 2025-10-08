import type { VercelRequest, VercelResponse } from '@vercel/node';

function json(res: VercelResponse, code: number, payload: unknown) {
  res.status(code).setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(payload));
}
function bad(res: VercelResponse, msg: string, code = 400) {
  return json(res, code, { ok: false, error: msg });
}

function ensureAbsoluteUrl(rawIn: unknown) {
  const raw = String(rawIn || '').trim();
  if (!raw) throw new Error('company_url is required (website | company_url | company.url | url)');
  let u = raw.replace(/^"+|"+$/g, '').replace(/^\/\//, 'https://');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  const url = new URL(u);
  const absolute = `${url.protocol}//${url.hostname}`;
  const host = url.hostname.replace(/^www\./i, '').toLowerCase();
  return { absolute, host };
}

// ---------- BYPASS HELPERS ----------
type BypassRule = { cookie?: string; token?: string };
type BypassRules = Record<string, BypassRule>;

function readBypassRules(): BypassRules {
  try {
    const raw = process.env.RESEARCH_BYPASS_RULES || '';
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as BypassRules;
  } catch { /* ignore */ }
  return {};
}

function matchRule(rules: BypassRules, host: string): BypassRule | undefined {
  // Exact, then wildcard like *.domain, then "*"
  if (rules[host]) return rules[host];
  const parts = host.split('.');
  for (let i = 1; i < parts.length; i++) {
    const wc = '*.' + parts.slice(i).join('.');
    if (rules[wc]) return rules[wc];
  }
  return rules['*'];
}

function buildBypassCookie(rule?: BypassRule): string | undefined {
  if (!rule) return undefined;
  if (rule.cookie && rule.cookie.trim()) return rule.cookie.trim();
  if (rule.token && rule.token.trim()) {
    // Standard Vercel protection cookie shape
    return `vercel-protection-bypass=${rule.token.trim()}; vercel-protection-bypass-s=1`;
  }
  return undefined;
}

function looksLikeVercelProtection(html: string) {
  const s = html.toLowerCase();
  return s.includes('authentication required') && s.includes('vercel');
}

// ---------- TINY FETCH / PARSE ----------
async function fetchText(url: string, headers?: Record<string,string>, ms = 7000, maxBytes = 400_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { redirect: 'follow', headers, signal: ctrl.signal });
    const status = res.status;
    const reader = res.body?.getReader?.();
    if (!reader) {
      const txt = await res.text();
      return { status, text: txt };
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) break;
        chunks.push(value);
      }
    }
    const txt = Buffer.concat(chunks).toString('utf8');
    return { status, text: txt };
  } finally {
    clearTimeout(t);
  }
}

function parseXmlLocs(xml: string): string[] {
  const locs: string[] = [];
  const re = /<loc>([^<]+)<\/loc>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) locs.push(m[1].trim());
  return Array.from(new Set(locs));
}

function extractLinksFromHtml(html: string, root: string): string[] {
  const out = new Set<string>();
  const base = new URL(root);
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) continue;
    try {
      const u = new URL(href, base);
      if (u.hostname === base.hostname) {
        out.add(u.href.split('#')[0]);
      }
    } catch { /* ignore */ }
  }
  return Array.from(out);
}

function rankTopK(urls: string[], k = 20) {
  const score = (u: string) => {
    const s = u.toLowerCase();
    let x = 0;
    if (/\/$/.test(s) || /index\.html?$/.test(s)) x += 10; // home
    if (/about/.test(s)) x += 8;
    if (/product|solutions/.test(s)) x += 8;
    if (/pricing/.test(s)) x += 7;
    if (/blog|news|stories/.test(s)) x += 5;
    if (/docs|help|support/.test(s)) x += 5;
    if (/careers|jobs/.test(s)) x += 2;
    if (/contact/.test(s)) x += 4;
    return x;
  };
  return Array.from(new Set(urls)).sort((a, b) => score(b) - score(a)).slice(0, k);
}

// ---------- HTTP HANDLER ----------
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return bad(res, 'Method Not Allowed', 405);
  }

  const b: any = req.body || {};
  const rawUrl = b.website || b.company_url || b?.company?.url || b.url;

  let absolute: string, host: string;
  try {
    ({ absolute, host } = ensureAbsoluteUrl(rawUrl));
  } catch (e: any) {
    return bad(res, e?.message || 'Invalid company URL', 400);
  }

  const tenant_id = b.tenant_id || `tenant_${host.replace(/\./g, '_')}_${Date.now().toString(36)}`;
  const company_name = b.company_name || b?.company?.name || host;

  const rules = readBypassRules();
  const rule = matchRule(rules, host);
  const bypassCookie = buildBypassCookie(rule);

  // ---- DISCOVERY (with retry on protection) ----
  const diagnostics: Record<string, unknown> = {};
  let discovered: string[] = [];
  let source: 'sitemap' | 'homepage' | 'none' = 'none';
  let blocked = false;
  let blocked_reason: string | undefined;

  // 1) Try sitemap
  try {
    const r1 = await fetchText(`${absolute}/sitemap.xml`);
    if (r1.status === 401 || r1.status === 403) {
      // retry with bypass cookie if available
      if (bypassCookie) {
        const r1b = await fetchText(`${absolute}/sitemap.xml`, { cookie: bypassCookie });
        if (r1b.status < 400) {
          const locs = parseXmlLocs(r1b.text).filter(u => u.startsWith(absolute));
          if (locs.length) { discovered = locs; source = 'sitemap'; }
        } else {
          blocked = true;
          blocked_reason = `sitemap_${r1b.status}`;
        }
      } else {
        blocked = true;
        blocked_reason = `sitemap_${r1.status}`;
      }
    } else if (r1.status < 400) {
      const locs = parseXmlLocs(r1.text).filter(u => u.startsWith(absolute));
      if (locs.length) { discovered = locs; source = 'sitemap'; }
    }
  } catch { /* ignore */ }

  // 2) Fallback: homepage links
  if (discovered.length === 0) {
    try {
      const r2 = await fetchText(`${absolute}/`);
      if (r2.status === 401 || r2.status === 403 || looksLikeVercelProtection(r2.text)) {
        if (bypassCookie) {
          const r2b = await fetchText(`${absolute}/`, { cookie: bypassCookie });
          if (r2b.status < 400) {
            const links = extractLinksFromHtml(r2b.text, absolute);
            if (links.length) { discovered = links; source = 'homepage'; }
          } else {
            blocked = true;
            blocked_reason = blocked_reason || `home_${r2b.status}`;
          }
        } else {
          blocked = true;
          blocked_reason = blocked_reason || `home_${r2.status}`;
        }
      } else if (r2.status < 400) {
        const links = extractLinksFromHtml(r2.text, absolute);
        if (links.length) { discovered = links; source = 'homepage'; }
      }
    } catch { /* ignore */ }
  }

  // Rank or synthesize plan
  const crawl_plan = rankTopK(discovered.length ? discovered : [
    `${absolute}/`,
    `${absolute}/about`,
    `${absolute}/products`,
    `${absolute}/solutions`,
    `${absolute}/pricing`,
    `${absolute}/blog`,
    `${absolute}/docs`,
    `${absolute}/contact`,
    `${absolute}/careers`,
  ], 20).map(u => {
    const reason = /about/.test(u) ? 'about'
      : /pricing/.test(u) ? 'pricing'
      : /product|solutions/.test(u) ? 'products/solutions'
      : /blog|news|stories/.test(u) ? 'blog/news'
      : /docs|help|support/.test(u) ? 'docs/help'
      : /careers|jobs/.test(u) ? 'careers'
      : /contact/.test(u) ? 'contact'
      : /\/$/.test(u) ? 'homepage'
      : 'page';
    return { url: u, reason };
  });

  // Simple profile scaffold (agent-friendly)
  const profile = {
    company: { name: company_name, website: absolute, domain: host },
    offerings: { products: [], services: [], integrations: [], differentiators: [] },
    go_to_market: { ideal_customer_profile: {}, value_props: [], common_use_cases: [], sales_motions: [] },
    public_pricing: [],
    voice_and_tone: { brand_keywords: [], sample_headlines: [], messaging_do: [], messaging_dont: [] },
    proof_points: { customers: [], case_studies: [], metrics: [] },
    industry_context: { competitors: [], category_terms: [], best_practices: [], risks: [], opportunities: [] },
    crawl_plan
  };

  if (blocked) {
    diagnostics.protection = {
      blocked,
      blocked_reason,
      used_bypass_cookie: Boolean(bypassCookie),
    };
  }

  return json(res, 200, {
    ok: true,
    tenant_id,
    company_url: absolute,
    domain: host,
    kb_records_count: 0,
    profile,
    flags: { demo: true, source, blocked },
    diagnostics
  });
}
