import { createHash } from 'node:crypto';

export const TTL = 900;
export const CLOCK_SKEW_MS = 60000;
export const TOKEN = /^[^\s\x00-\x1f\x7f]{1,8192}(?![\s\S])/;
export const ROOM = /^[A-Z0-9]{12}$(?![\s\S])/;
export const isId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => {
  if (!record(value)) return false;
  const actual = Object.keys(value).sort(), wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};
const word = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$(?![\s\S])/.test(value);
const line = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value.isWellFormed()
  && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) && value.trim() === value;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function iso(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$(?![\s\S])/.test(raw)) throw new Error('Expected a UTC timestamp.');
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== raw.slice(0, 19)) throw new Error('Invalid UTC timestamp.');
  return new Date(time).toISOString();
}



const safeId = value => word(value) && value.length <= 12 && !['constructor', 'prototype', '__proto__', 'unknown'].includes(value);
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export const POLICY = Object.freeze({ name: 'immutable-byte-cache-replay-v1',
  start: 'empty independent cache for each capacity; immutable objects and sizes',
  lru: 'a hit moves the resident to newest; a fitting miss evicts oldest last-access order until it fits',
  fifo: 'a hit leaves insertion order unchanged; a fitting miss evicts oldest insertion order until it fits',
  bypass: 'an object larger than capacity is a miss and bypass; it does not evict or alter residents',
  admission: 'every fitting miss admits the requested object as newest after necessary evictions',
  bytes: 'object payload bytes only; no metadata, allocator or transport overhead',
  selection: 'one owner-declared LRU or FIFO policy; Unknown withholds replay',
  excluded: 'TTL, mutation, prefetch, invalidation, concurrency, warm starts, live fetches and future performance guarantees' });
export const POLICY_HASH = hash(POLICY);
const promptFor = input => `${input.title}\n${input.context}\nWhich documented eviction rule should trace ${input.traceId} use?\nLRU evicts least recently accessed; FIFO evicts earliest admitted. Oversized objects bypass without evictions. Choose Unknown if unsupported. Object IDs, sizes and requests stay local.`;
export function validateInput(input) {
  if (!keys(input, ['traceId', 'title', 'context', 'objects', 'requests', 'capacities']) || !word(input.traceId)
    || !line(input.title, 40) || !line(input.context, 80) || !Array.isArray(input.objects) || input.objects.length < 1 || input.objects.length > 32
    || !Array.isArray(input.requests) || input.requests.length > 256 || !Array.isArray(input.capacities) || input.capacities.length < 1 || input.capacities.length > 8) throw new Error('Supply trace metadata, one to 32 objects, up to 256 requests and one to eight capacities.');
  const ids = new Set();
  const objects = Array.from(input.objects, object => {
    if (!keys(object, ['id', 'bytes']) || !safeId(object.id) || ids.has(object.id) || !Number.isSafeInteger(object.bytes) || object.bytes < 1 || object.bytes > 1000000) throw new Error('Objects need unique safe IDs and positive integer byte sizes up to 1000000.');
    ids.add(object.id); return { ...object };
  }).sort((a, b) => order(a.id, b.id));
  const requests = Array.from(input.requests, id => {
    if (!ids.has(id)) throw new Error('Every request must identify a declared immutable object.');
    return id;
  });
  const seen = new Set();
  const capacities = Array.from(input.capacities, capacity => {
    if (!Number.isSafeInteger(capacity) || capacity < 0 || capacity > 10000000 || Object.is(capacity, -0) || seen.has(capacity)) throw new Error('Capacities must be distinct nonnegative integer bytes up to 10000000, without negative zero.');
    seen.add(capacity); return capacity;
  }).sort((a, b) => a - b);
  const result = { traceId: input.traceId, title: input.title, context: input.context, objects, requests, capacities };
  if (promptFor(result).length > 500) throw new Error('Eviction-policy Question exceeds 500 UTF-16 units.');
  return result;
}
export function validateConfig(config) {
  if (!keys(config, ['participant']) || !keys(config.participant, ['id', 'label']) || !isId(config.participant.id) || !line(config.participant.label, 60)) throw new Error('Config requires an exact cache owner UUID and label.');
  return structuredClone(config);
}
export const itemsFor = input => { validateInput(input); return [{ id: 'policy' }]; };
export function requestFor(rawInput, config, itemId, attemptId) {
  const input = validateInput(rawInput); validateConfig(config);
  if (itemId !== 'policy' || !isId(attemptId)) throw new Error('Invalid eviction-policy selection or attempt.');
  const key = `eviction-${attemptId}`;
  return { prompt: promptFor(input), context: `To ${config.participant.id}`,
    options: [{ value: 'lru', label: 'LRU', style: 'default' }, { value: 'fifo', label: 'FIFO', style: 'default' }, { value: 'unknown', label: 'Unknown', style: 'default' }],
    responder_scope: 'direct', target_user_id: config.participant.id, ttl: TTL, correlation_id: key,
    data: { input_hash: hash(input), catalog_hash: hash(input.objects), policy_hash: POLICY_HASH, item_id: itemId, attempt_id: attemptId }, idempotencyKey: key };
}
export function previewInput(rawInput, config) {
  const input = validateInput(rawInput), request = requestFor(input, config, 'policy', '01990000-0000-7000-8000-000000000001');
  const { correlation_id, idempotencyKey, data, ...question } = request;
  return { source: input, sourceHash: hash(input), policy: POLICY, policyHash: POLICY_HASH, question,
    note: 'The attempt UUID, correlation ID and input/catalog/policy hashes are added when the session creates its Question.' };
}

