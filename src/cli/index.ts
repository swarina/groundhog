#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { formatCount } from '../core/format.js';
import { inspectRequest, type InspectOptions } from '../engine/inspect.js';
import { loadTable, resolveProfile } from '../providers/table.js';
import { explain } from '../report/catalogue.js';
import { renderReport } from '../report/render.js';
import type { Report } from '../types.js';
import { boolFlag, parseArgs, stringFlag, UsageError, type ParsedArgs } from './args.js';

const DEFAULT_LOG = '.groundhog/requests.ndjson';

const HELP = `groundhog  prompt cache checker

usage
  groundhog doctor [file]        check a request or a captured log
  groundhog providers list       list providers in the data table
  groundhog providers show <id> [model]
  groundhog explain <code>       full write-up for a finding code

doctor reads a json request body, or an ndjson log written by the capture
helper. With no file it looks for ${DEFAULT_LOG}.

flags
  --model <id>          model identifier, when the request body has none
  --provider <id>       skip provider detection
  --provider-table <p>  path to a provider data override
  --json                machine readable output
  --strict              exit non zero when a check reaches no verdict
  --no-color            plain output, also the default when not a terminal
  --width <n>           wrap width, default 80

exit codes
  0  no failures
  1  at least one failure
  2  usage or configuration error
  3  a check reached no verdict and --strict was set
`;

function main(argv: string[]): number {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }

  if (boolFlag(parsed.flags, 'help') || parsed.command === '' || parsed.command === 'help') {
    process.stdout.write(HELP);
    return parsed.command === '' && !boolFlag(parsed.flags, 'help') ? 2 : 0;
  }

  try {
    switch (parsed.command) {
      case 'doctor':
        return runDoctor(parsed);
      case 'providers':
        return runProviders(parsed);
      case 'explain':
        return runExplain(parsed);
      default:
        process.stderr.write(`Unknown command "${parsed.command}".\nRun "groundhog --help" for the list of commands.\n`);
        return 2;
    }
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }
}

interface LoadedRequest {
  body: unknown;
  url?: string;
  wireBytes?: number;
}

function readRequests(path: string): LoadedRequest[] {
  const raw = readFileSync(path, 'utf8');

  if (extname(path) === '.ndjson' || raw.trimStart().startsWith('{\n') === false && raw.includes('\n{')) {
    const out: LoadedRequest[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      out.push(normaliseRecord(JSON.parse(trimmed)));
    }
    if (out.length > 0) return out;
  }

  const parsed: unknown = JSON.parse(raw);
  if (Array.isArray(parsed)) return parsed.map(normaliseRecord);
  return [normaliseRecord(parsed)];
}

function normaliseRecord(value: unknown): LoadedRequest {
  const record = (value ?? {}) as Record<string, unknown>;
  if ('body' in record && record['body'] != null) {
    return {
      body: record['body'],
      ...(typeof record['url'] === 'string' ? { url: record['url'] } : {}),
      ...(typeof record['wireBytes'] === 'number' ? { wireBytes: record['wireBytes'] } : {}),
    };
  }
  return { body: value };
}

function runDoctor(parsed: ParsedArgs): number {
  const path = parsed.positionals[0] ?? DEFAULT_LOG;

  if (!existsSync(path)) {
    if (parsed.positionals.length > 0) {
      process.stderr.write(
        `No such file: ${path}\n` + 'Pass a json request body, or an ndjson log written by the capture helper.\n',
      );
      return 2;
    }
    process.stderr.write(
      `Nothing to check. No file given and ${DEFAULT_LOG} does not exist.\n\n` +
        'To produce one, record the requests your tests already make:\n\n' +
        "  import { capture } from 'groundhog/capture';\n\n" +
        '  const recorder = capture();\n' +
        '  await runYourCode();\n' +
        '  recorder.inspect({ model: "your-model-id" });\n\n' +
        'Or point doctor at a saved request body:\n\n' +
        '  groundhog doctor request.json --model your-model-id\n',
    );
    return 2;
  }

  const options: InspectOptions = {
    ...(stringFlag(parsed.flags, 'model') ? { model: stringFlag(parsed.flags, 'model') } : {}),
    ...(stringFlag(parsed.flags, 'provider') ? { provider: stringFlag(parsed.flags, 'provider') } : {}),
    ...(stringFlag(parsed.flags, 'provider-table') ? { table: stringFlag(parsed.flags, 'provider-table') } : {}),
  };

  const requests = readRequests(path);
  const reports: Report[] = requests.map((request) =>
    inspectRequest(request.body, {
      ...options,
      ...(request.url ? { url: request.url, fidelity: 'wire' as const } : {}),
      ...(request.wireBytes != null ? { wireBytes: request.wireBytes } : {}),
    }),
  );

  if (boolFlag(parsed.flags, 'json')) {
    process.stdout.write(JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2) + '\n');
  } else {
    const color = shouldColor(parsed);
    const widthFlag = stringFlag(parsed.flags, 'width');
    const width = widthFlag ? Number.parseInt(widthFlag, 10) : 80;

    reports.forEach((report, index) => {
      if (reports.length > 1) {
        process.stdout.write(`request ${formatCount(index + 1)} of ${formatCount(reports.length)}\n`);
      }
      process.stdout.write(renderReport(report, { color, width }));
      if (index < reports.length - 1) process.stdout.write('\n');
    });
  }

  if (reports.some((report) => !report.ok)) return 1;
  if (boolFlag(parsed.flags, 'strict') && reports.some((report) => !report.certain)) return 3;
  return 0;
}

