import type { VercelRequest, VercelResponse } from '@vercel/node';

function bad(res: VercelResponse, msg: string, code = 400) {
  res.status(code).json({ ok: false, error: msg });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return bad(res, 'Method Not Allowed', 405);
  }

  const trace: Array<{ at: string; msg: string }> = [];
  const step = (msg: string) => trace.push({ at: new Date().toISOString(), msg });

  step('received_request');

  const body = (req.body ?? {}) as any;
  const { user_id, session_id, utterance } = body;

  if (!user_id || !session_id || !utterance) {
    step('schema_guard:bad_request');
    return res.status(400).json({ ok: false, error: 'BAD_REQUEST: Missing user_id | session_id | utterance', trace });
  }

  step('schema_guard:ok');

  // tenant
  const domain =
    body?.context?.company?.domain ||
    (body?.context?.company?.name ? String(body.context.company.name).toLowerCase().replace(/\s+/g, '') + '.local' : '') ||
    'local.dev';
  const tenant_id = `tenant_${domain.replace(/\./g, '_')}_${Date.now().toString(36)}`;
  step(`tenant_resolver:${tenant_id}`);

  // naive intent → dept plan
  step('intent_classifier:stub');
  const plan = ['SALES', 'OPS', 'FIN']; // you can customize later

  step('planner:build_tickets');
  const capabilities = {
    crm: { provider: 'none' },
    support_desk: { provider: 'none' },
    calendar: { provider: 'google_calendar' },
    payments: { provider: 'stripe' },
    messaging: { chat: 'slack', sms: 'twilio', email: 'sendgrid' },
    fallbacks: { generic_ticketing: 'google_sheets', manual_review_channel: 'slack:#ops-review' },
    policies: { after_hours_outreach: false, pii: 'mask', phi: 'drop' }
  };

  const tickets = plan.map((dept, i) => {
    const action = dept === 'SALES' ? 'create_or_update_lead' : dept === 'OPS' ? 'schedule_meeting' : 'draft_quote';
    return {
      id: `sess_${Date.now()}:${dept}:${action}:${i}`,
      dept,
      action,
      inputs: { notes: 'N/A' },
      context: { tenant_id, capabilities },
      idempotency_key: `${session_id}:${dept}:${action}:0`,
      sla_sec: 120,
      retries: 2
    };
  });

  step('policy_gates:ok');

  // mock department handlers
  step('departments:execute:start');
  const results = tickets.map(t => ({
    dept: t.dept,
    status: 'ok',
    summary: `${t.dept} processed: ${t.action}`,
    ticket: t,
    diagnostics: { adapter: 'mock' }
  }));
  step('departments:execute:done');

  step('merge:final');
  const summary = results.map(r => `${r.dept}:${r.status}`).join(', ');

  step('respond:200');
  return res.status(200).json({
    ok: true,
    stage: 'FINAL',
    tenant_id,
    summary,
    results,
    trace
  });
}
