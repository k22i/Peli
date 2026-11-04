// A plugin shaped like the community bundles (esbuild's IIFE, its __async
// generator helper and __toESM around require), using the host API with no
// network: cheerio, crypto-js, atob, TextDecoder, Buffer, URL and timers.
// Written for Sinag's tests.
var __provider = (() => {
  var __create = Object.create;
  var __defProp = Object.defineProperty;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __copyProps = (to, from) => {
    if ((from && typeof from === "object") || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key)) __defProp(to, key, { get: () => from[key], enumerable: true });
    }
    return to;
  };
  var __toESM = (mod) => __copyProps(__defProp(mod != null ? __create(Object.getPrototypeOf(mod)) : {}, "default", { value: mod, enumerable: true }), mod);
  var __async = (__this, __arguments, generator) =>
    new Promise((resolve, reject) => {
      var fulfilled = (value) => {
        try {
          step(generator.next(value));
        } catch (e) {
          reject(e);
        }
      };
      var rejected = (value) => {
        try {
          step(generator.throw(value));
        } catch (e) {
          reject(e);
        }
      };
      var step = (x) => (x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected));
      step((generator = generator.apply(__this, __arguments)).next());
    });

  var import_cheerio = __toESM(require("cheerio-without-node-native"));
  var import_crypto_js = __toESM(require("crypto-js"));

  var page =
    '<html><body><div id="list">' +
    '<a class="item hd" href="/v/1" data-quality="1080p">Fight Club 1080p</a>' +
    '<a class="item" href="/v/2" data-quality="720p">Fight Club 720p</a>' +
    "</div><script>var x = 1;</script></body></html>";

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getStreams(tmdbId, mediaType, season, episode) {
    return __async(this, null, function* () {
      yield sleep(5);
      const $ = import_cheerio.default.load(page);
      const key = import_crypto_js.default.enc.Utf8.parse("0123456789abcdef");
      const iv = import_crypto_js.default.enc.Utf8.parse("fedcba9876543210");
      const sealed = import_crypto_js.default.AES.encrypt("https://cdn.example.com", key, { iv }).toString();
      const host = import_crypto_js.default.AES.decrypt(sealed, key, { iv }).toString(import_crypto_js.default.enc.Utf8);
      const decoded = new TextDecoder().decode(new Uint8Array(Buffer.from(btoa("ok"), "base64")));
      const base = new URL(host);
      return $("#list a.item")
        .map((i, el) => ({
          name: "Offline",
          title: $(el).text().trim() + " " + decoded,
          quality: $(el).attr("data-quality"),
          url: new URL($(el).attr("href") + "?id=" + tmdbId + (mediaType === "tv" ? "&s=" + season + "&e=" + episode : ""), base).href,
          headers: { Referer: base.origin + "/" },
        }))
        .get();
    });
  }
  return { getStreams };
})();
if (typeof module !== "undefined" && module.exports) {
  module.exports = __provider;
}
if (__provider && __provider.getStreams) {
  if (typeof globalThis !== "undefined") globalThis.getStreams = __provider.getStreams;
}
