---
posture: human-written
---

# New Vision for Pult

This RFC presents an overview of what problems Bach is aiming to solve, specific ways Bach solves them, and problems with adopted solutions. It then proposes alternative ways to solve these problems, and integrates them all into a single coherent vision for Pult as an alternative to Bach.

## What is Bach's value?

Bach was built having several core features in mind:
* Agent-driven orchestration. Allow agents to manage other agents, and collaborate with them. This also includes cross-provider orchestration (e.g. Claude managing GPT).
* Observability. A way to quickly answer questions about what the fleet is doing and what's on my plate.
* Enhanced agent awareness. Enforce agents receiving updates about current time, usage limits, and their context window.
* Powerful prompt builder. Allow building prompts by easily referencing relevant context: conversation part, local file, review comment, etc.
* Ease of iteration. Deploying changes doesn't require an elaborate procedure or a fleet pause.
* Avoid vendor lock. Works equally well with Anthropic, OpenAI, and other harnesses. The choice is model quality and price of inference, not price of migration.

## Bach overview

This section provides an overview of Bach core features, each carrying what values they support, motivation, problems, and alternatives.

### Extensibility story

Support: ease of iteration.

**What have we built?**
We've built extensibility support in our own fork of T3 Code, and Bach is an extension on top of it, not a separate application.

**Why did we build it?**
The main problem this architecture solves is ease of iteration. The original Bach was just a standalone fork of T3 Code, and any change to it required a full build->quit->install->relaunch cycle. That cycle is long, has several manual steps, and requires a full fleet shutdown. Extension deploy, on the other hand, is a one-click action.
Additional benefits:
* Maintaining the fork is maintaining a single extensibility story, not a bunch of disjointed changes.
* An "improve Bach" feature is straightforward.

**What are some problems with this solution?**
Extensions can only affect what the host seam exposes. This means awkward, non-native UI, and occasional reinstall cycles when we need to expand the seam.

**What are alternative solutions?**
I can see several alternatives to what we've built:
* Work from the remote connection. This one is the most native T3 Code approach: we launch the server app under one account/machine, and we connect to it remotely from a different account/machine. T3 Code allows clients to be of a newer version than the server, so we can reinstall just the client app. This approach would still create somewhat more friction than the one-click extension deploy, but most of the steps can be done by agents. This also requires always connecting remotely from a separate account/machine.
* Support a separate client-bundle-only reinstall path.
* Build a fully separate client that connects to T3 Code.

All of these approaches only solve the UI part, and MCP customizations would still require either a server restart, or building a separate mechanism for the MCP changes deploy.

### Custom UI

Support: observability.

**What have we built?**
Bach ships with its own UI, available by clicking the Bach extension row on the left side panel.

**Why did we build it?**
Bach features are accessible to agents through an MCP, and to humans through a custom UI. Specifically we use custom UI for:
* Dashboard: what tasks are we working on, what agents are available, etc.
* Chat: view and send Bach messages.
* Observability: review Bach events, surface diagnostics.
* Settings: customize Bach in app.

**What are some problems with this solution?**
The main problem is that all our UI is shipped through a separate page, and it ends up competing with the native UI. The problem is exacerbated by the fact that extensions have no access to T3 Code native UI components, and therefore can only mimic them, usually imperfectly, so the look and feel is also different.

**What are alternative solutions?**
The main alternative is to ship a single UI that we fully own.

### Custom MCP

Support: agent-driven orchestration, avoid vendor lock, enhanced agent awareness, observability.

**What have we built?**
Bach exposes custom MCP tools for agents to interact with Bach features.

**Why did we build it?**
We use custom MCP tools primarily for:
* Agents/threads CRUD.
* Cross-agent messaging.
* Task CRUD.

### Agents/threads CRUD

Support: agent-driven orchestration, avoid vendor lock.

**What have we built?**
Bach supports tools to start new threads, list existing threads, and settle/archive old threads. At various times Bach supported this either directly (CRUD on threads), or indirectly (CRUD on durable agents, that use threads as a substrate).

**Why did we build it?**
To support agent-driven orchestration features.

### Durable agents

Support: agent-driven orchestration.

