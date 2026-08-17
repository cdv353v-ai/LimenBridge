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

// ── /demo-lead ──
// Sandbox "Stay in tune" card: captures an email for the free full morning
// track, kept entirely separate from /register (no plan, no onboarding state).
// Stored under its own KV prefix so Mark can see who/when without opening
// MailerLite — and added to a dedicated MailerLite group so an automation
// there can send the track + one follow-up email.
//
// Uses its own MailerLite call (not upsertMailerLite) so API errors are
// visible in the response instead of silently swallowed — useful while
// confirming the group ID / API key are correct.
async function handleDemoLead(body, env) {
  const email = normalizeEmail(body.email);
  if (!email) return jsonResponse({ error: 'email required' }, 400);
  try {
    const key = 'demo_lead:' + email;
    const existingRaw = await env.LIMENBRIDGE_KV.get(key);
    const capturedAt = existingRaw ? JSON.parse(existingRaw).capturedAt : new Date().toISOString();
    const record = { email, capturedAt };
    await env.LIMENBRIDGE_KV.put(key, JSON.stringify(record));

    let mailerliteStatus = null;
    let mailerliteBody = null;
    try {
      const mlResp = await fetch('https://connect.mailerlite.com/api/subscribers', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + env.MAILERLITE_API_KEY
        },
        body: JSON.stringify({
          email,
          fields: { source: 'demo_lead' },
          groups: env.MAILERLITE_DEMO_LEAD_GROUP_ID ? [env.MAILERLITE_DEMO_LEAD_GROUP_ID] : []
        })
      });
      mailerliteStatus = mlResp.status;
      mailerliteBody = await mlResp.text();
    } catch (mlErr) {
      mailerliteBody = 'fetch failed: ' + String(mlErr && mlErr.message || mlErr);
    }

    return jsonResponse({
      status: 'ok',
      mailerlite_status: mailerliteStatus,
      mailerlite_body: mailerliteBody,
      group_id_used: env.MAILERLITE_DEMO_LEAD_GROUP_ID || null
    });
  } catch (e) {
    return jsonResponse({ error: 'server error', detail: String(e && e.message || e) }, 500);
  }
}

