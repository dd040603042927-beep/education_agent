class RecoverableQueue {
  constructor({ storage, handlers, pollMs = 250 }) {
    this.storage = storage;
    this.handlers = handlers;
    this.pollMs = pollMs;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer || typeof this.storage.claimNextJob !== "function") return;
    this.storage.recoverJobs?.();
    this.timer = setInterval(() => this.drain().catch((error) => console.error("[queue]", error)), this.pollMs);
    this.timer.unref?.();
    this.drain().catch((error) => console.error("[queue]", error));
  }

  enqueue(type, payload, options = {}) {
    return this.storage.enqueueJob({ type, payload, ...options });
  }

  get(id) {
    return this.storage.getJob?.(id) || null;
  }

  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      let job;
      while ((job = this.storage.claimNextJob?.())) {
        const handler = this.handlers[job.type];
        if (!handler) {
          this.storage.failJob(job.id, `No handler for ${job.type}`, false);
          continue;
        }
        try {
          this.storage.completeJob(job.id, await handler(job));
        } catch (error) {
          this.storage.failJob(job.id, error?.message || String(error), true);
        }
      }
    } finally {
      this.running = false;
    }
  }
}

module.exports = { RecoverableQueue };
