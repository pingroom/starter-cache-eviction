import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateInput, replayCache, cachePlan, previewInput, requestFor, hash } from '../src/model.js';
import { readJson } from '../src/storage.js';
import { step, exportAnalysis, localReport } from '../src/engine.js';
import { mockApi, CONFIG, ROOM_CODE, id } from '../src/mock.js';
const example = await readJson(new URL('../examples/cache.json', import.meta.url));
const inputFor = (requests, sizes = [1, 2, 3], capacities = [0, 1, 2, 3, 4, 5, 6, 10]) => ({
  traceId: 'test', title: 'Test cache', context: 'Declared immutable objects',
  objects: sizes.map((bytes, i) => ({ id: String.fromCharCode(97 + i), bytes })), requests, capacities,
});

// A timestamp map models residency independently of the production ordered array.
function reference(input, policy, capacity) {
  const sizes = Object.fromEntries(input.objects.map(x => [x.id, x.bytes])), residents = new Map();
  const summary = { requests: input.requests.length, hits: 0, misses: 0, bypasses: 0, admissions: 0, evictions: 0, requestedBytes: 0, hitBytes: 0, missBytes: 0 };
  const residentOrder = () => [...residents.keys()].sort((a, b) => residents.get(a)[policy === 'lru' ? 'accessed' : 'inserted'] - residents.get(b)[policy === 'lru' ? 'accessed' : 'inserted']);
  const occupied = () => [...residents.keys()].reduce((n, key) => n + sizes[key], 0);
  const steps = [];
  input.requests.forEach((objectId, index) => {
    const objectBytes = sizes[objectId], evicted = []; let outcome;
    summary.requestedBytes += objectBytes;
    if (residents.has(objectId)) {
      summary.hits++; summary.hitBytes += objectBytes; outcome = 'hit'; residents.get(objectId).accessed = index;
    } else {
      summary.misses++; summary.missBytes += objectBytes;
      if (objectBytes > capacity) { outcome = 'bypass'; summary.bypasses++; }
      else {
        outcome = 'miss'; summary.admissions++;
        while (occupied() + objectBytes > capacity) { const victim = residentOrder()[0]; residents.delete(victim); evicted.push(victim); summary.evictions++; }
        residents.set(objectId, { inserted: index, accessed: index });
      }
    }
    steps.push({ index, objectId, objectBytes, outcome, evicted, residentOrder: residentOrder(), usedBytes: occupied() });
  });
  summary.hitRatio = input.requests.length ? summary.hits / input.requests.length : null;
  summary.exactHitRatio = input.requests.length ? { numerator: summary.hits, denominator: input.requests.length } : null;
  return { capacity, steps, finalResidentOrder: residentOrder(), finalUsedBytes: occupied(), summary };
}

test('exhaustive traces match an independent timestamp-map oracle for both rules and eight capacities', () => {
  let traces = 0;
  const visit = requests => {
    for (const sizes of [[1, 1, 1], [1, 2, 3], [2, 4, 1]]) for (const policy of ['lru', 'fifo']) {
      const input = inputFor(requests, sizes), result = replayCache(input, policy);
      assert.deepEqual(result.runs, input.capacities.map(capacity => reference(input, policy, capacity)));
    }
    traces++;
    if (requests.length < 6) for (const objectId of ['a', 'b', 'c']) visit([...requests, objectId]);
  };
  visit([]); assert.equal(traces, 1093);
});

test('LRU refreshes a hit, FIFO retains admission order, and bypass never changes residents', () => {
  const input = inputFor(['a', 'b', 'a', 'c', 'b', 'd', 'a'], [3, 2, 2, 9], [5]);
  const lru = replayCache(input, 'lru').runs[0], fifo = replayCache(input, 'fifo').runs[0];
  assert.deepEqual(lru.steps[3].evicted, ['b']); assert.deepEqual(fifo.steps[3].evicted, ['a']);
  for (const run of [lru, fifo]) {
    assert.equal(run.steps[5].outcome, 'bypass'); assert.deepEqual(run.steps[5].residentOrder, run.steps[4].residentOrder);
    assert.deepEqual(run.steps[5].evicted, []); assert.equal(run.steps[5].usedBytes, run.steps[4].usedBytes);
    assert.equal(run.summary.hits + run.summary.misses, 7); assert.equal(run.summary.misses, run.summary.admissions + run.summary.bypasses);
  }
});

test('a fitting large object evicts several residents while an exact fit needs no extra vacancy', () => {
  const input = inputFor(['a', 'b', 'c', 'd', 'd'], [1, 1, 1, 3], [3]);
  for (const policy of ['lru', 'fifo']) {
    const run = replayCache(input, policy).runs[0];
    assert.deepEqual(run.steps[3].evicted, ['a', 'b', 'c']); assert.equal(run.steps[3].usedBytes, 3);
    assert.equal(run.steps[4].outcome, 'hit'); assert.deepEqual(run.steps[4].evicted, []);
  }
});

