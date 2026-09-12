import { pathToFileURL } from "node:url";

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_DELAY_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_OUTAGE_START_MARKER_NAME = "bot-outage-start";
const DEFAULT_BACKLOG_URL = "https://vhisobot.com/api/monitoring/telegram-delivery-backlog";
const DEFAULT_RECEIPT_CLEANUP_URL = "https://vhisobot.com/api/monitoring/telegram-receipt-cleanup";
const DEFAULT_BOT_IDENTITY_URL = "https://vhisobot.com/api/monitoring/telegram-bot-identity";

export function isHealthyBotResponse(statusCode, payload) {
  return (
    statusCode >= 200 &&
    statusCode < 300 &&
    payload !== null &&
    typeof payload === "object" &&
    payload.status === "ok" &&
    payload.polling?.status === "healthy" &&
    payload.scheduler?.status === "healthy"
  );
}

export async function checkBotHealth({
  url,
  attempts = DEFAULT_ATTEMPTS,
  delayMs = DEFAULT_DELAY_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
  sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
}) {
  if (!url || new URL(url).protocol !== "https:") {
    throw new Error("BOT_HEALTH_URL must be an HTTPS URL");
  }
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error("attempts must be a positive integer");
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const payload = await response.json();
      if (isHealthyBotResponse(response.status, payload)) {
        return { healthy: true, attempts: attempt };
      }
    } catch {
      // Network, timeout, redirect, and malformed JSON failures are unhealthy.
    }

    if (attempt < attempts) {
      await sleep(delayMs);
    }
  }

  return { healthy: false, attempts };
}

export function isHealthyDeliveryBacklogResponse(statusCode, payload) {
  return (
    statusCode >= 200 &&
    statusCode < 300 &&
    payload !== null &&
    typeof payload === "object" &&
    (payload.status === "healthy" || payload.status === "alert") &&
    Number.isInteger(payload.delayedPendingCount) &&
    payload.delayedPendingCount >= 0 &&
    Number.isInteger(payload.exhaustedCount) &&
    payload.exhaustedCount >= 0 &&
    Number.isInteger(payload.unavailableRecipientCount) &&
    payload.unavailableRecipientCount >= 0 &&
    (payload.oldestPendingAgeSeconds === null ||
      (Number.isInteger(payload.oldestPendingAgeSeconds) &&
        payload.oldestPendingAgeSeconds >= 0))
  );
}

export function evaluateDeliveryBacklog(payload) {
  if (!isHealthyDeliveryBacklogResponse(200, payload)) {
    throw new Error("Invalid delivery backlog response");
  }
  const alert =
    payload.delayedPendingCount > 0 ||
    payload.exhaustedCount > 0 ||
    payload.unavailableRecipientCount > 0;
  return { alert, healthy: !alert, ...payload };
}

export function parseDeliveryBacklogResponse(statusCode, payload) {
  if (!isHealthyDeliveryBacklogResponse(statusCode, payload)) {
    return { endpointHealthy: false, alert: false };
  }
  const result = evaluateDeliveryBacklog(payload);
  return { endpointHealthy: true, ...result };
}

export async function checkDeliveryBacklog({
  url,
  attempts = DEFAULT_ATTEMPTS,
  delayMs = DEFAULT_DELAY_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
  sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
}) {
  if (!url || new URL(url).protocol !== "https:") {
    throw new Error("TELEGRAM_BACKLOG_URL must be an HTTPS URL");
  }
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error("attempts must be a positive integer");
  }
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const payload = await response.json();
      if (isHealthyDeliveryBacklogResponse(response.status, payload)) {
        return { ...evaluateDeliveryBacklog(payload), endpointHealthy: true, attempts: attempt };
      }
    } catch {
      // Retry endpoint failures just as the liveness check does.
    }
    if (attempt < attempts) await sleep(delayMs);
  }
  return { endpointHealthy: false, alert: false, healthy: false, attempts };
}

