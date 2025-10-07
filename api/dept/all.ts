import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Single entrypoint for *all* department tickets.
 * Route:  POST /api/dept/all
 *
 * Input (DepartmentTicket):
 * {
 *   "id": "sess_<ts>:SALES:create_or_update_lead:0",
 *   "dept": "SALES" | "MARKETING" | "ANALYTICS" | "EXEC" | "PRODUCT" | "SECURITY" |
 *           "FACILITIES" | "PROCUREMENT" | "LEGAL" | "IT" | "HR" | "FIN" | "OPS" | "CS" | "RESEARCH",
 *   "action": "string",           // see ACTION_CATALOG for suggestions
 *   "inputs": { ... },            // freeform; validated per dept/action later
 *   "context": {
 *      "tenant_id": "tenant_...",
 *      "capabilities": { ... }    // provider registry (crm, calendar, payments, etc.)
 *   },
 *   "idempotency_key": "sess:dept:action:0",
 *   "sla_sec": 120,
 *   "retries": 2
 * }
 */

type Dept =
  | 'SALES' | 'MARKETING' | 'ANALYTICS' | 'EXEC' | 'PRODUCT' | 'SECURITY'
  | 'FACILITIES' | 'PROCUREMENT' | 'LEGAL' | 'IT' | 'HR' | 'FIN' | 'OPS' | 'CS' | 'RESEARCH';

type DeptTicket = {
  id: string;
  dept: Dept;
  action: string;
  inputs: Record<string, unknown>;
  context: {
    tenant_id: string;
    capabilities: Record<string, unknown>;
  };
  idempotency_key: string;
  sla_sec: number;
  retries: number;
};

type DeptResult = {
  ok: boolean;
  dept: Dept;
  status: 'ok' | 'error';
  summary: string;
  ticket: DeptTicket;
  diagnostics: {
    adapter: 'mock' | string;
    provider?: string;
    notes?: string;
  };
};

function json(res: VercelResponse, code: number, payload: unknown) {
  res.status(code).setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(payload));
}

function bad(res: VercelResponse, msg: string, code = 400) {
  return json(res, code, { ok: false, error: msg });
}

// --- ACTION CATALOG -----------------------------------------------------------
// (Used for docs + sensible defaults. You can enforce/validate later per adapter.)
const ACTION_CATALOG: Record<Dept, string[]> = {
  SALES:       ['create_or_update_lead', 'qualify_lead', 'create_opportunity', 'update_pipeline_stage', 'log_activity'],
  MARKETING:   ['create_campaign', 'send_newsletter', 'segment_audience', 'sync_ad_platform', 'publish_post'],
  ANALYTICS:   ['track_event', 'run_report', 'build_dashboard', 'kpi_snapshot'],
  EXEC:        ['summarize_okrs', 'board_report', 'daily_digest'],
  PRODUCT:     ['collect_feedback', 'prioritize_backlog', 'create_spec', 'create_ticket'],
  SECURITY:    ['risk_assessment', 'access_review', 'incident_intake', 'generate_vulnerability_report'],
  FACILITIES:  ['create_work_order', 'schedule_maintenance', 'log_incident'],
  PROCUREMENT: ['create_po', 'vendor_intake', 'compare_quotes', 'renew_contract'],
  LEGAL:       ['generate_msa', 'nda_intake', 'review_contract', 'dpa_request'],
  IT:          ['provision_access', 'reset_password', 'asset_intake', 'create_ticket'],
  HR:          ['new_hire', 'offboarding', 'policy_answer', 'pto_request'],
  FIN:         ['draft_quote', 'invoice_issue', 'expense_approve', 'revenue_report'],
  OPS:         ['schedule_meeting', 'create_task', 'assign_dispatch', 'update_sop'],
  CS:          ['create_ticket', 'auto_reply', 'escalate_case', 'csat_request'],
  RESEARCH:    ['build_kb', 'company_profile', 'crawl_pages', 'faq_extract']
};

// --- PROVIDER REGISTRY (MOCK) ------------------------------------------------
// Later: switch to real providers using env vars (e.g., HUBSPOT, GOOGLE_CALENDAR).
function providerFor(dept: Dept) {
  switch (dept) {
    case 'SALES': return { adapter: 'mock', provider: 'crm:none' };
    case 'OPS': return { adapter: 'mock', provider: 'calendar:google_calendar' };
    case 'FIN': return { adapter: 'mock', provider: 'payments:stripe' };
    case 'CS': return { adapter: 'mock', provider: 'support:zendesk' };
    case 'MARKETING': return { adapter: 'mock', provider: 'email:sendgrid' };
    case 'RESEARCH': return { adapter: 'mock', provider: 'crawler:internal' };
    default: return { adapter: 'mock', provider: 'generic:none' };
  }
}

