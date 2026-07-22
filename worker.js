function corsHeaders(extra) {
  return Object.assign({
    'Access-Control-Allow-Origin': 'https://limenbridge.cc',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  }, extra || {});
}
function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: corsHeaders({ 'Content-Type': 'application/json' })
  });
}
function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// ── /register ──
async function handleRegister(body, env) {
  const email = normalizeEmail(body.email);
  if (!email) return jsonResponse({ error: 'email required' }, 400);
  const key = 'user:' + email;
  const existingRaw = await env.LIMENBRIDGE_KV.get(key);
  if (existingRaw) {
    return jsonResponse({ status: 'existing', user: JSON.parse(existingRaw) });
  }
  try {
    await fetch('https://connect.mailerlite.com/api/subscribers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + env.MAILERLITE_API_KEY
      },
      body: JSON.stringify({
        email,
        fields: { name: body.name || '' },
        groups: body.groupId ? [body.groupId] : []
      })
    });
  } catch (e) {}
  const record = {
    email,
    name: body.name || '',
    registeredAt: new Date().toISOString(),
    onboardingComplete: false,
    plan: 'free',
    firstTrack: null,
    morningTime: null,
    eveningTime: null
  };
  await env.LIMENBRIDGE_KV.put(key, JSON.stringify(record));
  return jsonResponse({ status: 'new', user: record });
}

// ── /sync ──
async function handleSync(body, env) {
  const email = normalizeEmail(body.email);
  if (!email) return jsonResponse({ error: 'email required' }, 400);
  const key = 'user:' + email;
  const existingRaw = await env.LIMENBRIDGE_KV.get(key);
  const existing = existingRaw
    ? JSON.parse(existingRaw)
    : { email, registeredAt: new Date().toISOString(), onboardingComplete: false, plan: 'free' };
  const updated = Object.assign({}, existing, body.updates || {});
  await env.LIMENBRIDGE_KV.put(key, JSON.stringify(updated));
  return jsonResponse({ status: 'ok', user: updated });
}

// ── Stripe webhook signature verification ──
// Pure Web Crypto HMAC-SHA256, no npm dependency needed.
async function verifyStripeSignature(payload, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = Object.fromEntries(
    sigHeader.split(',').map(p => {
      const [k, v] = p.split('=');
      return [k, v];
    })
  );
  const timestamp = parts.t;
  const expectedSig = parts.v1;
  if (!timestamp || !expectedSig) return false;

  const signedPayload = timestamp + '.' + payload;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
  const computedSig = Array.from(new Uint8Array(sigBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  if (computedSig.length !== expectedSig.length) return false;
  let diff = 0;
  for (let i = 0; i < computedSig.length; i++) {
    diff |= computedSig.charCodeAt(i) ^ expectedSig.charCodeAt(i);
  }
  return diff === 0;
}

// Determine plan from the amount actually charged (in cents).
// Covers weekly ($6), monthly ($19), annual ($163 — no longer sold on the
// landing, but the in-app upsell to existing monthly subscribers still uses it).
function planFromAmount(amountCents) {
  if (amountCents >= 16000) return 'annual';
  if (amountCents >= 1900) return 'monthly';
  if (amountCents >= 600) return 'weekly';
  return 'unknown';
}

async function upsertMailerLite(email, plan, accountStatus, env, groupId) {
  try {
    await fetch('https://connect.mailerlite.com/api/subscribers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + env.MAILERLITE_API_KEY
      },
      body: JSON.stringify({
        email,
        fields: { plan, account_status: accountStatus },
        groups: groupId ? [groupId] : []
      })
    });
  } catch (e) {}
}

// ── /stripe-webhook ──
// checkout.session.completed: a payment succeeded. Determine the plan by
// amount, write user:<email> to KV, remember stripe_customer:<id> → email
// for the next event, and upsert MailerLite.
//
// customer.subscription.deleted: fires when a subscription ends — including
// the automatic cancellation from "Limit the number of payments: 1" on the
// weekly/monthly links. We tell apart "ended naturally after the paid
// period" from "cancelled early" by comparing when it ended against when
// the current billing period was scheduled to end (see below) — only
// genuine early cancellations count as a dissatisfaction signal.
async function handleStripeWebhook(request, env) {
  const payload = await request.text();
  const sig = request.headers.get('Stripe-Signature');
  const valid = await verifyStripeSignature(payload, sig, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return new Response('Invalid signature', { status: 400 });

  let event;
  try {
    event = JSON.parse(payload);
  } catch (e) {
    return new Response('Invalid JSON', { status: 400 });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = normalizeEmail(session.customer_details?.email || session.customer_email);
    const amountCents = session.amount_total || 0;
    const customerId = session.customer;
    const plan = planFromAmount(amountCents);

    if (email) {
      const key = 'user:' + email;
      const existingRaw = await env.LIMENBRIDGE_KV.get(key);
      const existing = existingRaw
        ? JSON.parse(existingRaw)
        : { email, registeredAt: new Date().toISOString(), onboardingComplete: false };
      const updated = Object.assign({}, existing, {
        plan,
        planStartedAt: new Date().toISOString(),
        accountStatus: 'active'
      });
      await env.LIMENBRIDGE_KV.put(key, JSON.stringify(updated));

      if (customerId) {
        await env.LIMENBRIDGE_KV.put('stripe_customer:' + customerId, email);
      }
      await upsertMailerLite(email, plan, 'active', env, env.MAILERLITE_GROUP_ID);
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    const customerId = subscription.customer;
    if (customerId) {
      const email = await env.LIMENBRIDGE_KV.get('stripe_customer:' + customerId);
      if (email) {
        const key = 'user:' + email;
        const existingRaw = await env.LIMENBRIDGE_KV.get(key);
        const existing = existingRaw ? JSON.parse(existingRaw) : null;

        // canceled_at/ended_at is when it actually ended. current_period_end
        // is when the paid-for period was scheduled to end. If those line up
        // (within a day, for processing delays), it's a normal finish —
        // not an early cancellation.
        const canceledAt = subscription.canceled_at || subscription.ended_at;
        const periodEnd = subscription.items?.data?.[0]?.current_period_end
          || subscription.current_period_end;
        const ONE_DAY = 24 * 60 * 60; // Stripe timestamps are in seconds
        const endedNaturally = canceledAt && periodEnd
          ? Math.abs(canceledAt - periodEnd) <= ONE_DAY
          : false;
        const accountStatus = endedNaturally ? 'completed' : 'cancelled';

        if (existing) {
          const updated = Object.assign({}, existing, { accountStatus });
          await env.LIMENBRIDGE_KV.put(key, JSON.stringify(updated));
        }

        const plan = existing ? existing.plan : 'unknown';
        // Only genuine early cancellations go into the reactivation-email
        // group. Natural completions just get their MailerLite fields updated.
        const groupId = endedNaturally ? null : env.MAILERLITE_CANCELLED_GROUP_ID;
        await upsertMailerLite(email, plan, accountStatus, env, groupId);
      }
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders() });
    }

    const url = new URL(request.url);

    // Stripe webhook needs the raw body for signature verification —
    // must be handled before the generic JSON parse below.
    if (url.pathname === '/stripe-webhook') {
      return handleStripeWebhook(request, env);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ error: 'invalid JSON' }, 400);
    }
    if (url.pathname === '/register') return handleRegister(body, env);
    if (url.pathname === '/sync') return handleSync(body, env);
    return jsonResponse({ error: 'not found' }, 404);
  }
};