/** Pure replay of a frozen trace; the CLI export additionally requires attributed owner evidence. */
export function replayCache(rawInput, policy) {
  const input = validateInput(rawInput);
  if (!['lru', 'fifo'].includes(policy)) throw new Error('Choose a known eviction policy before replay.');
  const sizes = new Map(input.objects.map(object => [object.id, object.bytes]));
  const runs = input.capacities.map(capacity => {
    const resident = [];
    let usedBytes = 0, hits = 0, misses = 0, bypasses = 0, admissions = 0, evictions = 0, hitBytes = 0, missBytes = 0;
    const steps = input.requests.map((objectId, index) => {
      const objectBytes = sizes.get(objectId), position = resident.indexOf(objectId), evicted = [];
      let outcome;
      if (position !== -1) {
        hits++; hitBytes += objectBytes; outcome = 'hit';
        if (policy === 'lru') { resident.splice(position, 1); resident.push(objectId); }
      } else {
        misses++; missBytes += objectBytes;
        if (objectBytes > capacity) { bypasses++; outcome = 'bypass'; }
        else {
          outcome = 'miss';
          while (usedBytes + objectBytes > capacity) {
            const removed = resident.shift();
            if (removed === undefined) throw new Error('Cache eviction invariant failed.');
            evicted.push(removed); usedBytes -= sizes.get(removed); evictions++;
          }
          resident.push(objectId); usedBytes += objectBytes; admissions++;
        }
      }
      if (new Set(resident).size !== resident.length || usedBytes !== resident.reduce((sum, id) => sum + sizes.get(id), 0) || usedBytes > capacity) throw new Error('Cache occupancy invariant failed.');
      return { index, objectId, objectBytes, outcome, evicted, residentOrder: [...resident], usedBytes };
    });
    return { capacity, steps, finalResidentOrder: [...resident], finalUsedBytes: usedBytes,
      summary: { requests: input.requests.length, hits, misses, bypasses, admissions, evictions, requestedBytes: hitBytes + missBytes, hitBytes, missBytes,
        hitRatio: input.requests.length === 0 ? null : hits / input.requests.length,
        exactHitRatio: input.requests.length === 0 ? null : { numerator: hits, denominator: input.requests.length } } };
  });
  return { policy, runs, sourceHash: hash(input), policyHash: POLICY_HASH, objectsFetched: false, cacheModified: false,
    note: 'Cold replay under the declared rule; capacities are separate simulations, not a monotonicity or future-performance guarantee.' };
}
export function cachePlan(rawInput, choice) {
  validateInput(rawInput);
  if (![null, 'unknown', 'lru', 'fifo'].includes(choice)) throw new Error('Supply LRU, FIFO, Unknown or a missing selection.');
  return { status: choice === null ? 'incomplete' : choice === 'unknown' ? 'unknown' : 'complete', analysis: choice === null || choice === 'unknown' ? null : replayCache(rawInput, choice) };
}

