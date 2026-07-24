import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

const SNAPSHOT_PATH = "/api/upstream/zzz/snapshot";
const HEALTH_PATH = "/api/health";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8790;
const FETCH_TIMEOUT_MS = 12_000;
const FETCH_ATTEMPTS = 4;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const RETRY_DELAYS_MS = [500, 1_000, 2_000];

class SnapshotBootstrapError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.name = "SnapshotBootstrapError";
    this.retryable = retryable;
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertFiniteNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`Invalid ZZZ snapshot: ${label} must be a finite number`);
  }
}

function assertOptionalString(value, key, label) {
  if (value[key] !== undefined && typeof value[key] !== "string") {
    throw new TypeError(
      `Invalid ZZZ snapshot: ${label}.${key} must be a string`
    );
  }
}

function assertOptionalNumber(value, key, label) {
  if (value[key] !== undefined) {
    assertFiniteNumber(value[key], `${label}.${key}`);
  }
}

function validateEnvelope(value, label, arrayKey) {
  if (!isRecord(value)) {
    throw new TypeError(`Invalid ZZZ snapshot: ${label} must be an object`);
  }
  if (value.retcode !== 0) {
    throw new TypeError(`Invalid ZZZ snapshot: ${label}.retcode must be 0`);
  }
  if (typeof value.message !== "string") {
    throw new TypeError(
      `Invalid ZZZ snapshot: ${label}.message must be a string`
    );
  }
  if (!isRecord(value.data) || !Array.isArray(value.data[arrayKey])) {
    throw new TypeError(
      `Invalid ZZZ snapshot: ${label}.data.${arrayKey} must be an array`
    );
  }
}

function validateActivity(value) {
  validateEnvelope(value, "activity", "activity_list");
  for (const [index, item] of value.data.activity_list.entries()) {
    const label = `activity.data.activity_list[${index}]`;
    if (!isRecord(item)) {
      throw new TypeError(`Invalid ZZZ snapshot: ${label} must be an object`);
    }
    assertOptionalString(item, "activity_id", label);
    assertOptionalString(item, "name", label);
    assertOptionalString(item, "start_time", label);
    assertOptionalString(item, "end_time", label);
  }
}

function validateAnnouncement(value, label) {
  if (!isRecord(value)) {
    throw new TypeError(`Invalid ZZZ snapshot: ${label} must be an object`);
  }
  assertOptionalNumber(value, "ann_id", label);
  assertOptionalString(value, "title", label);
  assertOptionalString(value, "subtitle", label);
  assertOptionalString(value, "start_time", label);
  assertOptionalString(value, "end_time", label);
}

function validateList(value) {
  validateEnvelope(value, "list", "list");
  for (const [categoryIndex, category] of value.data.list.entries()) {
    const label = `list.data.list[${categoryIndex}]`;
    if (!isRecord(category)) {
      throw new TypeError(`Invalid ZZZ snapshot: ${label} must be an object`);
    }
    assertFiniteNumber(category.type_id, `${label}.type_id`);
    if (typeof category.type_label !== "string") {
      throw new TypeError(
        `Invalid ZZZ snapshot: ${label}.type_label must be a string`
      );
    }
    if (!Array.isArray(category.list)) {
      throw new TypeError(`Invalid ZZZ snapshot: ${label}.list must be an array`);
    }
    for (const [itemIndex, item] of category.list.entries()) {
      validateAnnouncement(item, `${label}.list[${itemIndex}]`);
    }
  }
}

function validateContentItem(value, label) {
  if (!isRecord(value)) {
    throw new TypeError(`Invalid ZZZ snapshot: ${label} must be an object`);
  }
  assertOptionalNumber(value, "ann_id", label);
  assertOptionalString(value, "title", label);
  assertOptionalString(value, "subtitle", label);
  assertOptionalString(value, "banner", label);
  assertOptionalString(value, "img", label);
  assertOptionalString(value, "content", label);
  assertOptionalString(value, "lang", label);
  assertOptionalString(value, "remind_text", label);
  assertOptionalString(value, "href", label);
  assertOptionalNumber(value, "href_type", label);
}

