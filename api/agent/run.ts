import type { VercelRequest, VercelResponse } from '@vercel/node';

function json(res: VercelResponse, code: number, payload: unknown) {
  res.status(code).setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(payload));
}
function bad(res: VercelResponse, msg: string, code = 400) {
  return json(res, code, { ok: false, error: msg });
}

// --- Utils ------------------------------------------------------------------

/**
 * Extract the first http(s) URL from a free-form sentence and clean it.
 * - removes trailing punctuation, quotes, closing parens/brackets
 * - returns undefined if none found
 */
function getFirstUrlFromText(s: string | undefined): string | undefined {
  if (!s) return undefined;

  // 1) find first http(s) URL-like token
  const m = s.match(/https?:\/\/[^\s<>")'}\]]+/i);
  if (!m) return undefined;

  let url = m[0];

  // 2) strip trailing punctuation/quotes that often ride along in prose
  url = url.replace(/[),.;:'"’”]+$/g, '');

  // 3) normalize double leading slashes (rare)
  url = url.replace(/^\/\//, 'https://');

  // 4) final sanity check
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}${u.pathname ? u.pathname : ''}`;
  } catch {
    return undefined;
  }
}

async function postJson<T>(url: string, body: any): Promise<T> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  try {
    return JSON.parse(txt) as T;
  } catch {
    // keep raw body so caller sees HTML (e.g., Vercel protection page)
    return { ok: false, status: r.status, body: txt } as unknown as T;
  }
}

// --- Types (minimal) --------------------------------------------------------

type DeptTicket = {
  id: string;
  dept: 'SALES' | 'OPS' | 'FIN';
  action: string;
  inputs: Record<string, unknown>;
  context: { tenant_id: string; capabilities?: Record<string, unknown> };
  idempotency_key: string;
  sla_sec: number;
  retries: number;
};

type DeptReply = {
  ok: boolean;
  dept: string;
  status: 'ok' | 'error';
  summary: string;
  ticket: DeptTicket;
  diagnostics?: unknown;
};

type ResearchReply = {
  ok: boolean;
  tenant_id?: string;
  company_url?: string;
  domain?: string;
  kb_records_count?: number;
  profile?: unknown;
  status?: number;
  body?: string; // when not-JSON (e.g., Vercel protection HTML)
};

// --- Handler ----------------------------------------------------------------

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return bad(res, 'Method Not Allowed', 405);
  }

  const { message = '', user = 'ps_test_user', context = {} } = (req.body ?? {}) as {
    message?: string;
    user?: string;
    context?: { tenant_id?: string; capabilities?: Record<string, unknown> };
  };

  const tenant_id = context?.tenant_id || 'tenant_manual_test';
  const capabilities = context?.capabilities || {};

  // 1) Research (optional if URL present)
  const website = getFirstUrlFromText(String(message));
  let research: ResearchReply | null = null;
  let did_research = false;

  if (website) {
    did_research = true;
    research = await postJson<ResearchReply>(
      `${req.headers['x-forwarded-proto'] ?? 'https'}://${req.headers.host}/api/research/build-kb`,
      {
        website,
        tenant_id,
        company_name: undefined, // optional—tool will infer from domain
      }
    );
  }

  // 2) Build and execute the default SALES → OPS → FIN plan
  const plan: DeptTicket[] = [
    {
      id: `sess:${tenant_id}:SALES:create_or_update_lead:0`,
      dept: 'SALES',
      action: 'create_or_update_lead',
      inputs: { lead_name: 'Unknown Lead', source: 'agent' },
      context: { tenant_id, capabilities },
      idempotency_key: `sess:${tenant_id}:SALES:create_or_update_lead:0`,
      sla_sec: 120,
      retries: 2,
    },
    {
      id: `sess:${tenant_id}:OPS:schedule_meeting:0`,
      dept: 'OPS',
      action: 'schedule_meeting',
      inputs: { length_min: 30, calendar: 'owner' },
      context: { tenant_id, capabilities },
      idempotency_key: `sess:${tenant_id}:OPS:schedule_meeting:0`,
      sla_sec: 120,
      retries: 2,
    },
    {
      id: `sess:${tenant_id}:FIN:draft_quote:0`,
      dept: 'FIN',
      action: 'draft_quote',
      inputs: { currency: 'USD', terms: 'NET 30' },
      context: { tenant_id, capabilities },
      idempotency_key: `sess:${tenant_id}:FIN:draft_quote:0`,
      sla_sec: 120,
      retries: 2,
    },
  ];

  const base = `${req.headers['x-forwarded-proto'] ?? 'https'}://${req.headers.host}`;
  const results: Record<string, any> = {};

  async function exec(ticket: DeptTicket) {
    const out = await postJson<DeptReply>(`${base}/api/dept/all`, { ticket });
    results[ticket.dept.toLowerCase()] = out;
    return out;
  }

  const sales = await exec(plan[0]);
  const ops = await exec(plan[1]);
  const fin = await exec(plan[2]);

  return json(res, 200, {
    ok: true,
    user,
    context: { tenant_id, capabilities },
    summary: {
      did_research,
      did_sales: sales?.ok === true,
      did_ops: ops?.ok === true,
      did_fin: fin?.ok === true,
    },
    results: {
      research: research ?? null,
      sales,
      ops,
      fin,
    },
  });
}
