import { EventEmitter } from "node:events";

/** @typedef {"scan"|"export"|"materialize"|"undo-move"|"enrich"|"transcode"} JobType */

class JobRegistry extends EventEmitter {
  #jobs = new Map();
  #seq = 0;

  create(type, { label, total = 0 } = {}) {
    const id = `job-${++this.#seq}`;
    const job = {
      id,
      type,
      label: label ?? type,
      status: "running",
      done: 0,
      total,
      phase: "",
      result: null,
      error: null,
      controller: new AbortController(),
    };
    this.#jobs.set(id, job);
    this.#emit();
    return job;
  }
  update(id, patch) {
    const j = this.#jobs.get(id);
    if (!j) return;
    Object.assign(j, patch);
    this.#emit();
  }
  finish(id, result) {
    const j = this.#jobs.get(id);
    if (!j) return;
    j.status = "done";
    j.result = result ?? null;
    this.#emit();
  }
  fail(id, error) {
    const j = this.#jobs.get(id);
    if (!j) return;
    j.status = j.controller.signal.aborted ? "canceled" : "failed";
    j.error = String(error?.message ?? error);
    this.#emit();
  }
  cancel(id) {
    const j = this.#jobs.get(id);
    if (!j || j.status !== "running") return false;
    j.controller.abort();
    return true;
  }
  dismiss(id) {
    const j = this.#jobs.get(id);
    if (!j || j.status === "running") return false;
    this.#jobs.delete(id);
    this.#emit();
    return true;
  }
  get(id) {
    return this.#jobs.get(id);
  }
  list() {
    return [...this.#jobs.values()].map(({ controller, ...rest }) => ({
      ...rest,
    }));
  }
  #emit() {
    this.emit("change", this.list());
  }
}

export const registry = new JobRegistry();