function validateContent(value) {
  validateEnvelope(value, "content", "list");
  if (!Array.isArray(value.data.pic_list)) {
    throw new TypeError(
      "Invalid ZZZ snapshot: content.data.pic_list must be an array"
    );
  }
  for (const [index, item] of value.data.list.entries()) {
    validateContentItem(item, `content.data.list[${index}]`);
  }
  for (const [index, item] of value.data.pic_list.entries()) {
    validateContentItem(item, `content.data.pic_list[${index}]`);
  }
}

export function validateZzzSnapshotBundle(value) {
  if (!isRecord(value)) {
    throw new TypeError("Invalid ZZZ snapshot: root must be an object");
  }
  const expectedKeys = [
    "activity",
    "content",
    "game",
    "list",
    "schema_version",
  ];
  const actualKeys = Object.keys(value).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new TypeError(
      "Invalid ZZZ snapshot: root fields must exactly match the trusted schema"
    );
  }
  if (value.schema_version !== 1) {
    throw new TypeError(
      "Invalid ZZZ snapshot: schema_version must be exactly 1"
    );
  }
  if (value.game !== "zzz") {
    throw new TypeError('Invalid ZZZ snapshot: game must be exactly "zzz"');
  }
  validateActivity(value.activity);
  validateList(value.list);
  validateContent(value.content);
  return value;
}

function sortJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJsonValue(value[key])])
    );
  }
  return value;
}

export function canonicalZzzSnapshotBytes(value) {
  const snapshot = validateZzzSnapshotBundle(value);
  return Buffer.from(JSON.stringify(sortJsonValue(snapshot)), "utf8");
}

export function validateSnapshotSourceUrl(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError("ZZZ_SNAPSHOT_SOURCE_URL must be set");
  }
  let sourceUrl;
  try {
    sourceUrl = new URL(value.trim());
  } catch {
    throw new TypeError(
      "ZZZ_SNAPSHOT_SOURCE_URL must be an absolute HTTP(S) URL"
    );
  }
  if (sourceUrl.protocol !== "https:" && sourceUrl.protocol !== "http:") {
    throw new TypeError(
      "ZZZ_SNAPSHOT_SOURCE_URL must be an absolute HTTP(S) URL"
    );
  }
  if (sourceUrl.username || sourceUrl.password) {
    throw new TypeError("ZZZ_SNAPSHOT_SOURCE_URL must not contain credentials");
  }
  if (sourceUrl.hash) {
    throw new TypeError("ZZZ_SNAPSHOT_SOURCE_URL must not contain a fragment");
  }
  return sourceUrl;
}

function publicSourceLabel(sourceUrl) {
  return `${sourceUrl.origin}${sourceUrl.pathname}`;
}

function parsePort(value) {
  const raw = value == null || value === "" ? DEFAULT_PORT : Number(value);
  if (!Number.isInteger(raw) || raw < 1 || raw > 65_535) {
    throw new TypeError(
      "ZZZ_SNAPSHOT_SERVER_PORT must be an integer from 1 to 65535"
    );
  }
  return raw;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchSnapshotAttempt(sourceUrl) {
  let response;
  try {
    response = await fetch(sourceUrl, {
      headers: {
        accept: "application/json",
        "user-agent": "game-cal-trusted-snapshot/1.0",
      },
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new SnapshotBootstrapError("snapshot source request failed", {
      retryable: true,
    });
  }

  if (!response.ok) {
    const retryable =
      response.status === 408 ||
      response.status === 425 ||
      response.status === 429 ||
      response.status >= 500;
    throw new SnapshotBootstrapError(
      `snapshot source returned HTTP ${response.status}`,
      { retryable }
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new SnapshotBootstrapError(
      "snapshot source did not return application/json"
    );
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new SnapshotBootstrapError("snapshot source response was too large");
  }

  let responseBytes;
  try {
    responseBytes = Buffer.from(await response.arrayBuffer());
  } catch {
    throw new SnapshotBootstrapError(
      "snapshot source response could not be read",
      { retryable: true }
    );
  }
  if (responseBytes.length > MAX_RESPONSE_BYTES) {
    throw new SnapshotBootstrapError("snapshot source response was too large");
  }

  let decoded;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(responseBytes);
  } catch {
    throw new SnapshotBootstrapError(
      "snapshot source returned invalid UTF-8"
    );
  }
  let value;
  try {
    value = JSON.parse(decoded);
  } catch {
    throw new SnapshotBootstrapError("snapshot source returned invalid JSON");
  }
  try {
    return canonicalZzzSnapshotBytes(value);
  } catch (error) {
    throw new SnapshotBootstrapError(
      error instanceof Error
        ? error.message
        : "snapshot source returned an invalid bundle"
    );
  }
}

async function fetchSnapshot(sourceUrl) {
  let lastError;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      return await fetchSnapshotAttempt(sourceUrl);
    } catch (error) {
      lastError = error;
      if (
        !(error instanceof SnapshotBootstrapError) ||
        !error.retryable ||
        attempt === FETCH_ATTEMPTS
      ) {
        throw error;
      }
      await delay(RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS.at(-1));
    }
  }
  throw lastError;
}

function sendBytes(response, status, bytes, extraHeaders = {}) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": String(bytes.length),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  response.end(bytes);
}

