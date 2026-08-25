import { appConfig } from "../../config/env.js";

export type MessengerStatus = "pending" | "sending" | "sent" | "delivered" | "read" | "failed";
export type MessengerTemplate = { name: string; language: string; placeholderCount: number };
export type MessengerMessage = { id: string; status: MessengerStatus; providerMessageId: string | null; lastError: string | null };

export class MessengerClientError extends Error {
  constructor(message: string, public readonly retryable: boolean) { super(message); this.name = "MessengerClientError"; }
}

function configured() {
  if (!appConfig.MESSENGER_BASE_URL || !appConfig.MESSENGER_API_KEY) throw new MessengerClientError("Messenger is not configured.", false);
}

export class MessengerClient {
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    configured();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), appConfig.MESSENGER_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${appConfig.MESSENGER_BASE_URL!.replace(/\/$/, "")}${path}`, { ...init, signal: controller.signal, headers: { "content-type": "application/json", "x-api-key": appConfig.MESSENGER_API_KEY!, ...init.headers } });
      const body = await response.json().catch(() => ({})) as T & { message?: string };
      if (!response.ok) throw new MessengerClientError(body.message ?? `Messenger request failed (${response.status})`, [408, 429, 500, 502, 503, 504].includes(response.status));
      return body;
    } catch (error) {
      if (error instanceof MessengerClientError) throw error;
      throw new MessengerClientError(error instanceof Error ? error.message : "Messenger request failed", true);
    } finally { clearTimeout(timer); }
  }
  sendWhatsApp(input: { recipient: string; template: string; language: string; parameters: Record<string, string>; idempotencyKey: string }) {
    return this.request<MessengerMessage>("/messages", { method: "POST", body: JSON.stringify({ provider: "whatsapp", recipient: input.recipient, message: { type: "template", template: input.template, language: input.language, parameters: input.parameters }, idempotencyKey: input.idempotencyKey, authorization: { whatsapp: true }, metadata: { source: "spielkind-core" } }) });
  }
  getMessage(id: string) { return this.request<MessengerMessage>(`/messages/${encodeURIComponent(id)}`); }
  retryMessage(id: string) { return this.request<MessengerMessage>(`/messages/${encodeURIComponent(id)}/retry`, { method: "POST" }); }
  async listWhatsAppTemplates() { return (await this.request<{ items: MessengerTemplate[] }>("/providers/whatsapp/templates")).items; }
}
