/*!
 * ask-page · page behaviour (inlined into the output by `ask_page.py new`)
 *
 * No server, no network. Everything the page needs is in this file.
 *
 *   - comments are stored in localStorage under `ask-page:<pageId>`
 *   - "复制结果" builds a Markdown block and copies it to the clipboard
 *   - the user pastes that block back into the chat
 *
 * Declarative hooks (see SKILL.md):
 *   [data-pi-anchor="name"]                    clickable, becomes one comment
 *   [data-pi-option="name"]                    option list (radio / checkbox)
 *   [data-pi-submit] / [data-ap-copy]          copy the result
 *   [data-ap-comments] / [data-ap-count]       comment list / counter
 *   [data-ap-clear] / [data-ap-reload]         clear all / reload from disk
 *   [data-ap-pop] / [data-ap-status]            copy preview / status line
 *   script[type="text/markdown"]               rendered in place
 *
 * Plain IIFE on purpose: ES modules are blocked on file:// .
 */
(function () {
  "use strict";

  if (window.askPage && window.askPage.__askPage) return;

  var KEY_PREFIX = "ask-page:";
  var MAX_QUOTE = 300;
  var MAX_LABEL = 40;

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  // ── identity ───────────────────────────────────────────────────────────
  // data-page-id wins so that renaming the file does not orphan the draft.
  // The filename is only a fallback for hand-written pages.
  function resolvePageId() {
    var declared = (document.body.getAttribute("data-page-id") || "").trim();
    if (declared) return declared;
    var base = (location.pathname.split("/").pop() || "page");
    base = base.replace(/\.(html?|xhtml)$/i, "");
    base = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "");
    return base || "page";
  }

  var PAGE_ID = resolvePageId();
  var KEY = KEY_PREFIX + PAGE_ID;

  // ── state ──────────────────────────────────────────────────────────────
  var state = { pageId: PAGE_ID, comments: [], options: {}, submittedAt: null };
  var storageOK = true;

  function nowIso() { return new Date().toISOString().replace(/\.\d+Z$/, "Z"); }

  function fmtTime(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
  }

  function warnStorage() {
    if (!storageOK) return;
    storageOK = false;
    var el = $("[data-ap-status]");
    if (el) {
      el.textContent = "⚠ 浏览器禁用了本地存储，草稿关闭后会丢失（现在导出仍然可用）";
      el.classList.add("ap-warn-text");
    }
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      updateStatus();
    } catch (err) {
      warnStorage();
    }
  }

  function load() {
    var raw = null;
    try {
      raw = localStorage.getItem(KEY);
    } catch (err) {
      warnStorage();
      return;
    }
    if (!raw) return;
    try {
      var draft = JSON.parse(raw) || {};
      if (Array.isArray(draft.comments)) {
        state.comments = draft.comments.filter(function (c) {
          return c && typeof c.text === "string" && c.text.trim();
        }).map(function (c) {
          return {
            anchor: String(c.anchor || ""),
            label: String(c.label || ""),
            text: String(c.text),
            selectionText: String(c.selectionText || ""),
            at: c.at || nowIso(),
            submitted: !!c.submitted
          };
        });
      }
      if (draft.options && typeof draft.options === "object") {
        Object.keys(draft.options).forEach(function (k) {
          var v = draft.options[k];
          if (typeof v === "string" || (Array.isArray(v) && v.every(function (x) { return typeof x === "string"; }))) {
            state.options[k] = v;
          }
        });
      }
      if (draft.submittedAt) state.submittedAt = draft.submittedAt;
    } catch (err) {
      // A corrupt draft must never break the page.
    }
  }

  // ── anchors and labels ─────────────────────────────────────────────────
  function shortText(el) {
    var t = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (t.length > MAX_LABEL) t = t.slice(0, MAX_LABEL) + "…";
    return t;
  }

  function anchorNodes() {
    var map = {};
    $$("[data-pi-anchor]").forEach(function (el) {
      var id = el.getAttribute("data-pi-anchor");
      if (id && !map[id]) map[id] = el;
    });
    return map;
  }

  // ── comments ───────────────────────────────────────────────────────────
  function addComment(anchor, text, selectionText) {
    text = String(text || "").trim();
    if (!text) return null;
    var nodes = anchorNodes();
    var item = {
      anchor: anchor || "",
      label: (nodes[anchor] && shortText(nodes[anchor])) || "",
      text: text,
      selectionText: String(selectionText || "").slice(0, MAX_QUOTE),
      at: nowIso(),
      submitted: false
    };
    state.comments.push(item);
    save();
    render();
    return item;
  }

  function removeComment(index) {
    state.comments.splice(index, 1);
    save();
    render();
  }

  // ── rendering ──────────────────────────────────────────────────────────
  function render() {
    renderComments();
    renderOptions();
    markAnchors();
  }

  function renderComments() {
    var count = $("[data-ap-count]");
    if (count) count.textContent = String(state.comments.length);

    var host = $("[data-ap-comments]");
    if (!host) return;

    host.textContent = "";
    if (!state.comments.length) {
      var empty = document.createElement("div");
      empty.className = "ap-empty";
      empty.textContent = "还没有批注。点击正文里带下划线的内容即可添加。";
      host.appendChild(empty);
      return;
    }

    var nodes = anchorNodes();
    state.comments.forEach(function (item, index) {
      var row = document.createElement("div");
      row.className = "ap-comment" + (item.submitted ? " is-submitted" : "");

      var head = document.createElement("div");
      head.className = "ap-comment-head";

      var left = document.createElement("div");
      left.style.cssText = "display:flex;gap:6px;align-items:center;min-width:0";
      var chip = document.createElement("span");
      chip.className = "ap-comment-anchor";
      chip.textContent = "#" + (item.anchor || "?");
      chip.title = item.label || item.anchor;
      left.appendChild(chip);
      if (!nodes[item.anchor]) {
        var stale = document.createElement("span");
        stale.className = "ap-flag stale";
        stale.textContent = "位置已失效";
        stale.title = "这一轮的页面里没有对应的 data-pi-anchor，批注仍会导出";
        left.appendChild(stale);
      } else if (item.submitted) {
        var sent = document.createElement("span");
        sent.className = "ap-flag sent";
        sent.textContent = "已提交";
        left.appendChild(sent);
      }

      var del = document.createElement("button");
      del.type = "button";
      del.className = "ap-comment-del";
      del.textContent = "删除";
      del.addEventListener("click", function () { removeComment(index); });

      head.appendChild(left);
      head.appendChild(del);
      row.appendChild(head);

      var body = document.createElement("div");
      body.className = "ap-comment-body";
      body.textContent = item.text;
      row.appendChild(body);

      if (item.selectionText) {
        var quote = document.createElement("div");
        quote.className = "ap-comment-quote";
        quote.textContent = "「" + item.selectionText + "」";
        row.appendChild(quote);
      }
      host.appendChild(row);
    });
  }

  function markAnchors() {
    var used = {};
    state.comments.forEach(function (c) { if (c.anchor) used[c.anchor] = true; });
    $$("[data-pi-anchor]").forEach(function (el) {
      var id = el.getAttribute("data-pi-anchor");
      el.classList.toggle("ap-anchored", !!used[id]);
      el.classList.add("ap-anchorable");
      el.title = el.title || "点击添加批注";
    });
  }

  // ── option lists ───────────────────────────────────────────────────────
  // One question, N answers. Single select by default; data-pi-multiple="true"
  // turns it into a checkbox list. Values live in state.options[name].
  function optionMeta(el) {
    function split(attr, sep) {
      return (el.getAttribute(attr) || "").split(sep).map(function (s) { return s.trim(); });
    }
    return {
      name: (el.getAttribute("data-pi-option") || "").trim(),
      prompt: (el.getAttribute("data-pi-prompt") || "").trim(),
      multiple: el.getAttribute("data-pi-multiple") === "true",
      options: split("data-pi-options", ",").filter(Boolean),
      labels: split("data-pi-labels", "|")
    };
  }

  function setOption(name, value) {
    if (value === null) delete state.options[name];
    else state.options[name] = value;
    save();
    renderOptions();
  }

  function renderOptions() {
    $$("[data-pi-option]").forEach(setupOption);
  }

  function setupOption(el) {
    var meta = optionMeta(el);
    if (!meta.name || !meta.options.length) return;

    if (el.getAttribute("data-ap-ready") !== "1") {
      el.setAttribute("data-ap-ready", "1");
      el.classList.add("ap-opt");
      el.setAttribute("role", meta.multiple ? "group" : "radiogroup");
      if (meta.multiple) el.setAttribute("data-multiple", "true");
      if (meta.prompt) el.setAttribute("aria-label", meta.prompt);
      el.textContent = "";

      if (meta.prompt) {
        var prompt = document.createElement("div");
        prompt.className = "ap-opt-prompt";
        prompt.textContent = meta.prompt;
        el.appendChild(prompt);
      }

      var list = document.createElement("div");
      list.className = "ap-opt-list";

      meta.options.forEach(function (value, index) {
        var item = document.createElement("button");
        item.type = "button";
        item.className = "ap-opt-item";
        item.setAttribute("data-value", value);
        item.setAttribute("role", meta.multiple ? "checkbox" : "radio");
        var mark = document.createElement("span");
        mark.className = "ap-opt-mark";
        var label = document.createElement("span");
        label.className = "ap-opt-label";
        label.textContent = meta.labels[index] || value;
        item.appendChild(mark);
        item.appendChild(label);
        item.addEventListener("click", function () {
          if (meta.multiple) {
            var cur = Array.isArray(state.options[meta.name]) ? state.options[meta.name].slice() : [];
            var at = cur.indexOf(value);
            if (at === -1) cur.push(value); else cur.splice(at, 1);
            setOption(meta.name, cur.length ? cur : null);
          } else {
            // Clicking the current answer clears it: a question on this page is
            // allowed to stay unanswered, and a misclick must be undoable.
            setOption(meta.name, state.options[meta.name] === value ? null : value);
          }
        });
        list.appendChild(item);
      });
      el.appendChild(list);

      // Arrow keys move the selection inside a radio group, like native radios.
      list.addEventListener("keydown", function (ev) {
        if (meta.multiple) return;
        var items = $$(".ap-opt-item", el);
        var idx = items.indexOf(document.activeElement);
        if (idx === -1) return;
        var delta = (ev.key === "ArrowDown" || ev.key === "ArrowRight") ? 1
          : (ev.key === "ArrowUp" || ev.key === "ArrowLeft") ? -1 : 0;
        if (!delta) return;
        ev.preventDefault();
        var next = items[(idx + delta + items.length) % items.length];
        next.focus();
        next.click();
      });

      if (el.hasAttribute("data-pi-default") && state.options[meta.name] === undefined) {
        var preset = el.getAttribute("data-pi-default");
        state.options[meta.name] = meta.multiple
          ? preset.split(",").map(function (s) { return s.trim(); }).filter(Boolean)
          : preset.trim();
        save();
      }
    }

    // Paint from state. Roving tabindex keeps the group a single tab stop.
    var current = state.options[meta.name];
    var items = $$(".ap-opt-item", el);
    var focusAt = 0;
    items.forEach(function (item, index) {
      var value = item.getAttribute("data-value");
      var on = meta.multiple
        ? Array.isArray(current) && current.indexOf(value) !== -1
        : current === value;
      item.setAttribute("aria-checked", on ? "true" : "false");
      if (on) focusAt = index;
    });
    if (!meta.multiple) {
      items.forEach(function (item, index) {
        item.setAttribute("tabindex", index === focusAt ? "0" : "-1");
      });
    }
  }

  // Only options whose container is still on the page are exported: if the
  // question is gone, its old answer is noise.
  function optionLines() {
    var out = [];
    $$("[data-pi-option]").forEach(function (el) {
      var meta = optionMeta(el);
      if (!meta.name) return;
      var value = state.options[meta.name];
      if (value === undefined || value === null || value === "") return;
      var values = Array.isArray(value) ? value.filter(Boolean) : [value];
      if (!values.length) return;

      var labels = values.map(function (v) {
        var at = meta.options.indexOf(v);
        return (at >= 0 && meta.labels[at]) || v;
      });
      var head = meta.prompt && meta.prompt !== meta.name ? meta.prompt + "（" + meta.name + "）" : meta.name;
      var labelText = labels.join("、");
      var valueText = values.join(", ");
      out.push("- " + head + "：" + (labelText === valueText ? valueText : labelText + "（" + valueText + "）"));
    });
    return out;
  }

  // ── composer ───────────────────────────────────────────────────────────
  var composer = null;

  function closeComposer() {
    if (composer && composer.parentNode) composer.parentNode.removeChild(composer);
    composer = null;
  }

  function selectionInside(el) {
    var sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return "";
    var range = sel.getRangeAt(0);
    if (!el.contains(range.commonAncestorContainer)) return "";
    return String(sel.toString()).trim().slice(0, MAX_QUOTE);
  }

  function openComposer(target) {
    closeComposer();
    var anchor = target.getAttribute("data-pi-anchor") || "";
    var quote = selectionInside(target);

    var box = document.createElement("div");
    box.className = "ap-composer";

    var hint = document.createElement("div");
    hint.className = "ap-composer-hint";
    var label = shortText(target);
    hint.textContent = "批注 #" + anchor + (label ? " · " + label : "");
    box.appendChild(hint);

    if (quote) {
      var q = document.createElement("div");
      q.className = "ap-comment-quote";
      q.style.margin = "0 0 8px";
      q.textContent = "「" + quote + "」";
      box.appendChild(q);
    }

    var area = document.createElement("textarea");
    area.placeholder = "写下你的意见…（⌘/Ctrl+Enter 保存，Esc 取消）";
    box.appendChild(area);

    var actions = document.createElement("div");
    actions.className = "ap-composer-actions";
    var saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "ap-btn primary";
    saveBtn.textContent = "保存批注";
    var cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "ap-btn ghost";
    cancelBtn.textContent = "取消";
    actions.appendChild(saveBtn);
    actions.appendChild(cancelBtn);
    box.appendChild(actions);

    function commit() {
      if (!area.value.trim()) { closeComposer(); return; }
      addComment(anchor, area.value, quote);
      closeComposer();
    }

    saveBtn.addEventListener("click", commit);
    cancelBtn.addEventListener("click", closeComposer);
    area.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") { ev.stopPropagation(); closeComposer(); }
      if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); commit(); }
    });

    document.body.appendChild(box);

    var rect = target.getBoundingClientRect();
    var top = Math.min(window.innerHeight - box.offsetHeight - 12, Math.max(12, rect.bottom + 8));
    var left = Math.min(window.innerWidth - box.offsetWidth - 12, Math.max(12, rect.left));
    box.style.top = top + "px";
    box.style.left = left + "px";
    composer = box;
    area.focus();

    setTimeout(function () {
      document.addEventListener("mousedown", onOutside, true);
    }, 0);

    function onOutside(ev) {
      if (composer && !composer.contains(ev.target) && !target.contains(ev.target)) {
        document.removeEventListener("mousedown", onOutside, true);
        closeComposer();
      }
    }
  }

  function setupAnchors() {
    $$("[data-pi-anchor]").forEach(function (el) {
      if (el.getAttribute("data-ap-anchor-ready") === "1") return;
      el.setAttribute("data-ap-anchor-ready", "1");
      el.addEventListener("click", function (ev) {
        if (ev.target.closest("a,input,button,textarea,select")) return;
        openComposer(el);
      });
    });
  }

  // ── export ─────────────────────────────────────────────────────────────
  function buildExport() {
    var nodes = anchorNodes();
    var lines = [];
    lines.push("<!-- ask-page-result · pageId=" + PAGE_ID + " · " + nowIso() + " -->");

    var opts = optionLines();
    if (opts.length) {
      lines.push("");
      lines.push("## 选择");
      lines.push("");
      opts.forEach(function (line) { lines.push(line); });
    }

    if (state.comments.length) {
      lines.push("");
      lines.push("## 批注（" + state.comments.length + " 条）");
      state.comments.forEach(function (c) {
        lines.push("");
        var label = (nodes[c.anchor] && shortText(nodes[c.anchor])) || c.label || "";
        var head = "### [" + (c.anchor || "?") + "] " + (label || "（无标签）");
        if (!nodes[c.anchor]) head += " ⚠ 位置已失效";
        lines.push(head);
        lines.push(c.text);
        if (c.selectionText) {
          lines.push("");
          lines.push("> 圈选原文：" + c.selectionText.replace(/\s*\n\s*/g, " "));
        }
      });
    }

    lines.push("");
    lines.push("<!-- /ask-page-result -->");
    return lines.join("\n");
  }

  // ── clipboard (three levels) ───────────────────────────────────────────
  function legacyCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:-2000px;left:0;opacity:0";
    document.body.appendChild(ta);
    var ok = false;
    try {
      ta.select();
      ta.setSelectionRange(0, text.length);
      ok = document.execCommand("copy");
    } catch (err) { /* fall through */ }
    if (ta.parentNode) ta.parentNode.removeChild(ta);
    return ok ? "execCommand" : "manual";
  }

  function copyText(text, done) {
    // Called synchronously from a click so the user gesture is still valid.
    if (navigator.clipboard && navigator.clipboard.writeText) {
      var p = null;
      try { p = navigator.clipboard.writeText(text); } catch (err) { p = null; }
      if (p && typeof p.then === "function") {
        p.then(function () { done("clipboard"); }, function () { done(legacyCopy(text)); });
        return;
      }
    }
    done(legacyCopy(text));
  }

  var pop = null;
  var popOpenedAt = 0;

  function showPop(text, how) {
    pop = pop || $("[data-ap-pop]");
    if (!pop) {
      window.prompt("复制下面的内容，粘到对话里：", text);
      return;
    }
    var copied = how !== "manual";
    var status = $("[data-ap-pop-status]", pop);
    var body = $("[data-ap-pop-body]", pop);
    var note = $("[data-ap-pop-note]", pop);
    if (status) {
      status.textContent = copied ? "已复制到剪贴板" : "自动复制被拦住，请手动复制";
      status.classList.toggle("is-warn", !copied);
    }
    if (body) body.textContent = text;
    if (note) note.textContent = copied ? "粘回对话即可" : "已全选 · ⌘C / Ctrl+C";
    pop.hidden = false;
    // Reset only after the panel is laid out: a display:none element keeps its
    // previous scroll offset, so setting scrollTop before unhiding is lost.
    if (body) body.scrollTop = 0;
    popOpenedAt = Date.now();

    if (!copied && body) {
      var range = document.createRange();
      range.selectNodeContents(body);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    setTimeout(function () {
      document.addEventListener("mousedown", onOutsidePop, true);
    }, 0);
  }

  function hidePop() {
    if (pop) pop.hidden = true;
    document.removeEventListener("mousedown", onOutsidePop, true);
  }

  function onOutsidePop(ev) {
    if (!pop || pop.hidden) return;
    if (pop.contains(ev.target)) return;
    if (ev.target.closest && ev.target.closest("[data-ap-copy]")) return;
    hidePop();
  }

  // Wheel over the popover must never leak into the page. Once the preview
  // itself is at either end, swallow the event instead of scroll-chaining.
  function onPopWheel(ev) {
    var body = $("[data-ap-pop-body]", pop);
    if (!body) { ev.preventDefault(); return; }
    // Wheel over the header/footer should still move the preview, never the page.
    if (!body.contains(ev.target)) {
      ev.preventDefault();
      body.scrollTop += ev.deltaY;
      return;
    }
    var scrollable = body.scrollHeight > body.clientHeight + 1;
    if (!scrollable) { ev.preventDefault(); return; }
    var atTop = body.scrollTop <= 0;
    var atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 1;
    if ((ev.deltaY < 0 && atTop) || (ev.deltaY > 0 && atBottom)) ev.preventDefault();
  }

  // Scrolling the page means "done reading" — dismiss instead of leaving the
  // panel pinned over content the user is now looking at.
  function onPageScroll() {
    if (!pop || pop.hidden) return;
    if (Date.now() - popOpenedAt < 300) return;
    hidePop();
  }

  // ── submit ─────────────────────────────────────────────────────────────
  function submit() {
    var text = buildExport();
    copyText(text, function (how) {
      markSubmitted();
      showPop(text, how);
    });
  }

  function markSubmitted() {
    var now = nowIso();
    state.comments.forEach(function (c) { c.submitted = true; });
    state.submittedAt = now;
    save();
    renderComments();
  }

  // ── misc actions ───────────────────────────────────────────────────────
  function clearDraft() {
    var options = optionLines().length;
    if (!state.comments.length && !options) return;
    var what = [];
    if (state.comments.length) what.push(state.comments.length + " 条批注");
    if (options) what.push(options + " 项选择");
    if (!window.confirm("清空" + what.join("、") + "？这一步不能撤销。")) return;
    state.comments = [];
    state.options = {};
    state.submittedAt = null;
    save();
    render();
  }

  function reloadLatest() {
    // The file on disk may have been rewritten by the agent. A fresh query
    // string is the only reliable way to bypass the browser cache on file://.
    var base = location.href.split("#")[0].split("?")[0];
    location.replace(base + "?r=" + Date.now());
  }

  // ── markdown blocks (offline, ~60 lines) ───────────────────────────────
  function renderMarkdown(src) {
    function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
    function inline(s) {
      return esc(s)
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|\W)\*([^*]+)\*/g, "$1<em>$2</em>")
        .replace(/~~([^~]+)~~/g, "<del>$1</del>")
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    }
    var lines = String(src).replace(/\r\n?/g, "\n").split("\n");
    var out = [];
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (/^\s*$/.test(line)) { i++; continue; }
      if (/^```(\w*)\s*$/.test(line)) {
        i++;
        var buf = [];
        while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++]);
        i++;
        out.push("<pre><code>" + esc(buf.join("\n")) + "</code></pre>");
        continue;
      }
      var h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { out.push("<h" + h[1].length + ">" + inline(h[2]) + "</h" + h[1].length + ">"); i++; continue; }
      if (/^\s*([-*_])\s*\1\s*\1\s*$/.test(line)) { out.push("<hr>"); i++; continue; }
      if (/^\s*>\s?/.test(line)) {
        var q = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ""));
        out.push("<blockquote>" + inline(q.join(" ")) + "</blockquote>");
        continue;
      }
      if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
        var ordered = /^\s*\d+\./.test(line);
        var items = [];
        while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
          items.push(lines[i++].replace(/^\s*([-*+]|\d+\.)\s+/, ""));
        }
        out.push((ordered ? "<ol>" : "<ul>") + items.map(function (t) { return "<li>" + inline(t) + "</li>"; }).join("") + (ordered ? "</ol>" : "</ul>"));
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
        var cells = function (l) { return l.trim().replace(/^\||\|$/g, "").split("|").map(function (c) { return c.trim(); }); };
        var head = cells(lines[i]);
        i += 2;
        var rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
        out.push("<table><thead><tr>" + head.map(function (c) { return "<th>" + inline(c) + "</th>"; }).join("") +
          "</tr></thead><tbody>" + rows.map(function (r) {
            return "<tr>" + r.map(function (c) { return "<td>" + inline(c) + "</td>"; }).join("") + "</tr>";
          }).join("") + "</tbody></table>");
        continue;
      }
      var para = [];
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,6}\s|```|\s*>|\s*([-*+]|\d+\.)\s|\s*\|)/.test(lines[i])) {
        para.push(lines[i++]);
      }
      out.push("<p>" + inline(para.join(" ")) + "</p>");
    }
    return out.join("\n");
  }

  function renderMarkdownBlocks() {
    $$('script[type="text/markdown"]').forEach(function (node) {
      var host = document.createElement("div");
      host.innerHTML = renderMarkdown(node.textContent || "");
      node.parentNode.replaceChild(host, node);
    });
  }

  // ── wiring ─────────────────────────────────────────────────────────────
  function setup() {
    load();
    renderMarkdownBlocks();
    setupAnchors();
    render();
    updateStatus();

    $$("[data-ap-copy],[data-pi-submit]").forEach(function (el) {
      if (el.getAttribute("data-ap-ready") === "1") return;
      el.setAttribute("data-ap-ready", "1");
      el.addEventListener("click", submit);
    });

    $$("[data-ap-clear]").forEach(function (el) {
      if (el.getAttribute("data-ap-ready") === "1") return;
      el.setAttribute("data-ap-ready", "1");
      el.addEventListener("click", clearDraft);
    });

    $$("[data-ap-reload]").forEach(function (el) {
      if (el.getAttribute("data-ap-ready") === "1") return;
      el.setAttribute("data-ap-ready", "1");
      el.addEventListener("click", reloadLatest);
    });

    $$("[data-ap-close]").forEach(function (el) {
      el.addEventListener("click", hidePop);
    });

    if (!window.__askPagePopBound) {
      window.__askPagePopBound = true;
      var popEl = $("[data-ap-pop]");
      if (popEl) popEl.addEventListener("wheel", onPopWheel, { passive: false });
      window.addEventListener("scroll", onPageScroll, { passive: true });
    }

    if (document.body.getAttribute("data-ap-keys") !== "1") {
      document.body.setAttribute("data-ap-keys", "1");
      document.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
          ev.preventDefault();
          submit();
        }
        if (ev.key === "Escape") hidePop();
      });
    }

  }

  function updateStatus() {
    if (!storageOK) return;
    var el = $("[data-ap-status]");
    if (!el) return;
    var picked = [];
    if (state.comments.length) picked.push(state.comments.length + " 条批注");
    var options = optionLines().length;
    if (options) picked.push(options + " 项选择");
    var parts = [picked.length ? "草稿已保存 · " + picked.join(" · ") : "草稿保存在本机浏览器，刷新不会丢"];
    if (state.submittedAt) parts.push("上次导出 " + fmtTime(state.submittedAt));
    el.textContent = parts.join(" · ");
  }

  // ── public api (for custom pages) ──────────────────────────────────────
  var api = {
    __askPage: true,
    pageId: PAGE_ID,
    state: state,
    comment: addComment,
    option: setOption,
    submit: submit,
    exportText: buildExport,
    preview: showPop,
    reload: reloadLatest,
    rescan: function () { setupAnchors(); render(); }
  };
  window.askPage = api;
  window.pi = window.pi || api; // older pages may still call pi.*

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setup);
  } else {
    setup();
  }
})();
