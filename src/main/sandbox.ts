/**
 * Script sandbox: every script runs in a fresh QuickJS (WebAssembly) runtime with a memory limit,
 * a stack limit and an interrupt deadline. No Node APIs exist inside — only the `pm` object, `console`,
 * `atob/btoa`, `setTimeout` and JSON-string host calls (`sendRequest`, `vault.get`, `sleep`).
 * Never Node `vm`.
 */
import { getQuickJS, type QuickJSContext, type QuickJSDeferredPromise, type QuickJSHandle, type QuickJSWASMModule } from 'quickjs-emscripten'
import type { ConsoleEntry, ScriptSource, TestResult, VariableMutation } from '../shared/types'

export interface SandboxHeader {
  key: string
  value: string
  disabled?: boolean
}

export interface SandboxRequest {
  id: string
  name: string
  method: string
  url: string
  headers: SandboxHeader[]
  body: { mode: string; raw?: string; urlencoded?: SandboxHeader[]; formdata?: SandboxHeader[]; graphql?: { query: string; variables: string } }
}

export interface SandboxResponse {
  code: number
  status: string
  headers: [string, string][]
  body: string
  responseTime: number
  responseSize: number
  cookies: { name: string; value: string }[]
}

export interface ScriptVars {
  global: Record<string, string>
  collection: Record<string, string>
  environment: Record<string, string>
  data: Record<string, string>
  local: Record<string, string>
}

export interface ScriptContext {
  code: string
  source: ScriptSource
  request: SandboxRequest
  response?: SandboxResponse
  vars: ScriptVars
  info: { requestName: string; requestId: string; iteration: number; iterationCount: number; eventName: 'prerequest' | 'test' }
}

/** Shape accepted by `pm.sendRequest` after normalisation in the prelude. */
export interface SandboxSendRequest {
  url: string
  method: string
  headers: [string, string][]
  body?: string
}

export interface SandboxSendResponse {
  code: number
  status: string
  headers: [string, string][]
  body: string
  responseTime: number
}

export interface ScriptHooks {
  sendRequest(req: SandboxSendRequest): Promise<SandboxSendResponse>
  vaultGet?(ref: string): Promise<string>
}

export interface ScriptLimits {
  timeoutMs: number
  memoryLimitMb: number
}

export interface ScriptOutcome {
  tests: TestResult[]
  console: ConsoleEntry[]
  error?: string
  vars: ScriptVars
  mutations: VariableMutation[]
  request: SandboxRequest
}

let modulePromise: Promise<QuickJSWASMModule> | null = null
function quickjs(): Promise<QuickJSWASMModule> {
  if (!modulePromise) modulePromise = getQuickJS()
  return modulePromise
}

