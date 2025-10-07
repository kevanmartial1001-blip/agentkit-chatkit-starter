import type { VercelRequest, VercelResponse } from '@vercel/node';

function json(res: VercelResponse, code: number, payload: unknown) {
  res.status(code).setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(payload));
}

function bad(res: VercelResponse, msg: string, code = 400) {
  return json(res, code, { ok: false, error: msg });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const path = (req.query.path || []) as string[];
  const method = req.method || 'GET';

  // --- GET /api/health
  if (method === 'GET' && path.length === 1 && path[0] === 'health') {
    return json(res, 200, { ok: true, service: 'agentkit-chatkit-starter' });
  }

  // --- POST /api/corp/ingest
  if (method === 'POST' && path.length === 2 && path[0] === 'corp' && path[1] === 'ingest') {
    const body = (req.body ?? {}) as any;
    const { user_id, session_id, utterance } = body;

    if (!user_id || !session_id || !utterance) {
      return bad(res, 'BAD_REQUEST: Missing user_id | session_id | utterance');
    }

    // derive a tenant id (demo mode)
    const domain =
      body?.context?.company?.domain ||
      (body?.context?.company?.name ? String(body.context.company.name).toLowerCase().replace(/\s+/g, '') + '.local' : '') ||
      'local.dev';

    const tenant_id = `tenant_${domain.replace(/\./g, '_')}_${Date.now().toString(36)}`;

    // minimal plan + mock department results (keeps us within 1 function on Vercel)
    const plan = ['SALES', 'OPS', 'FIN'];
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

    const results = tickets.map(t => ({
      dept: t.dept,
      status: 'ok',
      summary: `${t.dept} processed: ${t.action}`,
      ticket: t,
      diagnostics: { adapter: 'mock' }
    }));

    const summary = results.map(r => `${r.dept}:${r.status}`).join(', ');
    return json(res, 200, { ok: true, stage: 'FINAL', summary, results });
  }

  // --- Fallback
  return json(res, 404, { ok: false, error: 'Not Found', route: `/api/${path.join('/')}` });
}
