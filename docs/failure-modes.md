# Failure modes

A prompt cache fails to pay in a small number of specific ways. Every one of
them lives in the application's own request assembly, not in the provider, and
every one is silent: the request succeeds, the response is normal, and the only
symptom is the bill.

This is the catalogue of what Groundhog detects, why each mode costs money, and
which command finds it. Each entry names the finding code, so the terminal
output can be looked up here or with `groundhog explain <code>`.

## The six causes

Cache misses that an application can fix come from six places.

1. The cacheable span does not qualify to be cached at all.
2. There is no cache boundary, on a provider that needs one.
3. The traffic is too sparse to stay inside the time to live.
4. The cache is fragmented or the request is routed away from its entry.
5. The cacheable prefix is not identical from one request to the next.
6. The tool or schema definitions change and invalidate everything after them.

The first four are visible in a single request or a log. The fifth needs more
than one request by definition, and it is the one the tool spends the most
effort on. The sixth is a special case of the fifth that happens between the
turns of a conversation.

## Qualification failures

These stop caching before it can begin. A single request shows them, through
`groundhog doctor`.

### The cacheable span is below the model minimum

Code: GH102.

A model caches nothing below a minimum length, and that minimum is model
specific. An application that cached correctly can stop caching entirely after a
model upgrade without one line of its own code changing, because the new model
has a higher minimum than the old one. The request still succeeds and every
token is billed at the full rate.

How it is detected: the cacheable span is estimated in tokens and compared
against the model minimum in the provider data. When the estimate and its error
band both clear the minimum, it passes. When the band crosses the minimum, the
result is uncertain rather than a pass, because a wrong pass here is worse than
no answer.

The fix: add stable content above the boundary until the span clears the
minimum, or move to a model with a lower one. Content only counts if it is
identical on every request.

### No cache boundary is declared

Code: GH101.

Some providers cache only what a request explicitly marks. A request that marks
nothing is a valid request that caches nothing, and there is no error to say so.
Every token is billed at the full rate on every call.

The fix: mark the end of the stable part of the prompt, after the tool
definitions and the system prompt and before any per request content.

### The span falls between cache steps

Code: GH105.

A provider that caches in fixed steps above a floor bills a span that lands
between two steps at the lower step, and charges the remainder at the full rate
on every request. It is small and it is free to reclaim.

The fix: extend the stable part of the prompt to the next step, or accept the
remainder.

### Too many boundaries, or a span beyond the lookback window

Codes: GH103, GH104.

A provider honours a limited number of cache boundaries and looks back a limited
number of content blocks. Boundaries or blocks beyond those limits are not
matched against the cache even when they are byte identical.

The fix: reduce to the supported number of boundaries, keeping the ones at the
end of the largest stable sections, and merge adjacent stable blocks so the span
fits inside the lookback window.

## Routing and scope failures

The prefix is perfect and the cache still misses, because the request never
reaches its cache entry.

### No cache routing key

Code: GH106.

On a provider that routes requests across backends, a cache hit is served only
when a request reaches a backend that already holds the prefix. Without a routing
key, the prompt is byte perfect and nothing in the application changed, yet the
hit rate falls as traffic spreads across machines that do not share a cache.

How it is detected: statically, from the absence of the routing key field, and
in the audit as a reconciliation miss, where the prefix matched a recent request
but the usage says it did not hit.

The fix: set the routing key to a stable identifier shared by requests with the
same prefix, such as a prompt version or a route name. A per user or per request
value makes it worse, since it spreads traffic rather than concentrating it.

## Determinism failures

The largest class. The cacheable prefix is not the same on the next request, so
from the first differing byte onward nothing is served from cache. `groundhog
check` finds these by building the prompt across a matrix of repeats, varied
inputs, and changed environments, then classifying what changed. All of them
report under GH120, distinguished by cause.

### A volatile literal in the cached span

A value that changes on every call, sitting in the part meant to be shared. The
classifier names which kind it is, because the fix differs.

- A timestamp or date. The most common one. A current time interpolated into a
  system prompt gives every request a unique prefix. Detected with certainty
  when every differing value parses as an ISO 8601 date or time, and when a unix
  epoch tracks the clock across the environment axis.
- A uuid, request id, trace id, or session id. Detected with certainty for a
  uuid, and as a probability for an opaque identifier such as a ulid or nanoid.
- An incrementing counter. Detected with certainty when the value is an integer
  that strictly increases across repeated calls.
- A high entropy random value. Detected only as a possibility, because a content
  hash of changed content looks identical to a generated token, and the honest
  answer is that it may be either.

The fix: move the value out of the cached span, into the final user message below
the boundary, or make it deterministic.

### Per request data above the boundary