// --- COMMON HANDLER (MOCK) ---------------------------------------------------
function ok(ticket: DeptTicket, summary: string, notes?: string): DeptResult {
  return {
    ok: true,
    dept: ticket.dept,
    status: 'ok',
    summary,
    ticket,
    diagnostics: { ...providerFor(ticket.dept), notes }
  };
}

// Optional: minimal per-dept input shims
function normalizeInputs(ticket: DeptTicket) {
  const t = { ...ticket };
  t.inputs = t.inputs || {};

  // tiny defaults for common actions
  if (t.dept === 'SALES' && t.action === 'create_or_update_lead') {
    t.inputs = { lead_name: 'Unknown Lead', source: 'agent', ...t.inputs };
  }
  if (t.dept === 'OPS' && t.action === 'schedule_meeting') {
    t.inputs = { length_min: 30, calendar: 'owner', ...t.inputs };
  }
  if (t.dept === 'FIN' && t.action === 'draft_quote') {
    t.inputs = { currency: 'USD', terms: 'NET 30', ...t.inputs };
  }
  return t;
}

// --- DEPT IMPLEMENTATIONS (mock-now/real-later) ------------------------------
async function handleDept(ticket: DeptTicket): Promise<DeptResult> {
  const t = normalizeInputs(ticket);
  const a = t.action || 'default';

  switch (t.dept) {
    case 'SALES':
      return ok(t, `SALES processed: ${a} (lead=${(t.inputs as any).lead_name})`);

    case 'MARKETING':
      return ok(t, `MARKETING processed: ${a} (campaign=${(t.inputs as any).campaign || 'n/a'})`);

    case 'ANALYTICS':
      return ok(t, `ANALYTICS processed: ${a} (report=${(t.inputs as any).report || 'n/a'})`);

    case 'EXEC':
      return ok(t, `EXEC processed: ${a} (digest prepared)`);

    case 'PRODUCT':
      return ok(t, `PRODUCT processed: ${a} (ticket/spec created)`);

    case 'SECURITY':
      return ok(t, `SECURITY processed: ${a} (risk/incident logged)`);

    case 'FACILITIES':
      return ok(t, `FACILITIES processed: ${a} (work order queued)`);

    case 'PROCUREMENT':
      return ok(t, `PROCUREMENT processed: ${a} (vendor=${(t.inputs as any).vendor || 'n/a'})`);

    case 'LEGAL':
      return ok(t, `LEGAL processed: ${a} (doc=${(t.inputs as any).doc_type || 'n/a'})`);

    case 'IT':
      return ok(t, `IT processed: ${a} (request=${(t.inputs as any).request || 'n/a'})`);

    case 'HR':
      return ok(t, `HR processed: ${a} (employee=${(t.inputs as any).employee || 'n/a'})`);

    case 'FIN':
      return ok(t, `FIN processed: ${a} (terms=${(t.inputs as any).terms || 'NET 30'})`);

    case 'OPS':
      return ok(t, `OPS processed: ${a} (${(t.inputs as any).length_min || 30} minutes)`);

    case 'CS':
      return ok(t, `CS processed: ${a} (ticket created)`);

    case 'RESEARCH':
      return ok(t, `RESEARCH processed: ${a} (see /api/research/build-kb for heavy work)`, 'Use the dedicated KB endpoint for crawling.');

    default:
      return {
        ok: false,
        dept: t.dept,
        status: 'error',
        summary: `Unknown department: ${t.dept}`,
        ticket: t,
        diagnostics: { adapter: 'mock', notes: 'unsupported dept' }
      };
  }
}

// --- HTTP HANDLER ------------------------------------------------------------
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return bad(res, 'Method Not Allowed', 405);
  }

  const body = req.body as any;
  const ticket: DeptTicket = body?.ticket ?? body;

  if (!ticket || !ticket.dept || !ticket.action || !ticket.context?.tenant_id) {
    return bad(res, 'BAD_REQUEST: ticket.dept, ticket.action, and context.tenant_id are required', 400);
  }

  try {
    const result = await handleDept(ticket);
    return json(res, 200, result);
  } catch (e: any) {
    return json(res, 500, {
      ok: false,
      dept: ticket.dept,
      status: 'error',
      summary: 'Unhandled exception in department handler',
      ticket,
      diagnostics: { adapter: 'mock', notes: e?.message || String(e) }
    });
  }
}
