// Checks which turns of a teammate exchange notify the user. Runs the real agent service on a
// temporary profile with a fake Codex app-server, and sends each agent event to the real desktop
// notification forwarder (with an Electron `Notification` that records what it shows) and to the real
// phone notification service (with a send that records what it sends). The message of a turn names
// what the fake does in `<<PLAN[...]PLAN>>`: one element for each turn of that thread, with its answer,
// its OpenBot tool calls, a question or approval to ask, and a gate that holds the turn until the check
// opens it.
// Checks:
//   1. A coordinator asks six teammates for a report. The teammates' turns and their results to the
//      coordinator do not notify; the coordinator's answer with the results notifies once.
//   2. A message from the user to a teammate notifies.
//   3. A question and an approval in a teammate's turn for the coordinator notify.
//   4. A routine run that asks a teammate notifies, and so does the coordinator's answer with the
//      result; the teammate's turn does not.
// No provider, account or network is used. `bun run test:teammate-turn-notifications`.
// Writes .openbot-build/teammate-turn-notifications-e2e/report.json.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS, type AgentEvent, LOCAL_SERVER_ID } from "@openbot/contracts/ipc";
import { createFormat, translateFor } from "@openbot/i18n";
import { encodeLiveActivityBytes } from "@openbot/team-client/live-activity-seal";
import { pushNotificationKeys } from "@openbot/team-client/push-notification-seal";
import { plugin } from "bun";
import { Effect } from "effect";
import { openSealedLiveActivity } from "../apps/mobile/src/features/live-activity/model/live-activity-open";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";

