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

// --- tiny helpers (no deps) ---
async function fetchTextWithLimit(url: string, ms = 4000, maxBytes = 250_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: ctrl.signal });
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
    const reader = res.body?.getReader?.();
    if (!reader) return await res.text(); // environments without streams
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
    return txt;
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

  // --- SAFE FETCH PLAN (one remote read)
  let discovered: string[] = [];
  let source: 'sitemap' | 'homepage' | 'none' = 'none';

  // 1) Try sitemap.xml (fast, small)
  try {
    const xml = await fetchTextWithLimit(`${absolute}/sitemap.xml`, 4000, 250_000);
    const locs = parseXmlLocs(xml).filter(u => u.startsWith(absolute));
    if (locs.length) { discovered = locs; source = 'sitemap'; }
  } catch { /* ignore */ }

  // 2) Fallback: fetch homepage and extract internal links
  if (discovered.length === 0) {
    try {
      const html = await fetchTextWithLimit(`${absolute}/`, 4000, 250_000);
      const links = extractLinksFromHtml(html, absolute);
      if (links.length) { discovered = links; source = 'homepage'; }
    } catch { /* ignore */ }
  }

  // Rank & keep top-K
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

  return json(res, 200, {
    ok: true,
    tenant_id,
    company_url: absolute,
    domain: host,
    kb_records_count: 0,
    profile,
    flags: { demo: true, source }
  });
}
