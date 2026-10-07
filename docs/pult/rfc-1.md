# RFC 1: Pult in the editor

Draft of 2026-10-07, written by the designer from a conversation with Anton. Anton's to take over.

## What changed since RFC 0

RFC 0 ends with the client as a copy of T3 Code's web client, and most of its UI ideas are variations of citations: on agent messages, on files, on diffs. The conversation behind this RFC asked whether Pult should instead be a fork of VS Code, since the ideas revolve around file editing, file citations and diff viewing.

Three findings settled it:

- T3 Code's server already speaks what remote editing needs: read, write, list, search by name and by content, plus diff, VCS and terminal RPCs. Nothing in the client uses them as an editor.
- VS Code's extension API covers the ideas without a fork: a virtual filesystem on a custom scheme, the diff editor, comments anchored to ranges, decorations, an Activity Bar container, the tabs API. Two VS Code extensions already act as T3 Code clients (busFred's `t3-vscode`, patroza's build), both young. Neither is a fork, and neither edits remote files through T3's RPCs.
- The one project that forks both T3 Code and Code - OSS, Tabs IDE, shows that a fork's cost lands in hosting the workbench, not in patching it, and its chat and editor are barely connected even so.

## Direction

1. **A Pult VS Code extension**, against stock T3 Code servers, no fork or plugin required. It attaches to an environment with Pult's existing attach flow, one window per environment. It exposes the environment's projects as a virtual workspace on the `pult:` scheme, adds an Activity Bar entry with a thread picker, opens individual threads as tabs, and renders thread content, thread cards and the message box with the vendored T3 Code client components. Open: what exactly `pult:` exposes.
2. **Deeper integration.** Cited files open in tabs on click, comments on any file feed the conversation builder as citations, agentic citations appear as comments, a bottom-panel prompt builder. Open: how a tab is linked to the thread it feeds, from the UI side.
3. **Reconsider the plugin.** Which uses of T3 Code Extensible plugins survive on their own merit now that the Bach comparison is deferred, and which server RPCs the extension wished it had, the filesystem first.
4. **If the idea proves out, an own shell.** VS Code is centred on editing, with threads also there; Pult is centred on threads, with editing a convenience. Start from VS Code's workbench, and go down to its editor layer and services only when a specific need demands it. Own the shell and never merge it; merge the editor and never alter it. Open: fork or vendor; extensions, even in a limited form; how much resemblance to VS Code to keep.
5. **Fork or not, a full product.** Ship with a server, by vendoring t3code or t3code-extensible and launching a local one. Open first: whom Pult is for.

Web stays open while it costs nothing: the extension is a web extension, so it runs in VS Code's web build too. The day a concrete UX needs Node, web goes.

## The proof

The extension is Anton's daily driver for all development. Steps 4 and 5 wait until that has answered whether threads as tabs beat the current client, and whether inline citations change how agent work is reviewed.

## What stays

The web client `apps/pult`, the desktop shell, the payload slot and the no-local-server ruling stay as they are. The Bach comparison of RFC 0 is deferred.