export function validateState(state, rawInput) {
  const input = validateInput(rawInput);
  if (!keys(state, ['version', 'inputHash', 'config', 'room', 'credentialHash', 'startedAt', 'attempts']) || state.version !== 1
    || state.inputHash !== hash(input) || typeof state.room !== 'string' || !ROOM.test(state.room)
    || typeof state.credentialHash !== 'string' || !/^[0-9a-f]{64}$(?![\s\S])/.test(state.credentialHash)
    || !Array.isArray(state.attempts) || state.attempts.length > itemsFor(input).length || iso(state.startedAt) !== state.startedAt) throw new Error('Invalid state or changed cache trace. Restore the original input and configuration.');
  validateConfig(state.config);
  const items = itemsFor(input), ids = new Set(), questionIds = new Set(); let previous = state.startedAt, askerId;
  for (const [index, attempt] of state.attempts.entries()) {
    if (!keys(attempt, ['id', 'itemId', 'createdAt', 'request', 'questionId', 'status', 'observation']) || !isId(attempt.id) || ids.has(attempt.id)
      || attempt.itemId !== items[index].id || iso(attempt.createdAt) !== attempt.createdAt || attempt.createdAt < previous
      || hash(attempt.request) !== hash(requestFor(input, state.config, attempt.itemId, attempt.id))
      || !['creating', 'pending', 'answered', 'expired', 'cancelled', 'invalid_answer'].includes(attempt.status)) throw new Error('Invalid saved eviction-policy selection or order.');
    ids.add(attempt.id); previous = attempt.createdAt;
    if (attempt.status === 'creating') {
      if (attempt.questionId !== null || attempt.observation !== null) throw new Error('Invalid uncertain creation state.');
    } else {
      if (!isId(attempt.questionId) || questionIds.has(attempt.questionId)) throw new Error('Invalid or repeated Question ID.');
      questionIds.add(attempt.questionId); validateObservation(attempt.observation, attempt.status, attempt.request);
      if (attempt.observation.checkedAt < attempt.createdAt) throw new Error('Observation predates its saved creation intent.');
      previous = attempt.observation.checkedAt;
      if (Date.parse(attempt.observation.createdAt) < Date.parse(attempt.createdAt) - CLOCK_SKEW_MS) throw new Error('Question predates its saved creation intent.');
      if (askerId !== undefined && attempt.observation.askerId !== askerId) throw new Error('Questions belong to different asking registrations.');
      askerId = attempt.observation.askerId;
    }
    if (['creating', 'pending'].includes(attempt.status) && index !== state.attempts.length - 1) throw new Error('Only the last confirmation may have an active Question.');
  }
  return state;
}




export function report(state, rawInput) {
  const input = validateInput(rawInput); validateState(state, input);
  const attempt = state.attempts[0], answer = attempt?.observation?.answer;
  const answers = [{ itemId: 'policy', status: attempt?.status === 'creating' ? 'create_unknown' : attempt?.status ?? 'unasked',
    choice: answer?.value ?? null, label: answer?.label ?? null, questionId: attempt?.questionId ?? null, attemptId: attempt?.id ?? null,
    responderId: answer?.responderId ?? null, answeredAt: answer?.answeredAt ?? null, askerId: attempt?.observation?.askerId ?? null, observedAt: attempt?.observation?.checkedAt ?? null }];
  const calculation = cachePlan(input, answers[0].choice);
  const status = ['create_unknown', 'pending'].includes(answers[0].status) ? answers[0].status : answers[0].status === 'unasked' ? 'ready' : calculation.status;
  return { version: 1, traceId: input.traceId, sourceHash: hash(input), source: input, policy: POLICY, policyHash: POLICY_HASH,
    participant: state.config.participant, room: state.room, configHash: hash(state.config), answers, ...calculation, status };
}

