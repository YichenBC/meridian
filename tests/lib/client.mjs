import { WebSocket } from 'ws';
import { log } from './helpers.mjs';

export class MeridianTestClient {
  constructor(url = 'ws://localhost:3333/ws') {
    this.url = url;
    this.ws = null;
    this.feeds = [];
    this.tasks = new Map();
    this.agents = new Map();
    this.notes = [];
    this._listeners = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      let opened = false;
      let resolved = false;
      const stateTimer = setTimeout(() => {
        if (opened && !resolved) {
          resolved = true;
          resolve();
        }
      }, 5000);
      this.ws.on('open', () => {
        log('Connected to Meridian');
        opened = true;
      });
      this.ws.on('error', (err) => {
        clearTimeout(stateTimer);
        reject(err);
      });
      this.ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        this._handleMessage(msg);
        if (msg.type === 'state' && !resolved) {
          clearTimeout(stateTimer);
          resolved = true;
          resolve();
        }
      });
    });
  }

  _handleMessage(msg) {
    switch (msg.type) {
      case 'state': {
        const d = msg.data;
        this.tasks.clear();
        (d.tasks || []).forEach(t => this.tasks.set(t.id, t));
        this.agents.clear();
        (d.agents || []).forEach(a => this.agents.set(a.id, a));
        this.feeds = d.feeds || [];
        break;
      }
      case 'feed':
        this.feeds.push(msg.data);
        break;
      case 'task_update':
        this.tasks.set(msg.data.id, msg.data);
        break;
      case 'agent_update':
        this.agents.set(msg.data.id, msg.data);
        break;
      case 'note':
        this.notes.push(msg.data);
        break;
    }
    // Notify waiters
    for (const listener of this._listeners) {
      listener(msg);
    }
  }

  send(content) {
    log(`Sending: ${content.slice(0, 80)}`);
    this.ws.send(JSON.stringify({ type: 'message', content }));
  }

  /**
   * Wait for a feed entry matching type and optional predicate.
   * @param {string} type - Feed type to match (e.g. 'agent_spawned')
   * @param {function} [predicate] - Optional filter on the feed entry
   * @param {number} [timeout=15000] - Max wait time in ms
   * @returns {Promise<object>} The matching feed entry
   */
  waitForFeed(type, predicate, timeout = 15000) {
    // Check existing feeds first
    const existing = this.feeds.find(f => f.type === type && (!predicate || predicate(f)));
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._listeners = this._listeners.filter(l => l !== handler);
        reject(new Error(`Timeout waiting for feed type="${type}" after ${timeout}ms`));
      }, timeout);

      const handler = (msg) => {
        if (msg.type === 'feed' && msg.data.type === type) {
          if (!predicate || predicate(msg.data)) {
            clearTimeout(timer);
            this._listeners = this._listeners.filter(l => l !== handler);
            resolve(msg.data);
          }
        }
      };
      this._listeners.push(handler);
    });
  }

  /**
   * Wait for any feed entry matching a predicate (any type).
   */
  waitForAnyFeed(predicate, timeout = 15000) {
    const existing = this.feeds.find(f => predicate(f));
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._listeners = this._listeners.filter(l => l !== handler);
        reject(new Error(`Timeout waiting for feed after ${timeout}ms`));
      }, timeout);

      const handler = (msg) => {
        if (msg.type === 'feed' && predicate(msg.data)) {
          clearTimeout(timer);
          this._listeners = this._listeners.filter(l => l !== handler);
          resolve(msg.data);
        }
      };
      this._listeners.push(handler);
    });
  }

  /**
   * Wait for a task to reach a specific status.
   */
  waitForTaskStatus(status, timeout = 600000) {
    // Check existing
    for (const t of this.tasks.values()) {
      if (t.status === status) return Promise.resolve(t);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._listeners = this._listeners.filter(l => l !== handler);
        reject(new Error(`Timeout waiting for task status="${status}" after ${timeout}ms`));
      }, timeout);

      const handler = (msg) => {
        if (msg.type === 'task_update' && msg.data.status === status) {
          clearTimeout(timer);
          this._listeners = this._listeners.filter(l => l !== handler);
          resolve(msg.data);
        }
      };
      this._listeners.push(handler);
    });
  }

  /**
   * Wait for a note to appear via WebSocket.
   */
  waitForNote(predicate, timeout = 30000) {
    const existing = this.notes.find(n => predicate(n));
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._listeners = this._listeners.filter(l => l !== handler);
        reject(new Error(`Timeout waiting for note after ${timeout}ms`));
      }, timeout);

      const handler = (msg) => {
        if (msg.type === 'note' && predicate(msg.data)) {
          clearTimeout(timer);
          this._listeners = this._listeners.filter(l => l !== handler);
          resolve(msg.data);
        }
      };
      this._listeners.push(handler);
    });
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._listeners = [];
  }
}
