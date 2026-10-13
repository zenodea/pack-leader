// A small argv parser: positionals, --flag, --flag value, --flag=value, and
// everything after -- untouched. A value flag given twice accumulates its values
// comma-joined (so `list()` splits them); a bare flag given twice stays `true`, and a
// bare repeat never discards a value already given.
export type Args = { positional: string[]; flags: Map<string, string | true>; rest: string[] };

export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  let rest: string[] = [];
  const set = (name: string, v: string | true) => {
    const prev = flags.get(name);
    if (typeof prev === "string" && typeof v === "string") flags.set(name, `${prev},${v}`);
    else if (prev === undefined || v !== true) flags.set(name, v);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      rest = argv.slice(i + 1);
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) set(a.slice(2, eq), a.slice(eq + 1));
      else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) set(a.slice(2), argv[++i]!);
      else set(a.slice(2), true);
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

/** `--files a,b,c`, or `--files a --files b` (parseArgs joins repeats with commas). */
export function list(args: Args, name: string): string[] {
  const v = str(args, name);
  return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
}