// The prelude runs inside QuickJS (trusted code, untrusted data). It builds `pm` over plain JSON state.
const PRELUDE = String.raw`
(function () {
  'use strict';
  var ctx = JSON.parse(globalThis.__courier_ctx);
  delete globalThis.__courier_ctx;
  var host = globalThis.__courier_host;
  delete globalThis.__courier_host;
  var out = { tests: [], console: [], mutations: [], pending: 0 };
  var hasOwn = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
  var asString = function (v) {
    if (v === undefined || v === null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'object') { try { return JSON.stringify(v); } catch (e) { return String(v); } }
    return String(v);
  };
  var fmt = function (v) {
    if (typeof v === 'string') return v;
    if (v === undefined) return 'undefined';
    if (typeof v === 'function') return '[Function]';
    if (v instanceof Error) return v.name + ': ' + v.message;
    try { var s = JSON.stringify(v); return s === undefined ? String(v) : s; } catch (e) { return String(v); }
  };

  // ---- console ----
  var con = {};
  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
    con[level] = function () {
      if (out.console.length >= 1000) return;
      var parts = [];
      for (var i = 0; i < arguments.length; i++) parts.push(fmt(arguments[i]));
      var msg = parts.join(' ');
      if (msg.length > 10000) msg = msg.slice(0, 10000) + '…';
      out.console.push({ level: level, message: msg, at: Date.now() });
    };
  });
  globalThis.console = con;

  // ---- variables ----
  var vars = ctx.vars;
  var scopeNames = { global: 'global', collection: 'collection', environment: 'environment', local: 'local' };
  function resolveStr(str) {
    if (typeof str !== 'string') return str;
    return str.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, function (m, name) {
      var v = variablesGet(name.trim());
      return v === undefined ? m : asString(v);
    });
  }
  function variablesGet(k) {
    var order = ['local', 'data', 'environment', 'collection', 'global'];
    for (var i = 0; i < order.length; i++) if (hasOwn(vars[order[i]], k)) return vars[order[i]][k];
    return undefined;
  }
  function scope(name) {
    var store = vars[name];
    var api = {
      get: function (k) { return hasOwn(store, k) ? store[k] : undefined; },
      has: function (k) { return hasOwn(store, k); },
      set: function (k, v) {
        k = String(k);
        store[k] = v;
        out.mutations.push({ scope: scopeNames[name], key: k, action: 'set', value: asString(v) });
      },
      unset: function (k) {
        k = String(k);
        delete store[k];
        out.mutations.push({ scope: scopeNames[name], key: k, action: 'unset' });
      },
      clear: function () { Object.keys(store).forEach(function (k) { api.unset(k); }); },
      toObject: function () { var o = {}; Object.keys(store).forEach(function (k) { o[k] = store[k]; }); return o; },
      replaceIn: resolveStr
    };
    return api;
  }

  // ---- property lists (headers, query) ----
  function PropertyList(items, caseInsensitive, readOnly) {
    var norm = function (k) { return caseInsensitive ? String(k).toLowerCase() : String(k); };
    var find = function (k) {
      for (var i = 0; i < items.length; i++) if (!items[i].disabled && norm(items[i].key) === norm(k)) return i;
      return -1;
    };
    var toItem = function (x, v) {
      if (typeof x === 'string' && v === undefined) {
        var idx = x.indexOf(':');
        return idx < 0 ? { key: x.trim(), value: '' } : { key: x.slice(0, idx).trim(), value: x.slice(idx + 1).trim() };
      }
      if (typeof x === 'string') return { key: x, value: asString(v) };
      return { key: String(x.key), value: asString(x.value), disabled: !!x.disabled };
    };
    var guard = function () { if (readOnly) throw new Error('This list is read-only here.'); };
    return {
      get: function (k) { var i = find(k); return i < 0 ? undefined : items[i].value; },
      has: function (k, v) { var i = find(k); return i >= 0 && (v === undefined || items[i].value === v); },
      one: function (k) { var i = find(k); return i < 0 ? undefined : { key: items[i].key, value: items[i].value }; },
      all: function () { return items.filter(function (h) { return !h.disabled; }).map(function (h) { return { key: h.key, value: h.value }; }); },
      count: function () { return items.filter(function (h) { return !h.disabled; }).length; },
      each: function (fn) { items.filter(function (h) { return !h.disabled; }).forEach(function (h) { fn({ key: h.key, value: h.value }); }); },
      toObject: function () { var o = {}; items.forEach(function (h) { if (!h.disabled) o[caseInsensitive ? h.key.toLowerCase() : h.key] = h.value; }); return o; },
      add: function (x, v) { guard(); items.push(toItem(x, v)); },
      upsert: function (x, v) { guard(); var it = toItem(x, v); var i = find(it.key); if (i < 0) items.push(it); else items[i].value = it.value; },
      remove: function (k) { guard(); for (var i = items.length - 1; i >= 0; i--) if (norm(items[i].key) === norm(typeof k === 'object' ? k.key : k)) items.splice(i, 1); },
      clear: function () { guard(); items.length = 0; },
      toString: function () { return items.filter(function (h) { return !h.disabled; }).map(function (h) { return h.key + ': ' + h.value; }).join('\n'); }
    };
  }

  // ---- assertions (chai-like BDD subset) ----
  function AssertionError(message) { this.name = 'AssertionError'; this.message = message; }
  AssertionError.prototype = Object.create(Error.prototype);
  AssertionError.prototype.constructor = AssertionError;

  function typeOf(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    if (v instanceof RegExp) return 'regexp';
    if (v instanceof Date) return 'date';
    return typeof v;
  }
  function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a === 'number' && typeof b === 'number' && isNaN(a) && isNaN(b)) return true;
    if (typeOf(a) !== typeOf(b)) return false;
    if (Array.isArray(a)) {
      if (a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
      return true;
    }
    if (a instanceof Date) return a.getTime() === b.getTime();
    if (a && typeof a === 'object') {
      var ka = Object.keys(a), kb = Object.keys(b);
      if (ka.length !== kb.length) return false;
      for (var j = 0; j < ka.length; j++) if (!hasOwn(b, ka[j]) || !deepEqual(a[ka[j]], b[ka[j]])) return false;
      return true;
    }
    return false;
  }
  function show(v) {
    var s = fmt(v);
    if (typeof v === 'string') s = "'" + v + "'";
    return s.length > 200 ? s.slice(0, 200) + '…' : s;
  }
  function getPath(obj, path) {
    var parts = String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter(function (p) { return p !== ''; });
    var cur = obj;
    for (var i = 0; i < parts.length; i++) {
      if (cur === null || cur === undefined || !(typeof cur === 'object' || typeof cur === 'string') || !(parts[i] in Object(cur))) return { found: false };
      cur = cur[parts[i]];
    }
    return { found: true, value: cur };
  }

  function Assertion(obj, msg) { this._obj = obj; this._msg = msg; this._neg = false; this._deep = false; this._nested = false; }
  var A = Assertion.prototype;
  A._assert = function (cond, positive, negative) {
    var ok = this._neg ? !cond : !!cond;
    if (!ok) throw new AssertionError((this._msg ? this._msg + ': ' : '') + (this._neg ? negative : positive));
    return this;
  };
  ['to', 'be', 'been', 'is', 'that', 'which', 'and', 'has', 'have', 'with', 'at', 'of', 'same', 'but', 'does', 'still', 'also'].forEach(function (w) {
    Object.defineProperty(A, w, { get: function () { return this; } });
  });
  Object.defineProperty(A, 'not', { get: function () { this._neg = !this._neg; return this; } });
  Object.defineProperty(A, 'deep', { get: function () { this._deep = true; return this; } });
  Object.defineProperty(A, 'nested', { get: function () { this._nested = true; return this; } });
  Object.defineProperty(A, 'own', { get: function () { return this; } });
  Object.defineProperty(A, 'any', { get: function () { return this; } });
  Object.defineProperty(A, 'all', { get: function () { return this; } });
  var flag = function (name, test, what) {
    Object.defineProperty(A, name, { get: function () {
      var o = this._obj;
      return this._assert(test(o), 'expected ' + show(o) + ' to be ' + what, 'expected ' + show(o) + ' not to be ' + what);
    } });
  };
  flag('ok', function (o) { return !!o; }, 'truthy');
  flag('true', function (o) { return o === true; }, 'true');
  flag('false', function (o) { return o === false; }, 'false');
  flag('null', function (o) { return o === null; }, 'null');
  flag('undefined', function (o) { return o === undefined; }, 'undefined');
  flag('NaN', function (o) { return typeof o === 'number' && isNaN(o); }, 'NaN');
  flag('exist', function (o) { return o !== null && o !== undefined; }, 'existing');
  flag('empty', function (o) {
    if (typeof o === 'string' || Array.isArray(o)) return o.length === 0;
    if (o && typeof o === 'object') return Object.keys(o).length === 0;
    return false;
  }, 'empty');
  A.equal = A.equals = A.eq = function (v) {
    var o = this._obj;
    return this._assert(this._deep ? deepEqual(o, v) : o === v, 'expected ' + show(o) + ' to ' + (this._deep ? 'deeply ' : '') + 'equal ' + show(v), 'expected ' + show(o) + ' not to equal ' + show(v));
  };
  A.eql = function (v) { this._deep = true; return this.equal(v); };
  A.above = A.gt = A.greaterThan = function (n) { return this._assert(this._obj > n, 'expected ' + show(this._obj) + ' to be above ' + n, 'expected ' + show(this._obj) + ' to be at most ' + n); };
  A.below = A.lt = A.lessThan = function (n) { return this._assert(this._obj < n, 'expected ' + show(this._obj) + ' to be below ' + n, 'expected ' + show(this._obj) + ' to be at least ' + n); };
  A.least = A.gte = function (n) { return this._assert(this._obj >= n, 'expected ' + show(this._obj) + ' to be at least ' + n, 'expected ' + show(this._obj) + ' to be below ' + n); };
  A.most = A.lte = function (n) { return this._assert(this._obj <= n, 'expected ' + show(this._obj) + ' to be at most ' + n, 'expected ' + show(this._obj) + ' to be above ' + n); };
  A.within = function (lo, hi) { var o = this._obj; return this._assert(o >= lo && o <= hi, 'expected ' + show(o) + ' to be within ' + lo + '..' + hi, 'expected ' + show(o) + ' not to be within ' + lo + '..' + hi); };
  A.closeTo = A.approximately = function (v, d) { var o = this._obj; return this._assert(Math.abs(o - v) <= d, 'expected ' + show(o) + ' to be close to ' + v + ' +/- ' + d, 'expected ' + show(o) + ' not to be close to ' + v); };
  A.a = A.an = function (type) {
    var t = typeOf(this._obj), want = String(type).toLowerCase();
    return this._assert(t === want, 'expected ' + show(this._obj) + ' to be a' + (/^[aeiou]/.test(want) ? 'n ' : ' ') + want, 'expected ' + show(this._obj) + ' not to be a ' + want);
  };
  A.instanceOf = A.instanceof = function (C) { return this._assert(this._obj instanceof C, 'expected ' + show(this._obj) + ' to be an instance of ' + (C && C.name), 'expected ' + show(this._obj) + ' not to be an instance of ' + (C && C.name)); };
  A.include = A.includes = A.contain = A.contains = function (v) {
    var o = this._obj, self = this, ok;
    if (typeof o === 'string') ok = o.indexOf(String(v)) >= 0;
    else if (Array.isArray(o)) ok = o.some(function (x) { return self._deep ? deepEqual(x, v) : x === v; });
    else if (o && typeof o === 'object' && v && typeof v === 'object') ok = Object.keys(v).every(function (k) { return hasOwn(o, k) && (self._deep ? deepEqual(o[k], v[k]) : o[k] === v[k]); });
    else ok = false;
    return this._assert(ok, 'expected ' + show(o) + ' to include ' + show(v), 'expected ' + show(o) + ' not to include ' + show(v));
  };
  A.property = function (name, value) {
    var o = this._obj, found, val;
    if (this._nested) { var r = getPath(o, name); found = r.found; val = r.value; }
    else { found = o !== null && o !== undefined && (name in Object(o)); val = found ? o[name] : undefined; }
    if (arguments.length > 1) {
      var match = found && (this._deep ? deepEqual(val, value) : val === value);
      this._assert(match, 'expected ' + show(o) + ' to have property ' + show(name) + ' of ' + show(value) + (found ? ', but got ' + show(val) : ''), 'expected ' + show(o) + ' not to have property ' + show(name) + ' of ' + show(value));
    } else this._assert(found, 'expected ' + show(o) + ' to have property ' + show(name), 'expected ' + show(o) + ' not to have property ' + show(name));
    if (!this._neg) this._obj = val;
    return this;
  };
  A.nestedProperty = function (name, value) { this._nested = true; return arguments.length > 1 ? this.property(name, value) : this.property(name); };
  A.lengthOf = A.length = function (n) {
    var len = this._obj === null || this._obj === undefined ? undefined : (this._obj.length !== undefined ? this._obj.length : (this._obj.size));
    return this._assert(len === n, 'expected ' + show(this._obj) + ' to have length ' + n + ' but got ' + len, 'expected ' + show(this._obj) + ' not to have length ' + n);
  };
  A.match = A.matches = function (re) { return this._assert(re.test(String(this._obj)), 'expected ' + show(this._obj) + ' to match ' + re, 'expected ' + show(this._obj) + ' not to match ' + re); };
  A.string = function (s) { return this._assert(typeof this._obj === 'string' && this._obj.indexOf(s) >= 0, 'expected ' + show(this._obj) + ' to contain ' + show(s), 'expected ' + show(this._obj) + ' not to contain ' + show(s)); };
  A.oneOf = function (list) { var o = this._obj, self = this; return this._assert(list.some(function (x) { return self._deep ? deepEqual(x, o) : x === o; }), 'expected ' + show(o) + ' to be one of ' + show(list), 'expected ' + show(o) + ' not to be one of ' + show(list)); };
  A.keys = A.key = function () {
    var want = Array.isArray(arguments[0]) ? arguments[0] : Array.prototype.slice.call(arguments);
    var o = this._obj || {};
    var ok = want.every(function (k) { return hasOwn(o, k); });
    return this._assert(ok, 'expected ' + show(o) + ' to have keys ' + show(want), 'expected ' + show(o) + ' not to have keys ' + show(want));
  };
  A.members = function (list) {
    var o = this._obj || [], self = this;
    var eq = function (a, b) { return self._deep ? deepEqual(a, b) : a === b; };
    var ok = Array.isArray(o) && o.length === list.length && list.every(function (x) { return o.some(function (y) { return eq(x, y); }); });
    return this._assert(ok, 'expected ' + show(o) + ' to have the same members as ' + show(list), 'expected ' + show(o) + ' not to have the same members as ' + show(list));
  };
  A.satisfy = A.satisfies = function (fn) { return this._assert(!!fn(this._obj), 'expected ' + show(this._obj) + ' to satisfy the predicate', 'expected ' + show(this._obj) + ' not to satisfy the predicate'); };
  A.throw = A.throws = A.Throw = function (expected) {
    var threw = false, err;
    try { this._obj(); } catch (e) { threw = true; err = e; }
    var ok = threw;
    if (threw && expected !== undefined) {
      var m = err && err.message !== undefined ? err.message : String(err);
      ok = expected instanceof RegExp ? expected.test(m) : typeof expected === 'string' ? m.indexOf(expected) >= 0 : typeof expected === 'function' ? err instanceof expected : true;
    }
    return this._assert(ok, 'expected function to throw' + (expected !== undefined ? ' ' + show(expected) : ''), 'expected function not to throw');
  };
  // Postman response assertions (pm.response.to.have.status(...) and pm.expect(pm.response).to.have.status)
  A.status = function (s) {
    var r = this._obj || {};
    var ok = typeof s === 'number' ? r.code === s : r.status === s;
    return this._assert(ok, 'expected response to have status ' + (typeof s === 'number' ? 'code ' : 'reason ') + show(s) + ' but got ' + (typeof s === 'number' ? r.code : show(r.status)), 'expected response not to have status ' + show(s));
  };
  A.header = function (name, value) {
    var r = this._obj || {}, v = r.headers ? r.headers.get(name) : undefined;
    if (arguments.length > 1) return this._assert(v === value, 'expected response to have header ' + name + ' with value ' + show(value) + ' but got ' + show(v), 'expected response not to have header ' + name + ' with value ' + show(value));
    return this._assert(v !== undefined, 'expected response to have header ' + name, 'expected response not to have header ' + name);
  };
  A.body = function (expected) {
    var r = this._obj || {}, text = r.text ? r.text() : '';
    if (arguments.length === 0) return this._assert(text.length > 0, 'expected response to have a body', 'expected response not to have a body');
    var ok = expected instanceof RegExp ? expected.test(text) : text === expected;
    return this._assert(ok, 'expected response body to match ' + show(expected), 'expected response body not to match ' + show(expected));
  };
  A.jsonBody = function (path, value) {
    var r = this._obj || {}, json;
    try { json = r.json(); } catch (e) { return this._assert(false, 'expected response to have a JSON body', ''); }
    if (arguments.length === 0) return this._assert(true, '', 'expected response not to have a JSON body');
    var g = getPath(json, path);
    if (arguments.length === 1) return this._assert(g.found, 'expected response JSON to have path ' + show(path), 'expected response JSON not to have path ' + show(path));
    return this._assert(g.found && deepEqual(g.value, value), 'expected response JSON at ' + show(path) + ' to equal ' + show(value) + ' but got ' + show(g.value), 'expected response JSON at ' + show(path) + ' not to equal ' + show(value));
  };
  Object.defineProperty(A, 'json', { get: function () {
    var r = this._obj || {}, ok = true;
    try { r.json(); } catch (e) { ok = false; }
    return this._assert(ok, 'expected response body to be JSON', 'expected response body not to be JSON');
  } });
  var statusFlag = function (name, lo, hi) {
    Object.defineProperty(A, name, { get: function () {
      var c = (this._obj || {}).code;
      return this._assert(c >= lo && c <= hi, 'expected response code to be ' + name + ' (' + lo + '-' + hi + ') but got ' + c, 'expected response code not to be ' + name + ' but got ' + c);
    } });
  };
  statusFlag('success', 200, 299);
  statusFlag('info', 100, 199);
  statusFlag('redirection', 300, 399);
  statusFlag('clientError', 400, 499);
  statusFlag('serverError', 500, 599);
  statusFlag('error', 400, 599);

  var expect = function (v, msg) { return new Assertion(v, msg); };
  expect.fail = function (msg) { throw new AssertionError(msg || 'expect.fail()'); };

  // ---- request ----
  var req = ctx.request;
  var isPre = ctx.info.eventName === 'prerequest';
  var urlObj = {
    toString: function () { return req.url; },
    update: function (u) { if (!isPre) throw new Error('pm.request.url is read-only in test scripts.'); req.url = String(u); },
    getHost: function () { var m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#:]*)/i.exec(req.url); return m ? m[1] : ''; },
    getPath: function () { var m = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/i.exec(req.url); return m ? (m[1] || '/') : ''; },
    getQueryString: function () { var i = req.url.indexOf('?'); return i < 0 ? '' : req.url.slice(i + 1).split('#')[0]; }
  };
  var pmRequest = {
    id: req.id,
    name: req.name,
    get url() { return urlObj; },
    set url(u) { urlObj.update(u); },
    get method() { return req.method; },
    set method(m) { if (!isPre) throw new Error('pm.request.method is read-only in test scripts.'); req.method = String(m).toUpperCase(); },
    headers: PropertyList(req.headers, true, !isPre),
    body: req.body,
    addHeader: function (h) { pmRequest.headers.add(h); },
    removeHeader: function (k) { pmRequest.headers.remove(k); },
    upsertHeader: function (h) { pmRequest.headers.upsert(h); },
    toJSON: function () { return { method: req.method, url: req.url, headers: req.headers, body: req.body }; }
  };

  // ---- response ----
  function makeResponse(r) {
    var headerItems = r.headers.map(function (h) { return { key: h[0], value: h[1] }; });
    var res = {
      code: r.code,
      status: r.status,
      responseTime: r.responseTime,
      responseSize: r.responseSize || (r.body ? r.body.length : 0),
      headers: PropertyList(headerItems, true, true),
      cookies: PropertyList((r.cookies || []).map(function (c) { return { key: c.name, value: c.value }; }), false, true),
      text: function () { return r.body; },
      json: function () { return JSON.parse(r.body); },
      reason: function () { return r.status; }
    };
    var to = new Assertion(res);
    Object.defineProperty(res, 'to', { get: function () { return new Assertion(res); } });
    void to;
    return res;
  }

  // ---- async host bridge ----
  function hostCall(op, payload) {
    out.pending++;
    return host(op, JSON.stringify(payload === undefined ? null : payload)).then(function (s) {
      out.pending--;
      var r = JSON.parse(s);
      if (r.error) { var err = new Error(r.error); if (r.code) err.code = r.code; throw err; }
      return r.value;
    }, function (e) { out.pending--; throw e; });
  }

  function normalizeSend(input) {
    if (typeof input === 'string') return { url: input, method: 'GET', headers: [] };
    var o = input || {};
    var headers = [];
    var h = o.header || o.headers;
    if (Array.isArray(h)) h.forEach(function (x) { if (typeof x === 'string') { var i = x.indexOf(':'); headers.push([x.slice(0, i).trim(), x.slice(i + 1).trim()]); } else if (x && !x.disabled) headers.push([String(x.key), asString(x.value)]); });
    else if (h && typeof h === 'object') Object.keys(h).forEach(function (k) { headers.push([k, asString(h[k])]); });
    var body;
    var b = o.body;
    if (typeof b === 'string') body = b;
    else if (b && b.mode === 'raw') body = asString(b.raw);
    else if (b && b.mode === 'urlencoded') {
      body = (b.urlencoded || []).filter(function (x) { return !x.disabled; }).map(function (x) { return encodeURIComponent(x.key) + '=' + encodeURIComponent(asString(x.value)); }).join('&');
      if (!headers.some(function (x) { return x[0].toLowerCase() === 'content-type'; })) headers.push(['Content-Type', 'application/x-www-form-urlencoded']);
    }
    else if (b && b.mode === 'graphql') {
      body = JSON.stringify({ query: b.graphql && b.graphql.query, variables: b.graphql && b.graphql.variables });
      if (!headers.some(function (x) { return x[0].toLowerCase() === 'content-type'; })) headers.push(['Content-Type', 'application/json']);
    }
    var url = typeof o.url === 'string' ? o.url : (o.url && o.url.toString ? o.url.toString() : '');
    return { url: url, method: String(o.method || 'GET').toUpperCase(), headers: headers, body: body };
  }

  var pm = {
    environment: scope('environment'),
    globals: scope('global'),
    collectionVariables: scope('collection'),
    variables: (function () {
      var local = scope('local');
      return {
        get: function (k) { return variablesGet(k); },
        has: function (k) { return variablesGet(k) !== undefined; },
        set: local.set,
        unset: local.unset,
        toObject: function () {
          var o = {};
          ['global', 'collection', 'environment', 'data', 'local'].forEach(function (s) { Object.keys(vars[s]).forEach(function (k) { o[k] = vars[s][k]; }); });
          return o;
        },
        replaceIn: resolveStr
      };
    })(),
    iterationData: (function () {
      var d = vars.data;
      return {
        get: function (k) { return hasOwn(d, k) ? d[k] : undefined; },
        has: function (k) { return hasOwn(d, k); },
        toObject: function () { var o = {}; Object.keys(d).forEach(function (k) { o[k] = d[k]; }); return o; },
        toJSON: function () { return this.toObject(); }
      };
    })(),
    info: ctx.info,
    request: pmRequest,
    expect: expect,
    test: function (name, fn) {
      var record = function (passed, err) {
        var t = { name: String(name), passed: passed };
        if (err !== undefined) t.error = (err && err.message !== undefined) ? String(err.message) : String(err);
        out.tests.push(t);
      };
      try {
        var r = typeof fn === 'function' ? fn() : undefined;
        if (r && typeof r.then === 'function') {
          out.pending++;
          r.then(function () { out.pending--; record(true); }, function (e) { out.pending--; record(false, e); });
        } else record(true);
      } catch (e) { record(false, e); }
    },
    sendRequest: function (input, cb) {
      var p = hostCall('sendRequest', normalizeSend(input)).then(function (r) { return makeResponse(r); });
      if (typeof cb === 'function') {
        p.then(function (res) {
          try { cb(null, res); } catch (e) { console.error('Error in sendRequest callback: ' + fmt(e)); }
        }, function (e) {
          try { cb(e, null); } catch (e2) { console.error('Error in sendRequest callback: ' + fmt(e2)); }
        });
      }
      return p;
    },
    vault: {
      get: function (name) { return hostCall('vaultGet', String(name)); }
    }
  };
  pm.test.skip = function () {};
  if (ctx.response) pm.response = makeResponse(ctx.response);

  globalThis.pm = pm;
  globalThis.setTimeout = function (fn, ms) {
    hostCall('sleep', Number(ms) || 0).then(function () { if (typeof fn === 'function') fn(); });
    return 0;
  };
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  globalThis.btoa = function (s) {
    s = String(s); var o = '';
    for (var i = 0; i < s.length; i += 3) {
      var a = s.charCodeAt(i), b = s.charCodeAt(i + 1), c = s.charCodeAt(i + 2);
      if (a > 255 || b > 255 || c > 255) throw new Error('btoa: invalid character');
      var n = (a << 16) | ((b || 0) << 8) | (c || 0);
      o += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < s.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < s.length ? B64[n & 63] : '=');
    }
    return o;
  };
  globalThis.atob = function (s) {
    s = String(s).replace(/[\s=]/g, ''); var o = '';
    for (var i = 0; i < s.length; i += 4) {
      var n = (B64.indexOf(s[i]) << 18) | (B64.indexOf(s[i + 1]) << 12) | ((B64.indexOf(s[i + 2]) & 63) << 6) | (B64.indexOf(s[i + 3]) & 63);
      o += String.fromCharCode((n >> 16) & 255);
      if (i + 2 < s.length) o += String.fromCharCode((n >> 8) & 255);
      if (i + 3 < s.length) o += String.fromCharCode(n & 255);
    }
    return o;
  };

  globalThis.__courier_out = function () {
    var plain = function (store) { var o = {}; Object.keys(store).forEach(function (k) { o[k] = asString(store[k]); }); return o; };
    return JSON.stringify({
      tests: out.tests,
      console: out.console,
      mutations: out.mutations,
      vars: { global: plain(vars.global), collection: plain(vars.collection), environment: plain(vars.environment), data: plain(vars.data), local: plain(vars.local) },
      request: req
    });
  };
})();
`

