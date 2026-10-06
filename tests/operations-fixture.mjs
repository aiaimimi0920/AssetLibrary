import assert from "node:assert/strict";
import { hostWorker } from "./worker-fixture.mjs";

export class OperationLog {
  constructor() {
    this.events = [];
  }
  log(message) {
    try {
      const event = JSON.parse(message.slice(message.indexOf("{")));
      if (event.service === "assetlibrary") this.events.push(event);
    } catch {}
    assert.ok(this.events.length < 256, "TEST_EVENT_LIMIT");
  }
  async response(id) {
    return this.wait((event) => event.requestId === id);
  }
  async wait(predicate) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const event = this.events.find(predicate);
      if (event) return event;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("WORKER_EVENT_NOT_OBSERVED");
  }
}

/** 宿主侧明确注入故障/捕获事件；同一生产 bundle，真实本地 D1/R2，不部署旁路。 */
export async function captured(action, { brokenLogger = false } = {}) {
  const log = console.log;
  const events = [];
  console.log = (message) => {
    if (brokenLogger) throw new Error("TEST_ONLY_LOG_FAILURE");
    events.push(JSON.parse(message));
  };
  try {
    return { value: await action(), events };
  } finally {
    console.log = log;
  }
}

export async function hostFetch(f, pathname, overrides = {}, options = {}) {
  const worker = await hostWorker();
  return worker.fetch(new Request(`http://localhost${pathname}`, options), {
    ...f.env,
    ...overrides,
  });
}

export function faultDatabase(db, matches, error) {
  return new Proxy(db, {
    get(target, name) {
      if (name === "prepare")
        return (sql) => {
          if (matches(sql)) throw new Error(error);
          return target.prepare(sql);
        };
      const value = target[name];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export async function hostSchedule(f, overrides = {}) {
  const worker = await hostWorker();
  return worker.scheduled({}, { ...f.env, ...overrides });
}
