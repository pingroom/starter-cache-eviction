# Cache eviction replay with PingRoom

Replay an asset-cache or application-cache trace after its owner identifies the eviction rule through PingRoom. Code runs LRU or FIFO independently at each supplied byte capacity and exports hits, misses, bypasses, evictions and resident order after every request.

The replay runs locally. It does not fetch objects, change a cache or predict future traffic.

## Run offline

Choose **Use this template**, clone your copy, and use Node.js 22 or newer:

```sh
npm ci
npm test
npm run demo
```

The fictional paper-asset demo runs LRU, FIFO and Unknown through the published `@pingroom/sdk` **0.8.0** with a local mock transport. After installation, tests and demo need no credentials or network and send no live pings. The lockfile pins dependencies; `.npmrc` requests a 14-day minimum release age where npm supports it.

## Supply the trace

```sh
cp examples/cache.json cache.json
cp config.example.json config.json
npm run preview
```

Replace `cache.json` with one retained trace before starting:

| Field | Contract |
| --- | --- |
| `traceId` | Stable ID, 1–40 characters: lowercase letter first, then lowercase letters, digits, `_` or `-`. |
| `title`, `context` | Nonempty single-line text, at most 40 and 80 UTF-16 code units. Identify the documented policy to consult. |
| `objects` | 1–32 objects, each exactly `{ "id": "asset", "bytes": 123 }`. IDs are unique. Sizes are positive integers up to 1,000,000 bytes. |
| Object `id` | 1–12 characters using the `traceId` alphabet. `unknown`, `constructor`, `prototype` and `__proto__` are reserved. |
| `requests` | 0–256 object IDs, in observed request order. Every ID must exist in `objects`; repetition is expected. |
| `capacities` | 1–8 distinct integer capacities in bytes, from 0 through 10,000,000. |

Object IDs identify immutable content with fixed sizes. Export the observed order without sorting or deduplicating requests. Object declarations canonicalize by ID and capacities by numeric value. Extra fields, sparse arrays, malformed Unicode, control/format characters, surrounding whitespace, invalid references and fractional sizes are rejected. The full Question must fit 500 UTF-16 code units.

Only payload bytes count. If the target cache uses metadata overhead, compressed sizes, mutable entries, partial reads, TTLs, prefetch, admission filters, concurrency or warm initial contents, this model does not reproduce it.

## Connect and select the policy

Install [PingRoom](https://pingroom.io/i), then run:

```sh
npm run connect
npm run inspect
```

Approve the printed pairing link and grant a **standard private room** containing the cache owner, with room-list and Question create/read permissions. Verify the person in the app, then put their exact member UUID and descriptive label in `config.json`. Names alone do not establish identity.

For an existing connection, copy `.env.example` to `.env` and set both `PINGROOM_TOKEN` and the 12-character `PINGROOM_ROOM`. Partial or blank pairs are rejected; values cannot be borrowed across credential sources.

```sh
npm run preview
npm start
# After the owner answers:
npm start
npm run export
```

Each invocation creates at most one direct, 15-minute Question or reads the original Question once. Choose **LRU**, **FIFO**, or **Unknown** based on the documented cache behavior. Unknown, missing, expired, cancelled, invalid or misattributed answers withhold the replay. The program does not automatically poll, resend or replace the Question.

`preview` and `validate` show the complete local source, policy, recipient and visible Question without network access. PingRoom receives the trace ID, title/context, owner UUID, policy explanation and input/catalog/policy hashes. Object IDs, sizes, request sequence and capacities stay local. Attempt identifiers are added at creation. The answer records the owner's assertion; the program does not inspect the cache.

## Read the replay

```sh
npm run status
npm run report
npm run export
```

These commands are local and require no credentials. `report` writes `.eviction/report.json`, including partial evidence. After a known policy selection, `export` writes `.eviction/replay.json` with the frozen source, owner, attributed Question evidence and replay. Repeated exports send nothing and preserve inputs. Keep these artifacts private if the trace is private.

Each capacity begins empty and runs independently:

- A **hit** returns an already resident object. LRU moves it to newest access order; FIFO leaves its insertion position unchanged.
- A fitting **miss** evicts the oldest resident repeatedly until the requested object fits, then admits it as newest.
- An oversized object is a **bypass**: it counts as a miss but neither evicts nor changes resident order. Repeated oversized requests bypass each time.

Every step records its index, object ID and size, outcome, evicted IDs, `residentOrder` from oldest to newest, and `usedBytes`. Each capacity also reports final residents and counts of requests, hits, misses, bypasses, admissions and evictions. `misses = admissions + bypasses`; `requests = hits + misses`. `hitBytes` and `missBytes` count the full requested payload size for each hit or miss, including repeated requests and bypasses. They are accounting measures, not measured network traffic.

An empty trace has zero counts and `hitRatio: null`; otherwise `hitRatio` is an approximate numeric ratio and `exactHitRatio` retains its integer numerator and denominator. Zero capacity bypasses every nonempty request. Objects, capacities and aggregate byte counts remain within JavaScript's safe integer range.

Results describe this trace. A larger capacity can produce more FIFO misses; the tests include such a case. The starter does not choose a deployment capacity.

## Adapt and resume

Convert your retained access log to the documented schema. Use stable content IDs, authoritative immutable payload sizes and an explicit observation order. Read `analysis.runs` in your reporting workflow. The pure helper `replayCache(input, policy)` in `src/model.js` needs no PingRoom connection; the CLI export also requires attributed policy evidence. No live-cache, deployment or external-action adapter is included.

Credentials, real input, configuration, state and generated reports are ignored by Git. Keep `.pingroom/` and `.eviction/` intact. Changed input, owner, room or credential cannot reuse the session. Input/config reads are limited to 64/16 KiB. Saved state is bounded to 1 MiB; full replay/report artifacts allow 4 MiB. Writes are private and atomic under a local lock.

A lost creation response leaves `create_unknown`; preserve state and recover only the original Question:

```sh
npm run status
npm run find-id
npm run recover -- EXACT-QUESTION-UUID
```

An empty bounded search does not prove creation failed. For uncertain or expired pairing, inspect Connected Agents and resolve or revoke the original registration before archiving pending pairing state. Remove a stale `.lock` only after confirming its process stopped. Resolve the original session before archiving it for changed inputs; do not delete state to retry.

Run commands serially. Exit codes: `0` complete/local result; `1` invalid setup/evidence or refused export; `2` incomplete/Unknown/failed answer; `3` ready/pending/interrupted; `4` uncertain creation. Local status/report commands return 0 even for incomplete evidence; inspect JSON `status`.

Tests compare 1,093 short request traces across three size catalogs, both policies and eight capacities against an independent timestamp-map implementation. They also cover the maximum trace, multiple evictions, bypasses, invalid input, durable recovery, pairing and CLI subprocesses. GitHub Actions checks Node.js 22 and 24. Live phone delivery is not tested. MIT licensed.