function cloneVars(v: ScriptVars): ScriptVars {
  return { global: { ...v.global }, collection: { ...v.collection }, environment: { ...v.environment }, data: { ...v.data }, local: { ...v.local } }
}

function describeError(vm: QuickJSContext, handle: Parameters<QuickJSContext['dump']>[0]): string {
  try {
    const e = vm.dump(handle) as unknown
    if (e && typeof e === 'object') {
      const o = e as { name?: string; message?: string }
      if (o.message !== undefined) return `${o.name ?? 'Error'}: ${o.message}`
    }
    return String(e)
  } catch {
    return 'Script error'
  }
}

function friendly(msg: string, limits: ScriptLimits): string {
  if (/interrupted/i.test(msg)) return `Script exceeded the time limit of ${limits.timeoutMs} ms and was stopped.`
  if (/out of memory/i.test(msg)) return `Script exceeded the memory limit of ${limits.memoryLimitMb} MB and was stopped.`
  if (/stack overflow/i.test(msg)) return 'Script exceeded the maximum call stack size.'
  return msg
}

/** Runs one script. Never throws for script failures — they come back in `outcome.error`. */
export async function runScript(ctx: ScriptContext, hooks: ScriptHooks, limits: ScriptLimits): Promise<ScriptOutcome> {
  const fallback: ScriptOutcome = { tests: [], console: [], vars: cloneVars(ctx.vars), mutations: [], request: structuredClone(ctx.request) }
  if (!ctx.code.trim()) return fallback

  const QuickJS = await quickjs()
  const runtime = QuickJS.newRuntime()
  runtime.setMemoryLimit(limits.memoryLimitMb * 1024 * 1024)
  runtime.setMaxStackSize(1024 * 1024)
  const deadline = Date.now() + limits.timeoutMs
  let interruptAt = deadline
  runtime.setInterruptHandler(() => Date.now() > interruptAt)
  const vm = runtime.newContext()
  const deferreds = new Set<QuickJSDeferredPromise>()
  let error: string | undefined
  let outcome: ScriptOutcome = fallback
  const inflight = new Set<Promise<void>>()
  let outFn: QuickJSHandle | undefined

  try {
    const ctxHandle = vm.newString(
      JSON.stringify({ vars: ctx.vars, request: ctx.request, response: ctx.response ?? null, info: ctx.info })
    )
    vm.setProp(vm.global, '__courier_ctx', ctxHandle)
    ctxHandle.dispose()

    const hostFn = vm.newFunction('__courier_host', (opHandle, argHandle) => {
      const op = vm.getString(opHandle)
      const arg = JSON.parse(vm.getString(argHandle)) as unknown
      const deferred = vm.newPromise()
      deferreds.add(deferred)
      const settle = (payload: { value?: unknown; error?: string; code?: string }): void => {
        if (!deferred.alive) return
        const h = vm.newString(JSON.stringify(payload))
        deferred.resolve(h)
        h.dispose()
      }
      let work: Promise<unknown>
      if (op === 'sendRequest') work = hooks.sendRequest(arg as SandboxSendRequest)
      else if (op === 'vaultGet')
        work = hooks.vaultGet ? hooks.vaultGet(String(arg)) : Promise.reject(new Error('pm.vault is not available.'))
      else if (op === 'sleep') work = new Promise((r) => setTimeout(r, Math.max(0, Math.min(Number(arg) || 0, Math.max(0, deadline - Date.now())))))
      else work = Promise.reject(new Error(`Unknown host operation ${op}`))
      const p = work.then(
        (value) => settle({ value: value ?? null }),
        (err: unknown) => {
          const code = (err as { code?: unknown } | null)?.code
          settle({ error: err instanceof Error ? err.message : String(err), ...(typeof code === 'string' ? { code } : {}) })
        }
      )
      inflight.add(p)
      void p.finally(() => inflight.delete(p))
      return deferred.handle
    })
    vm.setProp(vm.global, '__courier_host', hostFn)
    hostFn.dispose()

    const pre = vm.evalCode(PRELUDE, 'courier-prelude.js')
    if (pre.error) {
      const msg = describeError(vm, pre.error)
      pre.error.dispose()
      throw new Error(`Sandbox prelude failed: ${msg}`)
    }
    pre.value.dispose()
    // Keep host-side references so user code cannot replace the result collector.
    outFn = vm.getProp(vm.global, '__courier_out')
    const del = vm.evalCode('delete globalThis.__courier_out;')
    if (del.error) del.error.dispose()
    else del.value.dispose()

    const res = vm.evalCode(ctx.code, `${ctx.source.level}-${ctx.source.phase}.js`)
    if (res.error) {
      error = friendly(describeError(vm, res.error), limits)
      res.error.dispose()
    } else res.value.dispose()

    const pump = (): void => {
      const r = runtime.executePendingJobs()
      if (r.error) {
        if (!error) error = friendly(describeError(vm, r.error), limits)
        r.error.dispose()
      }
    }
    pump()
    // Drive async host calls (pm.sendRequest, setTimeout, pm.vault.get) until the script is idle.
    while (inflight.size > 0) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        error = error ?? `Script exceeded the time limit of ${limits.timeoutMs} ms while waiting for async work.`
        break
      }
      let timer: NodeJS.Timeout | undefined
      await Promise.race([...inflight, new Promise<void>((r) => (timer = setTimeout(r, remaining)))])
      if (timer) clearTimeout(timer)
      pump()
    }
    pump()

    // Collect results with a fresh, short budget (the user deadline may already have passed).
    interruptAt = Date.now() + 2000
    runtime.setMemoryLimit((limits.memoryLimitMb + 32) * 1024 * 1024)
    if (!outFn) throw new Error('Sandbox not initialised')
    const o = vm.callFunction(outFn, vm.undefined)
    if (o.error) {
      const msg = describeError(vm, o.error)
      o.error.dispose()
      error = error ?? friendly(msg, limits)
    } else {
      const parsed = JSON.parse(vm.getString(o.value)) as {
        tests: { name: string; passed: boolean; error?: string }[]
        console: { level: ConsoleEntry['level']; message: string; at: number }[]
        mutations: VariableMutation[]
        vars: ScriptVars
        request: SandboxRequest
      }
      o.value.dispose()
      outcome = {
        tests: parsed.tests.map((t) => ({ ...t, source: ctx.source })),
        console: parsed.console.map((c) => ({ ...c, source: ctx.source })),
        mutations: parsed.mutations,
        vars: parsed.vars,
        request: parsed.request
      }
    }
  } catch (err) {
    error = error ?? friendly(err instanceof Error ? err.message : String(err), limits)
  } finally {
    for (const d of deferreds) if (d.alive) d.dispose()
    if (outFn?.alive) outFn.dispose()
    try {
      vm.dispose()
    } catch {
      /* ignore */
    }
    try {
      runtime.dispose()
    } catch {
      /* ignore */
    }
  }
  if (error) outcome.error = error
  return outcome
}