export function isValidReceiptCleanupResponse(statusCode, payload) {
  return (
    statusCode >= 200 &&
    statusCode < 300 &&
    payload !== null &&
    typeof payload === "object" &&
    (payload.status === "healthy" || payload.status === "alert") &&
    (payload.lastSuccessAt === null || typeof payload.lastSuccessAt === "string") &&
    Number.isInteger(payload.lastDeletedCount) &&
    payload.lastDeletedCount >= 0 &&
    Number.isInteger(payload.consecutiveFailures) &&
    payload.consecutiveFailures >= 0 &&
    Array.isArray(payload.alertReasons)
  );
}

export async function checkReceiptCleanup({
  url,
  attempts = DEFAULT_ATTEMPTS,
  delayMs = DEFAULT_DELAY_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
  sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
}) {
  if (!url || new URL(url).protocol !== "https:") {
    throw new Error("TELEGRAM_RECEIPT_CLEANUP_URL must be an HTTPS URL");
  }
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const payload = await response.json();
      if (isValidReceiptCleanupResponse(response.status, payload)) {
        return {
          ...payload,
          endpointHealthy: true,
          alert: payload.status === "alert",
          healthy: payload.status === "healthy",
          attempts: attempt,
        };
      }
    } catch {
      // Retry endpoint failures without folding them into another incident.
    }
    if (attempt < attempts) await sleep(delayMs);
  }
  return { endpointHealthy: false, alert: false, healthy: false, attempts };
}

export function isValidBotIdentityResponse(statusCode, payload) {
  return (
    statusCode >= 200 &&
    statusCode < 300 &&
    payload !== null &&
    typeof payload === "object" &&
    (payload.status === "healthy" || payload.status === "alert") &&
    Number.isInteger(payload.consecutiveFailures) &&
    payload.consecutiveFailures >= 0 &&
    (payload.lastFailureReason === null ||
      typeof payload.lastFailureReason === "string") &&
    Array.isArray(payload.alertReasons) &&
    Number.isInteger(payload.thresholds?.consecutiveFailures) &&
    payload.thresholds.consecutiveFailures > 0
  );
}

export async function checkBotIdentity({
  url,
  attempts = DEFAULT_ATTEMPTS,
  delayMs = DEFAULT_DELAY_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
  sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
}) {
  if (!url || new URL(url).protocol !== "https:") {
    throw new Error("TELEGRAM_BOT_IDENTITY_URL must be an HTTPS URL");
  }
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const payload = await response.json();
      if (isValidBotIdentityResponse(response.status, payload)) {
        return {
          ...payload,
          endpointHealthy: true,
          alert: payload.status === "alert",
          healthy: payload.status === "healthy",
          attempts: attempt,
        };
      }
    } catch {
      // Endpoint failures are retried and never mistaken for a recovery.
    }
    if (attempt < attempts) await sleep(delayMs);
  }
  return { endpointHealthy: false, alert: false, healthy: false, attempts };
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function getOutageStartedAt(
  issue,
  markerName = DEFAULT_OUTAGE_START_MARKER_NAME,
) {
  if (!/^[a-z0-9-]+$/.test(markerName)) {
    throw new Error("Invalid outage marker name");
  }
  const outageStartMarker = new RegExp(
    `<!-- ${escapeRegularExpression(markerName)}:([^>]+) -->`,
  );
  const comments = Array.isArray(issue?.comments) ? issue.comments : [];
  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const match = comments[index]?.body?.match(outageStartMarker);
    if (match) {
      return match[1];
    }
  }
  return issue?.createdAt;
}

