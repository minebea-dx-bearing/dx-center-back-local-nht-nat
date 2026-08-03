# Scaling a Realtime Dashboard to 1000+ Viewers

How `GET /machines` serves hundreds or thousands of simultaneous dashboards without the backend load growing with viewer count.

- **Implementation:** [local-backend/util/realtimeMachinesRoute.js](../local-backend/util/realtimeMachinesRoute.js)
- **Reference route:** [local-backend/api_nat/tn_tn_realtime_redis.js](../local-backend/api_nat/tn_tn_realtime_redis.js)
- **Related:** [realtime-developer-guide.md](./realtime-developer-guide.md), [load-testing-and-performance.md](./load-testing-and-performance.md)

---

## 1. The problem

A realtime dashboard is opened on many screens at once — factory floor monitors, office desktops, supervisor tablets. Every one of them polls the same endpoint asking the **identical question**: "what is every machine doing right now?"

Without any caching, each request independently does all of this:

```
request → read data source (Redis / MQTT store / SQL)
        → prepareRealtimeData()  (derive target_pd, curr_utl, diff_pd, OEE …)
        → summarize()            (sum/average across all machines)
        → JSON.stringify()       (serialize every machine)
        → send bytes
```

With 1000 viewers, that entire pipeline runs **1000 times to produce 1000 byte-identical answers**.

### 1.1 It is worse than "1000 times" — it is a thundering herd

Look at how the frontend schedules its polls ([NatTnRedisRt.jsx](../../dx-center-front/src/pages/natNew/tn/NatTnRedisRt.jsx)):

```jsx
const id = setInterval(() => {
  if (Number(moment().format("ss")) % REFRESH_SECONDS === 0) fetchData();
}, 1000);
```

The condition is on the **wall clock**, not on when the page happened to load. Every dashboard in the factory sees `ss % 5 === 0` at exactly the same instant. They do **not** spread out over the interval.

```
        t=0s                    t=5s                    t=10s
         │                       │                       │
viewers  ██████████ (1000)      ██████████ (1000)       ██████████
         ▲                       ▲                       ▲
         │  ← idle 5s →          │  ← idle 5s →          │
      all at once             all at once            all at once
```

So the backend is not handling "200 requests/second steadily". It is handling **1000 requests in one instant, then nothing for 5 seconds**. Peak load is what breaks servers, not average load.

> **Why not just stagger the clients?** You could add random jitter so viewers spread across the interval. But then different screens show data from different moments, which looks wrong when two monitors sit side by side on the same wall. Wall-clock alignment is a *feature*; the fix belongs on the server.

---

## 2. The solution: one shared snapshot per tick

Since every viewer in a given window wants the same answer, compute it **once** and hand the same result to everyone.

```
BEFORE                              AFTER
──────                              ─────
req 1 ─► read+derive+serialize      req 1 ─┐
req 2 ─► read+derive+serialize      req 2 ─┤
req 3 ─► read+derive+serialize      req 3 ─┼─► cached snapshot ─► (rebuilt once per 5s)
  …                                   …    │
req 1000 ► read+derive+serialize    req1000─┘

work = O(viewers)                   work = O(1)  ← independent of viewer count
```

Enable it by passing `cacheMs` to `makeMachinesHandler`:

```js
router.get("/machines", makeMachinesHandler({
  getMachines,
  getRunningTime: async () => [],
  prepareRealtimeData: prepare,
  summary: "standard",
  cacheMs: 5_000,        // ← shared snapshot window
}));
```

**`cacheMs` defaults to `0` (disabled).** The ~17 existing MQTT-backed routes were not changed and behave exactly as before. Caching is opt-in per route because each one needs its own freshness judgement.

### 2.1 How to choose `cacheMs`

**Rule: never cache for longer than the data source updates.** Caching beyond that shows stale data; caching below that wastes work re-reading values that have not changed.

For the Redis route, upstream writes to the `rt_*` hashes roughly every ~5 seconds, so `cacheMs: 5_000` costs **zero** freshness — a shorter window would just re-read identical values.

Match this to the frontend's `REFRESH_SECONDS` so the two stay in step.

### 2.2 What exactly is cached