**What have we built?**
Bach recently shipped a conceptual shift: instead of thinking in threads, durable agents are the primary unit, and threads are their substrate: messages sent and tasks assigned to agents, and Bach routes them to the current thread.

**Why did we build it?**
Mainly to simplify management of lead agents: those are durable in nature, and outlive any individual task or effort.

**What are some problems with this solution?**
Durable agents do not make that much sense for builders, reviewers, and even designers, whose natural scope is much more limited to one task in hand. Also, context management between an agent's threads is not well solved in Bach at the moment.

**What are alternative solutions?**
We can implement something like durable agents through raw thread CRUD and custom instructions: document conventions in global AGENTS.md about how and when to spawn successors. Cross-agent messaging could be directed at roles or other slugs, rather than at specific thread or agent ids.

### System wakes

Support: agent-driven orchestration.

**What have we built?**
Bach sends "system wakes" to threads: a special turn that is initiated by Bach, and that asks agents to act with tools and not generate prose.

**Why did we build it?**
We built it so cross-agent messaging does not look like user turns, does not interrupt ongoing conversation with user, and so agent replies do not get lost within the thread.

**What are some problems with this solution?**
System wakes are still delivered as turns, and they rely on agents following instructions (like "act with tools and reply with ACK and nothing else"), which is flaky.

**What are alternative solutions?**
Perhaps we can mostly rely on long-lived "monitoring" and some sort of periodic polling, instead of system wakes.

### World state in inbox

Support: enhanced agent awareness.

**What have we built?**
We supply additional "world state" data with every inbox result: current time, per-provider usage limits, per-thread context window.

**Why did we build it?**
To let agents make better-informed decisions.

**What are some problems with this solution?**
The state arrives only if agents call `inbox`, and instructions invite a tool call for system wakes specifically, so it is not necessarily called during user initiated turns.

**What are alternative solutions?**
Provide a `start_turn` tool instead, with instructions in tool description (and possibly other places, if description is not enough) to call it at the beginning of every turn, not just system wakes.

### Complex task model

Support: powerful prompt builder, agent-driven orchestration, observability.

**What have we built?**
Bach ships a somewhat complex task model aimed at enforcing certain structure on the most common human or agentic task kinds.

**Why did we build it?**
Several reasons:
* The main reason is to provide a custom UI for certain frequent human tasks.
* Task tools and instructions also prime agents to structure their work in a certain way.
* It is a way for agents to report their status (what they are working on, what else is planned), and for humans to see it.

**What are some problems with this solution?**
We have to work on a much wider UI surface, lowering effective quality of each individual UI. Task model itself is complex and eats a fair chunk of every thread's context.

**What are alternative solutions?**
Turns out, most of what I actually want from UI is one or another variation of citations: citations on agent messages, citations on individual files, citations on task descriptions, and so on. Instead of providing a fully custom UI for each task kind, we can support just slightly better citation UX. For code reviews, we can parse the agent's citations: we prescribe a certain format for agents to generate for code explainers, and we parse it in conversation, embedding a special UI.

### Tools-based messaging

Support: agent-driven orchestration, avoid vendor lock, observability.

**What have we built?**
Bach exposes messaging tools agents can use to send messages to each other and to the user. These messages are then delivered to agents through system wakes and `inbox` tool, and to the user through custom UI.

**Why did we build it?**
Mainly for cross-track coordination between leads, but also so leads can orchestrate complex work using first-class threads, not just subagents, which helps to avoid vendor lock (orchestration workflows are no longer provider-specific). This also enables cross-provider orchestration.

**What are some problems with this solution?**
Messages are delivered through system wakes, which makes native threads messy and volatile (wakes delivered as turns, so the conversation moves suddenly, leaving "wake - ACK" noise in the user facing UI). Bach mitigates it by providing a separate chat surface that only shows Bach messages, not native thread content. But this exacerbates the "double UI" problem even more.

**What are alternative solutions?**
I can think of a few alternatives/mitigations:
* Deliver messages through long-lived monitoring and polling, as mentioned above.
* Filter out "wake - ACK" from the conversation surface, or collapse it under one section, like it is currently done for reasoning traces.