export function shouldEscalateOutage({
  issue,
  now = new Date(),
  thresholdMinutes,
  escalatedLabel,
  markerName = DEFAULT_OUTAGE_START_MARKER_NAME,
}) {
  const startedAt = getOutageStartedAt(issue, markerName);
  const startedAtMs = Date.parse(startedAt);
  if (
    !Number.isFinite(startedAtMs) ||
    !Number.isFinite(thresholdMinutes) ||
    thresholdMinutes < 1
  ) {
    throw new Error("Valid outage start and escalation threshold are required");
  }
  const alreadyEscalated = issue.labels?.some(
    (label) => label.name === escalatedLabel,
  );
  return (
    !alreadyEscalated &&
    now.getTime() - startedAtMs >= thresholdMinutes * 60_000
  );
}

async function readStandardInput() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  if (process.argv[2] === "should-escalate") {
    const issue = JSON.parse(await readStandardInput());
    const shouldEscalate = shouldEscalateOutage({
      issue,
      thresholdMinutes: Number(process.env.OUTAGE_ESCALATION_AFTER_MINUTES),
      escalatedLabel: process.env.ESCALATED_LABEL,
      markerName:
        process.env.OUTAGE_START_MARKER_NAME ||
        DEFAULT_OUTAGE_START_MARKER_NAME,
    });
    console.log(shouldEscalate ? "true" : "false");
    return;
  }

  if (process.argv[2] === "backlog") {
    const url = process.env.TELEGRAM_BACKLOG_URL || process.argv[3] || DEFAULT_BACKLOG_URL;
    const result = await checkDeliveryBacklog({
      url,
      attempts: Number.parseInt(process.env.BOT_HEALTH_ATTEMPTS || String(DEFAULT_ATTEMPTS), 10),
      delayMs: Number.parseInt(process.env.BOT_HEALTH_RETRY_DELAY_MS || String(DEFAULT_DELAY_MS), 10),
    });
    console.log(JSON.stringify(result));
    if (!result.endpointHealthy) process.exitCode = 1;
    return;
  }

  if (process.argv[2] === "receipt-cleanup") {
    const url =
      process.env.TELEGRAM_RECEIPT_CLEANUP_URL ||
      process.argv[3] ||
      DEFAULT_RECEIPT_CLEANUP_URL;
    const result = await checkReceiptCleanup({
      url,
      attempts: Number.parseInt(process.env.BOT_HEALTH_ATTEMPTS || String(DEFAULT_ATTEMPTS), 10),
      delayMs: Number.parseInt(process.env.BOT_HEALTH_RETRY_DELAY_MS || String(DEFAULT_DELAY_MS), 10),
    });
    console.log(JSON.stringify(result));
    if (!result.endpointHealthy) process.exitCode = 1;
    return;
  }

  if (process.argv[2] === "bot-identity") {
    const url =
      process.env.TELEGRAM_BOT_IDENTITY_URL ||
      process.argv[3] ||
      DEFAULT_BOT_IDENTITY_URL;
    const result = await checkBotIdentity({
      url,
      attempts: Number.parseInt(process.env.BOT_HEALTH_ATTEMPTS || String(DEFAULT_ATTEMPTS), 10),
      delayMs: Number.parseInt(process.env.BOT_HEALTH_RETRY_DELAY_MS || String(DEFAULT_DELAY_MS), 10),
    });
    console.log(JSON.stringify(result));
    if (!result.endpointHealthy) process.exitCode = 1;
    return;
  }

  const url = process.env.BOT_HEALTH_URL || process.argv[2];
  const attempts = Number.parseInt(
    process.env.BOT_HEALTH_ATTEMPTS || String(DEFAULT_ATTEMPTS),
    10,
  );
  const delayMs = Number.parseInt(
    process.env.BOT_HEALTH_RETRY_DELAY_MS || String(DEFAULT_DELAY_MS),
    10,
  );
  const result = await checkBotHealth({ url, attempts, delayMs });
  const state = result.healthy ? "healthy" : "unhealthy";
  console.log(`Telegram bot is ${state} after ${result.attempts} attempt(s)`);
  if (!result.healthy) {
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Health check failed",
    );
    process.exitCode = 1;
  });
}