const OUT = resolve(import.meta.dirname, "../.openbot-build/teammate-turn-notifications-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-teammate-turn-notifications-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const fakeCodex = join(root, "codex");
const english = translateFor("en");

/** The notifications that the desktop forwarder showed, in order. */
const shown: { title: string; body: string }[] = [];

// The main process imports Electron. No check opens a window or a real notification.
plugin({
  name: "teammate-turn-notifications-electron-boundary",
  setup(build) {
    class Inert {}
    class RecordingNotification {
      readonly #record: { title: string; body: string };
      constructor(options: { title: string; body: string }) {
        this.#record = { title: options.title, body: options.body };
      }
      static isSupported() {
        return true;
      }
      on() {
        return this;
      }
      show() {
        shown.push(this.#record);
      }
      close() {}
    }
    build.module("electron", () => ({
      loader: "object",
      exports: {
        app: { getPath: () => tmpdir(), getVersion: () => "0.0.0-e2e", isPackaged: false, on: () => undefined },
        // The window is open and not focused: the user is away, so a notification is due.
        BrowserWindow: class UnfocusedWindow {
          static getAllWindows() {
            return [];
          }
          readonly webContents = {
            isDestroyed: () => false,
            isLoadingMainFrame: () => false,
            mainFrame: { isDestroyed: () => false, detached: false },
            send: () => undefined,
          };
          isDestroyed() {
            return false;
          }
          isFocused() {
            return false;
          }
        },
        MessageChannelMain: class extends Inert {},
        Notification: RecordingNotification,
        clipboard: {},
        desktopCapturer: {},
        dialog: {},
        ipcMain: { handle: () => undefined, removeHandler: () => undefined, on: () => undefined },
        nativeImage: {},
        net: {},
        powerMonitor: { on: () => undefined },
        safeStorage: { isEncryptionAvailable: () => false },
        screen: { getAllDisplays: () => [] },
        session: {},
        shell: { openExternal: async () => undefined },
        systemPreferences: {},
        webContents: { getAllWebContents: () => [] },
      },
    }));
  },
});

// Before the service modules load: the Codex process and the stores read the home folder.
process.env.HOME = home;
process.env.CODEX_HOME = join(home, ".codex");
process.env.OPENBOT_CODEX_PATH = fakeCodex;
mkdirSync(home, { recursive: true });

const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { OpenBotDatabase } = await import("../src/backend/openbot-database");
const { RemoteServerManager } = await import("../src/main/remote-server-manager");
const { createRendererForwarders } = await import("../src/main/renderer-forwarders");
const { PushNotificationService } = await import("../src/main/push-notifications");
const { BrowserWindow } = await import("electron");

/** One turn of the fake: its answer, its OpenBot tool calls, a request to the user, and its gate. */
interface FakeTurn {
  answer?: string;
  calls?: { tool: "send_message"; arguments: { recipientAgentIds: string[]; text: string } }[];
  ask?: "prompt" | "approval";
  /** The turn ends only after the file of this name exists in the gate folder. */
  gate?: string;
}

const plan = (...turns: FakeTurn[]) => `<<PLAN${JSON.stringify(turns)}PLAN>>`;
const gates = join(root, "gates");
mkdirSync(gates, { recursive: true });
const openGate = (name: string) => writeFileSync(join(gates, name), "");

const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.160.1\\n");
  process.exit(0);
}
const GATES = ${JSON.stringify(gates)};
const config = { config: { mcp_servers: {} }, layers: [{ name: { type: "user", file: "/fake/.codex/config.toml", profile: null }, version: "1", config: { mcp_servers: {} } }] };
let buffer = "";
let threads = 0;
let turns = 0;
const waiting = new Map();
const scripts = new Map();
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const finish = (turn) => {
  if (turn.script.gate && !fs.existsSync(path.join(GATES, turn.script.gate))) return setTimeout(() => finish(turn), 20);
  const item = { type: "agentMessage", id: "message-" + turn.turnId, text: turn.script.answer || "Done.", phase: "final_answer" };
  write({ method: "item/completed", params: { threadId: turn.threadId, turnId: turn.turnId, item } });
  write({ method: "turn/completed", params: { threadId: turn.threadId, turn: { id: turn.turnId, status: "completed" } } });
};
const callNext = (turn) => {
  const id = "request-" + turn.turnId + "-" + turn.requests++;
  if (turn.ask) {
    const ask = turn.ask;
    turn.ask = null;
    waiting.set(id, turn);
    if (ask === "prompt")
      return write({ id, method: "item/tool/requestUserInput", params: { threadId: turn.threadId, turnId: turn.turnId, itemId: "ask-" + id, questions: [{ id: "q", header: "Choice", question: "Which server?", options: null }] } });
    return write({ id, method: "item/commandExecution/requestApproval", params: { threadId: turn.threadId, turnId: turn.turnId, itemId: "ask-" + id, command: "df -h", cwd: "/", reason: "Read the disk use." } });
  }
  const call = turn.calls.shift();
  if (!call) return finish(turn);
  waiting.set(id, turn);
  write({ id, method: "item/tool/call", params: { threadId: turn.threadId, turnId: turn.turnId, callId: "call-" + id, namespace: "openbot", tool: call.tool, arguments: call.arguments } });
};
const answer = (message) => {
  const params = message.params || {};
  switch (message.method) {
    case "initialize": return write({ id: message.id, result: {} });
    case "account/read": return write({ id: message.id, result: { account: { type: "chatgpt", email: "codex@example.com" } } });
    case "account/rateLimits/read": return write({ id: message.id, result: { rateLimits: { limitId: "codex", primary: null, secondary: null }, rateLimitsByLimitId: null } });
    case "model/list": return write({ id: message.id, result: { data: [{ model: "gpt-6-luna", displayName: "GPT-6 Luna" }] } });
    case "plugin/list": return write({ id: message.id, result: { marketplaces: [] } });
    case "config/read": return write({ id: message.id, result: config });
    case "config/batchWrite": return write({ id: message.id, result: {} });
    case "thread/start": return write({ id: message.id, result: { thread: { id: "thread-" + (++threads), turns: [] } } });
    case "thread/resume": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "thread/unsubscribe": return write({ id: message.id, result: { status: "Unsubscribed" } });
    case "thread/turns/list":
    case "thread/items/list": return write({ id: message.id, result: { data: [], nextCursor: null } });
    case "thread/read": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "turn/start": {
      const turnId = "turn-" + process.pid + "-" + (++turns);
      const text = (params.input || []).map((item) => item.text || "").join("\\n");
      write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      write({ method: "turn/started", params: { threadId: params.threadId, turn: { id: turnId } } });
      const named = /<<PLAN([\\s\\S]*)PLAN>>/.exec(text.split("--- current message ---").at(-1));
      if (named) scripts.set(params.threadId, JSON.parse(named[1]));
      const script = (named ? scripts.get(params.threadId).shift() : null) || {};
      return callNext({ threadId: params.threadId, turnId, script, ask: script.ask || null, calls: [...(script.calls || [])], requests: 0 });
    }
    case "turn/interrupt": {
      write({ id: message.id, result: {} });
      return write({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: params.turnId, status: "interrupted" } } });
    }
    default:
      return write({ id: message.id, error: { code: -32601, message: "Method not found: " + message.method } });
  }
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line) {
      const message = JSON.parse(line);
      if (message.method && message.id !== undefined) answer(message);
      else if (!message.method && waiting.has(message.id)) {
        const turn = waiting.get(message.id);
        waiting.delete(message.id);
        callNext(turn);
      }
    }
    newline = buffer.indexOf("\\n");
  }
});
`;

const report: {
  checks: { name: string; passed: boolean; detail?: unknown }[];
  passed: boolean;
  checkedAt?: string;
  error?: string;
} = { checks: [], passed: false };

const unused = () => Effect.die(new Error("Not used by this check."));
const browser: AgentBrowserHost = {
  listTabs: () => [],
  beginTakeover: unused,
  endTakeover: () => {},
  resolveUploadTarget: unused,
  handleDynamicTool: unused,
  userControlTabFor: () => null,
  awaitUserControlRelease: unused,
  onChanged: () => () => {},
  onControlChanged: () => () => {},
  onDocumentChanged: () => () => {},
  clearControls: () => {},
  endControl: () => {},
  close: () => Effect.void,
  clearAgentSession: () => Effect.void,
};

/** Waits for a state of the service. */
async function waitFor<T>(label: string, read: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

async function check(name: string, run: () => Promise<unknown>) {
  process.stdout.write(`- ${name}\n`);
  const detail = await run();
  report.checks.push({ name, passed: true, detail });
}

await writeFile(fakeCodex, FAKE_CODEX, { mode: 0o755 });

const database = new OpenBotDatabase(userData);
const store = new AgentStore(userData, home, database);
const mailbox = new MailboxStore(userData, store.sharedRoot, store.database);
const service = new AgentService({
  store,
  mailbox,
  browser,
  preferredProvider: "codex",
  offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
});
const manager = new RemoteServerManager(
  join(userData, "remote-servers.json"),
  { encrypt: (value: string) => Buffer.from(value, "utf8"), decrypt: (value: Buffer) => value.toString("utf8") },
  { createTeamAuthTicket: unused, getEmail: () => "e2e@example.invalid" },
  { appVersion: "0.0.0-e2e" },
);
const events: AgentEvent[] = [];
/** The agent events that the phone service reads, as the host's agent service sends them. */
const hostEvents = new EventEmitter<{ event: [AgentEvent] }>();
const phoneSecret = crypto.getRandomValues(new Uint8Array(32));
const phoneKeys = pushNotificationKeys(phoneSecret);
/** The notifications that the phone got, opened as the app opens them, in order. */
const phoneShown: { title: string; body: string }[] = [];
const phoneWaiters: (() => void)[] = [];
const phone = new PushNotificationService({
  agents: {
    on: (_name, listener) => hostEvents.on("event", listener),
    off: (_name, listener) => hostEvents.off("event", listener),
    listAgents: () => service.listAgents(),
    readConversationPageFor: unused,
    getRuntimeSnapshot: () => {
      throw new Error("Not used by this check.");
    },
    listConversationReads: () => {
      throw new Error("Not used by this check.");
    },
  },
  store: { list: () => [], replace: () => Effect.void },
  send: (request) =>
    Effect.sync(() => {
      const text = openSealedLiveActivity(
        request.push.sealed,
        encodeLiveActivityBytes(phoneKeys.seal),
        encodeLiveActivityBytes(phoneKeys.tag),
      );
      assert.ok(text, "The phone cannot open the send.");
      const { title, body } = JSON.parse(text);
      phoneShown.push({ title, body });
      for (const resolve of phoneWaiters.splice(0)) resolve();
      return "sent" as const;
    }),
  hiddenAgentIds: () => new Set(),
  memberActive: () => true,
  lastUseElsewhere: () => null,
  // The phone is checked on its own, so the desktop does not take its events.
  atHostComputer: () => false,
  memberLevels: () => ({ server: null, agents: new Map() }),
  liveActivityShows: () => false,
  randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
});
const forwarders = createRendererForwarders({
  getMainWindow: () => mainWindow,
  getChatWindows: () => [],
  getAgentService: () => service,
  getHostService: () => null,
  getHostAnalytics: () => null,
  getRemoteServerManager: () => manager,
  showMainWindow: () => undefined,
  getTranslate: () => english,
  getFormat: () => createFormat("en"),
  desktopNotificationsEnabled: () => true,
  notificationPreviewEnabled: () => false,
  ownAgentNotificationLevels: () => new Map(),
});
const mainWindow = new BrowserWindow();
service.on("event", (event) => {
  events.push(event);
  forwarders.forwardAgentEvent(LOCAL_SERVER_ID, event);
  hostEvents.emit("event", event);
});

const ended = (status: string | undefined) =>
  status === "completed" || status === "failed" || status === "interrupted" || status === "cancelled";

/** The queue of the agent ended, and each turn that started has sent its completion. */
const idle = (agentId: string) => {
  const turns = (type: "turn-started" | "turn-completed") =>
    new Set(events.flatMap((event) => (event.type === type && event.agentId === agentId ? [event.turnId] : [])));
  const completed = turns("turn-completed");
  return (
    service.listQueue(agentId).deliveries.every((delivery) => ended(delivery.status)) &&
    [...turns("turn-started")].every((turnId) => completed.has(turnId))
  );
};

async function createAgent(name: string) {
  const agent = await runCauseEffect(
    service.createAgent({
      name,
      description: "Checks which teammate turns notify.",
      avatarSeed: name.toLowerCase(),
      avatarHue: null,
      initialMessage: "Hello.",
    }),
  );
  await waitFor(`${name}'s first turn`, () => idle(agent.id));
  return agent;
}

