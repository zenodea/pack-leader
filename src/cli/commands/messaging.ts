import { str, has, num, list, type Args } from "../args.ts";
import { requestShow } from "../../core/requests.ts";
import { ack, ask, check, checkTypes, done, envMs, escalate, heartbeat, inbox, note, reply, say, sendTo, workerContext, workerSend } from "../../messaging/inbox.ts";
import { activeRuns, load, runMessages, type Message } from "../../core/state.ts";
import { handoffGate, resumeAfterHandoff, saveHandoff, spawnResume } from "../../agents/handoff.ts";
import { out, currentRun, coordinatesSubRun, reportPath } from "../shared.ts";

const contextFrom = (args: Args) => workerContext({ task: str(args, "task"), dispatch: str(args, "dispatch"), worker: str(args, "worker"), run: str(args, "run") });

function askReply(askId: string, r: Message, options?: string[]) {
  return { result: "reply", ask_id: askId, ...(options ? { options } : {}), reply: r.body, answer: r.answer ?? r.body, option_index: r.option_index ?? null };
}

export async function handleMessaging(command: string, args: Args, fromAction: boolean): Promise<void> {
  switch (command) {
    case "check": {
      const run = currentRun(args);
      const types = has(args, "types") ? checkTypes(list(args, "types")) : undefined;
      let acked: Record<string, unknown> = {};
      if (has(args, "ack")) {
        const ids = list(args, "ack");
        if (!ids.length) throw new Error("--ack takes message ids: --ack m1,m2");
        const known = new Set(runMessages(load(), run.id).map((m) => m.id));
        const unknown = ids.filter((id) => !known.has(id));
        const n = await ack(run, ids);
        if (!n && !has(args, "wait")) acked = { acked: 0, ack_warning: "nothing to ack with those ids" };
        if (unknown.length) acked = { ...acked, acked: n, ack_unknown: unknown, ack_warning: `no message ${unknown.join(", ")} in run ${run.id}` };
      }
      let timeoutMs = num(args, "timeout", 540_000);
      let raised: Record<string, unknown> = {};
      const floor = envMs("PACK_MIN_WAIT_MS", 300_000);
      if (has(args, "wait") && floor > 0 && timeoutMs < floor) {
        raised = { timeout_raised_from_ms: timeoutMs, timeout_ms: floor, hint: `a wait shorter than ${Math.round(floor / 60_000)} min was raised to it: check --wait returns as soon as a message arrives, so a short timeout only costs you another call` };
        timeoutMs = floor;
      }
      const handoff = has(args, "wait") ? await handoffGate(run) : null;
      if (handoff) {
        out({ ...acked, ...handoff });
        return;
      }
      if (has(args, "all")) {
        if (has(args, "wait")) throw new Error("--all is a read-only listing; it does not take --wait");
        const limit = num(args, "limit", 50);
        const mine = runMessages(load(), run.id).filter((m) => m.to === "orchestrator" && (!types || types.includes(m.type)));
        out({ ...acked, result: "all", messages: mine.slice(-limit), total: mine.length });
        return;
      }
      const r = await check(run, { wait: has(args, "wait"), timeoutMs, types });
      out({ ...acked, ...r, ...raised });
      return;
    }

    case "handoff": {
      const run = currentRun(args);
      if (args.positional[0] === "resume") {
        out({ run: run.id, handoff: await resumeAfterHandoff(run.id) });
        return;
      }
      const body = str(args, "body") ?? args.positional.join(" ");
      if (!body.trim()) throw new Error('usage: pack-leader handoff --body "<note for the session that replaces you>"');
      const saved = await saveHandoff(run, body);
      spawnResume(run.id);
      out({ handoff: "pending", ...saved, next: "End your turn now with one line saying you are handing off. Pack Leader clears this session once you are idle and resumes the run in a fresh one." });
      return;
    }

    case "reply": {
      const freeWord = str(args, "free");
      const positional = freeWord === undefined ? args.positional : [...args.positional, freeWord];
      const [askId] = positional;
      const body = str(args, "body") ?? positional[1];
      if (!askId || !body) throw new Error("usage: pack-leader reply ASK_ID --body \"answer\" [--free]");
      out({ reply: await reply(currentRun(args), askId, body, { free: has(args, "free") }) });
      return;
    }

    case "send": {
      if (!process.env.PACK_WORKER) {
        const workerOnlyFlags = ["worker", "task", "dispatch"].filter((flag) => has(args, flag));
        if (workerOnlyFlags.length) throw new Error(`${workerOnlyFlags.map((flag) => `--${flag}`).join(", ")} require worker mode (PACK_WORKER)`);
      }
      const [name, ...words] = args.positional;
      const body = str(args, "body") ?? words.join(" ");
      if (!name || !body) throw new Error("usage: pack-leader send NAME|@all|@idle|@KIND \"text\" [--now]");
      const sub = process.env.PACK_WORKER ? activeRuns(load()).find((r) => coordinatesSubRun(r)) : undefined;
      if (sub && (name.startsWith("@") || load().workers[name]?.run_id === sub.id)) out(await sendTo(sub, name, body, has(args, "now")));
      else if (process.env.PACK_WORKER) {
        const ctx = contextFrom(args);
        out(await workerSend(ctx, name, body, has(args, "now")));
      } else out(await sendTo(currentRun(args), name, body, has(args, "now")));
      return;
    }

    case "say": {
      const run = currentRun(args);
      const body = args.positional.join(" ") || str(args, "body");
      if (!body) throw new Error("usage: pack-leader say \"<what the orchestrator should hear>\"");
      const m = await say(run, body);
      out({ sent: m.id, run: run.id, to: "orchestrator", body, next: "The orchestrator reads it on its next `pack-leader check`." });
      return;
    }

    case "done": {
      const ctx = contextFrom(args);
      const outcome = str(args, "outcome");
      const summary = str(args, "summary");
      if ((outcome !== "succeeded" && outcome !== "failed") || !summary) throw new Error("usage: pack-leader done --outcome succeeded|failed --summary \"...\" [--files-modified a,b] [--report-path P]");
      const m = await done(ctx, { outcome, summary, files: list(args, "files-modified"), reportPath: reportPath(str(args, "report-path"), process.env.PACK_REMOTE_CALLBACK_CWD ?? process.cwd()) });
      out({ reported: m.id, task_id: m.task_id, outcome, next: "End your turn and wait for the orchestrator." });
      return;
    }

    case "ask": {
      const ctx = contextFrom(args);
      const r = await ask(ctx, { body: args.positional.join(" ") || str(args, "body"), options: list(args, "options"), resumeId: str(args, "id"), timeoutMs: num(args, "timeout", 600_000) });
      if (r.result === "timeout") out({ ...r, next: `No answer yet. Run \`pack-leader ask --id ${r.ask_id}\` to keep waiting.` });
      else out(askReply(r.ask_id, r.reply!, r.options));
      return;
    }

    case "heartbeat": {
      const ctx = contextFrom(args);
      const m = await heartbeat(ctx, args.positional.join(" ") || str(args, "body") || "working", str(args, "phase"));
      out({ heartbeat: m.id });
      return;
    }

    case "note": {
      const ctx = contextFrom(args);
      const body = args.positional.join(" ") || str(args, "body");
      if (!body) throw new Error("usage: pack-leader note \"<blocker, finding, or why this takes longer>\"");
      const m = await note(ctx, body);
      out({ note: m.id, next: "Keep working; the orchestrator sees it in `pack-leader check`." });
      return;
    }

    case "escalate": {
      const ctx = contextFrom(args);
      const body = args.positional.join(" ") || str(args, "body");
      if (!body) throw new Error("usage: pack-leader escalate \"<what the orchestrator must act on>\"");
      const m = await escalate(ctx, body);
      out({ escalation: m.id, next: "Keep working unless you cannot; the orchestrator must act on it and may send you a follow-up. Use `pack-leader ask` if you need an answer before you go on." });
      return;
    }

    case "inbox": {
      const ctx = contextFrom(args);
      const msgs = await inbox(ctx);
      out({
        messages: msgs.map((m) => ({
          id: m.id,
          ts: m.ts,
          from: m.from,
          body: m.body,
          ...(m.type === "reply" ? { reply_to: m.reply_to, ...(m.answer !== undefined ? { answer: m.answer, option_index: m.option_index ?? null } : {}) } : {}),
        })),
      });
      return;
    }

    case "request": {
      const [sub = "show", id] = args.positional;
      if (sub !== "show" || !id) throw new Error("usage: pack-leader request show ID");
      out(requestShow(id));
      return;
    }
  }
}
