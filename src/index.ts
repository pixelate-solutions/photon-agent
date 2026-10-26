import { query } from "@anthropic-ai/claude-agent-sdk";
import { Spectrum } from "spectrum-ts";
import { imessage } from "@spectrum-ts/imessage";
import { startWebhookServer } from "./webhook.ts";

// Spectrum bridges a single agent loop to many messaging interfaces.
// Docs: https://photon.codes/docs/spectrum-ts
const app = await Spectrum({
  projectId: process.env.PROJECT_ID!,
  projectSecret: process.env.PROJECT_SECRET!,
  providers: [imessage.config()],
});

startWebhookServer(Number(process.env.WEBHOOK_PORT ?? 8787));

const SYSTEM_PROMPT = `You are a helpful assistant chatting over iMessage.
Write like a person texting: short messages, plain text only — no markdown,
no headers, no bullet lists. Prefer one to three sentences; only go longer
when the question genuinely needs it. Be warm, direct, and useful.`;

// Replies come from the Claude Agent SDK, which authenticates through the
// local Claude Code login — no API key. Each iMessage conversation maps to
// a persistent Claude session (resumed by id), which carries the history.
const sessions = new Map<string, string>();

async function generateReply(spaceId: string, userText: string): Promise<string> {
  let reply = "";
  const run = query({
    prompt: userText,
    options: {
      model: "opus",
      systemPrompt: { type: "custom", prompt: SYSTEM_PROMPT },
      tools: [], // pure chat — no filesystem/bash access for iMessage senders
      resume: sessions.get(spaceId),
      // Strip ANTHROPIC_API_KEY so the CLI uses the subscription login.
      env: { ...process.env, ANTHROPIC_API_KEY: undefined },
    },
  });
  for await (const message of run) {
    if (message.type === "result") {
      sessions.set(spaceId, message.session_id);
      if (message.subtype === "success") {
        reply = message.result.trim();
      } else {
        throw new Error(`agent run failed: ${message.subtype}`);
      }
    }
  }
  return reply;
}

function preview(text: string): string {
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

// Serialize handling per conversation so replies stay in order, while
// separate conversations proceed concurrently.
const queues = new Map<string, Promise<void>>();

console.log("[agent] ready — waiting for messages");

for await (const [space, message] of app.messages) {
  if (message.direction === "outbound") continue;
  if (message.content.type !== "text") continue;
  const text = message.content.text;
  console.log(`[in]  ${space.id} <- ${message.sender?.id ?? "unknown"}: ${preview(text)}`);

  const prev = queues.get(space.id) ?? Promise.resolve();
  const next = prev.then(async () => {
    const started = Date.now();
    try {
      await space.responding(async () => {
        const reply = await generateReply(space.id, text);
        if (reply) {
          await space.send(reply);
          console.log(`[out] ${space.id} (${Date.now() - started}ms): ${preview(reply)}`);
        }
      });
    } catch (error) {
      console.error(`[err] ${space.id}:`, error);
      await space.send("Sorry, I hit a snag on my end. Try that again?").catch(() => {});
    }
  });
  queues.set(space.id, next);
}