async function send(agentId: string, text: string): Promise<string> {
  const receipt = await runCauseEffect(service.sendMessage({ agentId, text, attachmentDraftIds: [] }));
  const deliveryId = receipt.deliveries[0]?.id;
  assert.ok(deliveryId, "The message has a delivery.");
  return deliveryId;
}

const settled = (deliveryId: string) =>
  waitFor(`delivery ${deliveryId} to end`, () => {
    const status = mailbox.getDelivery(deliveryId)?.delivery.status;
    return ended(status) ? status : null;
  });

/** Turn completions of an agent since `from`, in order. */
const completions = (agentId: string, from: number) =>
  events
    .slice(from)
    .filter(
      (event): event is Extract<AgentEvent, { type: "turn-completed" }> =>
        event.type === "turn-completed" && event.agentId === agentId,
    );

const BARRIER = "Barrier";
let barriers = 0;
/**
 * Waits until the phone service has sent its notification of a request of the barrier agent, which
 * always reaches the phone. The service decides the events in order, so each event before it was
 * decided. A send that comes later shows in the next list with its own title, and fails that check.
 */
async function phoneBarrier(agentId: string): Promise<void> {
  const count = ++barriers;
  const sent = () => phoneShown.filter((notice) => notice.title === BARRIER).length >= count;
  hostEvents.emit("event", {
    type: "browser-takeover-requested",
    request: { requestId: `barrier-${count}`, agentId, threadId: "barrier", turnId: "barrier", tabId: "tab" },
  });
  while (!sent()) await new Promise<void>((done) => phoneWaiters.push(done));
}