A value that is stable for a given input but differs between inputs, such as a
user name, a tenant identifier, or a session detail interpolated into the cached
prefix. It is perfectly deterministic and it fragments the cache across the whole
user base.

How it is detected: the value is identical for repeats of one input and differs
between inputs, a clean split along the input axis of the matrix, which
demonstrates that it tracks the request rather than the clock or the code.

The fix: move the per request value out of the cached prefix and into the final
message.

### Environment dependence

A value that depends on the clock, the timezone, or the random stream. It repeats
happily inside one process, which is why running a builder twice does not find
it, and it differs on another machine or another day.

How it is detected: the prefix is identical within each environment and differs
between them, a clean split along the environment axis, which the matrix produces
by freezing the clock, moving it across a day boundary, shifting the timezone,
and reseeding randomness.

The fix: move the dependency below the cache boundary, or pin it, so the cached
part is the same on every machine and every day.

### Nondeterministic ordering

The same elements in a different order. Tool definitions assembled from an
unordered registry, retrieved documents returned in a different rank order with
ties unbroken, or object keys built from a set. The content is identical and the
sequence is not.

How it is detected: the elements are a permutation of each other, checked at the
level where reordering happens, across blocks, across the parts of a block such
as a tool list, or across the lines of a text block such as a set of retrieved
documents. Genuinely reordered prose is guarded against by requiring the elements
to be non trivial and an exact multiset match, so a real content change is not
mistaken for a reordering.

The fix: sort the elements into a stable order before they enter the prompt.

### A structural change

A content block added, removed, or retyped between requests. The shape of the
prompt differs, not only its text.

The fix: keep the block and part structure identical between requests.

### A genuine content change

The residual. The cached part is carrying content that genuinely differs, and no
volatile pattern explains it. This is a real answer, not a shrug: it means the
prompt itself was built differently, and the fix is to move the varying content
below the boundary.

## Conversation failures

An agent loop sends the whole conversation every turn, and the cache pays only
when each turn is a byte for byte extension of the last. `groundhog chain` walks
the turns and finds the first that is not.

### The conversation stops reusing its prefix

Code: GH130.

A turn re-renders content that an earlier turn already sent, so the match breaks
at that point, and from there on every turn pays full price on a context that
keeps growing. This is where the largest cache bills come from, and it is
invisible: the responses are normal and only the bill moves.

The usual causes are a tool result serialised differently the second time it is
sent, an assistant message normalised on the way back into the history, a history
summarised or truncated in place, or tool definitions rebuilt from a registry in
a different order. The classifier names which, using the same detectors as the
determinism check.

Only the first break is reported, because every later turn failing to reuse is a
consequence of the first one, and naming them all would bury the real finding.

The fix: carry earlier turns forward verbatim rather than rebuilding them from
parsed state.

## Traffic and deploy failures

Some misses are not code at all. `groundhog audit` separates them from the ones
that are, over a log of real requests.

### Time to live expiry

A prefix seen before, but longer ago than the window allows, so the cache had to
be rewritten. This is not a determinism bug: the code is fine and the traffic is
too sparse. A large share of real cache misses are this, and a tool that could
not name it would blame the code for something the code did not do.

The fix: keep the prefix warm, or use the longer time to live if the provider
offers one.

### Prefix fragmentation

Many prefixes that appear once and never reuse, usually because a per request
value makes each one unique. The audit ranks the prefixes by volume so the
fragmentation is visible, and counts it against the achievable ceiling as
recoverable.

The fix: find the value that makes each prefix unique and move it out of the
cached prefix, so the fragments collapse into one that reuses.

### The deploy that cold started the cache

Code: GH140.

A prompt edit shipped on a deploy invalidates every cached prefix at once, at the
full uncached rate until the cache refills. It is expected when the prompt was
edited on purpose and a surprise when it was not.

How it is detected: a prefix hash committed beside the code, checked in the build
with `groundhog baseline --check`. When it fails, `groundhog blame` walks the
lockfile's git history and names the commit that changed it.

The fix: accept the change into the baseline if it was intended, or find what
moved if it was not.

## What Groundhog does not detect

Stated plainly, so the tool is not trusted for what it cannot see.

- Provider side cache eviction under memory pressure. This happens inside the
  provider and is not observable from the request.
- Routing across regions or accounts that do not share a cache, beyond the
  reconciliation signal the audit provides.
- Anything that requires knowledge of provider internals that the tool cannot
  measure. Where a provider fact is unknown, the check that depends on it is
  skipped and named, never run against a guess.

Provider facts change without notice, so every value the tool uses carries a
confidence level and a verification date, and a value that has not been measured
against the live API is marked as such. When that data is older than a threshold,
a run says so under GH110 rather than presenting stale facts as current. The
`groundhog conformance` command measures those facts directly, so a reported
value can become an observed one.
