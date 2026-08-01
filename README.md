# Groundhog

Find out why your prompt cache is not paying.

Every major provider discounts a repeated prompt prefix heavily. The discount
applies only when the prefix is identical to the last one, and when it is not,
nothing happens: no error, no warning, a normal response, full price. Groundhog
finds the reasons that does not happen, names each one, and says what to do
about it.

It runs locally. Nothing leaves your machine, there is no account, and the check
path makes no network calls.

## Install

```bash
npx groundhog doctor request.json --model claude-sonnet-4-5
```

## Five minutes to an answer

Groundhog looks at the request your application actually sends, which is not
always the request your code appears to build. An SDK normalises content shapes,
fills in defaults and serialises before anything reaches the provider, and the
provider hashes what arrived. So the accurate place to measure is the wire.

Record what your existing tests already send:

```ts
import { capture } from 'groundhog/capture';

const recorder = capture();

test('support agent prompt is cacheable', async () => {
  await runMyAgent({ query: 'where is my order' });

  const [report] = recorder.inspect({ model: 'claude-sonnet-4-5' });
  expect(report.ok).toBe(true);
});
```

Nothing is sent. The recorder answers with a minimal valid response so the code
under test carries on, which means no keys, no cost and no network. If it
captures nothing it raises an error rather than reporting a pass, because a
check that inspected no requests has not verified anything.

If you already have a request body saved, skip the recorder:

```bash
npx groundhog doctor request.json --model gpt-4o
```

## What it tells you

```
anthropic / claude-opus-5
measured at   builder output, before any sdk normalisation
span          338 tokens (estimate, plus or minus 12%)
prompt        343 tokens (estimate, plus or minus 12%)
minimum       4,096 tokens for this model (inferred, unverified)
boundary      declared boundary at block 0 of 2

FAIL  GH102  cacheable span is below the minimum for this model, so nothing is
             cached
      confidence: certain

  The span is 338 tokens, at most 379 allowing for estimation error. This model
  requires 4,096. Nothing in this request is being cached.

  The API does not report an error when a span falls below the minimum. The
  request succeeds and every token is billed in full.

  Fix: Add about 3,758 more tokens of stable content above the boundary, or use
  a model with a lower minimum. Content only counts toward the minimum if it is
  identical on every request.
```

Every finding says what happened, where, why it matters, and what to do. Cost
appears as the unit that makes a finding legible, per request, never as a
dashboard.

## What it checks today

One request, whether it qualifies to be cached at all:

| Code | Finding |
| --- | --- |
| GH101 | No cache boundary declared, on a provider that caches nothing without one |
| GH102 | Cacheable span below the minimum for the model |
| GH103 | More cache boundaries than the provider honours |
| GH104 | Cacheable span beyond the provider lookback window |
| GH105 | Span falling between the provider cache steps |
| GH106 | No cache routing key, where hits depend on reaching the same backend |
| GH110 | The provider data used for the run is out of date |

A set of requests, whether the cacheable prefix stays identical, which is what
decides whether the cache pays across real traffic:

| Code | Finding |
| --- | --- |
| GH120 | The cacheable prefix is not identical between runs, classified by cause: a timestamp, a uuid, a counter, a random value, an unstable order, or genuine content |
| GH130 | A conversation stops reusing its prefix at a turn, because an earlier turn was re-rendered on replay |

`groundhog explain GH120` prints the full write-up for any of them.

## The four commands

```
groundhog doctor request.json --model claude-sonnet-4-5   one request, does it qualify
groundhog check requests.json --model claude-sonnet-4-5   a set, is the prefix stable
groundhog chain turns.ndjson  --model claude-sonnet-4-5   a conversation, per turn reuse
groundhog audit requests.ndjson                           real traffic, where the loss goes
```

The determinism check runs the builder across a matrix: repeats catch what
changes on every call, varied inputs catch per request data above the boundary,
and a frozen clock, shifted timezone, and reseeded randomness catch environment
dependencies that would otherwise repeat inside one process and differ
everywhere else. When the prefix breaks it names the byte, shows the diff, and
classifies the cause.

## The audit

Raw hit rate is a misleading target: even a perfect application pays one cache
write per prefix per time to live window. The audit measures how far the
observed rate sits below what the traffic could reach, and splits the gap by
cause.

```
anthropic / claude-sonnet-4-6
requests      36 over 12 minutes
observed      69.4% hit rate
achievable    97.2% given this traffic and window
recoverable   27.8%, about 0.0567 USD across this log

where it goes
   22.2%  prefix fragmentation (8 requests, 0.0454 USD)
    2.8%  time to live expiry (1 request)
    2.8%  routing or scope (1 request)
    2.8%  necessary cold writes (1 request)
```

It reads an NDJSON log, one record per request, each carrying a timestamp, the
model, the cacheable prefix hash, and the usage the response reported. No prompt
content is needed. Build the records in production with `buildAuditRecord`, which
turns a request and its response usage into one log line and keeps no content:

```ts
import { auditRecordLine } from 'groundhog';

const line = auditRecordLine({
  body: requestBody,
  usage: response.usage,
  ts: new Date().toISOString(),
});
appendFileSync('.groundhog/requests.ndjson', line + '\n');
```

The routing or scope bucket is the honest one: when a request should have hit by
our model but the usage says it did not, the miss is outside the prefix, and the
audit says so rather than reporting a rate it invented.

## Three things it will not do

**It will not report a pass it cannot support.** Token counts are estimates with
an error band. When the band crosses a threshold the answer is "no verdict", not
"looks fine". A wrong pass here is worse than no tool.

**It will not guess a provider fact.** Every threshold, limit, price and field
name lives in `data/providers.json` with a confidence level, a source and a
verification date. When a fact is unknown the check that needs it is skipped and
named, never run against a value borrowed from a similar provider.

**It will not go on the hot path.** There is no proxy and no gateway. The
recorder patches fetch inside your test process and nowhere else.

## Correcting the provider data

Provider caching rules change without notice. Every run prints how old its data
is, and any value can be corrected without forking:

```json
{
  "schemaVersion": 1,
  "staleAfterDays": 90,
  "providers": {
    "anthropic": {
      "models": {
        "claude-opus-5": {
          "minCacheableTokens": { "value": 2048, "confidence": "observed" }
        }
      }
    }
  }
}
```

Save it as `groundhog.providers.json` in your project root. Layers merge, so a
correction to one number leaves everything else alone. `groundhog providers show
anthropic claude-opus-5` prints the merged result and where each value came
from.

## Commands

```
groundhog doctor [file]        one request, does it qualify to be cached
groundhog check [file]         a set of requests, is the cacheable prefix stable
groundhog chain [file]         a conversation, does each turn reuse the prefix
groundhog audit <log>          real traffic, how far below the ceiling and why
groundhog providers list       list providers in the data table
groundhog providers show <id> [model]
groundhog explain <code>       full write-up for a finding code
```

Exit codes: `0` no failures, `1` at least one failure, `2` usage or
configuration error, `3` a check reached no verdict and `--strict` was set.

## Development

```bash
npm install
npm test
npm run build
```

Detector cases live in `test/fixtures/static`, one directory per case, walked by
a single table-driven test. Adding a case means adding a directory. The cases
that carry the weight are the negative ones, which are designed to make a
detector fire wrongly, because a detector that fires on everything passes every
positive case.

Terminal output is pinned by golden files. Regenerate with
`GROUNDHOG_UPDATE_GOLDEN=1 npm test` and read the diff before committing it.
Output is part of the product, so a change to it should be reviewed rather than
absorbed.

## Licence

MIT
