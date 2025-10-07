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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return bad(res, 'Method Not Allowed', 405);
  }

  const b: any = req.body || {};

  // Accept many input shapes
  const rawUrl =
    b.website ||
    b.company_url ||
    b?.company?.url ||
    b.url;

  let absolute: string;
  let host: string;
  try {
    ({ absolute, host } = ensureAbsoluteUrl(rawUrl));
  } catch (e: any) {
    return bad(res, e?.message || 'Invalid company URL', 400);
  }

  const tenant_id = b.tenant_id || `tenant_${host.replace(/\./g, '_')}_${Date.now().toString(36)}`;
  const company_name = b.company_name || b?.company?.name || host;

  // Light, zero-fetch crawl plan (we’ll wire real fetch later)
  const crawl_plan = [
    { url: `${absolute}/`, reason: 'homepage' },
    { url: `${absolute}/about`, reason: 'about' },
    { url: `${absolute}/products`, reason: 'products' },
    { url: `${absolute}/solutions`, reason: 'solutions' },
    { url: `${absolute}/pricing`, reason: 'pricing' },
    { url: `${absolute}/blog`, reason: 'blog/news' },
    { url: `${absolute}/docs`, reason: 'docs/help' },
    { url: `${absolute}/contact`, reason: 'contact' },
    { url: `${absolute}/careers`, reason: 'careers/jobs' }
  ];

  const profile = {
    company: {
      name: company_name,
      website: absolute,
      domain: host,
    },
    offerings: {
      products: [],
      services: [],
      integrations: [],
      differentiators: []
    },
    go_to_market: {
      ideal_customer_profile: {},
      value_props: [],
      common_use_cases: [],
      sales_motions: []
    },
    public_pricing: [],
    voice_and_tone: {
      brand_keywords: [],
      sample_headlines: [],
      messaging_do: [],
      messaging_dont: []
    },
    proof_points: { customers: [], case_studies: [], metrics: [] },
    industry_context: { competitors: [], category_terms: [], best_practices: [], risks: [], opportunities: [] },
    crawl_plan
  };

  return json(res, 200, {
    ok: true,
    tenant_id,
    company_url: absolute,
    domain: host,
    kb_records_count: 0,     // will increase once we actually fetch & chunk
    profile,
    flags: { demo: true }
  });
}
