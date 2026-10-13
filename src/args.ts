// A small argv parser: positionals, --flag, --flag value, --flag=value, and
// everything after -- untouched.
export type Args = { positional: string[]; flags: Map<string, string | true>; rest: string[] };

export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  let rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      rest = argv.slice(i + 1);
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) flags.set(a.slice(2, eq), a.slice(eq + 1));
      else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) flags.set(a.slice(2), argv[++i]!);
      else flags.set(a.slice(2), true);
    } else positional.push(a);
  }
  return { positional, flags, rest };
}

export const str = (args: Args, name: string): string | undefined => {
  const v = args.flags.get(name);
  return typeof v === "string" ? v : undefined;
};

export const has = (args: Args, name: string): boolean => args.flags.has(name);

export function num(args: Args, name: string, fallback: number): number {
  const v = str(args, name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number`);
  return n;
}

/** `--files a,b,c` or repeated values joined by commas. */
export function list(args: Args, name: string): string[] {
  const v = str(args, name);
  return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
}
