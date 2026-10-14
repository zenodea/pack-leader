// Packaging: `skill --install` against a temp HOME, the SKILL.md stub's herdr
// check, bin/pack-leader's Node version gate, and the guide's Commands block
// against `pack-leader help`. No herdr needed.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "pack-leader-skill-"));
const home = join(dir, "home");
mkdirSync(home);
// paths.ts reads the home directory at import time.
process.env.HOME = home;
process.env.HERDR_PLUGIN_STATE_DIR = join(dir, "state");

const paths = await import("../src/paths.ts");
const { guide, installSkill } = await import("../src/skill.ts");
const root = join(import.meta.dirname, "..");

after(() => rmSync(dir, { recursive: true, force: true }));

test("installSkill writes the stub and links pack-leader into ~/.local/bin, idempotently", () => {
  assert.ok(Object.values(paths.skillDirs).every((d) => d.startsWith(home)) && paths.localBin.startsWith(home), "must never touch the real home");
  mkdirSync(join(home, ".claude"), { recursive: true }); // only harnesses that are set up get the stub
  const r = installSkill();
  const stub = join(home, ".claude", "skills", "pack-leader", "SKILL.md");
  assert.deepEqual(r.skills, [stub]);
  assert.equal(readFileSync(stub, "utf8"), readFileSync(join(root, "skill", "SKILL.md"), "utf8"));
  const link = join(home, ".local", "bin", "pack-leader");
  assert.equal(r.bin, link);
  assert.equal(readlinkSync(link), paths.packLeaderBin);
  const again = installSkill();
  assert.equal(again.bin, link);
  assert.equal(readlinkSync(link), paths.packLeaderBin);
});

test("installSkill replaces a foreign symlink and leaves a regular file alone with a note", () => {
  const link = join(paths.localBin, "pack-leader");
  rmSync(link, { force: true });
  symlinkSync("/somewhere/else", link);
  assert.equal(installSkill().bin, link);
  assert.equal(readlinkSync(link), paths.packLeaderBin);

  rmSync(link);
  writeFileSync(link, "#!/bin/sh\n");
  const r = installSkill();
  assert.equal(r.bin, null);
  assert.ok(!lstatSync(link).isSymbolicLink());
  assert.ok(r.note.some((n) => n.includes("not a symlink")), JSON.stringify(r.note));
  rmSync(link);
});

test("installSkill says how to put ~/.local/bin on PATH when it is not", () => {
  const saved = process.env.PATH;
  try {
    process.env.PATH = "/usr/bin:/bin";
    const r = installSkill();
    assert.ok(r.note.some((n) => n.includes(`export PATH="${paths.localBin}:$PATH"`)), JSON.stringify(r.note));
    process.env.PATH = `${paths.localBin}:/usr/bin:/bin`;
    assert.deepEqual(installSkill().note, []);
  } finally {
    process.env.PATH = saved;
  }
});

test("SKILL.md's herdr check accepts what the CLI accepts: HERDR_ENV=1, HERDR_SOCKET_PATH or HERDR_PLUGIN_ID", () => {
  const stub = readFileSync(join(root, "skill", "SKILL.md"), "utf8");
  const check = /```bash\n(.*command -v pack-leader.*)\n```/.exec(stub)?.[1];
  assert.ok(check, "the stub has a one-line check");
  const bin = join(dir, "fakebin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "pack-leader"), "#!/bin/sh\n");
  chmodSync(join(bin, "pack-leader"), 0o755);
  const run = (env: Record<string, string>) => spawnSync("/bin/sh", ["-c", check], { env: { PATH: `${bin}:/usr/bin:/bin`, ...env } }).status;
  assert.equal(run({ HERDR_ENV: "1" }), 0);
  assert.equal(run({ HERDR_SOCKET_PATH: "/tmp/h.sock" }), 0);
  assert.equal(run({ HERDR_PLUGIN_ID: "pack-leader" }), 0);
  assert.notEqual(run({}), 0);
  assert.notEqual(run({ HERDR_ENV: "0" }), 0);
  assert.notEqual(spawnSync("/bin/sh", ["-c", check], { env: { PATH: "/usr/bin:/bin", HERDR_ENV: "1" } }).status, 0, "pack-leader not on PATH");
});

test("bin/pack-leader refuses Node older than 22.18 with a readable message", () => {
  const fake = join(dir, "fakenode");
  mkdirSync(fake, { recursive: true });
  const runWith = (version: string) => {
    writeFileSync(join(fake, "node"), `#!/bin/sh\nif [ "$1" = --version ]; then echo ${version}; exit 0; fi\necho ran\n`);
    chmodSync(join(fake, "node"), 0o755);
    return spawnSync(join(root, "bin", "pack-leader"), ["help"], { env: { PATH: `${fake}:/usr/bin:/bin` }, encoding: "utf8" });
  };
  for (const v of ["v20.11.1", "v22.17.0", "v21.9.0"]) {
    const r = runWith(v);
    assert.equal(r.status, 1, v);
    assert.match(r.stderr, /needs Node 22\.18 or newer/, v);
    assert.equal(r.stdout, "", v);
  }
  for (const v of ["v22.18.0", "v22.20.1", "v24.1.0"]) {
    const r = runWith(v);
    assert.equal(r.status, 0, v);
    assert.equal(r.stdout, "ran\n", v);
  }
});

/** Flags and command words in a command listing. */
function vocabulary(text: string): { flags: Set<string>; commands: Set<string> } {
  const flags = new Set(text.match(/--[a-z][a-z-]*/g));
  const commands = new Set<string>();
  for (const line of text.replaceAll("| pack-leader ", "| ").split("\n")) {
    // The command and subcommand after `pack-leader`, and each `| word` alternative (show, list, resend, ...).
    for (const m of line.matchAll(/(?:pack-leader|\|)\s+([a-z][a-z-]*)(?:\s+([a-z][a-z-]*)\b(?!-))?/g)) {
      commands.add(m[1]!);
      if (m[2]) commands.add(m[2]);
    }
  }
  return { flags, commands };
}

test("the guide's Commands block lists exactly the commands and flags of `pack-leader help`", async () => {
  const help = await new Promise<string>((resolve, reject) =>
    execFile(process.execPath, [join(root, "src", "cli.ts"), "help"], { env: { ...process.env, HERDR_PLUGIN_STATE_DIR: join(dir, "state") } }, (err, stdout) => (err ? reject(err) : resolve(stdout))),
  );
  // Only the command column of help: drop the descriptions after a wide gap, and the notes on lines of their own.
  const helpCommands = help
    .split("\n")
    .filter((l) => /^\s*pack-leader /.test(l) || /^\s{10,}\[/.test(l))
    .map((l) => l.replace(/(\S)\s{3,}.*$/, "$1"))
    .join("\n");
  const block = /## Commands\n\n```text\n([\s\S]*?)```/.exec(guide())?.[1];
  assert.ok(block, "the guide has a Commands block");
  const g = vocabulary(block!);
  const h = vocabulary(helpCommands);
  assert.deepEqual([...g.flags].sort(), [...h.flags].sort(), "flags");
  assert.deepEqual([...g.commands].sort(), [...h.commands].sort(), "commands");
});

test("the guide documents strict command flags, missing-value errors, and native passthrough", () => {
  assert.match(guide(), /unknown options fail with a spelling suggestion/);
  assert.match(guide(), /including `--keep` and `--timeout`/);
  assert.match(guide(), /List-valued options may be repeated or comma-separated/);
  assert.match(guide(), /`--` separator ends Pack Leader flag parsing/);
});
