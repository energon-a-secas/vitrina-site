// Plain node, no install. Run with: make validate
//
// The Clerk users webhook: convex/lib/webhookVerify.ts against Svix's own
// published test vector, then convex/lib/clerkWebhookCore.ts over every way a
// delivery can be wrong. A verified user.deleted erases a person's data, so the
// cases that must erase nothing matter as much as the one that must.

import { verifySvixSignature } from '../convex/lib/webhookVerify.ts';
import { clerkWebhookCore, TOLERANCE_SECONDS } from '../convex/lib/clerkWebhookCore.ts';

let failed = 0;
function eq(actual, expected, what) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failed += 1; console.error(`FAIL ${what}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`); }
  else console.log(`ok   ${what}`);
}

// Svix's documented example (docs.svix.com, "Verifying webhooks manually").
const VECTOR = {
  secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
  id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
  timestamp: '1614265330',
  body: '{"test": 2432232314}',
  signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
};
const NOW = Number(VECTOR.timestamp);
const verify = (over = {}) => {
  const v = { ...VECTOR, ...over };
  return verifySvixSignature(v.secret, v.id, v.timestamp, v.body, v.signature);
};

// ── The verifier ────────────────────────────────────────────────────────────
eq(await verify(), true, "Svix's own vector verifies");
eq(await verify({ body: VECTOR.body.replace('2432232314', '2432232315') }), false, 'a tampered body does not');
eq(await verify({ id: 'msg_other' }), false, 'nor a different message id');
eq(await verify({ timestamp: '1614265331' }), false, 'nor a different timestamp');
eq(await verify({ secret: VECTOR.secret.slice('whsec_'.length) }), true, 'the secret without its whsec_ prefix still verifies');
eq(await verify({ secret: 'whsec_' + Buffer.from('another key entirely').toString('base64') }), false, 'another secret does not');
eq(await verify({ secret: 'whsec_!!!not base64!!!' }), false, 'a secret that is not base64 verifies nothing, without throwing');
eq(await verify({ signature: 'v1,AAAA' }), false, 'a wrong signature does not');
eq(await verify({ signature: VECTOR.signature.replace('v1,', 'v2,') }), false, 'only v1 signatures count');
eq(await verify({ signature: 'v1,bogus ' + VECTOR.signature }), true, 'one valid v1 among several is enough');
eq(await verify({ signature: VECTOR.signature + ' v1,bogus' }), true, 'wherever it sits in the list');
eq(await verify({ signature: 'v1,%%%% v1,bogus' }), false, 'a list of only bad signatures does not');

// ── The core ────────────────────────────────────────────────────────────────
const REST = { status: 200, purgeSubject: null };
const REJECTED = { status: 400, purgeSubject: null };
let verifierCalls = 0;
const counted = (...args) => { verifierCalls += 1; return verifySvixSignature(...args); };
function headers(over = {}) {
  const all = { 'svix-id': VECTOR.id, 'svix-timestamp': VECTOR.timestamp, 'svix-signature': VECTOR.signature, ...over };
  return new Headers(Object.entries(all).filter(([, value]) => value !== undefined));
}
const run = (body, h, secret = VECTOR.secret, now = NOW) => clerkWebhookCore(body, h, secret, now, counted);

eq(await run(VECTOR.body, headers()), REST, "the vector's event is verified, is not user.deleted, and erases nothing");
eq(await run(VECTOR.body + ' ', headers()), REJECTED, 'a tampered body is 400');
eq(await run(VECTOR.body, headers(), VECTOR.secret, NOW + TOLERANCE_SECONDS), REST, 'a delivery exactly 300 s old is accepted');
eq(await run(VECTOR.body, headers(), VECTOR.secret, NOW + TOLERANCE_SECONDS + 1), REJECTED, 'a stale timestamp is 400');
eq(await run(VECTOR.body, headers(), VECTOR.secret, NOW - TOLERANCE_SECONDS - 1), REJECTED, 'so is one from the future');
eq(await run(VECTOR.body, headers({ 'svix-timestamp': '1614265330.5' })), REJECTED, 'a timestamp that is not whole seconds is 400');

verifierCalls = 0;
for (const name of ['svix-id', 'svix-timestamp', 'svix-signature']) {
  eq(await run(VECTOR.body, headers({ [name]: undefined })), REJECTED, `a missing ${name} header is 400`);
  eq(await run(VECTOR.body, headers({ [name]: '' })), REJECTED, `an empty ${name} header is 400`);
}
eq(await run(VECTOR.body, headers(), undefined), { status: 503, purgeSubject: null }, 'an unset secret is 503, so Svix retries once it is set');
eq(await run(VECTOR.body, headers(), ''), { status: 503, purgeSubject: null }, 'an empty secret too');
eq(await run(VECTOR.body, headers(), VECTOR.secret, NOW + 10_000), REJECTED, 'a stale delivery again');
eq(verifierCalls, 0, 'no signature was computed for a missing header, a missing secret or a stale timestamp');
eq(await run(VECTOR.body, headers({ 'svix-signature': 'v1,bogus v1,AAAA ' + VECTOR.signature })), REST, 'a multi-signature header with one valid signature is accepted');

// Clerk events, signed here with a test key.
const SECRET = 'whsec_' + Buffer.from('vitrina clerk webhook test key').toString('base64');
async function signed(body, id = 'msg_2test', ts = NOW) {
  const key = await crypto.subtle.importKey('raw', Buffer.from(SECRET.slice(6), 'base64'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${ts}.${body}`));
  return headers({ 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': 'v1,' + Buffer.from(mac).toString('base64') });
}
const clerkEvent = (type, data) => JSON.stringify({ data, object: 'event', type });

const deleted = clerkEvent('user.deleted', { id: 'user_2abcDEF123xyz', deleted: true, object: 'user' });
eq(await run(deleted, await signed(deleted), SECRET), { status: 200, purgeSubject: 'user_2abcDEF123xyz' }, 'a verified user.deleted names one subject to erase');
eq(await run(deleted, await signed(deleted), VECTOR.secret), REJECTED, 'the same event under the wrong secret erases nothing');
const updated = clerkEvent('user.updated', { id: 'user_2abcDEF123xyz', object: 'user' });
eq(await run(updated, await signed(updated), SECRET), REST, 'a verified user.updated schedules nothing');
const created = clerkEvent('user.created', { id: 'user_2abcDEF123xyz', object: 'user' });
eq(await run(created, await signed(created), SECRET), REST, 'nor does user.created, which Svix sends whatever the subscription');

for (const [id, what] of [['user_abc-def', 'a hyphen'], ['user_', 'no id after the prefix'], ['org_2abc', 'another object type'],
  ['user_abc; drop', 'a space and punctuation'], [' user_abc', 'leading space'], ['user_abc\n', 'a trailing newline'], [42, 'a number'], [undefined, 'no id']]) {
  const body = clerkEvent('user.deleted', id === undefined ? { deleted: true } : { id, deleted: true });
  eq(await run(body, await signed(body), SECRET), REST, `a user.deleted with ${what} is acknowledged and erases nothing`);
}
const noData = JSON.stringify({ type: 'user.deleted', object: 'event' });
eq(await run(noData, await signed(noData), SECRET), REST, 'a user.deleted with no data erases nothing');
const notJson = 'user.deleted user_2abc';
eq(await run(notJson, await signed(notJson), SECRET), REST, 'a verified body that is not JSON is acknowledged and dropped');

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
