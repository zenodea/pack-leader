# Bind queued messages to dispatches

Queued followups and replies are now deliverable only to the worker incarnation and task/dispatch pair they target. Inbox consumption, sync selection, delivery claims, and delivery finalization all enforce the pair, so a queued message from a settled dispatch stays unacknowledged rather than being consumed by a redispatched successor. Finalization also requires ownership of the original delivery claim before returning success.

Legacy messages with null task and dispatch IDs remain available to unassigned workers, preserving the historical unbound inbox fixtures/runtime case. They are not guessed onto a task-bound worker; messages with dispatch IDs require an exact current pair. Replied historical asks remain retrievable through their original ask context without refreshing the successor. Releasing a worker still acknowledges all undelivered messages from that worker incarnation, including messages from superseded dispatches.
