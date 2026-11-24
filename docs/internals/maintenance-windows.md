# Maintenance windows

[`ServerActivity`](../../apps/server/src/serverActivity.ts) (`server.getActivity`) says when a
restart would cut no work anyone waits on: on a thread not deleted, no run active or queued to
start, no native subagent working, no request a run waits on, and no background work that holds
completion; and no scheduled task dispatching. Background work is a task on any of the thread's
provider rosters that `backgroundWorkHoldsCompletion` says holds completion: a background subagent
or task, or a shell or monitor the agent marked awaited. That is not settlement's count, which reads
only the active provider thread's roster and adds running turn items and pull-request watches;
neither counts here, and a watch would hold the server busy for days. Held queues and unmarked
shells and monitors do not count either: recovery holds those queues anyway, and most unmarked
shells are dev servers and their watchdogs nobody waits on, so counting them would keep the server
busy forever. Nor do deleted threads, whose rosters and native subagents deletion leaves behind and
recovery skips, or queued runs on archived threads, which nothing starts and recovery skips too.
Archiving detaches the thread's sessions but leaves its other work to end on its own, and a message
can still start a run there, so that work counts. `restingSince` lives in memory and starts again
at boot; work that starts and ends between two reads still restarts it. A failed read or watch
reads busy, and a stopped watch resyncs with backoff. A server busy for three hours logs
`server-activity.busy` with a thread and kind of work holding it, again only when the holder
changes, so a holder that never ends is visible.

A desktop app's server installs the app's updates itself, through the Pult plugin
([`installAtRest`](../../plugins/pult/src/installAtRest/installAtRest.ts)), when
`T3CODE_DESKTOP_INSTALL_UPDATES_AT_REST=true`, which the desktop sets
for its supervised server under a brand that asks (`serverInstallUpdatesAtRest`). Every 30 minutes,
once the server has rested 3 minutes and the desktop's power telemetry has seen no input on the
host for 3, it runs the ordinary desktop update and commits it; missing or stale telemetry counts
as input. The download can take minutes, so both are checked again before the commit, the host on
a sample the server asks the desktop for then (the periodic one can be two minutes old once the host
idles); no sample within ten seconds counts as input. A prepared update left uncommitted expires on
the desktop and stays downloaded for the next tick. A download whose last install failed
(`installFailedVersion`) is left to the user: each attempt restarts the server, and the worker's
memory does not survive that. A gap remains after the re-check: the commit can wait up to 90 seconds
for a feed check to finish before it stops the backends, and work started in it is cut and
continued by restart continuation like any other.
