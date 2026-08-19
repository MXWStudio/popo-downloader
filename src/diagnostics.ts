declare const __POPO_DIAGNOSTIC_DSN__: string;

export const DIAGNOSTIC_SCHEMA_VERSION = 1;
export const DEFAULT_STALL_THRESHOLD_MS = 90_000;

const configuredDsn = typeof __POPO_DIAGNOSTIC_DSN__ === "string"
  ? __POPO_DIAGNOSTIC_DSN__.trim()
  : "";

export interface DiagnosticCandidate {
  code: string;
  level: "info" | "warn" | "error";
  at: string;
  count?: number;
  context?: Record<string, unknown>;
}

export interface DiagnosticEvent {
  event_id: string;
  timestamp: string;
  platform: "javascript";
  level: "info" | "warning" | "error";
  logger: "popo.diagnostics";
  release: string;
  environment: "production";
  message: string;
  fingerprint: string[];
  tags: Record<string, string>;
  extra: Record<string, unknown>;
}

export interface SentryTarget {
  dsn: string;
  envelopeUrl: string;
  publicKey: string;
  projectId: string;
}

function hashText(value: unknown) {
  const input = String(value || "");
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function eventId() {
  const value = globalThis.crypto?.randomUUID?.().replace(/-/g, "");
  if (value && /^[a-f0-9]{32}$/i.test(value)) return value.toLowerCase();
  const seed = `${Date.now()}-${Math.random()}-${Math.random()}`;
  return `${hashText(seed)}${hashText(seed + "a")}${hashText(seed + "b")}${hashText(seed + "c")}`;
}

export function redactText(value: unknown, maxLength = 160) {
  return String(value || "")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[url]")
    .replace(/\b[A-Za-z]:\\[^\r\n"'<>]*/g, "[path]")
    .replace(/\b(?:token|cookie|authorization|password|secret|signature)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\b[a-f0-9]{24,}\b/gi, "[id]")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function anonymizeIdentifier(value: unknown) {
  const normalized = String(value || "").trim();
  return normalized ? `h:${hashText(normalized)}` : "";
}

export function sanitizeDiagnosticContext(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output: Record<string, string | number | boolean> = {};
  for (const [key, raw] of Object.entries(value).slice(0, 16)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) continue;
    if (/^(?:job|task|batch|item|install).*id$/i.test(key)) {
      const hashed = anonymizeIdentifier(raw);
      if (hashed) output[key] = hashed;
    } else if (typeof raw === "number" && Number.isFinite(raw)) {
      output[key] = Math.max(-1_000_000_000, Math.min(1_000_000_000, raw));
    } else if (typeof raw === "boolean") {
      output[key] = raw;
    } else if (typeof raw === "string") {
      const sanitized = redactText(raw, 120);
      if (sanitized) output[key] = sanitized;
    }
  }
  return output;
}

export function diagnosticDsn() {
  return configuredDsn;
}

export function parseSentryDsn(value: unknown): SentryTarget | null {
  const dsn = String(value || "").trim();
  if (!dsn) return null;
  let parsed: URL;
  try {
    parsed = new URL(dsn);
  } catch {
    return null;
  }
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" || parsed.password || parsed.search || parsed.hash) return null;
  if (!hostname.endsWith(".ingest.sentry.io") && !hostname.endsWith(".ingest.us.sentry.io")) return null;
  const publicKey = parsed.username;
  const pathSegments = parsed.pathname.split("/").filter(Boolean);
  const projectId = pathSegments.pop() || "";
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(publicKey) || !/^\d{1,32}$/.test(projectId)) return null;
  const pathPrefix = pathSegments.length ? `/${pathSegments.join("/")}` : "";
  const envelopeUrl = `${parsed.origin}${pathPrefix}/api/${projectId}/envelope/?sentry_version=7&sentry_key=${encodeURIComponent(publicKey)}&sentry_client=popo-diagnostics%2F1`;
  return { dsn, envelopeUrl, publicKey, projectId };
}

export function diagnosticConfiguration() {
  const target = parseSentryDsn(configuredDsn);
  return {
    configured: Boolean(target),
    provider: target ? "sentry" : "none",
    host: target?.envelopeUrl ? new URL(target.envelopeUrl).hostname : ""
  };
}

export function buildDiagnosticEvent(input: {
  candidate: DiagnosticCandidate;
  installId: string;
  release: string;
  state?: Record<string, unknown>;
}): DiagnosticEvent {
  const candidate = input.candidate;
  const code = /^[A-Z0-9_]{1,64}$/.test(candidate.code) ? candidate.code : "UNKNOWN_DIAGNOSTIC";
  const state = input.state && typeof input.state === "object" ? input.state : {};
  const counts = state.counts && typeof state.counts === "object" && !Array.isArray(state.counts)
    ? sanitizeDiagnosticContext(state.counts)
    : {};
  const context = sanitizeDiagnosticContext(candidate.context);
  const stage = typeof context.failureStage === "string" ? context.failureStage : "";
  return {
    event_id: eventId(),
    timestamp: Number.isFinite(Date.parse(candidate.at)) ? candidate.at : new Date().toISOString(),
    platform: "javascript",
    level: candidate.level === "warn" ? "warning" : candidate.level,
    logger: "popo.diagnostics",
    release: redactText(input.release, 40) || "unknown",
    environment: "production",
    message: code,
    fingerprint: [code, stage || "none"],
    tags: {
      code,
      mode: redactText(state.mode, 32) || "unknown",
      phase: redactText(state.phase, 32) || "unknown",
      install: anonymizeIdentifier(input.installId),
      schema: String(DIAGNOSTIC_SCHEMA_VERSION)
    },
    extra: {
      occurrenceCount: Math.max(1, Math.min(10_000, Number(candidate.count) || 1)),
      counts,
      context
    }
  };
}

export function buildSentryEnvelope(event: DiagnosticEvent, target: SentryTarget) {
  const header = JSON.stringify({
    event_id: event.event_id,
    dsn: target.dsn,
    sent_at: new Date().toISOString()
  });
  return `${header}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify(event)}`;
}

export async function sendDiagnosticEvent(
  event: DiagnosticEvent,
  fetchImpl: typeof fetch = globalThis.fetch
) {
  const target = parseSentryDsn(configuredDsn);
  if (!target) throw new Error("诊断接收地址尚未配置");
  if (typeof fetchImpl !== "function") throw new Error("当前环境无法发送诊断信息");
  const response = await fetchImpl(target.envelopeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-sentry-envelope" },
    body: buildSentryEnvelope(event, target),
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer"
  });
  if (!response.ok) throw new Error(`诊断平台返回 HTTP ${response.status}`);
}

export function inspectTransferProgress(input: {
  previousDownloaded?: unknown;
  lastProgressAt?: unknown;
  stallReportedAt?: unknown;
  downloaded?: unknown;
  status?: unknown;
  now?: number;
  thresholdMs?: number;
}) {
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const downloaded = Math.max(0, Number(input.downloaded) || 0);
  const previousDownloaded = Math.max(0, Number(input.previousDownloaded) || 0);
  const progressed = downloaded > previousDownloaded;
  const parsedLastProgressAt = Number(input.lastProgressAt);
  const lastProgressAt = progressed || !Number.isFinite(parsedLastProgressAt) || parsedLastProgressAt <= 0
    ? now
    : parsedLastProgressAt;
  const status = String(input.status || "");
  const active = status === "active";
  const thresholdMs = Math.max(30_000, Number(input.thresholdMs) || DEFAULT_STALL_THRESHOLD_MS);
  const parsedReportedAt = Number(input.stallReportedAt);
  const previouslyReported = Number.isFinite(parsedReportedAt) && parsedReportedAt >= lastProgressAt;
  const stalledForMs = active ? Math.max(0, now - lastProgressAt) : 0;
  const stalled = active && stalledForMs >= thresholdMs && !previouslyReported;
  return {
    downloaded,
    lastProgressAt,
    stallReportedAt: stalled ? now : progressed ? 0 : Math.max(0, parsedReportedAt || 0),
    progressed,
    stalled,
    stalledForMs
  };
}
