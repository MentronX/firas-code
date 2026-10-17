// Shared plumbing for the link tests: a client wired to a mock service with an instant, recording sleep.
import { startMockService } from "../helpers/mock-service.js";
import { createServiceClient } from "../../src/link/client.js";
import { createAccumulator } from "../../src/link/accumulator.js";
import { abortError } from "../../src/link/errors.js";

export const CODE = "FC2-ABCDE-FGHJK-MNPQR-STVWX-YZ012-34567-89ABC-DEFGH";
export const REQUEST = { max_tokens: 1000, system: [{ type: "text", text: "sys" }], messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] };

/** A sleep that records its delays and returns at once, but still ends early when the signal aborts. */
export function recordingSleep() {
  const delays = [];
  const sleep = (ms, signal) => {
    delays.push(ms);
    if (signal?.aborted) return Promise.reject(abortError());
    return Promise.resolve();
  };
  return { delays, sleep };
}

export async function setup(script, { service: serviceOptions, client: clientOptions } = {}) {
  const service = await startMockService(script, { code: CODE, ...serviceOptions });
  const { delays, sleep } = recordingSleep();
  const client = createServiceClient({
    origin: service.origin, getCode: () => CODE, version: "1.2.3", lang: "en", sleep, ...clientOptions,
  });
  return { service, client, sleeps: delays };
}

/** Runs one request to the end: { events, acc } (acc already holds every event). */
export async function run(client, request = REQUEST, options = {}) {
  const acc = createAccumulator();
  const events = [];
  for await (const event of client.stream(request, options)) { acc.add(event); events.push(event); }
  return { events, acc };
}

/** Like run(), but returns the error the stream threw plus what it delivered first. */
export async function runToError(client, request = REQUEST, options = {}) {
  const events = [];
  try {
    for await (const event of client.stream(request, options)) events.push(event);
  } catch (error) {
    return { error, events };
  }
  throw new Error("the stream was expected to fail");
}

export async function until(check, { timeoutMs = 3000, label = "condition" } = {}) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
