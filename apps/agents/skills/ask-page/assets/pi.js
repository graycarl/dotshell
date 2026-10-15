/*!
 * ask-page client SDK (pi.js) — served by page_server.py, never opened directly.
 *
 * The server injects two things into every page:
 *   <script>window.__PI__ = {pageId, version, token}</script>
 *   <script src="/pi.js?t=TOKEN"></script>
 *
 * What the page gets for free:
 *   - window.pi.submit(extra)      collect state -> POST /pi/submit
 *   - window.pi.cancel(reason)     POST /pi/cancel
 *   - window.pi.comment(a, text)   anchors: any [data-pi-anchor] element
 *   - window.pi.choice(name, val)  widgets: any [data-pi-choice] element
 *   - window.pi.upload(file)       zones:   any [data-pi-upload] element
 *   - auto reload when the agent pushes a new version (GET /pi/state polling)
 *
 * State collected at submit time:
 *   {choices: {...}, comments: [{anchor, text, selectionText, at}], uploads: [...], ...extra}
 *
 * Conventions (not enforced, just useful): data-pi-choice="decision" with
 * data-pi-options="approve,revise,reject" makes choices.decision the verdict.
 *
 * No dependencies. Vanilla JS. Safe to load more than once.
 */
(function () {
  "use strict";

  if (window.pi && window.pi.__askPage) return;

  var CFG = window.__PI__ || {};
  var PAGE_ID = CFG.pageId || "";
  var VERSION = CFG.version || 0;
  var TOKEN = CFG.token || "";
  var POLL_MS = 1500;
  var MAX_UPLOAD = 25 * 1024 * 1024;
  var DRAFT_KEY = "pi-ask-page:draft:" + PAGE_ID;

  if (!TOKEN) console.warn("[ask-page] missing window.__PI__; the page was not served by page_server.py");

  function api(path) {
    return path + (path.indexOf("?") === -1 ? "?" : "&") + "t=" + encodeURIComponent(TOKEN);
  }

  // ── state ──────────────────────────────────────────────────────────────
  var state = { choices: {}, comments: [], uploads: [], extra: {} };
  var status = "waiting";
  var hooks = { submit: [], cancel: [], ready: [] };
  var timer = null;

  function emit(event, detail) {
    (hooks[event] || []).forEach(function (fn) {
      try { fn(detail); } catch (err) { console.error("[ask-page]", err); }
    });
  }

  // ── draft persistence: survive an `update` reload mid-review ───────────
  function saveDraft() {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        choices: state.choices, comments: state.comments, uploads: state.uploads,
      }));
    } catch (err) { /* private mode, quota, ... */ }
  }

  function loadDraft() {
    try {
      var raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      var draft = JSON.parse(raw) || {};
      if (draft.choices) state.choices = draft.choices;
      if (Array.isArray(draft.comments)) state.comments = draft.comments;
      if (Array.isArray(draft.uploads)) state.uploads = draft.uploads;
    } catch (err) { /* ignore a corrupt draft */ }
  }

  function clearDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch (err) { /* ignore */ }
  }

  // ── network ────────────────────────────────────────────────────────────
  function postJSON(path, body) {
    return fetch(api(path), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Pi-Token": TOKEN },
      body: JSON.stringify(body || {}),
    }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status + " " + res.statusText);
      return res.json().catch(function () { return {}; });
    });
  }

  function submit(extra) {
    if (status !== "waiting") return Promise.resolve(false);
    var payload = {};
    Object.keys(state.extra).forEach(function (k) { payload[k] = state.extra[k]; });
    Object.keys(extra || {}).forEach(function (k) { payload[k] = extra[k]; });
    payload.choices = Object.assign({}, state.choices, (extra && extra.choices) || {});
    payload.comments = state.comments.slice();
    payload.uploads = state.uploads.slice();
    if (!payload.decision && payload.choices.decision) payload.decision = payload.choices.decision;

    setBusy(true);
    return postJSON("/pi/submit", { payload: payload, meta: { submittedAt: new Date().toISOString() } })
      .then(function () {
        status = "submitted";
        clearDraft();
        setBusy(false);
        disableActions();
        showOverlay("✅ 已提交", "请回到终端 —— agent 已收到你的反馈并继续。", "ok");
        emit("submit", payload);
        stopPolling();
        return true;
      })
      .catch(function (err) {
        setBusy(false);
        showOverlay("⚠️ 提交失败", String((err && err.message) || err) + "　请回到终端确认 ask-page 服务是否仍在运行。", "error");
        return false;
      });
  }

  function cancel(reason) {
    if (status !== "waiting") return Promise.resolve(false);
    if (!window.confirm("放弃本次确认？agent 会知道你放弃了这次等待。")) return Promise.resolve(false);
    return postJSON("/pi/cancel", { reason: reason || "user" })
      .then(function () {
        status = "cancelled";
        clearDraft();
        disableActions();
        showOverlay("已放弃", "agent 已收到取消通知。", "muted");
        emit("cancel", reason || "user");
        stopPolling();
        return true;
      })
      .catch(function (err) {
        showOverlay("⚠️ 取消失败", String((err && err.message) || err), "error");
        return false;
      });
  }

  function upload(file) {
    if (file.size > MAX_UPLOAD) return Promise.reject(new Error("文件超过 25 MiB：" + file.name));
    return fetch(api("/pi/upload?name=" + encodeURIComponent(file.name)), {
      method: "POST",
      headers: { "X-Pi-Token": TOKEN, "X-Pi-Filename": encodeURIComponent(file.name), "Content-Type": "application/octet-stream" },
      body: file,
    })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        var item = { name: data.name, path: data.path, relPath: data.relPath, url: data.url, size: data.size };
        state.uploads.push(item);
        saveDraft();
        renderUploads();
        return item;
      });
  }

  function comment(anchor, text, selectionText) {
    if (!text || !String(text).trim()) return null;
    var item = {
      anchor: anchor || "",
      text: String(text).trim(),
      selectionText: selectionText || "",
      at: new Date().toISOString(),
    };
    state.comments.push(item);
    saveDraft();
    renderComments();
    return item;
  }

  function choice(name, value) {
    state.choices[name] = value;
    saveDraft();
    document.querySelectorAll('[data-pi-choice="' + name + '"]').forEach(function (el) {
      renderChoice(el);
    });
    return value;
  }

  // ── overlay / busy ─────────────────────────────────────────────────────
  function overlayEl() {
    var el = document.getElementById("pi-overlay");
    if (!el) {
      el = document.createElement("div");
      el.id = "pi-overlay";
      document.body.appendChild(el);
    }
    return el;
  }

  function showOverlay(title, body, kind) {
    var el = overlayEl();
    el.className = "pi-overlay pi-overlay-" + (kind || "info");
    el.innerHTML = "";
    var card = document.createElement("div");
    card.className = "pi-overlay-card";
    var h = document.createElement("div");
    h.className = "pi-overlay-title";
    h.textContent = title;
    var p = document.createElement("div");
    p.className = "pi-overlay-body";
    p.textContent = body || "";
    card.appendChild(h);
    card.appendChild(p);
    el.appendChild(card);
    el.style.display = "flex";
  }

  function setBusy(busy) {
    document.querySelectorAll("[data-pi-submit]").forEach(function (el) {
      el.disabled = !!busy;
      el.classList.toggle("pi-busy", !!busy);
    });
  }

  function disableActions() {
    document.querySelectorAll("[data-pi-submit],[data-pi-cancel],[data-pi-upload],input[type=file]").forEach(function (el) {
      el.disabled = true;
    });
  }

  // ── comments UI ────────────────────────────────────────────────────────
  function renderComments() {
    var badge = document.querySelector("[data-pi-comments-count]");
    if (badge) badge.textContent = String(state.comments.length);
    var host = document.querySelector("[data-pi-comments]");
    if (!host) return;
    host.innerHTML = "";
    if (!state.comments.length) {
      var empty = document.createElement("div");
      empty.className = "pi-empty";
      empty.textContent = "还没有批注。点击正文里高亮的内容即可添加。";
      host.appendChild(empty);
      return;
    }
    state.comments.forEach(function (item, index) {
      var row = document.createElement("div");
      row.className = "pi-comment";
      var head = document.createElement("div");
      head.className = "pi-comment-head";
      var anchor = document.createElement("span");
      anchor.className = "pi-comment-anchor";
      anchor.textContent = item.anchor ? "#" + item.anchor : "#" + (index + 1);
      var del = document.createElement("button");
      del.type = "button";
      del.className = "pi-comment-del";
      del.textContent = "删除";
      del.addEventListener("click", function () {
        state.comments.splice(index, 1);
        saveDraft();
        renderComments();
      });
      head.appendChild(anchor);
      head.appendChild(del);
      var body = document.createElement("div");
      body.className = "pi-comment-body";
      body.textContent = item.text;
      row.appendChild(head);
      row.appendChild(body);
      if (item.selectionText) {
        var quote = document.createElement("div");
        quote.className = "pi-comment-quote";
        quote.textContent = item.selectionText;
        row.appendChild(quote);
      }
      host.appendChild(row);
    });
  }

  function selectionInside(el) {
    var sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return "";
    var range = sel.getRangeAt(0);
    if (!el.contains(range.commonAncestorContainer)) return "";
    return String(sel.toString()).trim().slice(0, 300);
  }

  var composer = null;

  function closeComposer() {
    if (composer && composer.parentNode) composer.parentNode.removeChild(composer);
    composer = null;
  }

  function openComposer(target) {
    closeComposer();
    var anchor = target.getAttribute("data-pi-anchor") || "";
    var quote = selectionInside(target);
    var box = document.createElement("div");
    box.className = "pi-composer";
    var hint = document.createElement("div");
    hint.className = "pi-composer-hint";
    hint.textContent = anchor ? "批注 #" + anchor : "批注";
    var area = document.createElement("textarea");
    area.placeholder = "写下你的意见…（⌘/Ctrl+Enter 保存，Esc 取消）";
    var actions = document.createElement("div");
    actions.className = "pi-composer-actions";
    var save = document.createElement("button");
    save.type = "button";
    save.className = "pi-btn pi-btn-primary";
    save.textContent = "保存批注";
    var cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "pi-btn";
    cancelBtn.textContent = "取消";

    function saveIt() {
      if (!area.value.trim()) { closeComposer(); return; }
      comment(anchor, area.value, quote);
      if (target.getAttribute("data-pi-anchor")) target.classList.add("pi-anchored");
      closeComposer();
    }

    save.addEventListener("click", saveIt);
    cancelBtn.addEventListener("click", closeComposer);
    area.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") { ev.stopPropagation(); closeComposer(); }
      if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); saveIt(); }
    });

    actions.appendChild(save);
    actions.appendChild(cancelBtn);
    box.appendChild(hint);
    if (quote) {
      var q = document.createElement("div");
      q.className = "pi-comment-quote";
      q.textContent = quote;
      box.appendChild(q);
    }
    box.appendChild(area);
    box.appendChild(actions);
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
    document.querySelectorAll("[data-pi-anchor]").forEach(function (el) {
      if (el.getAttribute("data-pi-anchor-ready") === "1") return;
      el.setAttribute("data-pi-anchor-ready", "1");
      el.classList.add("pi-anchorable");
      el.addEventListener("click", function (ev) {
        if (ev.target.closest("a,input,button,textarea,select")) return;
        openComposer(el);
      });
    });
  }

  // ── choice UI ──────────────────────────────────────────────────────────
  function renderChoice(el) {
    var name = el.getAttribute("data-pi-choice");
    var multiple = el.getAttribute("data-pi-multiple") === "true";
    var current = state.choices[name];
    el.querySelectorAll(".pi-choice-opt").forEach(function (btn) {
      var value = btn.getAttribute("data-value");
      var active = multiple ? Array.isArray(current) && current.indexOf(value) !== -1 : current === value;
      btn.classList.toggle("pi-choice-active", !!active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  function setupChoices() {
    document.querySelectorAll("[data-pi-choice]").forEach(function (el) {
      if (el.getAttribute("data-pi-choice-ready") === "1") { renderChoice(el); return; }
      el.setAttribute("data-pi-choice-ready", "1");
      var name = el.getAttribute("data-pi-choice");
      var options = (el.getAttribute("data-pi-options") || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean);
      var labels = (el.getAttribute("data-pi-labels") || "").split("|").map(function (s) { return s.trim(); });
      var multiple = el.getAttribute("data-pi-multiple") === "true";
      var preset = el.getAttribute("data-pi-default");

      el.classList.add("pi-choice");
      el.innerHTML = "";
      options.forEach(function (value, index) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "pi-choice-opt";
        btn.setAttribute("data-value", value);
        btn.textContent = labels[index] || value;
        btn.addEventListener("click", function () {
          if (multiple) {
            var list = Array.isArray(state.choices[name]) ? state.choices[name].slice() : [];
            var at = list.indexOf(value);
            if (at === -1) list.push(value); else list.splice(at, 1);
            state.choices[name] = list;
          } else {
            state.choices[name] = value;
          }
          saveDraft();
          renderChoice(el);
        });
        el.appendChild(btn);
      });
      if (preset && state.choices[name] === undefined) {
        state.choices[name] = multiple ? preset.split(",").map(function (s) { return s.trim(); }) : preset;
      }
      renderChoice(el);
    });
  }

  // ── upload UI ──────────────────────────────────────────────────────────
  function renderUploads() {
    var list = document.querySelector("[data-pi-uploads-list]");
    if (!list) return;
    list.innerHTML = "";
    state.uploads.forEach(function (item) {
      var row = document.createElement("div");
      row.className = "pi-upload-item";
      var link = document.createElement("a");
      link.href = item.url;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = item.name;
      var meta = document.createElement("span");
      meta.className = "pi-upload-size";
      meta.textContent = formatSize(item.size);
      row.appendChild(link);
      row.appendChild(meta);
      list.appendChild(row);
    });
  }

  function formatSize(bytes) {
    if (!bytes && bytes !== 0) return "";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1024 / 1024).toFixed(1) + " MB";
  }

  function setupUploads() {
    document.querySelectorAll("[data-pi-upload]").forEach(function (el) {
      if (el.getAttribute("data-pi-upload-ready") === "1") return;
      el.setAttribute("data-pi-upload-ready", "1");
      var input;
      if (el.tagName === "INPUT" && el.type === "file") {
        input = el;
      } else {
        input = document.createElement("input");
        input.type = "file";
        input.multiple = true;
        input.className = "pi-upload-input";
        el.appendChild(input);
      }
      input.addEventListener("change", function () {
        Array.prototype.slice.call(input.files || []).forEach(function (file) {
          upload(file).catch(function (err) {
            showOverlay("⚠️ 上传失败", String((err && err.message) || err), "error");
          });
        });
        input.value = "";
      });
      if (el.tagName !== "INPUT") {
        el.addEventListener("click", function () { input.click(); });
      }
    });
  }

  // ── buttons / keys / polling ───────────────────────────────────────────
  function setupButtons() {
    document.querySelectorAll("[data-pi-submit]").forEach(function (el) {
      if (el.getAttribute("data-pi-ready") === "1") return;
      el.setAttribute("data-pi-ready", "1");
      el.addEventListener("click", function () { submit(); });
    });
    document.querySelectorAll("[data-pi-cancel]").forEach(function (el) {
      if (el.getAttribute("data-pi-ready") === "1") return;
      el.setAttribute("data-pi-ready", "1");
      el.addEventListener("click", function () { cancel(); });
    });
    if (document.body.getAttribute("data-pi-keys-ready") !== "1") {
      document.body.setAttribute("data-pi-keys-ready", "1");
      document.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
          ev.preventDefault();
          submit();
        }
      });
    }
  }

  function stopPolling() {
    if (timer) { clearTimeout(timer); timer = null; }
  }

  function poll() {
    if (status !== "waiting") { stopPolling(); return; }
    fetch(api("/pi/state"), { cache: "no-store" })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (data && data.version && data.version !== VERSION) {
          showOverlay("↓ 有新版本", "agent 更新了这一页，正在刷新…", "info");
          setTimeout(function () { location.reload(); }, 250);
          return;
        }
        if (data && (data.status === "expired" || data.status === "timeout" || data.status === "cancelled" || data.status === "aborted")) {
          showOverlay("页面已失效", "状态：" + data.status + "。请回到终端。", "muted");
          status = data.status;
          disableActions();
          stopPolling();
          return;
        }
        timer = setTimeout(poll, POLL_MS);
      })
      .catch(function () { timer = setTimeout(poll, POLL_MS); });
  }

  // ── SDK styles: the composer/overlay must look right in any page ───────
  var CSS = [
    ".pi-anchorable{cursor:pointer;border-radius:3px;box-shadow:inset 0 -1px 0 0 var(--pi-accent,#2f6fed);transition:background .12s}",
    ".pi-anchorable:hover{background:rgba(47,111,237,.10)}",
    ".pi-anchored{background:rgba(255,196,0,.18);box-shadow:inset 0 -1px 0 0 #d9a400}",
    ".pi-composer{position:fixed;z-index:99998;width:340px;max-width:92vw;background:var(--pi-surface,#fff);color:var(--pi-text,#111);border:1px solid rgba(0,0,0,.14);border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.22);padding:10px;font:13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}",
    ".pi-composer textarea{width:100%;box-sizing:border-box;min-height:78px;resize:vertical;font:inherit;padding:8px;border:1px solid rgba(0,0,0,.16);border-radius:7px;background:transparent;color:inherit}",
    ".pi-composer-hint{font-weight:600;font-size:12px;opacity:.75;margin-bottom:6px}",
    ".pi-composer-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:8px}",
    ".pi-btn{font:inherit;padding:5px 12px;border-radius:7px;border:1px solid rgba(0,0,0,.16);background:transparent;color:inherit;cursor:pointer}",
    ".pi-btn-primary{background:var(--pi-accent,#2f6fed);border-color:transparent;color:#fff}",
    ".pi-btn:disabled{opacity:.5;cursor:default}",
    ".pi-busy{opacity:.6}",
    ".pi-overlay{position:fixed;inset:0;z-index:99999;display:none;align-items:center;justify-content:center;background:rgba(12,16,24,.55);backdrop-filter:blur(3px)}",
    ".pi-overlay-card{background:var(--pi-surface,#fff);color:var(--pi-text,#111);border-radius:14px;padding:22px 26px;max-width:440px;text-align:center;box-shadow:0 18px 48px rgba(0,0,0,.3);font:14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}",
    ".pi-overlay-title{font-size:17px;font-weight:700;margin-bottom:6px}",
    ".pi-overlay-ok .pi-overlay-title{color:#1a7f37}",
    ".pi-overlay-error .pi-overlay-title{color:#c0392b}",
    ".pi-comment{border-left:3px solid var(--pi-accent,#2f6fed);padding:2px 0 2px 10px;margin:0 0 12px}",
    ".pi-comment-head{display:flex;justify-content:space-between;gap:8px;font-size:12px;opacity:.7}",
    ".pi-comment-del{border:0;background:none;color:inherit;cursor:pointer;font-size:12px;opacity:.7}",
    ".pi-comment-body{white-space:pre-wrap;margin-top:2px}",
    ".pi-comment-quote{font-size:12px;opacity:.65;border-left:2px solid rgba(0,0,0,.15);padding-left:8px;margin-top:4px;white-space:pre-wrap}",
    ".pi-empty{opacity:.55;font-size:13px}",
    ".pi-choice{display:flex;flex-wrap:wrap;gap:8px}",
    ".pi-choice-opt{font:inherit;padding:6px 14px;border-radius:999px;border:1px solid rgba(0,0,0,.18);background:transparent;color:inherit;cursor:pointer}",
    ".pi-choice-active{background:var(--pi-accent,#2f6fed);border-color:transparent;color:#fff}",
    ".pi-upload-input{display:block;margin-top:6px}",
    ".pi-upload-item{display:flex;justify-content:space-between;gap:10px;font-size:13px;padding:3px 0}",
    ".pi-upload-size{opacity:.6}",
    "@media (prefers-color-scheme:dark){.pi-composer,.pi-overlay-card{background:var(--pi-surface,#171a20);color:var(--pi-text,#e7e9ee)}.pi-choice-opt,.pi-btn{border-color:rgba(255,255,255,.22)}}",
  ].join("\n");

  function injectStyles() {
    if (document.getElementById("pi-sdk-styles")) return;
    var style = document.createElement("style");
    style.id = "pi-sdk-styles";
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function setup() {
    injectStyles();
    loadDraft();
    setupAnchors();
    setupChoices();
    setupUploads();
    setupButtons();
    renderComments();
    renderUploads();
    document.querySelectorAll("[data-pi-version]").forEach(function (el) {
      el.textContent = String(VERSION);
    });
    emit("ready", null);
    timer = setTimeout(poll, POLL_MS);
  }

  // The agent may re-render content after the SDK loaded; re-scan on demand.
  var pi = {
    __askPage: true,
    pageId: PAGE_ID,
    version: VERSION,
    state: state,
    get status() { return status; },
    submit: submit,
    cancel: cancel,
    comment: comment,
    choice: choice,
    upload: upload,
    setExtra: function (key, value) { state.extra[key] = value; return value; },
    on: function (event, fn) { (hooks[event] = hooks[event] || []).push(fn); return pi; },
    rescan: function () { setupAnchors(); setupChoices(); setupUploads(); setupButtons(); },
    refresh: poll,
  };
  window.pi = pi;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setup);
  } else {
    setup();
  }
})();