The **serialized string**, not the object:

```js
const json = JSON.stringify(body);   // ← this is what gets cached
```

This matters. `JSON.stringify` over every machine is the single largest per-request CPU cost once the machine count grows. Caching the object would still leave 1000 serializations per tick. Caching the string reduces it to one.

### 2.3 Single-flight: preventing a stampede on a cold cache

There is a subtle failure mode. When the cache expires, 1000 requests arrive *simultaneously* and all see "cache is empty" before any of them has finished rebuilding it. Naively, all 1000 start their own rebuild — exactly the problem the cache was meant to solve.

The fix is to store the **in-flight Promise**, so latecomers await the rebuild already running instead of starting another:

```js
const getPayload = () => {
  if (!cacheMs) return build();
  if (cache.payload && Date.now() - cache.at < cacheMs) return Promise.resolve(cache.payload);
  if (cache.inflight) return cache.inflight;      // ← join the rebuild already running

  const inflight = build().then((payload) => {
    cache = { at: Date.now(), payload, inflight: null };
    return payload;
  });

  cache = { ...cache, inflight };
  inflight.catch(() => {                           // on failure, drop it so the next call retries
    if (cache.inflight === inflight) cache.inflight = null;
  });
  return inflight;
};
```

Three states, and every request lands in exactly one:

| State | Condition | Action |
|---|---|---|
| **Fresh** | `payload` exists, within `cacheMs` | return it immediately |
| **Rebuilding** | a build is already running | await *that* build |
| **Cold** | neither | start one build, everyone else joins it |

> This same pattern already exists in [`runningTimeCache.js`](../local-backend/util/runningTimeCache.js) and [`masterStorage.js`](../local-backend/util/masterStorage.js). It is the standard shape for caching in this codebase — reuse it, do not reinvent it.

**Note the `.catch()`:** if a build fails, the in-flight Promise must be cleared. Otherwise every future request awaits a Promise that already rejected, and the endpoint stays broken until restart.

---

## 3. Compression: gzip the snapshot, not the response

Once the shared snapshot works, CPU is no longer the constraint — **bandwidth** is. At 1000 machines a response is ~581 KB. 1000 viewers × 581 KB every 5 seconds is ~116 MB/s ≈ **930 Mbps**, saturating a gigabit link on its own.

### 3.1 Why NOT `compression()` middleware

The obvious answer is Express's `compression()` middleware. **Do not use it here.** It compresses *per response* — 1000 viewers means 1000 separate gzip operations on byte-identical data. Measured, it made things actively worse at scale:

| Viewers | `compression()` middleware | Uncompressed |
|---|---|---|
| 2000 | **616 failures** | 88 failures |

The CPU spent compressing exceeded the bandwidth saved. Compression is only worth it when its cost can be **amortised across viewers** — which requires a cache.

### 3.2 Compress once per tick

Because a snapshot already exists, gzip it at build time and serve the same buffer to everyone:

```js
// Compress ONCE per tick, not once per response.
const gz = cacheMs ? await gzip(json) : null;
return { json, gz };
```

The `cacheMs ?` guard is the important part: **no cache means no compression.** A route without a cache would pay per-request gzip cost with nothing to amortise it against — the exact trap in §3.1.

Serving then negotiates on the request header:

```js
res.type("json").vary("Accept-Encoding");

if (gz && /\bgzip\b/.test(req.headers["accept-encoding"] || "")) {
  return res.set("Content-Encoding", "gzip").send(gz);
}
return res.send(json);
```

- **`Vary: Accept-Encoding`** tells proxies/CDNs to cache the compressed and uncompressed variants separately. Omitting it can cause a proxy to serve gzipped bytes to a client that cannot decode them.
- Clients that do not send `Accept-Encoding: gzip` (curl by default, some legacy tools) still get plain JSON. Browsers and axios send it automatically — **no frontend change is needed.**

### 3.3 Measured effect at 1000 machines

| | Plain | Gzip |
|---|---|---|
| Payload | 581,029 B | **15,857 B** |
| p95 @ 1000 viewers | 1801 ms | **586 ms** |
| Data moved @ 1000 viewers | 554 MB | **15.1 MB** |
| Peak RSS | 224 MB | **74 MB** |
| CPU | ~1 core | ~1 core |

