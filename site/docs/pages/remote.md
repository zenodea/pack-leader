# Remote crewmates

On herdr, a crewmate can run on another machine over SSH, while the run's state stays with the leader on yours.

## What both machines need

- Lodestar on both, with Zig to build it, and herdr on both.
- An existing herdr workspace and working directory on the remote machine.
- Non-interactive SSH **in both directions**, with trusted host keys. The leader starts crewmates over SSH; crewmates call back over SSH with reports and questions.

## Adding a host

```sh
lodestar host add buildbox --ssh-target buildbox --workspace-id w1 \
  --leader-ssh-target laptop
```

- `--ssh-target`: how the leader reaches the remote machine (an SSH alias or `user@host`).
- `--workspace-id`: the herdr workspace to start crewmates in.
- `--leader-ssh-target`: how the remote machine reaches back to the leader.
- `--herdr-socket`, `--lodestar` and `--leader-lodestar`: custom socket and binary paths, if yours aren't the defaults.

Host profiles hold no credentials; those stay in your OpenSSH setup. Manage them with `host list`, `host show NAME` and `host remove NAME`. Crewmates already running keep the settings they started with.

## Starting a remote crewmate

```sh
lodestar crew start remote-tests --host buildbox --cwd /srv/project \
  --spec "Run the test suite and report failures; don't modify files."
```

Everything else works the same as a local crewmate: messages, `crewmate read` (the Navigator can read remote crewmates too), release.

## Limits

- Remote crewmates use an existing directory and a tab. No remote worktrees, setup commands or adoption yet.
- If the connection drops, the host is marked unreachable and its crewmates and tasks are kept, not failed. Use `crewmate abandon` if you need to stop supervising one.
- SSH access is a trust boundary: a remote crewmate can do what that SSH user can.
- Delivery receipts over SSH are best effort, not exactly-once.
- Remote support is tested against a fake SSH transport; a live end-to-end SSH setup hasn't been verified yet.