function errorBytes(message) {
  return Buffer.from(JSON.stringify({ error: message }), "utf8");
}

function createRequestHandler(snapshotBytes) {
  const healthBytes = Buffer.from('{"ok":true}', "utf8");
  return (request, response) => {
    let requestUrl;
    try {
      requestUrl = new URL(request.url ?? "/", "http://snapshot.invalid");
    } catch {
      sendBytes(response, 400, errorBytes("invalid request target"));
      return;
    }

    if (requestUrl.pathname !== SNAPSHOT_PATH && requestUrl.pathname !== HEALTH_PATH) {
      sendBytes(response, 404, errorBytes("not found"));
      return;
    }
    if (request.method !== "GET") {
      sendBytes(response, 405, errorBytes("method not allowed"), {
        allow: "GET",
      });
      return;
    }
    if (requestUrl.search !== "") {
      sendBytes(response, 400, errorBytes("query parameters are not supported"));
      return;
    }
    sendBytes(
      response,
      200,
      requestUrl.pathname === SNAPSHOT_PATH ? snapshotBytes : healthBytes
    );
  };
}

export async function startSnapshotServer({
  sourceUrl: sourceUrlValue = process.env.ZZZ_SNAPSHOT_SOURCE_URL,
  host: hostValue = process.env.ZZZ_SNAPSHOT_SERVER_HOST ?? DEFAULT_HOST,
  port: portValue = process.env.ZZZ_SNAPSHOT_SERVER_PORT,
} = {}) {
  const sourceUrl = validateSnapshotSourceUrl(sourceUrlValue);
  const host = String(hostValue).trim();
  if (host === "") {
    throw new TypeError("ZZZ_SNAPSHOT_SERVER_HOST must not be empty");
  }
  const port = parsePort(portValue);
  const snapshotBytes = await fetchSnapshot(sourceUrl);
  const server = http.createServer(createRequestHandler(snapshotBytes));
  server.headersTimeout = 5_000;
  server.requestTimeout = 5_000;
  server.keepAliveTimeout = 1_000;

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

  console.log(
    `Trusted ZZZ snapshot loaded from ${publicSourceLabel(sourceUrl)}; listening on ${host}:${port}`
  );
  return { server, snapshotBytes };
}

function isMainModule() {
  const entry = process.argv[1];
  return (
    typeof entry === "string" &&
    import.meta.url === pathToFileURL(path.resolve(entry)).href
  );
}

function safeBootstrapMessage(error) {
  if (error instanceof SnapshotBootstrapError || error instanceof TypeError) {
    return error.message;
  }
  if (isRecord(error) && typeof error.code === "string") {
    return `${error.name ?? "Error"} (${error.code})`;
  }
  return error instanceof Error ? error.name : "unknown error";
}

if (isMainModule()) {
  startSnapshotServer()
    .then(({ server }) => {
      let closing = false;
      const close = (signal) => {
        if (closing) return;
        closing = true;
        console.log(`Received ${signal}; closing trusted snapshot server`);
        server.close((error) => {
          if (error) {
            console.error("Trusted snapshot server failed to close cleanly");
            process.exitCode = 1;
          }
        });
      };
      process.once("SIGTERM", () => close("SIGTERM"));
      process.once("SIGINT", () => close("SIGINT"));
    })
    .catch((error) => {
      console.error(
        `Trusted snapshot server bootstrap failed: ${safeBootstrapMessage(error)}`
      );
      process.exitCode = 1;
    });
}
