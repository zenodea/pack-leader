import { str, type Args } from "../args.ts";
import { addHost, getHost, listHosts, removeHost } from "../../herdr/hosts.ts";
import { out } from "../shared.ts";

export async function handleHost(command: string, args: Args, fromAction: boolean): Promise<void> {
  switch (command) {
    case "host": {
      const [sub = "list", name] = args.positional;
      if (sub === "add") {
        if (!name) throw new Error("usage: pack-leader host add NAME --ssh-target ALIAS_OR_USER@HOST --workspace-id ID --leader-ssh-target TARGET");
        const sshTarget = str(args, "ssh-target");
        const workspaceId = str(args, "workspace-id");
        const leaderTarget = str(args, "leader-ssh-target");
        if (!sshTarget || !workspaceId || !leaderTarget) throw new Error("host add requires --ssh-target, --workspace-id and --leader-ssh-target");
        const host = await addHost({
          name,
          ssh_target: sshTarget,
          workspace_id: workspaceId,
          leader_ssh_target: leaderTarget,
          ...(str(args, "herdr-socket") ? { herdr_socket: str(args, "herdr-socket") } : {}),
          ...(str(args, "pack-leader") ? { pack_leader: str(args, "pack-leader") } : {}),
          ...(str(args, "leader-pack-leader") ? { leader_pack_leader: str(args, "leader-pack-leader") } : {}),
        });
        out({ host });
        return;
      }
      if (sub === "list") {
        out({ hosts: listHosts() });
        return;
      }
      if (sub === "show") {
        if (!name) throw new Error("usage: pack-leader host show NAME");
        out({ host: getHost(name) });
        return;
      }
      if (sub === "remove") {
        if (!name) throw new Error("usage: pack-leader host remove NAME");
        await removeHost(name);
        out({ removed: name });
        return;
      }
      throw new Error(`unknown: pack-leader host ${sub}`);
    }
  }
}
