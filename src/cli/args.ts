export interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

const VALUE_FLAGS = new Set(['model', 'provider', 'width', 'provider-table', 'name', 'lockfile']);
const BOOLEAN_FLAGS = new Set(['json', 'color', 'no-color', 'strict', 'help', 'version', 'check', 'update', 'yes']);

/**
 * Small hand written parser.
 *
 * A dependency for this would be a dependency on every run of a tool whose
 * whole argument surface is five flags.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg == null) continue;

    if (!arg.startsWith('-')) {
      positionals.push(arg);
      continue;
    }

    const withoutDashes = arg.replace(/^--?/, '');
    const [name, inlineValue] = withoutDashes.split('=', 2) as [string, string | undefined];

    if (VALUE_FLAGS.has(name)) {
      const value = inlineValue ?? argv[i + 1];
      if (value == null || value.startsWith('-')) {
        throw new UsageError(`Flag --${name} needs a value. Example: --${name} <value>`);
      }
      if (inlineValue == null) i += 1;
      flags[name] = value;
      continue;
    }

    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = inlineValue == null ? true : inlineValue !== 'false';
      continue;
    }

    throw new UsageError(`Unknown flag --${name}. Run "groundhog --help" for the flags this command accepts.`);
  }

  const command = positionals.shift() ?? '';
  return { command, positionals, flags };
}

export function stringFlag(flags: ParsedArgs['flags'], name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

export function boolFlag(flags: ParsedArgs['flags'], name: string): boolean {
  return flags[name] === true;
}
