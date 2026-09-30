'use strict';

const crypto = require('node:crypto');

class KillSwitchError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'KillSwitchError';
    this.code = code || 'killswitch_error';
  }
}

class HaltedError extends KillSwitchError {
  constructor(reason) {
    super(`Kill switch active: ${reason || 'no reason given'}`, 'halted');
    this.name = 'HaltedError';
    this.reason = reason || null;
  }
}

const nowIso = () => new Date().toISOString();
const uid = (p) => `${p}_${crypto.randomUUID()}`;

class KillSwitch {
  constructor(store, options) {
    options = options || {};
    if (!store) throw new KillSwitchError('store required', 'bad_store');
    this.store = store;
    this.authFn = typeof options.authFn === 'function' ? options.authFn : null;
    this.haltListeners = [];
    this.resumeListeners = [];
  }

  isHalted() {
    return this.store.getGlobalHalt() === '1';
  }

  status() {
    const halted = this.isHalted();
    const events = this.store.killSwitchEventsList({});
    const last = events[events.length - 1] || null;
    return {
      halted,
      reason: last && last.action === 'halt' ? last.reason : null,
      operator: last && last.action === 'halt' ? last.operator : null,
      since: last && last.action === 'halt' ? last.timestamp : null,
      last_event: last,
    };
  }

  halt(operator, reason) {
    if (!operator) throw new KillSwitchError('operator required', 'bad_operator');
    if (!reason) throw new KillSwitchError('reason required', 'bad_reason');
    if (this.isHalted()) {
      throw new KillSwitchError('already halted', 'already_halted');
    }
    this.store.setGlobalHalt('1');
    const event = {
      id: uid('kse'),
      action: 'halt',
      operator: String(operator),
      reason: String(reason),
      timestamp: nowIso(),
    };
    this.store.killSwitchEventsInsert(event);
    for (const fn of this.haltListeners) {
      try { fn(event); } catch { /* swallow listener errors */ }
    }
    return event;
  }

  resume(operator, reason, credential) {
    if (!operator) throw new KillSwitchError('operator required', 'bad_operator');
    if (!reason) throw new KillSwitchError('reason required', 'bad_reason');
    if (!this.isHalted()) {
      throw new KillSwitchError('not halted', 'not_halted');
    }
    if (typeof this.authFn !== 'function') {
      throw new KillSwitchError('re-auth function not configured', 'no_authfn');
    }
    let ok = false;
    try { ok = this.authFn(credential, operator) === true; } catch { ok = false; }
    if (!ok) {
      throw new KillSwitchError('re-auth failed', 'auth_failed');
    }
    this.store.setGlobalHalt('0');
    const event = {
      id: uid('kse'),
      action: 'resume',
      operator: String(operator),
      reason: String(reason),
      timestamp: nowIso(),
    };
    this.store.killSwitchEventsInsert(event);
    for (const fn of this.resumeListeners) {
      try { fn(event); } catch { /* swallow listener errors */ }
    }
    return event;
  }

  onHalt(fn) {
    if (typeof fn === 'function') this.haltListeners.push(fn);
    return () => {
      const i = this.haltListeners.indexOf(fn);
      if (i >= 0) this.haltListeners.splice(i, 1);
    };
  }

  onResume(fn) {
    if (typeof fn === 'function') this.resumeListeners.push(fn);
    return () => {
      const i = this.resumeListeners.indexOf(fn);
      if (i >= 0) this.resumeListeners.splice(i, 1);
    };
  }

  assertNotHalted() {
    if (this.isHalted()) {
      const s = this.status();
      throw new HaltedError(s.reason || 'halted');
    }
  }

  history() {
    return this.store.killSwitchEventsList({});
  }
}

module.exports = { KillSwitch, KillSwitchError, HaltedError };