### Group chats

Support: agent-driven orchestration.

**What have we built?**
Bach allows sending messages to groups, on top of to individual agents or the user. These messages are then delivered to all participating agents.

**Why did we build it?**
Mainly to smooth out cross-lead coordination, and improve incidental discovery.

**What are some problems with this solution?**
Group chats rely heavily on other deep features, like durable agents, tools-based messaging, and a custom chat surface.

**What are alternative solutions?**
I can think of several alternatives:
* Instead of full group chats, with memberships, mentions, and delivery rules, we can support role-based or topic-based message targets: agents assume role or subscribe to topic, then send messages to roles or topics.
* We can give agents good old unstructured message boards, delivered in full with every inbox.

## Pult Vision Proposal

As shown above, Bach delivers its value through a set of deep features, adding another thick level of abstraction over native harnesses. This works (kind of), but has serious limitations. I now think that this might be an over-engineered approach. Perhaps most or all of the value might be delivered through UI improvements, and a limited tooling.

Originally Pult was conceived as Bach extension, delivered as a standalone app. Under the new vision, Pult starts as a fork of T3 Code: its own client, plus the smallest server changes that client needs. Not all of my ideas can be delivered through client changes alone, but I believe the server changes can be minimal, and offered upstream one at a time. Once and if upstream has them all, the fork ends, and Pult becomes a third-party client for T3 Code.

Pult's client is a copy of the T3 Code client in its own folder, and we do not merge upstream client changes into it. This has two costs. The client still depends on shared packages that upstream keeps changing, so protocol drift surfaces as type errors at each upstream merge. And whatever upstream adds to its own client reaches Pult only if we port it by hand.

### MVP

We can start Pult as a fresh T3 Code fork that adds three features:
* Deploy client changes independently of server changes.
* Deploy one dynamic server part independently of server changes. The paradigm is "minimal seam, maximum capabilities": perhaps just a process with access to host effects, exposing MCP and HTTP API from the server.
* Pult branding (name, identity, icons).

MVP is essentially T3 Code plus ease of iteration, under own branding.

A fresh fork, rather than t3code-extensible, for two reasons. First, Bach relies on t3code-extensible today, so this is the simplest way to avoid conflicts either way. Second, Pult's requirements for extensibility are different: not a generic extensions support, but a limited "server loads one dynamic part" situation.

### Rest of Bach value, and beyond

Once we have an MVP, we can gradually re-build Bach's orchestration capability and rest of its value, incorporating lessons learned from it, leaning heavily into native UI features, and under one constraint: whatever the host can do deterministically, we do not ask agents to do.
* Threads and projects CRUD.
* Message sending to topics, and topic subscriptions.
* Use system prompt append (on supported providers) to add pult-specific context instructions and user-defined context files.
* System wake filtering/pretty-printing.
* Parsing agentic citations.
* Native integration with xaxis, and generic issue trackers. Probably tightly coupled with agentic citations (agents can cite issues, and Pult loads context through API).
* Basic generic tasks: a title, a status, and whose move it is.
* Ejectable client head (ejecting client to source code, and tweaking it in place).
* User defined server extensions.
* Gradually, simplifying and tightening T3 Code UI, and adopting a more and more distinct visual identity.

## What happens to Bach and t3code-extensible fork?

Work on Bach continues in parallel, for now. Today, the experiment is incomplete: Bach has its model (more or less), but I can't really use it through the current UI, which is noisy and counter-intuitive. So I can't confidently answer the question of whether Bach's model (another abstraction layer over harnesses) is viable. The test is feel and ease of use, among other things, and it can't be done with the current UI. I'd like to finish all my UI ideas first.

Eventually, I'd like to try Bach and Pult side-by-side. The comparison starts once Pult has enough orchestration to do real work with: threads CRUD, message sending to topics, and system wake filtering. Whichever is more convenient to use in practice wins. Until then, there are two forks to keep merged with upstream.

If Pult wins, t3code-extensible is retired: the Pult fork already carries the server changes Pult needs, and is the vehicle for offering them upstream. If Bach wins, we might also consider offering parts of Bach extensibility story upstream.
