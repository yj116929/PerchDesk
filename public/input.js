// Keep the newest motion until its reliable input barrier has been dispatched.
export class InputReceiver {
  constructor(epoch, dispatch, counters) {
    this.epoch = epoch;
    this.dispatch = dispatch;
    this.counters = counters;
    this.barrier = 0;
    this.lastPosition = 0;
    this.pending = null;
  }

  receive(message) {
    if (!Number.isSafeInteger(message.sequence) || message.sequence <= 0 ||
        (message.epoch !== undefined && message.epoch !== this.epoch)) return;
    if (message.type === 'move') {
      if (message.sequence <= this.lastPosition || message.sequence <= (this.pending?.sequence ?? 0)) {
        this.counters.stale++;
        return;
      }
      if (message.after !== undefined && message.after !== this.barrier) {
        this.counters.barrier++;
        if (Number.isSafeInteger(message.after) && message.after > this.barrier && message.after < message.sequence) {
          this.pending = message;
          this.counters.deferred++;
        }
        return;
      }
      this.lastPosition = message.sequence;
      this.dispatch(message);
      return;
    }
    if (!['button', 'wheel', 'key', 'reset'].includes(message.type) || message.sequence <= this.barrier) return;
    this.barrier = message.sequence;
    this.lastPosition = Math.max(this.lastPosition, message.sequence);
    this.dispatch(message);
    const pending = this.pending;
    if (!pending || pending.after > this.barrier) return;
    this.pending = null;
    if (pending.after === this.barrier && pending.sequence > this.lastPosition) {
      this.lastPosition = pending.sequence;
      this.counters.replayed++;
      this.dispatch(pending);
    }
  }
}
