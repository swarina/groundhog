# Detector fixtures

One directory per case. Each contains a request and the result the detectors
must produce for it. `test/static-detectors.test.ts` walks this tree, so adding
a case means adding a directory and nothing else.

## Files

`request.json` is the request body as an application would send it.

`expected.json` describes the result:

```json
{
  "model": "claude-opus-5",
  "provider": "anthropic",
  "ok": false,
  "certain": true,
  "codes": ["GH101"],
  "notCodes": ["GH102"],
  "skipped": ["GH104"]
}
```

`codes` must all be present. `notCodes` must all be absent. `provider` is
optional and forces detection when the case is about something else.

## Negative cases carry the weight

`notCodes` is the important field. A detector that fires on everything passes
every positive case. The cases that prove a detector is right are the ones
designed to make it fire wrongly: content that looks like a problem and is not.
Every detector needs at least one.

## Filler text

Real cases need prompts of realistic length, and pasting thousands of words into
a fixture makes it unreadable. Anywhere a string is expected, this object
expands into deterministic filler instead:

```json
{ "$filler": { "words": 1200 } }
```

The words come from a fixed vocabulary in a fixed order, so the same directive
always produces the same bytes. Nothing about the filler is random.