function runProviders(parsed: ParsedArgs): number {
  const tablePath = stringFlag(parsed.flags, 'provider-table');
  const loaded = loadTable(tablePath ? { table: tablePath } : {});
  const sub = parsed.positionals[0] ?? 'list';

  if (sub === 'list') {
    process.stdout.write('provider data\n');
    for (const source of loaded.loadedFrom) process.stdout.write(`  loaded from ${source}\n`);
    process.stdout.write('\n');
    for (const [id, entry] of Object.entries(loaded.table.providers)) {
      const models = Object.keys(entry.models);
      process.stdout.write(`${id.padEnd(20)} ${entry.caching.mode.padEnd(9)} verified ${entry.lastVerified}\n`);
      process.stdout.write(`  ${models.length > 0 ? models.join(', ') : 'no models recorded'}\n`);
    }
    return 0;
  }

  if (sub === 'show') {
    const providerId = parsed.positionals[1];
    if (!providerId) throw new UsageError('Usage: groundhog providers show <provider> [model]');
    const modelId = parsed.positionals[2] ?? '';
    const profile = resolveProfile(loaded, providerId, modelId);

    process.stdout.write(`${profile.id}  ${profile.displayName}\n`);
    process.stdout.write(`verified ${profile.lastVerified}, stale after ${formatCount(profile.staleAfterDays)} days\n`);
    for (const source of profile.loadedFrom) process.stdout.write(`loaded from ${source}\n`);
    process.stdout.write('\n');
    process.stdout.write(`caching mode          ${profile.caching.mode}\n`);
    writeFact('max boundaries', profile.caching.maxBreakpoints);
    writeFact('cache floor tokens', profile.caching.cacheFloorTokens);
    writeFact('cache step tokens', profile.caching.cacheGranularityTokens);
    writeFact('lookback blocks', profile.caching.lookbackBlocks);
    writeFact('routing key field', profile.caching.routingKeyField);
    if (modelId) {
      process.stdout.write('\n');
      process.stdout.write(`model                 ${modelId} (matched ${profile.model.resolvedFrom})\n`);
      writeFact('minimum tokens', profile.model.minCacheableTokens);
      const price = profile.model.price;
      process.stdout.write(
        `price                 ${price.value ? `${price.value.inputPer1M} in, ${price.value.cachedReadPer1M} cached read, per million ${price.value.currency}` : 'not recorded'}  [${price.confidence}]\n`,
      );
    }
    return 0;
  }

  throw new UsageError(`Unknown providers subcommand "${sub}". Use list or show.`);
}

function writeFact(name: string, fact: { value: unknown; confidence: string; note?: string }): void {
  const value = fact.value == null ? 'not recorded' : Array.isArray(fact.value) ? fact.value.join(', ') : String(fact.value);
  process.stdout.write(`${name.padEnd(22)}${value}  [${fact.confidence}]\n`);
  if (fact.note) process.stdout.write(`${' '.repeat(22)}${fact.note}\n`);
}

function runExplain(parsed: ParsedArgs): number {
  const code = parsed.positionals[0];
  if (!code) throw new UsageError('Usage: groundhog explain <code>. Example: groundhog explain GH102');
  const text = explain(code);
  if (text.startsWith('Unknown finding code')) {
    process.stderr.write(text);
    return 2;
  }
  process.stdout.write(text);
  return 0;
}

function shouldColor(parsed: ParsedArgs): boolean {
  if (boolFlag(parsed.flags, 'no-color')) return false;
  if (process.env['NO_COLOR']) return false;
  if (boolFlag(parsed.flags, 'color')) return true;
  return process.stdout.isTTY === true;
}

process.exitCode = main(process.argv.slice(2));
