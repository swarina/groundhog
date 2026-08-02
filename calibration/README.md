# Token estimator calibration

The token estimator is a character class heuristic, not a real tokenizer, so it
carries an error band. That band is only honest if it is measured. This directory
holds the corpus and the method used to measure it.

## The corpus

`corpus/` holds samples that span the content classes the estimator treats
differently, because prose, structured json, source code, markdown, and CJK text
tokenize at very different rates:

- `prose-system-prompt.txt`, `prose-agent-instructions.txt` English prose
- `json-tool-schemas.txt` json tool definitions
- `code-typescript.txt` source code
- `mixed-markdown.txt` markdown with a table and lists
- `cjk-japanese.txt` Japanese text

Every sample is self-authored, so the corpus can be committed and redistributed
without a copyright question.

## The reference

The exact token counts come from the real OpenAI tokenizer, `o200k_base`, through
the `gpt-tokenizer` dev dependency. It runs offline with no key, so the
calibration is reproducible by anyone who clones the repository. Anthropic
publishes no offline tokenizer, so its band is not calibrated this way and is
marked unverified in the provider data until a conformance run measures it.

## The method

`test/token-calibration.test.ts` reads each sample, tokenizes it with `o200k_base`
for the truth and with the estimator for the estimate, and computes the relative
error. It asserts three things:

1. the ninetieth percentile error is within the band the tool prints for OpenAI,
   so the band is not a lie,
2. that percentile is within an independent ceiling, so the estimator cannot
   silently degrade even if the band is later widened,
3. no single sample falls outside the band.

The estimator coefficients in `src/tokens/estimate.ts` were fitted against this
corpus. Measured against `o200k_base`, the ninetieth percentile error is about
9.5 percent, and the OpenAI band is set to 12 percent to leave margin for text
the corpus does not contain.

## Regenerating

To see the current distribution:

```bash
GROUNDHOG_CALIBRATE=1 npx vitest run test/token-calibration.test.ts
```

It prints the per sample and aggregate error. If a coefficient change moves the
numbers, update the band in `data/providers.json` to match what is measured, and
keep the ceiling in the test honest.

## Known limit

The estimator over-estimates highly repetitive text, because a character class
heuristic cannot see the byte pair merges a real tokenizer makes on repeated
substrings. Realistic prompts are not degenerate repetition, so the calibrated
band holds for them, but padding a prompt with a repeated sentence will estimate
higher than the true count. Exact counting, rather than a wider band, is the fix
for that case, and it is an explicit opt in rather than the default so the check
path stays offline.
