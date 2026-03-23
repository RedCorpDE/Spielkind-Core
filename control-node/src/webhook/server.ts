import http from "http";
import { config } from "../config.js";
import { verifyWebhookSignature } from "./verify.js";
import { handleWebhookEvent, type WebhookPayload } from "./handler.js";

const MAX_BODY_BYTES = 1024 * 512; // 512 KB — more than enough for any Regiondo event

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = "";
        let size = 0;

        req.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error("Request body too large"));
                req.destroy();
                return;
            }
            body += chunk.toString("utf8");
        });

        req.on("end", () => resolve(body));
        req.on("error", reject);
    });
}

function send(
    res: http.ServerResponse,
    status: number,
    body: object
): void {
    const json = JSON.stringify(body);
    res.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(json),
    });
    res.end(json);
}

async function requestHandler(
    req: http.IncomingMessage,
    res: http.ServerResponse
): Promise<void> {
    const url = new URL(req.url ?? "/", `http://localhost`);

    // Health-check — useful for load balancers / uptime monitors
    if (req.method === "GET" && url.pathname === "/health") {
        send(res, 200, { status: "ok" });
        return;
    }

    // Only the webhook endpoint accepts POST
    if (req.method !== "POST" || url.pathname !== "/webhook/regiondo") {
        send(res, 404, { error: "Not found" });
        return;
    }

    let rawBody: string;
    try {
        rawBody = await readBody(req);
    } catch (err) {
        console.error("[Webhook] Failed to read body:", err);
        send(res, 400, { error: "Bad request" });
        return;
    }

    // Signature verification
    if (config.webhook.verifySignature) {
        const signature = req.headers["x-regiondo-signature"] as string | undefined;
        if (!verifyWebhookSignature(rawBody, signature)) {
            console.warn("[Webhook] Invalid signature — request rejected");
            send(res, 401, { error: "Invalid signature" });
            return;
        }
    }

    // Parse payload
    let payload: WebhookPayload;
    try {
        payload = JSON.parse(rawBody) as WebhookPayload;
    } catch {
        send(res, 400, { error: "Invalid JSON" });
        return;
    }

    if (!payload.event || !payload.data) {
        send(res, 400, { error: "Missing event or data field" });
        return;
    }

    // Acknowledge immediately — Regiondo expects a fast 200
    send(res, 200, { received: true });

    // Process asynchronously so we don't block the HTTP response
    handleWebhookEvent(payload).catch((err) => {
        console.error(`[Webhook] Handler error for event "${payload.event}":`, err);
    });
}

export function createWebhookServer(): http.Server {
    const server = http.createServer((req, res) => {
        requestHandler(req, res).catch((err) => {
            console.error("[Webhook] Unhandled error:", err);
            if (!res.headersSent) {
                send(res, 500, { error: "Internal server error" });
            }
        });
    });

    return server;
}

export function startWebhookServer(): Promise<void> {
    return new Promise((resolve) => {
        const server = createWebhookServer();
        server.listen(config.webhook.port, () => {
            console.log(`[Webhook] Server listening on port ${config.webhook.port}`);
            console.log(`[Webhook] Endpoint: POST /webhook/regiondo`);
            console.log(
                `[Webhook] Signature verification: ${config.webhook.verifySignature ? "enabled" : "disabled"}`
            );
            resolve();
        });
    });
}