// ── /restore ──
// Manual fallback for a lost/wiped/stolen device: localStorage is the entire
// user identity, so if it's gone, the site can't recognize a returning
// paying user on its own. This endpoint looks the person up by the email
// used at Stripe checkout and returns enough to rebuild local state —
// registeredAt (so day-of-cycle math stays correct), plan, and onboarding
// answers if they were ever synced.
//
// Known limitation, by design: mood diary entries (moodLog) are never sent
// to KV — they only ever live in localStorage — so they cannot be restored
// this way. Only access/day-count is recoverable, not diary content.
async function handleRestore(body, env) {
  const email = normalizeEmail(body.email);
  if (!email) return jsonResponse({ error: 'email required' }, 400);
  const key = 'user:' + email;
  const existingRaw = await env.LIMENBRIDGE_KV.get(key);
  if (!existingRaw) return jsonResponse({ status: 'not_found' });
  const u = JSON.parse(existingRaw);
  return jsonResponse({
    status: 'ok',
    user: {
      registeredAt: u.registeredAt,
      plan: u.plan || 'free',
      accountStatus: u.accountStatus || null,
      onboardingComplete: !!u.onboardingComplete,
      firstTrack: u.firstTrack || null,
      morningTime: u.morningTime || null,
      eveningTime: u.eveningTime || null
    }
  });
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

// Schedules a subscription to stop after the current paid period instead of
// auto-renewing. Called right after checkout.session.completed for weekly
// and monthly plans — the customer pays once, keeps access for the full
// period they paid for, and the subscription simply doesn't charge again.
// Runs after the customer has already been redirected, so it never affects
// checkout completion or the success-page redirect.
async function cancelSubscriptionAtPeriodEnd(subscriptionId, env) {
  if (!subscriptionId) return;
  try {
    await fetch('https://api.stripe.com/v1/subscriptions/' + subscriptionId, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + env.STRIPE_SECRET_KEY,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'cancel_at_period_end=true'
    });
  } catch (e) {}
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
// for the next event, and upsert MailerLite. For weekly and monthly plans,
// also schedule the subscription to stop after this paid period — the
// customer decides on the site whether to buy again, nothing is auto-charged.
//
// customer.subscription.deleted: fires when a subscription ends — including
// the scheduled stop above. We tell apart "ended naturally after the paid
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
    const subscriptionId = session.subscription;
    const plan = planFromAmount(amountCents);

    if (email) {
      const key = 'user:' + email;
      const existingRaw = await env.LIMENBRIDGE_KV.get(key);
      const existing = existingRaw
        ? JSON.parse(existingRaw)
        : { email, onboardingComplete: false };
      const updated = Object.assign({}, existing, {
        plan,
        registeredAt: new Date().toISOString(),
        onboardingComplete: false,
        planStartedAt: new Date().toISOString(),
        accountStatus: 'active'
      });
      await env.LIMENBRIDGE_KV.put(key, JSON.stringify(updated));

      if (customerId) {
        await env.LIMENBRIDGE_KV.put('stripe_customer:' + customerId, email);
      }
      await upsertMailerLite(email, plan, 'active', env, env.MAILERLITE_GROUP_ID);
    }

    // One payment, then the customer decides — no auto-renewal for either
    // paid tier. Annual is excluded: it's only sold as an in-app upsell to
    // existing subscribers and follows its own cycle logic (day 29–30).
    if (plan === 'weekly' || plan === 'monthly') {
      await cancelSubscriptionAtPeriodEnd(subscriptionId, env);
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

// ── Tribute Shop API ──
// Same pattern as Stripe: create the order server-side (so the API key never
// reaches the browser), redirect the customer to the returned paymentUrl,
// and confirm via webhook. Prices are fixed RUB amounts chosen by Mark —
// Tribute does not do live currency conversion, so these numbers don't move
// on their own if USD pricing changes; update TRIBUTE_PRICING by hand.
const TRIBUTE_API_BASE = 'https://tribute.tg/api/v1';
const TRIBUTE_PRICING = {
  weekly: { amount: 69000, title: 'LimenBridge — недельный доступ', description: 'Доступ к ежедневным трекам на 7 дней' },
  monthly: { amount: 195000, title: 'LimenBridge — месячный доступ', description: 'Доступ к ежедневным трекам на 28 дней' }
};

// ── /tribute-create-order ──
// Email is required (unlike Stripe, where Stripe's own hosted checkout
// collects it) because we create the order ourselves before redirecting —
// Tribute's docs don't guarantee its payment page asks for email, and the
// webhook handler below needs one to know which KV user record to update.
async function handleTributeCreateOrder(body, env) {
  const plan = body.plan;
  const pricing = TRIBUTE_PRICING[plan];
  if (!pricing) return jsonResponse({ error: 'invalid plan' }, 400);
  const email = normalizeEmail(body.email);
  if (!email) return jsonResponse({ error: 'email required' }, 400);

  const origin = 'https://limenbridge.cc';
  const payload = {
    currency: 'rub',
    amount: pricing.amount,
    title: pricing.title,
    description: pricing.description,
    period: 'onetime',
    email,
    successUrl: origin + '/?payment=success&plan=' + plan + '&provider=tribute',
    failUrl: origin + '/'
  };

  // Logged without the key value itself — only whether it's present and how
  // long it is, so we can tell "env var truly empty" apart from "wrong value"
  // straight from the Cloudflare log, without ever printing the secret.
  console.log('tribute create-order: key present=' + !!env.TRIBUTE_API_KEY + ' length=' + (env.TRIBUTE_API_KEY ? env.TRIBUTE_API_KEY.length : 0) + ' plan=' + plan);

  let resp, data;
  try {
    resp = await fetch(TRIBUTE_API_BASE + '/shop/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Api-Key': env.TRIBUTE_API_KEY
      },
      body: JSON.stringify(payload)
    });
    data = await resp.json();
  } catch (e) {
    console.error('tribute create-order: fetch threw', String(e && e.message || e));
    return jsonResponse({ error: 'tribute request failed', detail: String(e && e.message || e) }, 502);
  }
  if (!resp.ok || !data.paymentUrl) {
    console.error('tribute create-order: rejected, status=' + resp.status + ' body=' + JSON.stringify(data));
    return jsonResponse({ error: 'tribute order failed', detail: data }, 502);
  }
  return jsonResponse({ paymentUrl: data.paymentUrl, orderUuid: data.uuid });
}

