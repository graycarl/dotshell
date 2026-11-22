/*!
 * ask-page · page behaviour (inlined into the output by `ask_page.py new`)
 *
 * No server, no network. The Markdown is already rendered to HTML with anchors
 * baked in at build time — this file only adds the review layer on top:
 *
 *   - comments are stored in localStorage under `ask-page:<session>:<pageId>`
 *     (all file:// pages share one origin, so the session has to be in the key;
 *     pages built before sessions existed have no data-page-session and keep
 *     using the old `ask-page:<pageId>` key)
 *   - "复制结果" builds a Markdown block and copies it to the clipboard
 *   - the user pastes that block back into the chat
 *
 * Hooks (all provided by the template; a page never needs to add them):
 *   [data-pi-anchor]                           clickable, becomes one comment
 *   [data-ap-copy]                             copy the result
 *   [data-ap-comments] / [data-ap-count]       comment list / counter
 *   [data-ap-clear] / [data-ap-reload]         clear all / reload from disk
 *   [data-ap-pop] / [data-ap-status]           copy preview / status line
 *
 * Plain IIFE on purpose: ES modules are blocked on file:// .
 */
(function () {
  "use strict";

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

  // Empty for hand-written pages and for pages built before sessions existed.
  function resolvePageSession() {
    var declared = (document.body.getAttribute("data-page-session") || "").trim();
    return declared.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "");
  }

  var PAGE_ID = resolvePageId();
  var PAGE_SESSION = resolvePageSession();
  var KEY = KEY_PREFIX + (PAGE_SESSION ? PAGE_SESSION + ":" : "") + PAGE_ID;

  // ── state ──────────────────────────────────────────────────────────────
  var state = { comments: [], submittedAt: null };
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
      empty.textContent = "还没有批注。点击正文里带下划线（或悬停变亮）的段落、标题、列表项即可添加。";
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
        stale.title = "这一轮页面里没有对应的 anchor（那段文字被改写了），批注仍会导出";
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
      el.addEventListener("click", function (ev) {
        if (ev.target.closest("a,input,button,textarea,select")) return;
        // Nested anchors (a list item inside an anchored list) must open the
        // innermost one only, so the click stops here.
        ev.stopPropagation();
        openComposer(el);
      });
    });
  }

  // ── export ─────────────────────────────────────────────────────────────
  function buildExport() {
    var nodes = anchorNodes();
    var lines = [];
    lines.push(
      "<!-- ask-page-result · pageId=" + PAGE_ID +
      (PAGE_SESSION ? " · session=" + PAGE_SESSION : "") +
      " · " + nowIso() + " -->"
    );

    if (state.comments.length) {
      lines.push("");
      lines.push("## 批注（" + state.comments.length + " 条）");
      state.comments.forEach(function (c) {
        lines.push("");
        var label = (nodes[c.anchor] && shortText(nodes[c.anchor])) || c.label || "";
        var head = "### [" + (c.anchor || "?") + "] " + (label || "（无标签）");
        if (!nodes[c.anchor]) head += " ⚠ 位置已失效";
        lines.push(head);
        // Every body line is indented: a comment may itself contain a line
        // starting with `>` or `### [`, and those must not read as structure.
        lines.push(
          c.text.split("\n").map(function (line) { return "  " + line; }).join("\n")
        );
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
    if (!state.comments.length) return;
    if (!window.confirm("清空 " + state.comments.length + " 条批注？这一步不能撤销。")) return;
    state.comments = [];
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

  // ── wiring ─────────────────────────────────────────────────────────────
  function setup() {
    load();
    setupAnchors();
    render();
    updateStatus();

    $$("[data-ap-copy]").forEach(function (el) {
      el.addEventListener("click", submit);
    });

    $$("[data-ap-clear]").forEach(function (el) {
      el.addEventListener("click", clearDraft);
    });

    $$("[data-ap-reload]").forEach(function (el) {
      el.addEventListener("click", reloadLatest);
    });

    $$("[data-ap-close]").forEach(function (el) {
      el.addEventListener("click", hidePop);
    });

    var popEl = $("[data-ap-pop]");
    if (popEl) popEl.addEventListener("wheel", onPopWheel, { passive: false });
    window.addEventListener("scroll", onPageScroll, { passive: true });

    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
        ev.preventDefault();
        submit();
      }
      if (ev.key === "Escape") hidePop();
    });
  }

  function updateStatus() {
    if (!storageOK) return;
    var el = $("[data-ap-status]");
    if (!el) return;
    var parts = [
      state.comments.length
        ? "草稿已保存 · " + state.comments.length + " 条批注"
        : "草稿保存在本机浏览器，刷新不会丢"
    ];
    if (state.submittedAt) parts.push("上次导出 " + fmtTime(state.submittedAt));
    el.textContent = parts.join(" · ");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setup);
  } else {
    setup();
  }
})();