async function mark(barrierAgentId: string) {
  await phoneBarrier(barrierAgentId);
  return { desktop: shown.length, phone: phoneShown.length, events: events.length };
}

/** The notifications of the desktop and the phone since `from`, without the barriers. */
async function notificationsSince(from: { desktop: number; phone: number }, barrierAgentId: string) {
  await phoneBarrier(barrierAgentId);
  return {
    desktop: shown.slice(from.desktop),
    phone: phoneShown.slice(from.phone).filter((notice) => notice.title !== BARRIER),
  };
}

const finished = english("notification.finished");

try {
  await runCauseEffect(service.initialize());
  await runCauseEffect(manager.initialize());
  await runCauseEffect(manager.setNotificationLevel(LOCAL_SERVER_ID, "all"));
  phone.start();
  phone.register(
    "phone-session",
    { memberId: "owner", protocol: 7, capabilities: new Set() },
    {
      platform: "android",
      value: {
        serverId: "phone-server-id",
        token: "e2e-token-".padEnd(40, "x"),
        secret: Buffer.from(phoneSecret).toString("base64url"),
        locale: "en",
        away: true,
        level: "all",
        mutedUntil: null,
        preview: false,
        sound: "default",
      },
    },
  );

  const barrier = await createAgent(BARRIER);
  const coordinator = await createAgent("Coordinator");
  const teammates: Awaited<ReturnType<typeof createAgent>>[] = [];
  for (const name of ["Porygon", "Machamp", "Hoothoot", "Dedenne", "Meowth", "Vespiquen"])
    teammates.push(await createAgent(name));

  await check("a coordinator and six teammates notify once, with the coordinator's answer", async () => {
    const start = events.length;
    const request = await send(
      coordinator.id,
      `Ask the team for a health report. ${plan({
        calls: [
          {
            tool: "send_message",
            arguments: {
              recipientAgentIds: teammates.map((agent) => agent.id),
              text: `Send your health report. ${plan({ answer: "Status: done\nResult: all checks pass.\nEvidence: none", gate: "reports" })}`,
            },
          },
        ],
        answer: "I asked the team.",
      })}`,
    );
    // The user was at the app when the request went out: the window opens after the coordinator's
    // own turn, and each teammate holds its report until then.
    assert.equal(await settled(request), "completed");
    await waitFor("the end of the coordinator's own turn", () =>
      completions(coordinator.id, start).some((event) => event.origin === "user"),
    );
    const from = await mark(barrier.id);
    openGate("reports");
    const summary = await waitFor("the coordinator's answer with the reports", () =>
      completions(coordinator.id, from.events).find(
        (event) => event.status === "completed" && event.origin === "agent",
      ),
    );
    await waitFor("every agent to be idle", () => [coordinator, ...teammates].every((agent) => idle(agent.id)));
    for (const teammate of teammates)
      assert.equal(
        completions(teammate.id, from.events).filter((event) => event.status === "completed").length,
        1,
        `${teammate.name} ran its report turn.`,
      );
    const received = mailbox
      .listQueue(coordinator.id)
      .deliveries.filter((delivery) => delivery.turnId === summary.turnId)
      .map((delivery) => delivery.sender.kind === "agent" && delivery.sender.agentId);
    assert.deepEqual(
      new Set(received),
      new Set(teammates.map((agent) => agent.id)),
      "The coordinator's answer turn took each teammate's result.",
    );
    const seen = await notificationsSince(from, barrier.id);
    const once = [{ title: coordinator.name, body: finished }];
    assert.deepEqual(seen, { desktop: once, phone: once });
    return seen;
  });

  const teammate = teammates[0];
  assert.ok(teammate);
  await check("a message from the user to a teammate notifies", async () => {
    const from = await mark(barrier.id);
    assert.equal(await settled(await send(teammate.id, "How is the disk?")), "completed");
    const seen = await notificationsSince(from, barrier.id);
    const expected = [{ title: teammate.name, body: finished }];
    assert.deepEqual(seen, { desktop: expected, phone: expected });
    return seen;
  });

  await check("a question and an approval in a teammate's turn for the coordinator notify", async () => {
    const [asker, approver] = teammates.slice(1, 3);
    assert.ok(asker && approver);
    const from = await mark(barrier.id);
    const request = await send(
      coordinator.id,
      `Ask two teammates. ${plan({
        calls: [
          {
            tool: "send_message",
            arguments: {
              recipientAgentIds: [asker.id],
              text: `Pick a server. ${plan({ ask: "prompt", answer: "Status: done\nResult: picked.\nEvidence: none" })}`,
            },
          },
          {
            tool: "send_message",
            arguments: {
              recipientAgentIds: [approver.id],
              text: `Check the disk. ${plan({ ask: "approval", answer: "Status: done\nResult: 40% used.\nEvidence: df -h" })}`,
            },
          },
        ],
        answer: "I asked them.",
      })}`,
    );
    assert.equal(await settled(request), "completed");
    const prompt = await waitFor("the teammate's question", () =>
      events.slice(from.events).find((event) => event.type === "prompt" && event.agentId === asker.id),
    );
    const approval = await waitFor("the teammate's approval", () =>
      events.slice(from.events).find((event) => event.type === "approval" && event.approval.agentId === approver.id),
    );
    assert.equal(prompt.type, "prompt");
    assert.equal(approval.type, "approval");
    await runCauseEffect(service.respondToPrompt({ requestId: prompt.requestId, answers: { q: ["One"] } }));
    await runCauseEffect(service.respondToApproval({ requestId: approval.approval.requestId, decision: "accept" }));
    await waitFor("the coordinator's answer with the results", () =>
      completions(coordinator.id, from.events).some(
        (event) => event.status === "completed" && event.origin === "agent",
      ),
    );
    await waitFor("every agent to be idle", () => [coordinator, asker, approver].every((agent) => idle(agent.id)));
    const seen = await notificationsSince(from, barrier.id);
    // Each request is its own message, so each answer can start its own turn of the coordinator.
    const coordinatorTurns = completions(coordinator.id, from.events).filter((event) => event.status === "completed");
    assert.ok(coordinatorTurns.length >= 2, "The coordinator answered with the results.");
    const expected = [
      ...coordinatorTurns.map(() => ({ title: coordinator.name, body: finished })),
      { title: asker.name, body: english("notification.needsInput") },
      { title: approver.name, body: english("notification.needsApproval") },
    ];
    const order = (list: { title: string; body: string }[]) =>
      list.map((entry) => `${entry.title}: ${entry.body}`).sort();
    assert.deepEqual(order(seen.desktop), order(expected));
    assert.deepEqual(order(seen.phone), order(expected));
    return seen;
  });

  await check("a routine run that asks a teammate notifies, and so does the answer with the result", async () => {
    const helper = teammates[3];
    assert.ok(helper);
    const routine = service.createRoutine(
      {
        agentId: coordinator.id,
        name: "Daily health",
        instruction: `Ask for the health report. ${plan({
          calls: [
            {
              tool: "send_message",
              arguments: {
                recipientAgentIds: [helper.id],
                text: `Send your health report. ${plan({ answer: "Status: done\nResult: healthy.\nEvidence: none", gate: "routine" })}`,
              },
            },
          ],
          answer: "I asked for the report.",
        })}`,
        active: false,
        timezone: "UTC",
        schedule: { kind: "custom", expression: "0 9 * * *" },
      },
      { recordConversationEvent: false },
    );
    const from = await mark(barrier.id);
    await runCauseEffect(service.testRoutine({ agentId: coordinator.id, routineId: routine.id }));
    await waitFor("the routine run", () =>
      completions(coordinator.id, from.events).some((event) => event.origin === "routine"),
    );
    openGate("routine");
    await waitFor("the coordinator's answer with the result", () =>
      completions(coordinator.id, from.events).some(
        (event) => event.status === "completed" && event.origin === "agent",
      ),
    );
    await waitFor("every agent to be idle", () => [coordinator, helper].every((agent) => idle(agent.id)));
    assert.equal(completions(helper.id, from.events).length, 1, "The teammate ran its report turn.");
    const seen = await notificationsSince(from, barrier.id);
    const expected = [
      { title: coordinator.name, body: finished },
      { title: coordinator.name, body: finished },
    ];
    assert.deepEqual(seen, { desktop: expected, phone: expected });
    return seen;
  });

  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  await runCauseEffect(phone.dispose()).catch(() => {});
  await runCauseEffect(manager.stop()).catch(() => {});
  await runCauseEffect(service.stop()).catch(() => {});
  report.checkedAt = new Date().toISOString();
  database.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  for (const entry of report.checks) process.stdout.write(`PASS ${entry.name}\n`);
  process.stdout.write(`${report.passed ? "PASS" : "FAIL"} ${join(OUT, "report.json")}\n`);
  if (report.error) process.stdout.write(`${report.error}\n`);
}