test('FIFO capacity results can be nonmonotonic on the same immutable trace', () => {
  const trace = [1,2,3,4,1,2,5,1,2,3,4,5].map(n => String.fromCharCode(96+n));
  const input = inputFor(trace, [1,1,1,1,1], [3,4]);
  assert.deepEqual(replayCache(input, 'fifo').runs.map(run => run.summary.misses), [9,10]);
});

test('empty traces have zero counters and null ratios; zero capacity bypasses every request', () => {
  for (const policy of ['lru', 'fifo']) {
    const empty = replayCache(inputFor([], [1], [0,1]), policy);
    for (const run of empty.runs) { assert.equal(run.summary.requests, 0); assert.equal(run.summary.hitRatio, null); assert.equal(run.summary.exactHitRatio, null); assert.deepEqual(run.steps, []); }
    const zero = replayCache(inputFor(['a','a'], [1], [0]), policy).runs[0];
    assert.equal(zero.summary.bypasses, 2); assert.equal(zero.summary.evictions, 0); assert.equal(zero.finalUsedBytes, 0);
  }
});

test('catalog/capacity order canonicalizes while request order remains meaningful', () => {
  const input = inputFor(['a','b','a','c'], [1,2,3], [4,3]);
  const shuffled = { ...input, objects: input.objects.toReversed(), capacities: input.capacities.toReversed() };
  assert.deepEqual(validateInput(shuffled), validateInput(input)); assert.deepEqual(replayCache(shuffled,'lru'), replayCache(input,'lru'));
  assert.notEqual(hash(validateInput({ ...input, requests: input.requests.toReversed() })), hash(validateInput(input)));
});

test('invalid catalogs, references, bounds and extra fields are rejected', () => {
  const mutations = [
    x => { x.objects = []; }, x => { x.objects[0].bytes = 0; }, x => { x.objects[0].bytes = 1.2; }, x => { x.objects[0].bytes = 1000001; },
    x => { x.objects[0].id = 'constructor'; }, x => { x.objects.push(x.objects[0]); }, x => { x.objects[0].extra = true; },
    x => { x.requests = ['missing']; }, x => { x.requests = Array(1); }, x => { x.requests = Array(257).fill('a'); },
    x => { x.capacities = [0,0]; }, x => { x.capacities = [-0]; }, x => { x.capacities = [10000001]; }, x => { x.capacities = ['4']; },
    x => { x.capacities = Array(1); }, x => { x.title = ' bad'; }, x => { x.context = '\ud800'; }, x => { x.extra = 1; },
  ];
  for (const mutate of mutations) { const input = inputFor(['a']); mutate(input); assert.throws(() => validateInput(input)); }
});

test('known policy is required and preview sends no trace payload', () => {
  const input = inputFor(['a']);
  assert.throws(() => replayCache(input,'random')); assert.equal(cachePlan(input,'unknown').analysis,null); assert.equal(cachePlan(input,null).analysis,null);
  const request = requestFor(input,CONFIG,'policy',id(1));
  assert.equal(request.options.length,3); assert.equal(request.data.catalog_hash,hash(validateInput(input).objects));
  assert.equal(Object.hasOwn(request.data,'requests'),false); assert.equal(Object.hasOwn(request.data,'objects'),false);
  assert.deepEqual(previewInput(input,CONFIG).source,validateInput(input));
});

test('malformed or oversized metadata fails before state files or API operations', async t => {
  const directory = await mkdtemp(join(tmpdir(),'eviction-preflight-')); t.after(() => rm(directory,{recursive:true,force:true}));
  const api = mockApi(() => '2026-01-01T09:00:00.000Z'), input = structuredClone(example); input.context = 'x'.repeat(81);
  await assert.rejects(step({ client:api.client,directory,input,config:CONFIG,token:'offline-fixture-token',room:ROOM_CODE }));
  assert.equal(api.calls.length,0); await assert.rejects(readFile(join(directory,'state.json')),{code:'ENOENT'});
});

test('maximum trace exports complete step evidence inside a bounded private four-MiB artifact', async t => {
  const objects = Array.from({length:32},(_,i)=>({id:`object${String(i).padStart(6,'0')}`,bytes:1}));
  const input = { traceId:'maximum',title:'Maximum trace',context:'Payload bytes only',objects,requests:Array.from({length:256},(_,i)=>objects[i%32].id),capacities:[32,33,34,35,36,37,38,39] };
  const directory=await mkdtemp(join(tmpdir(),'eviction-maximum-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const now=()=> '2026-01-01T09:00:00.000Z',api=mockApi(now),options={client:api.client,directory,input,config:CONFIG,token:'offline-fixture-token',room:ROOM_CODE,now};
  await step(options);api.answer(id(1),'lru');await step(options);
  const result=await exportAnalysis(directory,input);assert.equal(result.analysis.runs.length,8);assert.equal(result.analysis.runs[0].steps.length,256);
  const bytes=(await readFile(join(directory,'replay.json'))).length;assert(bytes>1024*1024);assert(bytes<4*1024*1024);
  await localReport(directory,input,{save:true});assert.equal((await readFile(join(directory,'report.json'))).length,bytes);
});