function validateObservation(observation, status, request) {
  if (!keys(observation, ['createdAt', 'expiresAt', 'checkedAt', 'askerId', 'resolvedAt', 'answer']) || !isId(observation.askerId)) throw new Error('Invalid saved observation.');
  for (const key of ['createdAt', 'expiresAt', 'checkedAt']) if (iso(observation[key]) !== observation[key]) throw new Error('Invalid saved timestamp.');
  const duration = Date.parse(observation.expiresAt) - Date.parse(observation.createdAt);
  if (duration < TTL * 1000 - 1000 || duration > TTL * 1000 + 1000) throw new Error('Question lifetime differs from the saved request.');
  const latest = Date.parse(observation.checkedAt) + CLOCK_SKEW_MS;
  if (Date.parse(observation.createdAt) > latest) throw new Error('Question creation is implausibly in the future. Check the local clock.');
  if (status === 'pending') {
    if (observation.resolvedAt !== null) throw new Error('Pending Question has a resolution timestamp.');
  } else if (iso(observation.resolvedAt) !== observation.resolvedAt || observation.resolvedAt < observation.createdAt
    || Date.parse(observation.resolvedAt) > latest
    || (status === 'expired' ? observation.resolvedAt < observation.expiresAt : observation.resolvedAt > observation.expiresAt)) throw new Error('Invalid Question resolution time.');
  if (status === 'answered') {
    const answer = observation.answer;
    if (!keys(answer, ['value', 'label', 'responderId', 'answeredAt']) || answer.responderId !== request.target_user_id
      || !request.options.some((option) => option.value === answer.value && option.label === answer.label)
      || iso(answer.answeredAt) !== answer.answeredAt || answer.answeredAt !== observation.resolvedAt
      || answer.answeredAt < observation.createdAt || answer.answeredAt > observation.expiresAt) throw new Error('Invalid saved eviction-policy selection evidence.');
  } else if (observation.answer !== null) throw new Error('Unanswered eviction-policy selections must not contain eviction-policy selection evidence.');
}

export function observeQuestion(q, request, questionId, room, checkedAt) {
  if (!isId(questionId) || q?.id !== questionId || q.kind !== 'question' || (q.is_handoff !== undefined && q.is_handoff !== false)
    || q.asker?.type !== 'agent' || !isId(q.asker?.id) || q.prompt !== request.prompt || q.context !== request.context
    || q.responder_scope !== 'direct' || q.target_user_id !== request.target_user_id || q.resolution_policy !== 'first'
    || (q.results !== undefined && q.results !== null) || q.text_input !== null || q.correlation_id !== request.correlation_id || q.reply_to !== null || hash(q.data) !== hash(request.data)
    || (q.room_code ?? q.room?.code) !== room || q.room_code !== undefined && q.room_code !== room
    || q.room !== undefined && q.room?.code !== room || !['pending', 'answered', 'expired', 'cancelled'].includes(q.state)
    || !Array.isArray(q.options) || q.options.length !== request.options.length
    || Array.from(q.options).some((option, index) => option?.value !== request.options[index].value || option?.label !== request.options[index].label
      || (option?.primary !== undefined && option.primary !== false) || (option?.destructive !== undefined && option.destructive !== false))) throw new Error('Question does not match the saved configuration, room, or reviewer.');
  const observation = { createdAt: iso(q.created_at), expiresAt: iso(q.expires_at), checkedAt: iso(checkedAt), askerId: q.asker.id,
    resolvedAt: q.resolved_at === null ? null : iso(q.resolved_at), answer: null };
  let status = q.state === 'answered' ? 'invalid_answer' : q.state;
  if (q.state !== 'answered' && q.answer !== null) throw new Error('Unresolved Question includes an unexpected answer.');
  if (q.state === 'answered') {
    const answer = q.answer;
    try {
      if (!answer || answer.text !== null || answer.responder?.id !== request.target_user_id
        || !request.options.some((option) => option.value === answer.value && option.label === answer.label)) throw new Error('Invalid answer.');
      observation.answer = { value: answer.value, label: answer.label, responderId: answer.responder.id, answeredAt: iso(answer.answered_at) };
      validateObservation(observation, 'answered', request); status = 'answered';
    } catch { observation.answer = null; }
  }
  validateObservation(observation, status, request);
  return { status, observation };
}

export function assertParticipantRoom(rooms, room, participantId) {
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Invalid room inventory.');
  const matches = rooms.filter((item) => item?.invite_code === room), selected = matches[0];
  if (matches.length !== 1 || selected.type !== 'standard' || selected.is_public !== false || !Array.isArray(selected.members)
    || selected.members.length > 1000 || !selected.members.some((member) => member?.user_id === participantId)) throw new Error('Use a granted standard private room containing the named participant.');
}
