// The skill: a stub that agents discover, and the full guide the binary prints
// so the two never drift apart (the stub only says "run `pack-leader skill`").
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { skillDirs, guideFile, localBin, skillStubFile, packLeaderBin } from "./paths.ts";

export function guide(): string {
  return readFileSync(guideFile, "utf8");
}

export type InstallReport = { skills: string[]; bin: string | null; note: string[] };

/** Installs the skill stub into each harness that is set up here and puts `pack-leader` on PATH via ~/.local/bin. */
export function installSkill(): InstallReport {
  const note: string[] = [];
  const stub = readFileSync(skillStubFile, "utf8");
  const skills: string[] = [];
  for (const [harness, dir] of Object.entries(skillDirs)) {
    if (!existsSync(dirname(dirname(dir)))) continue;
    mkdirSync(dir, { recursive: true });
    const stubPath = join(dir, "SKILL.md");
    writeFileSync(stubPath, stub);
    skills.push(stubPath);
    void harness;
  }
  if (!skills.length) note.push("no harness directory found (~/.claude, ~/.codex, ~/.pi/agent)");

  let bin: string | null = null;
  try {
    mkdirSync(localBin, { recursive: true });
    const link = join(localBin, "pack-leader");
    if (existsSync(link) || isLink(link)) {
      if (isLink(link) && readlinkSync(link) === packLeaderBin) bin = link;
      else if (isLink(link)) {
        unlinkSync(link);
        symlinkSync(packLeaderBin, link);
        bin = link;
      } else note.push(`${link} exists and is not a symlink; left alone`);
    } else {
      symlinkSync(packLeaderBin, link);
      bin = link;
    }
  } catch (err) {
    note.push(`could not link pack-leader into ${localBin}: ${(err as Error).message}`);
  }
  if (bin && !(process.env.PATH ?? "").split(":").includes(localBin)) note.push(`${localBin} is not on PATH in this shell`);
  return { skills, bin, note };
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