Two things worth understanding:

- **CPU is flat at ~1 core in both.** Node's JS thread is saturated either way; gzip adds nothing because it runs once per 5s, not per request. This is the proof that §3.2 works.
- **Memory is 3× lower with gzip.** Not because gzip saves heap, but because 15 KB buffers queue in socket send-memory instead of 581 KB ones. Slow clients hold far less.

> **Caution on the 36× ratio.** That was measured with synthetic machines whose values are nearly identical, which compresses unrealistically well. Real data with varied part numbers, counters and timestamps compresses closer to **8–12×**. Plan with the conservative figure.

---

## 4. Putting it together — the full request path

```
GET /machines
      │
      ├─ cache fresh?  ──yes──►  return cached {json, gz}          ← the 999 other viewers
      │
      ├─ build in flight? ─yes─►  await it
      │
      └─ no ─► build():
                 ├─ getMachines()          read Redis / store
                 ├─ getRunningTime()
                 ├─ prepareRealtimeData()  derive every computed field
                 ├─ summarize()            KPI totals
                 ├─ JSON.stringify()
                 └─ gzip()                 only when cacheMs > 0
                        │
                        ▼
                 store in cache, return
      │
      ▼
Accept-Encoding: gzip ?  ──yes──► send gz buffer  (+ Content-Encoding: gzip)
                         ──no───► send json string
```

Per 5-second tick, regardless of whether 1 or 1000 people are watching: **one** data-source read, **one** derive, **one** serialize, **one** gzip.

---

## 5. What this does *not* solve

Be honest about the remaining limits.

1. **Bandwidth still scales linearly with viewers.** The cache makes *computation* O(1), but every viewer still receives their own copy of the bytes. Gzip reduces the constant by ~10×; it does not change the growth rate. Only push-based delivery with deltas (SSE) changes that.
2. **Frontend rendering.** [`MasterRtPage`](../../dx-center-front/src/components/redesign/realtime/MasterRtPage.jsx) renders one `DefaultCard` per machine with no virtualization. At high machine counts the browser becomes the bottleneck long before the server does.
3. **Very large machine counts are a design problem, not a capacity problem.** Sending a 581 KB snapshot of 1000 machines to every dashboard every 5 seconds is the wrong shape. The fix is to send *less*: filter/paginate server-side by line or area, so each dashboard receives only the machines it displays.

---

## 6. Applying this to a new route

1. **Confirm the data source's update cadence.** Measure it — do not assume. See [load-testing-and-performance.md §2](./load-testing-and-performance.md).
2. **Set `cacheMs` to that cadence** (or slightly below). Never above.
3. **Align the frontend's `REFRESH_SECONDS`** with `cacheMs`, and pass it to `MasterRtPage` via the `refreshSeconds` prop so the countdown matches reality.
4. **Verify gzip negotiation:**
   ```bash
   curl -s -o /dev/null -w "plain: %{size_download}B\n" http://<host>:<port>/<route>/machines
   curl -s -H "Accept-Encoding: gzip" -o /dev/null -w "gzip : %{size_download}B\n" http://<host>:<port>/<route>/machines
   ```
   The second number should be much smaller. If they are equal, the server is running stale code — restart it.
5. **Confirm uncached routes are unaffected:**
   ```bash
   curl -s -I -H "Accept-Encoding: gzip" http://<host>:<port>/nat/tn/tn-realtime/machines | grep -i content-encoding
   ```
   Should return nothing — `cacheMs` defaults to `0`, so no compression.

### Common mistakes

| Mistake | Symptom |
|---|---|
| `cacheMs` longer than source update rate | dashboard shows stale numbers |
| Adding `compression()` middleware as well | CPU cliff under load (§3.1) |
| Caching the object instead of the string | serialization cost stays O(viewers) |
| Forgetting `.catch()` on the in-flight Promise | endpoint dead until restart after one failed build |
| Omitting `Vary: Accept-Encoding` | proxy serves gzipped bytes to a client that cannot decode |
| Testing gzip without restarting the server | sizes identical; Node caches `require`d modules at boot |
