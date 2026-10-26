import { createServer } from "node:http";
import {
  slimEnvelopeSchema,
  verifySpectrumSignature,
} from "@spectrum-ts/core/webhook";

/**
 * Receiver for the native Spectrum webhook (https://photon.codes/docs/webhooks).
 * Register the public URL of POST /webhook on the Photon dashboard (Webhook tab)
 * and put the signing secret from that registration in WEBHOOK_SECRET.
 */
export function startWebhookServer(port: number) {
  const secret = process.env.WEBHOOK_SECRET;

  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/webhook") {
      res.writeHead(404).end();
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const rawBody = new Uint8Array(Buffer.concat(chunks));

    if (secret) {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers[k.toLowerCase()] = v;
      }
      const verdict = await verifySpectrumSignature({ headers, rawBody, secret });
      if (!verdict.ok) {
        console.warn(`[webhook] rejected delivery: ${verdict.reason}`);
        res.writeHead(401).end();
        return;
      }
    } else {
      console.warn("[webhook] WEBHOOK_SECRET not set — accepting unverified delivery");
    }

    try {
      const envelope = slimEnvelopeSchema.parse(
        JSON.parse(Buffer.from(rawBody).toString("utf8")),
      );
      const m = envelope.message;
      console.log(
        `[webhook] ${envelope.event}: ${m.direction ?? "?"} ${m.content.type} ` +
          `in space ${m.space.id} from ${m.sender?.id ?? "unknown"}`,
      );
    } catch (error) {
      console.warn("[webhook] delivery did not parse as a Spectrum envelope:", error);
    }

    res.writeHead(200).end();
  });

  server.listen(port, () => {
    console.log(`[webhook] listening on http://localhost:${port}/webhook`);
  });
  return server;
}