// ── Tribute webhook signature verification ──
// Docs confirm HMAC-SHA256 of the raw body using the API key as the secret,
// delivered via the trbt-signature header, but don't state hex vs base64
// encoding — this checks both. Confirm against a real "Отправить тестовый
// запрос" once live and simplify to whichever one actually matches.
async function verifyTributeSignature(payload, sigHeader, secret) {
  if (!sigHeader) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const bytes = new Uint8Array(sigBuffer);
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  const b64 = btoa(String.fromCharCode.apply(null, bytes));
  return sigHeader === hex || sigHeader === b64;
}

function planFromTributeAmount(amountKopecks) {
  if (amountKopecks >= TRIBUTE_PRICING.monthly.amount) return 'monthly';
  if (amountKopecks >= TRIBUTE_PRICING.weekly.amount) return 'weekly';
  return 'unknown';
}

// ── /tribute-webhook ──
// Rather than branch on event.type (naming is inconsistent across Tribute's
// own docs), treat the webhook only as a "check this order" nudge: look the
// order up straight from Tribute via GET /shop/orders/{uuid} and act only if
// status is genuinely "paid". Slightly more defensive, and doubles as
// dedup/idempotency protection against webhook retries.
async function handleTributeWebhook(request, env) {
  const payload = await request.text();
  const sig = request.headers.get('trbt-signature');
  const valid = await verifyTributeSignature(payload, sig, env.TRIBUTE_API_KEY);
  if (!valid) return new Response('Invalid signature', { status: 400 });

  let event;
  try {
    event = JSON.parse(payload);
  } catch (e) {
    return new Response('Invalid JSON', { status: 400 });
  }

  const orderUuid = event.orderUuid || event.uuid
    || (event.data && (event.data.orderUuid || event.data.uuid))
    || (event.order && event.order.uuid)
    || (event.payload && event.payload.orderUuid);
  if (!orderUuid) {
    return new Response(JSON.stringify({ received: true, note: 'no orderUuid in payload' }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }

  let order;
  try {
    const orderResp = await fetch(TRIBUTE_API_BASE + '/shop/orders/' + orderUuid, {
      headers: { 'Api-Key': env.TRIBUTE_API_KEY }
    });
    order = await orderResp.json();
  } catch (e) {
    return new Response('order lookup failed', { status: 502 });
  }

  if (order && order.status === 'paid') {
    const email = normalizeEmail(order.email || '');
    const plan = planFromTributeAmount(order.amount || 0);
    if (email) {
      const key = 'user:' + email;
      const existingRaw = await env.LIMENBRIDGE_KV.get(key);
      const existing = existingRaw ? JSON.parse(existingRaw) : { email, onboardingComplete: false };
      const updated = Object.assign({}, existing, {
        plan,
        registeredAt: new Date().toISOString(),
        onboardingComplete: existing.onboardingComplete || false,
        planStartedAt: new Date().toISOString(),
        accountStatus: 'active'
      });
      await env.LIMENBRIDGE_KV.put(key, JSON.stringify(updated));
      await upsertMailerLite(email, plan, 'active', env, env.MAILERLITE_GROUP_ID);
    }
    // Marks this order processed — lets /tribute-webhook safely no-op on
    // Tribute's automatic retries instead of reprocessing every time.
    await env.LIMENBRIDGE_KV.put('tribute_order:' + orderUuid, JSON.stringify({
      email, plan, processedAt: new Date().toISOString()
    }));
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
    // Tribute webhook also needs the raw body for signature verification.
    if (url.pathname === '/tribute-webhook') {
      return handleTributeWebhook(request, env);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ error: 'invalid JSON' }, 400);
    }
    if (url.pathname === '/register') return handleRegister(body, env);
    if (url.pathname === '/sync') return handleSync(body, env);
    if (url.pathname === '/demo-lead') return handleDemoLead(body, env);
    if (url.pathname === '/restore') return handleRestore(body, env);
    if (url.pathname === '/tribute-create-order') return handleTributeCreateOrder(body, env);
    return jsonResponse({ error: 'not found' }, 404);
  }
};
