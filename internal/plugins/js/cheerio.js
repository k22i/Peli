// cheerio-without-node-native, as plugins use it (#56): load(html) gives a
// $ that selects with CSS, and selections with jQuery's reading methods
// (find, each, map, attr, text, html, first, next, closest…). Written for
// Sinag; parsing and selector matching are Go's (html.go), where a node is
// a number within its document. Elements look like htmlparser2's: type,
// name, attribs, data, parent, children, next, prev.
(function (host) {
  "use strict";

  function Doc(handle) {
    this.h = handle;
    this.els = [];
  }
  Doc.prototype.el = function (id) {
    if (id === undefined || id === null || id < 0) return null;
    var el = this.els[id];
    if (!el) {
      el = element(this, id);
      this.els[id] = el;
    }
    return el;
  };

  var nodeTypes = { tag: 1, script: 1, style: 1, text: 3, comment: 8, directive: 10, root: 9 };
  var ElementProto = {};
  function getter(name, fn) {
    Object.defineProperty(ElementProto, name, { get: fn, configurable: true });
  }
  getter("parent", function () {
    return this.__doc.el(this.__doc.h.parent(this.__id));
  });
  getter("parentNode", function () {
    return this.parent;
  });
  getter("children", function () {
    var doc = this.__doc;
    return doc.h.children(this.__id).map(function (id) {
      return doc.el(id);
    });
  });
  getter("childNodes", function () {
    return this.children;
  });
  getter("firstChild", function () {
    var c = this.children;
    return c.length ? c[0] : null;
  });
  getter("lastChild", function () {
    var c = this.children;
    return c.length ? c[c.length - 1] : null;
  });
  getter("next", function () {
    return this.__doc.el(this.__doc.h.nextNode(this.__id));
  });
  getter("nextSibling", function () {
    return this.next;
  });
  getter("prev", function () {
    return this.__doc.el(this.__doc.h.prevNode(this.__id));
  });
  getter("previousSibling", function () {
    return this.prev;
  });
  getter("nodeType", function () {
    return nodeTypes[this.type] || 1;
  });

  function element(doc, id) {
    var info = doc.h.info(id);
    var el = Object.create(ElementProto);
    Object.defineProperty(el, "__doc", { value: doc });
    Object.defineProperty(el, "__id", { value: id });
    el.type = info.type;
    if (info.name !== undefined) {
      el.name = info.name;
      el.tagName = info.name;
    }
    if (info.attribs !== undefined) el.attribs = info.attribs;
    if (info.data !== undefined) {
      el.data = info.data;
      el.nodeValue = info.data;
    }
    return el;
  }

  function isNode(el) {
    return Boolean(el && el.__doc);
  }
  function isTag(el) {
    return isNode(el) && (el.type === "tag" || el.type === "script" || el.type === "style");
  }
  function unique(items) {
    var out = [];
    items.forEach(function (item) {
      if (out.indexOf(item) < 0) out.push(item);
    });
    return out;
  }
  function matches(el, selector) {
    return isTag(el) && el.__doc.h.matches(el.__id, selector);
  }

  function Selection(items, doc, prev) {
    for (var i = 0; i < items.length; i++) this[i] = items[i];
    Object.defineProperty(this, "length", { value: items.length, writable: true });
    Object.defineProperty(this, "_doc", { value: doc });
    Object.defineProperty(this, "prevObject", { value: prev, writable: true });
  }
  var fn = Selection.prototype;
  fn.cheerio = "[cheerio object]";
  fn[Symbol.iterator] = Array.prototype[Symbol.iterator];
  fn._new = function (items) {
    return new Selection(items, this._doc, this);
  };
  fn._els = function () {
    return Array.prototype.slice.call(this);
  };

  // A test from a selector, a function (i, el), an element or a selection.
  function predicate(match) {
    if (typeof match === "string") {
      return function (el) {
        return matches(el, match);
      };
    }
    if (typeof match === "function") {
      return function (el, i) {
        return Boolean(match.call(el, i, el));
      };
    }
    if (match instanceof Selection) {
      var set = match._els();
      return function (el) {
        return set.indexOf(el) >= 0;
      };
    }
    if (isNode(match)) {
      return function (el) {
        return el === match;
      };
    }
    return function () {
      return false;
    };
  }
  function filtered(items, selector) {
    return selector === undefined ? items : items.filter(predicate(selector));
  }

  fn.toArray = function () {
    return this._els();
  };
  fn.get = function (i) {
    if (i === undefined || i === null) return this._els();
    i = Number(i);
    return this[i < 0 ? this.length + i : i];
  };
  fn.each = function (cb) {
    for (var i = 0; i < this.length; i++) {
      if (cb.call(this[i], i, this[i]) === false) break;
    }
    return this;
  };
  fn.map = function (cb) {
    var out = [];
    for (var i = 0; i < this.length; i++) {
      var v = cb.call(this[i], i, this[i]);
      if (v === null || v === undefined) continue;
      if (Array.isArray(v)) out.push.apply(out, v);
      else out.push(v);
    }
    return this._new(out);
  };
  fn.filter = function (match) {
    return this._new(this._els().filter(predicate(match)));
  };
  fn.not = function (match) {
    var test = predicate(match);
    return this._new(
      this._els().filter(function (el, i) {
        return !test(el, i);
      }),
    );
  };
  fn.is = function (match) {
    return this._els().some(predicate(match));
  };
  fn.has = function (selector) {
    return this.filter(function () {
      return new Selection([this], null).find(selector).length > 0;
    });
  };
  fn.find = function (selector) {
    if (selector instanceof Selection || isNode(selector)) {
      var mine = this._els();
      var wanted = selector instanceof Selection ? selector._els() : [selector];
      return this._new(
        wanted.filter(function (el) {
          for (var p = el.parent; p; p = p.parent) if (mine.indexOf(p) >= 0) return true;
          return false;
        }),
      );
    }
    var byDoc = [];
    this._els().forEach(function (el) {
      if (!isNode(el)) return;
      var group = byDoc.find(function (g) {
        return g.doc === el.__doc;
      });
      if (!group) byDoc.push((group = { doc: el.__doc, ids: [] }));
      group.ids.push(el.__id);
    });
    var out = [];
    byDoc.forEach(function (group) {
      group.doc.h.select(group.ids, String(selector)).forEach(function (id) {
        out.push(group.doc.el(id));
      });
    });
    return this._new(out);
  };
  fn.children = function (selector) {
    var out = [];
    this._els().forEach(function (el) {
      if (isNode(el)) out.push.apply(out, el.children.filter(isTag));
    });
    return this._new(filtered(out, selector));
  };
  fn.contents = function () {
    var out = [];
    this._els().forEach(function (el) {
      if (isNode(el)) out.push.apply(out, el.children);
    });
    return this._new(out);
  };
  fn.parent = function (selector) {
    var out = [];
    this._els().forEach(function (el) {
      var p = isNode(el) ? el.parent : null;
      if (p && p.type !== "root") out.push(p);
    });
    return this._new(filtered(unique(out), selector));
  };
  fn.parents = function (selector) {
    var out = [];
    this._els().forEach(function (el) {
      for (var p = isNode(el) ? el.parent : null; p && p.type !== "root"; p = p.parent) out.push(p);
    });
    return this._new(filtered(unique(out), selector));
  };
  fn.parentsUntil = function (selector) {
    var stop = predicate(selector);
    var out = [];
    this._els().forEach(function (el) {
      for (var p = isNode(el) ? el.parent : null; p && p.type !== "root" && !stop(p); p = p.parent) out.push(p);
    });
    return this._new(unique(out));
  };
  fn.closest = function (selector) {
    var test = predicate(selector);
    var out = [];
    this._els().forEach(function (el) {
      for (var p = el; p && p.type !== "root"; p = p.parent) {
        if (isTag(p) && test(p)) {
          out.push(p);
          return;
        }
      }
    });
    return this._new(unique(out));
  };
  function sibling(step, all) {
    return function (selector) {
      var out = [];
      this._els().forEach(function (el) {
        for (var s = isNode(el) ? el[step] : null; s; s = s[step]) {
          if (!isTag(s)) continue;
          out.push(s);
          if (!all) break;
        }
      });
      return this._new(filtered(unique(out), selector));
    };
  }
  fn.next = sibling("next", false);
  fn.nextAll = sibling("next", true);
  fn.prev = sibling("prev", false);
  fn.prevAll = sibling("prev", true);
  fn.siblings = function (selector) {
    var out = [];
    this._els().forEach(function (el) {
      var p = isNode(el) ? el.parent : null;
      if (!p) return;
      p.children.forEach(function (c) {
        if (c !== el && isTag(c)) out.push(c);
      });
    });
    return this._new(filtered(unique(out), selector));
  };
  fn.first = function () {
    return this._new(this.length ? [this[0]] : []);
  };
  fn.last = function () {
    return this._new(this.length ? [this[this.length - 1]] : []);
  };
  fn.eq = function (i) {
    i = Number(i);
    var el = this[i < 0 ? this.length + i : i];
    return this._new(el === undefined ? [] : [el]);
  };
  fn.slice = function (start, end) {
    return this._new(Array.prototype.slice.call(this, start, end));
  };
  fn.end = function () {
    return this.prevObject || this._new([]);
  };
  fn.add = function (other, context) {
    var more = other instanceof Selection ? other._els() : isNode(other) ? [other] : Array.isArray(other) ? other : [];
    if (typeof other === "string" && this._doc) more = this._doc.$(other, context)._els();
    return this._new(unique(this._els().concat(more)));
  };
  fn.addBack = function (selector) {
    var prev = this.prevObject ? this.prevObject._els() : [];
    return this._new(unique(this._els().concat(filtered(prev, selector))));
  };
  fn.index = function (selector) {
    var el = this[0];
    if (!el) return -1;
    if (selector === undefined) {
      var p = el.parent;
      return p ? p.children.filter(isTag).indexOf(el) : 0;
    }
    var within = selector instanceof Selection ? selector._els() : this._doc ? this._doc.$(selector)._els() : [];
    return within.indexOf(el);
  };
  fn.hasClass = function (name) {
    return this._els().some(function (el) {
      return isTag(el) && (" " + (el.attribs["class"] || "") + " ").replace(/\s+/g, " ").indexOf(" " + name + " ") >= 0;
    });
  };
  fn.attr = function (name, value) {
    if (name && typeof name === "object") {
      var self = this;
      Object.keys(name).forEach(function (k) {
        self.attr(k, name[k]);
      });
      return this;
    }
    if (value === undefined) {
      var el = this._els().find(isTag);
      if (!el) return undefined;
      if (name === undefined) return Object.assign({}, el.attribs);
      return Object.prototype.hasOwnProperty.call(el.attribs, name) ? el.attribs[name] : undefined;
    }
    return this.each(function (i, el) {
      if (!isTag(el)) return;
      var v = typeof value === "function" ? value.call(el, i, el.attribs[name]) : value;
      if (v === null) {
        el.__doc.h.setAttr(el.__id, name, "", true);
        delete el.attribs[name];
      } else {
        el.__doc.h.setAttr(el.__id, name, String(v), false);
        el.attribs[name] = String(v);
      }
    });
  };
  fn.removeAttr = function (name) {
    return this.attr(name, null);
  };
  fn.prop = function (name) {
    var el = this._els().find(isTag);
    if (!el) return undefined;
    switch (name) {
      case "tagName":
      case "nodeName":
        return el.name.toUpperCase();
      case "innerHTML":
        return el.__doc.h.html(el.__id);
      case "outerHTML":
        return el.__doc.h.outer(el.__id);
      case "textContent":
      case "innerText":
        return el.__doc.h.text(el.__id);
      case "checked":
      case "selected":
      case "disabled":
        return Object.prototype.hasOwnProperty.call(el.attribs, name);
    }
    return Object.prototype.hasOwnProperty.call(el.attribs, name) ? el.attribs[name] : el[name];
  };
  function dataValue(text) {
    if (text === "true") return true;
    if (text === "false") return false;
    if (text === "null") return null;
    if (text !== "" && String(Number(text)) === text) return Number(text);
    if (/^[\[{]/.test(text)) {
      try {
        return JSON.parse(text);
      } catch (e) {}
    }
    return text;
  }
  fn.data = function (name) {
    var el = this._els().find(isTag);
    if (!el) return undefined;
    if (name === undefined) {
      var out = {};
      Object.keys(el.attribs).forEach(function (k) {
        if (k.indexOf("data-") !== 0) return;
        var key = k.slice(5).replace(/-([a-z])/g, function (m, c) {
          return c.toUpperCase();
        });
        out[key] = dataValue(el.attribs[k]);
      });
      return out;
    }
    var attr =
      "data-" +
      String(name).replace(/[A-Z]/g, function (c) {
        return "-" + c.toLowerCase();
      });
    return Object.prototype.hasOwnProperty.call(el.attribs, attr) ? dataValue(el.attribs[attr]) : undefined;
  };
  fn.val = function () {
    var el = this._els().find(isTag);
    if (!el) return undefined;
    if (el.name === "textarea") return el.__doc.h.text(el.__id);
    if (el.name === "select") {
      var options = new Selection([el], null).find("option");
      var chosen = options.filter("[selected]");
      var pick = chosen.length ? chosen : options.first();
      return pick.length ? pick.val() : undefined;
    }
    if (el.name === "option" && el.attribs.value === undefined) return el.__doc.h.text(el.__id);
    return el.attribs.value;
  };
  fn.text = function (value) {
    if (value !== undefined) return this;
    return this._els()
      .map(function (el) {
        return isNode(el) ? el.__doc.h.text(el.__id) : "";
      })
      .join("");
  };
  fn.html = function (value) {
    if (value !== undefined) return this;
    var el = this[0];
    return isNode(el) ? el.__doc.h.html(el.__id) : null;
  };
  fn.toString = function () {
    return this._els()
      .map(function (el) {
        return isNode(el) ? el.__doc.h.outer(el.__id) : "";
      })
      .join("");
  };
  fn.remove = function () {
    this._els().forEach(function (el) {
      if (isNode(el)) el.__doc.h.remove(el.__id);
    });
    return this;
  };

  function contains(container, contained) {
    if (!isNode(container) || !isNode(contained) || container === contained) return false;
    for (var p = contained.parent; p; p = p.parent) if (p === container) return true;
    return false;
  }

  function fragment(markup) {
    var doc = new Doc(host.html(String(markup), true));
    return doc.el(0).children;
  }

  function load(content) {
    if (content instanceof Selection) content = content.toString();
    else if (isNode(content)) content = content.__doc.h.outer(content.__id);
    var doc = new Doc(host.html(content === undefined || content === null ? "" : String(content), false));
    function $(selector, context) {
      if (selector === undefined || selector === null || selector === "") return new Selection([], doc);
      if (selector instanceof Selection) return selector;
      if (Array.isArray(selector)) return new Selection(selector, doc);
      if (isNode(selector)) return new Selection([selector], doc);
      if (typeof selector === "string") {
        var text = selector.trim();
        if (text.charAt(0) === "<") return new Selection(fragment(text), doc);
        if (context !== undefined && context !== null) {
          var within = context instanceof Selection ? context : $(context);
          return within.find(text);
        }
        return new Selection([doc.el(0)], doc).find(text);
      }
      return new Selection([], doc);
    }
    doc.$ = $;
    $.root = function () {
      return new Selection([doc.el(0)], doc);
    };
    $.html = function (selector) {
      if (selector === undefined) return doc.h.outer(0);
      return (selector instanceof Selection ? selector : $(selector)).toString();
    };
    $.xml = $.html;
    $.text = function (selector) {
      if (selector === undefined) return doc.h.text(0);
      return (selector instanceof Selection ? selector : $(selector)).text();
    };
    $.parseHTML = fragment;
    $.contains = contains;
    $.load = load;
    $.fn = fn;
    $.prototype = fn;
    return $;
  }

  var cheerio = {
    load: load,
    contains: contains,
    parseHTML: fragment,
    html: function (selector) {
      return selector instanceof Selection ? selector.toString() : "";
    },
    text: function (selector) {
      return selector instanceof Selection ? selector.text() : "";
    },
  };
  cheerio.default = cheerio;
  return cheerio;
});
