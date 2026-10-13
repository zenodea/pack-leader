// The skill: a stub that agents discover, and the full guide the binary prints
// so the two never drift apart (the stub only says "run `pack-leader skill`").
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeSkillDir, guideFile, localBin, skillStubFile, packLeaderBin } from "./paths.ts";

export function guide(): string {
  return readFileSync(guideFile, "utf8");
}

export type InstallReport = { skill: string; bin: string | null; note: string[] };

/** Installs the Claude Code skill stub and puts `pack-leader` on PATH via ~/.local/bin. */
export function installSkill(): InstallReport {
  const note: string[] = [];
  mkdirSync(claudeSkillDir, { recursive: true });
  const stubPath = join(claudeSkillDir, "SKILL.md");
  writeFileSync(stubPath, readFileSync(skillStubFile, "utf8"));

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
  return { skill: stubPath, bin, note };
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
