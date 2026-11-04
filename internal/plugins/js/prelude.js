// The globals a Nuvio plugin expects, as the community plugins use them
// (#56): fetch with Headers, Response and AbortController, timers,
// TextEncoder / TextDecoder, atob / btoa, crypto.getRandomValues, console,
// React Native's process.env, and require() for the modules Sinag has.
// Written for Sinag from how plugins behave; `host` is the Go side
// (sandbox.go) and never reaches the plugin.
(function (host, modules) {
  "use strict";
  var g = globalThis;
  function define(name, value) {
    Object.defineProperty(g, name, { value: value, writable: true, configurable: true, enumerable: false });
  }
  define("global", g);
  define("self", g);

  // console: to the sandbox's log, which Sinag only keeps when asked to.
  function show(value) {
    if (typeof value === "string") return value;
    if (value instanceof Error) return value.stack || String(value);
    try {
      var json = JSON.stringify(value);
      return json === undefined ? String(value) : json;
    } catch (e) {
      return String(value);
    }
  }
  var console = {};
  ["log", "info", "warn", "error", "debug", "trace"].forEach(function (level) {
    console[level] = function () {
      host.log(level, Array.prototype.map.call(arguments, show).join(" "));
    };
  });
  define("console", console);

  // Timers.
  function timer(repeat) {
    return function (fn, ms) {
      if (typeof fn !== "function") return 0;
      return host.setTimer(fn, Number(ms) || 0, Array.prototype.slice.call(arguments, 2), repeat);
    };
  }
  function clear(id) {
    if (typeof id === "number") host.clearTimer(id);
  }
  define("setTimeout", timer(false));
  define("setInterval", timer(true));
  define("clearTimeout", clear);
  define("clearInterval", clear);
  define("setImmediate", function (fn) {
    return g.setTimeout.apply(g, [fn, 0].concat(Array.prototype.slice.call(arguments, 1)));
  });
  define("clearImmediate", clear);
  define("queueMicrotask", function (fn) {
    Promise.resolve().then(fn);
  });
  var started = Date.now();
  define("performance", {
    now: function () {
      return Date.now() - started;
    },
  });

  // Base64 and text.
  define("atob", function (text) {
    return host.atob(String(text));
  });
  define("btoa", function (text) {
    return host.btoa(String(text));
  });
  function bufferOf(value) {
    if (value instanceof ArrayBuffer) return value;
    if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    throw new TypeError("expected an ArrayBuffer or a typed array");
  }
  class TextEncoder {
    get encoding() {
      return "utf-8";
    }
    encode(text) {
      return new Uint8Array(host.encodeUTF8(text === undefined ? "" : String(text)));
    }
    encodeInto(text, into) {
      var bytes = this.encode(text);
      var n = Math.min(bytes.length, into.length);
      into.set(bytes.subarray(0, n));
      return { read: n === bytes.length ? String(text).length : n, written: n };
    }
  }
  class TextDecoder {
    constructor(label, options) {
      this._label = label === undefined ? "utf-8" : String(label).trim().toLowerCase();
      this._fatal = Boolean(options && options.fatal);
      host.checkEncoding(this._label);
    }
    get encoding() {
      return this._label === "utf8" ? "utf-8" : this._label;
    }
    get fatal() {
      return this._fatal;
    }
    decode(input) {
      if (input === undefined || input === null) return "";
      return host.decode(bufferOf(input), this._label, this._fatal);
    }
  }
  define("TextEncoder", TextEncoder);
  define("TextDecoder", TextDecoder);

  // Random values only: no crypto.subtle, which plugins check for and do
  // without.
  define("crypto", {
    getRandomValues: function (array) {
      if (!ArrayBuffer.isView(array) || array instanceof Float32Array || array instanceof Float64Array) {
        throw new TypeError("getRandomValues needs an integer typed array");
      }
      var bytes = new Uint8Array(host.random(array.byteLength));
      new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(bytes);
      return array;
    },
    randomUUID: function () {
      return host.randomUUID();
    },
  });

  // React Native's process: an environment and nothing else.
  define("process", { env: { NODE_ENV: "production" } });

  class DOMException extends Error {
    constructor(message, name) {
      super(message === undefined ? "" : String(message));
      this.name = name === undefined ? "Error" : String(name);
    }
  }
  define("DOMException", DOMException);

  // AbortController and AbortSignal, with just enough of EventTarget.
  function abortError() {
    return new DOMException("This operation was aborted", "AbortError");
  }
  class AbortSignal {
    constructor() {
      this.aborted = false;
      this.reason = undefined;
      this.onabort = null;
      Object.defineProperty(this, "_listeners", { value: [], writable: true });
    }
    addEventListener(type, listener) {
      if (type === "abort" && typeof listener === "function") this._listeners.push(listener);
    }
    removeEventListener(type, listener) {
      this._listeners = this._listeners.filter(function (l) {
        return l !== listener;
      });
    }
    throwIfAborted() {
      if (this.aborted) throw this.reason;
    }
    _abort(reason) {
      if (this.aborted) return;
      this.aborted = true;
      this.reason = reason === undefined ? abortError() : reason;
      var event = { type: "abort", target: this };
      var self = this;
      if (typeof this.onabort === "function") {
        try {
          this.onabort(event);
        } catch (e) {}
      }
      this._listeners.slice().forEach(function (listener) {
        try {
          listener.call(self, event);
        } catch (e) {}
      });
    }
    static abort(reason) {
      var signal = new AbortSignal();
      signal._abort(reason);
      return signal;
    }
    static timeout(ms) {
      var signal = new AbortSignal();
      g.setTimeout(function () {
        signal._abort(new DOMException("The operation timed out.", "TimeoutError"));
      }, ms);
      return signal;
    }
    static any(signals) {
      var signal = new AbortSignal();
      Array.prototype.forEach.call(signals, function (s) {
        if (s.aborted) signal._abort(s.reason);
        else
          s.addEventListener("abort", function () {
            signal._abort(s.reason);
          });
      });
      return signal;
    }
  }
  class AbortController {
    constructor() {
      this.signal = new AbortSignal();
    }
    abort(reason) {
      this.signal._abort(reason);
    }
  }
  define("AbortSignal", AbortSignal);
  define("AbortController", AbortController);

  // Headers, by lower-case name, each with its values in order.
  class Headers {
    constructor(init) {
      Object.defineProperty(this, "_map", { value: new Map() });
      var self = this;
      if (init instanceof Headers) {
        init._map.forEach(function (values, name) {
          self._map.set(name, values.slice());
        });
      } else if (Array.isArray(init)) {
        init.forEach(function (pair) {
          self.append(pair[0], pair[1]);
        });
      } else if (init && typeof init === "object") {
        Object.keys(init).forEach(function (name) {
          if (init[name] !== undefined && init[name] !== null) self.append(name, init[name]);
        });
      }
    }
    append(name, value) {
      name = String(name).toLowerCase();
      var values = this._map.get(name) || [];
      values.push(String(value));
      this._map.set(name, values);
    }
    set(name, value) {
      this._map.set(String(name).toLowerCase(), [String(value)]);
    }
    get(name) {
      var values = this._map.get(String(name).toLowerCase());
      return values === undefined ? null : values.join(", ");
    }
    getSetCookie() {
      return (this._map.get("set-cookie") || []).slice();
    }
    has(name) {
      return this._map.has(String(name).toLowerCase());
    }
    delete(name) {
      this._map.delete(String(name).toLowerCase());
    }
    forEach(fn, thisArg) {
      var self = this;
      this.keys_().forEach(function (name) {
        fn.call(thisArg, self.get(name), name, self);
      });
    }
    keys_() {
      return Array.from(this._map.keys()).sort();
    }
    *entries() {
      for (var name of this.keys_()) yield [name, this.get(name)];
    }
    *keys() {
      for (var name of this.keys_()) yield name;
    }
    *values() {
      for (var name of this.keys_()) yield this.get(name);
    }
    [Symbol.iterator]() {
      return this.entries();
    }
    // Every value on its own, for the host.
    _pairs() {
      var out = [];
      this._map.forEach(function (values, name) {
        values.forEach(function (value) {
          out.push([name, value]);
        });
      });
      return out;
    }
  }
  define("Headers", Headers);

  class FormData {
    constructor() {
      Object.defineProperty(this, "_entries", { value: [], writable: true });
    }
    append(name, value) {
      this._entries.push([String(name), String(value)]);
    }
    set(name, value) {
      this.delete(name);
      this.append(name, value);
    }
    get(name) {
      var hit = this._entries.find(function (e) {
        return e[0] === String(name);
      });
      return hit ? hit[1] : null;
    }
    getAll(name) {
      return this._entries
        .filter(function (e) {
          return e[0] === String(name);
        })
        .map(function (e) {
          return e[1];
        });
    }
    has(name) {
      return this.get(name) !== null;
    }
    delete(name) {
      this._entries = this._entries.filter(function (e) {
        return e[0] !== String(name);
      });
    }
    *entries() {
      yield* this._entries.slice();
    }
    [Symbol.iterator]() {
      return this.entries();
    }
  }
  define("FormData", FormData);

  // A body as the host takes it: a string or an ArrayBuffer, and the
  // content type it implies.
  function bodyOf(body, headers) {
    if (body === undefined || body === null) return undefined;
    if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
      if (!headers.has("content-type")) headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
      return body.toString();
    }
    if (body instanceof FormData) {
      var boundary = "----SinagFormBoundary" + host.randomUUID().replace(/-/g, "");
      headers.set("content-type", "multipart/form-data; boundary=" + boundary);
      var parts = body._entries.map(function (e) {
        return "--" + boundary + '\r\nContent-Disposition: form-data; name="' + e[0].replace(/"/g, "%22") + '"\r\n\r\n' + e[1] + "\r\n";
      });
      return parts.join("") + "--" + boundary + "--\r\n";
    }
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return bufferOf(body);
    if (typeof body === "object" && typeof body.text === "function" && body._body !== undefined) return body._body;
    if (!headers.has("content-type")) headers.set("content-type", "text/plain;charset=UTF-8");
    return String(body);
  }

  class Response {
    constructor(body, init) {
      init = init || {};
      var headers = new Headers(init.headers);
      Object.defineProperty(this, "_body", {
        value: body === undefined || body === null ? new ArrayBuffer(0) : typeof body === "string" ? host.encodeUTF8(body) : bodyOf(body, headers),
        writable: true,
      });
      if (typeof this._body === "string") this._body = host.encodeUTF8(this._body);
      this.status = init.status === undefined ? 200 : Number(init.status);
      this.statusText = init.statusText === undefined ? "" : String(init.statusText);
      this.ok = this.status >= 200 && this.status < 300;
      this.headers = headers;
      this.url = "";
      this.redirected = false;
      this.type = "basic";
      this.bodyUsed = false;
    }
    _take() {
      if (this.bodyUsed) return Promise.reject(new TypeError("Body has already been consumed."));
      this.bodyUsed = true;
      return Promise.resolve(this._body);
    }
    text() {
      return this._take().then(function (body) {
        return host.decode(body, "utf-8", false);
      });
    }
    json() {
      return this.text().then(function (text) {
        return JSON.parse(text);
      });
    }
    arrayBuffer() {
      return this._take();
    }
    blob() {
      var type = this.headers.get("content-type") || "";
      return this._take().then(function (body) {
        return {
          size: body.byteLength,
          type: type,
          text: function () {
            return Promise.resolve(host.decode(body, "utf-8", false));
          },
          arrayBuffer: function () {
            return Promise.resolve(body);
          },
        };
      });
    }
    clone() {
      if (this.bodyUsed) throw new TypeError("Response body has already been used");
      var copy = new Response(this._body.slice(0), { status: this.status, statusText: this.statusText, headers: this.headers });
      copy.url = this.url;
      copy.redirected = this.redirected;
      return copy;
    }
    static json(data, init) {
      var response = new Response(JSON.stringify(data), init);
      if (!response.headers.has("content-type")) response.headers.set("content-type", "application/json");
      return response;
    }
    static error() {
      var response = new Response(null, { status: 0 });
      response.type = "error";
      return response;
    }
  }
  define("Response", Response);

  class Request {
    constructor(input, init) {
      init = init || {};
      var from = input instanceof Request ? input : null;
      this.url = from ? from.url : String(input && input.href ? input.href : input);
      this.method = String(init.method || (from && from.method) || "GET").toUpperCase();
      this.headers = new Headers(init.headers || (from && from.headers));
      this.body = init.body !== undefined ? init.body : from ? from.body : null;
      this.redirect = init.redirect || (from && from.redirect) || "follow";
      this.signal = init.signal || (from && from.signal) || new AbortSignal();
    }
  }
  define("Request", Request);

  // fetch, through the host. A redirect: "manual" request answers the 3xx
  // itself, with its Location, as Node's fetch does.
  define("fetch", function (input, init) {
    return new Promise(function (resolve, reject) {
      init = init || {};
      var from = input instanceof Request ? input : null;
      var url = typeof input === "string" ? input : input && input.href ? input.href : from ? from.url : String(input);
      var headers = new Headers(init.headers || (from && from.headers));
      var body = bodyOf(init.body !== undefined ? init.body : from ? from.body : undefined, headers);
      var signal = init.signal || (from && from.signal);
      if (signal && signal.aborted) {
        reject(signal.reason === undefined ? abortError() : signal.reason);
        return;
      }
      var call = host.fetch({
        url: url,
        method: init.method || (from && from.method) || "GET",
        headers: headers._pairs(),
        body: body,
        redirect: init.redirect || (from && from.redirect) || "follow",
      });
      var onAbort = function () {
        call.abort();
        reject(signal.reason === undefined ? abortError() : signal.reason);
      };
      if (signal) signal.addEventListener("abort", onAbort);
      call.promise.then(
        function (raw) {
          if (signal) signal.removeEventListener("abort", onAbort);
          var response = new Response(raw.body, { status: raw.status, statusText: raw.statusText, headers: raw.headers });
          response.url = raw.url;
          response.redirected = raw.redirected;
          resolve(response);
        },
        function (failure) {
          if (signal) signal.removeEventListener("abort", onAbort);
          reject(failure.kind === "abort" ? abortError() : new TypeError(failure.message));
        },
      );
    });
  });

  // require(): the modules Sinag has, under the names plugins use.
  var cache = Object.create(null);
  var aliases = { cheerio: "cheerio-without-node-native", "react-native-cheerio": "cheerio-without-node-native" };
  return function require(name) {
    var key = String(name).replace(/^node:/, "");
    if (key.indexOf("crypto-js/") === 0) key = "crypto-js";
    key = aliases[key] || key;
    var load = Object.prototype.hasOwnProperty.call(modules, key) ? modules[key] : undefined;
    if (typeof load !== "function") {
      var error = new Error("Cannot find module '" + name + "'");
      error.code = "MODULE_NOT_FOUND";
      throw error;
    }
    if (!(key in cache)) cache[key] = load();
    return cache[key];
  };
});
