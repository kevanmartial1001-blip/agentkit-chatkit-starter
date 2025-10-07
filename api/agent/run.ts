// /api/agent/run.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

type AgentPayload = {
  message: string;
  user?: string;
  context?: {
    tenant_id?: string;
    capabilities?: Record<string, unknown>;
  };
};

// Small helpers
function ok(res: VercelResponse, payload: unknown, status = 200) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}
function fail(res: VercelResponse, msg: string, status = 400, extra: any = {}) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: false, error: msg, ...extra }));
}

const THIS_ORIGIN = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : ''; // optional; we’ll build absolute URLs from req.headers if needed

function absoluteApi(req: VercelRequest, path: string) {
  if (THIS_ORIGIN) return `${THIS_ORIGIN}${path}`;
  // Build from incoming request host if running locally or preview
  const proto = (req.headers['x-forwarded-proto'] as string) || 'https';
  const host = (req.headers['x-forwarded-host'] as string) || req.headers.host;
  return `${proto}://${host}${path}`;
}

function extractFirstUrl(text: string): string | null {
  const m = text.match(/\bhttps?:\/\/[^\s)]+/i);
  return m ? m[0] : null;
}

function wantsResearch(text: string) {
  const s = text.toLowerCase();
  return s.includes('research') || /\bhttps?:\/\//i.test(s);
}

function wantsLead(text: string) {
  return /create (a )?new lead|create lead|add lead/i.test(text);
}
function wantsMeeting(text: string) {
  return /schedule .*meeting|book .*meeting|30 minute meeting|30-minute meeting/i.test(text);
}
function wantsQuote(text: string) {
  return /draft (a )?quote|create quote|make a quote/i.test(text);
}

async function postJson(url: string, body: any, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const txt = await res.text();
    let json: any = null;
    try { json = txt ? JSON.parse(txt) : null; } catch { /* ignore */ }
    return { status: res.status, ok: res.ok, json, text: txt };
  } finally {
    clearTimeout(t);
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return fail(res, 'Method not allowed', 405);
  }

  try {
    const body = (req.body || {}) as AgentPayload;
    const message = (body.message || '').trim();
    if (!message) return fail(res, "Missing 'message' in body.", 400);

    const tenant_id =
      body.context?.tenant_id ||
      'tenant_manual_test'; // sensible default so you don’t have to type it every time

    const capabilities = body.context?.capabilities || {};

    const plan: Array<{ step: string; endpoint: string; request: any; response?: any }> = [];
    const results: any = { research: null, sales: null, ops: null, fin: null };

    // 1) Research branch (KB)
    if (wantsResearch(message)) {
      const website = extractFirstUrl(message) || 'https://example.com';
      const kbReq = {
        website,
        tenant_id,
        company_name: new URL(website).hostname.replace(/^www\./i, ''),
      };
      const kbUrl = absoluteApi(req, '/api/research/build-kb');
      const kbResp = await postJson(kbUrl, kbReq);

      plan.push({ step: 'research_build_kb', endpoint: kbUrl, request: kbReq, response: kbResp });

      if (!kbResp.ok) {
        // Continue but record the failure
        results.research = { ok: false, status: kbResp.status, body: kbResp.json || kbResp.text };
      } else {
        results.research = kbResp.json;
      }
    }

    // 2) Execution branch (tickets)
    const needsLead = wantsLead(message);
    const needsMeeting = wantsMeeting(message);
    const needsQuote = wantsQuote(message);

    const deptUrl = absoluteApi(req, '/api/dept/all');

    // SALES: create_or_update_lead
    if (needsLead) {
      const ticket = {
        id: 'sess_test:SALES:create_or_update_lead:0',
        dept: 'SALES',
        action: 'create_or_update_lead',
        inputs: { lead_name: 'Unknown Lead', source: 'agent' },
        context: { tenant_id, capabilities },
        idempotency_key: 'sess_test:SALES:create_or_update_lead:0',
        sla_sec: 120,
        retries: 2,
      };
      const resp = await postJson(deptUrl, { ticket });
      plan.push({ step: 'execute_department:SALES', endpoint: deptUrl, request: { ticket }, response: resp });
      results.sales = resp.json || resp.text;
    }

    // OPS: schedule_meeting (default 30 min)
    if (needsMeeting) {
      const ticket = {
        id: 'sess_test:OPS:schedule_meeting:0',
        dept: 'OPS',
        action: 'schedule_meeting',
        inputs: { length_min: 30, calendar: 'owner' },
        context: { tenant_id, capabilities },
        idempotency_key: 'sess_test:OPS:schedule_meeting:0',
        sla_sec: 120,
        retries: 2,
      };
      const resp = await postJson(deptUrl, { ticket });
      plan.push({ step: 'execute_department:OPS', endpoint: deptUrl, request: { ticket }, response: resp });
      results.ops = resp.json || resp.text;
    }

    // FIN: draft_quote
    if (needsQuote) {
      const ticket = {
        id: 'sess_test:FIN:draft_quote:0',
        dept: 'FIN',
        action: 'draft_quote',
        inputs: { currency: 'USD', terms: 'NET 30' },
        context: { tenant_id, capabilities },
        idempotency_key: 'sess_test:FIN:draft_quote:0',
        sla_sec: 120,
        retries: 2,
      };
      const resp = await postJson(deptUrl, { ticket });
      plan.push({ step: 'execute_department:FIN', endpoint: deptUrl, request: { ticket }, response: resp });
      results.fin = resp.json || resp.text;
    }

    // Final reply
    return ok(res, {
      ok: true,
      user: body.user || 'anonymous',
      context: { tenant_id },
      summary: {
        did_research: Boolean(results.research),
        did_sales: Boolean(results.sales),
        did_ops: Boolean(results.ops),
        did_fin: Boolean(results.fin),
      },
      results,
      debug_plan: plan, // helpful to view in Vercel logs or browser
    });
  } catch (err: any) {
    console.error('agent/run error:', err?.stack || err);
    return fail(res, 'Unhandled error in /api/agent/run', 500, { details: String(err?.message || err) });
  }
}
