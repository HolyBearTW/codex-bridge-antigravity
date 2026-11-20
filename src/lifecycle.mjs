export class BridgeLifecycle {
  constructor() {
    this.http = 0;
    this.models = 0;
    this.streams = 0;
    this.websockets = new Map();
    this.sockets = new Set();
    this.draining = false;
    this.lastProgressAt = Date.now();
  }

  snapshot() {
    return {
      active_http_requests: this.http,
      active_model_requests: this.models,
      active_sse_streams: this.streams,
      websocket_connections: this.websockets.size,
      tcp_connections: this.sockets.size,
      draining: this.draining,
      last_progress_at: this.lastProgressAt,
    };
  }

  trackHttp(req, res, model) {
    this.http++;
    const done = model ? this.beginModel() : () => {};
    let stream = false;
    if (model) {
      const lifecycle = this;
      res.bridgeMarkStream = () => {
        if (!stream) { stream = true; lifecycle.streams++; }
      };
      const write = res.write;
      res.write = function (...args) {
        lifecycle.lastProgressAt = Date.now();
        return write.apply(this, args);
      };
    }
    res.once('close', () => {
      this.http--;
      if (stream) this.streams--;
      done();
      this.checkDrain?.();
    });
  }

  trackWebSocket(socket, close) {
    const entry = { pending: new Set(), close };
    this.websockets.set(socket, entry);
    socket.once('close', () => {
      for (const done of entry.pending) done();
      this.websockets.delete(socket);
      this.checkDrain?.();
    });
  }

  beginModel(socket) {
    this.models++;
    this.lastProgressAt = Date.now();
    const entry = this.websockets.get(socket);
    let active = true;
    const done = () => {
      if (!active) return;
      active = false;
      this.models--;
      this.lastProgressAt = Date.now();
      entry?.pending.delete(done);
      if (this.draining && entry?.pending.size === 0) entry.close();
      this.checkDrain?.();
    };
    entry?.pending.add(done);
    return done;
  }

  shutdown(server, timeoutMs) {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.draining = true;
    this.shutdownPromise = new Promise(resolve => {
      let closed = false;
      let forced = false;
      const deadline = setTimeout(() => {
        forced = true;
        for (const socket of this.sockets) socket.destroy();
        this.checkDrain();
      }, timeoutMs);
      this.checkDrain = () => {
        for (const entry of this.websockets.values()) {
          if (entry.pending.size === 0) entry.close();
        }
        if (closed && this.http === 0 && this.models === 0 && this.websockets.size === 0) {
          clearTimeout(deadline);
          resolve({ forced });
        }
      };
      server.close(() => { closed = true; this.checkDrain(); });
      server.closeIdleConnections();
      this.checkDrain();
    });
    return this.shutdownPromise;
  }
}
