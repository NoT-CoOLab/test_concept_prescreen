/* Recognition pretest — main app logic.
 * Reads CONFIG from config.js and STRINGS from i18n.js.
 * No build step, no external dependencies — plain JS so it runs on old browsers/hardware.
 */
(function () {
  "use strict";

  var STATE_KEY = "expstate_" + CONFIG.siteId;
  var LANG_KEY = "explang_" + CONFIG.siteId;

  var CSV_HEADER = ["patient_id", "site", "index", "file_name", "response",
    "session_start", "response_time", "trial_index", "language", "regions_selected",
    "name_shown", "type", "population", "response_time_ms"];

  var data = null;        // { concepts: [...] }
  var conceptByFile = {};
  var lang = (CONFIG.languages && CONFIG.languages[0]) || "en";
  var state = null;       // active session state, see newState()
  var trialStartTs = 0;
  var locked = false;     // true while a response animation is in flight

  // ---------------- DOM helpers ----------------
  function $(id) { return document.getElementById(id); }
  function showScreen(id) {
    document.querySelectorAll("[data-screen]").forEach(function (el) {
      el.hidden = (el.id !== id);
    });
  }
  function t(key) {
    var s = STRINGS[lang] || STRINGS.en;
    return (key in s) ? s[key] : (STRINGS.en[key] || key);
  }

  // ---------------- Storage helpers ----------------
  function saveState() {
    if (state) localStorage.setItem(STATE_KEY, JSON.stringify(state));
  }
  function loadState() {
    try {
      var raw = localStorage.getItem(STATE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function clearState() {
    localStorage.removeItem(STATE_KEY);
  }

  // ---------------- Utility ----------------
  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }
  function nowIso() { return new Date().toISOString(); }

  function regionsByCodes(codes) {
    var list = CONFIG.regions || [];
    return list.filter(function (r) { return codes.indexOf(r.code) !== -1; });
  }

  function buildPool(regionPopulations) {
    // Case-insensitive on purpose: population values come from two independently-
    // edited places (the spreadsheet and each site's config.js), and a casing
    // mismatch between them (e.g. "german" vs "German") would otherwise silently
    // exclude every region-specific concept with no visible error at all.
    var regionPopulationsLower = regionPopulations.map(function (p) { return String(p).toLowerCase(); });
    return data.concepts.filter(function (c) {
      var cPop = String(c.population).toLowerCase();
      return (cPop === "global") || (regionPopulationsLower.indexOf(cPop) !== -1);
    });
  }

  function buildOrder(pool, excludeFileNames) {
    // Plain random order — deliberately not biased toward any topic, so a
    // participant's stated interests can't influence which stimuli they see
    // first (or at all, if the pool runs out before finishing).
    var excl = {};
    (excludeFileNames || []).forEach(function (f) { excl[f] = true; });
    var fileNames = [];
    pool.forEach(function (c) {
      if (excl[c.file_name]) return;
      fileNames.push(c.file_name);
    });
    shuffle(fileNames);
    return fileNames;
  }

  function setSaveIndicator(kind) {
    var el = $("save-indicator");
    if (!kind) { el.hidden = true; return; }
    el.hidden = false;
    el.classList.toggle("offline", kind === "offline");
    el.textContent = kind === "ok" ? t("savingIndicatorOk") :
      kind === "pending" ? t("savingIndicatorPending") : t("savingIndicatorOffline");
  }

  // ---------------- Email-relay backend ----------------
  // Sends the FULL accumulated session so far as a JSON-Lines email body to the
  // researcher's own inbox (CONFIG.emailjs.ingressTo), at finish and periodic
  // checkpoints. A separate Power Automate flow (see email-relay/DEPLOY.md) watches
  // that inbox and turns each one into a real file sent to CONFIG.notifyEmails.
  //
  // Because each checkpoint is a complete snapshot (not a diff), a single failed send
  // is not fatal — the next checkpoint resends everything, so there's no separate
  // retry queue needed here.
  //
  // This calls EmailJS's plain REST endpoint directly with fetch() rather than loading
  // their SDK from a CDN — deliberately. The SDK approach had a real bug: loading it
  // requires a separate script from a CDN, and that load was cached, including when it
  // failed — so if the very first attempt happened while offline, every future retry
  // (even after reconnecting) kept reusing that same failed, cached attempt forever
  // instead of trying again. A plain fetch() call has no such shared, cacheable
  // "is it loaded" state to get stuck in — every call is independent by construction,
  // and there's one fewer external host (the CDN) that could be the thing that's down.
  function buildCheckpointBody() {
    // Same CSV the download button produces — one consistent format everywhere,
    // and Excel/MATLAB's readtable() both open it natively with no custom parsing.
    return buildCsvContent();
  }

  function recipientsFor(checkpointType) {
    var always = (CONFIG.notifyEmails || []).filter(Boolean);
    var finalOnly = (CONFIG.finalOnlyEmails || []).filter(Boolean);
    return checkpointType === "finish" ? always.concat(finalOnly) : always;
  }

  // Resolves with {ok: true} or {ok: false} — never rejects — so callers can react to
  // failure (e.g. finishSession showing a "still trying to save" screen) without needing
  // a try/catch. A failed send isn't reported as a JS error, just a false "ok".
  function sendCheckpointEmail(checkpointType) {
    var cfg = CONFIG.emailjs || {};
    var recipients = recipientsFor(checkpointType);
    // Recipients joined with commas as ONE subject segment (not fixed slots), so this
    // works whether there's 1 recipient today or more added later — see
    // email-relay/DEPLOY.md for how the flow turns this back into a proper To field.
    var subject = ["PRETEST-DATA", CONFIG.siteId, state.code, checkpointType,
      recipients.join(",")].join("|");
    var payload = {
      service_id: cfg.serviceId,
      template_id: cfg.templateId,
      user_id: cfg.publicKey,
      template_params: {
        to_email: cfg.ingressTo,
        subject: subject,
        message: buildCheckpointBody()
      }
    };
    setSaveIndicator("pending");
    // A stalled connection (e.g. "connected to WiFi but no real internet") often
    // doesn't reject quickly — it can just hang for a long time. Racing it against a
    // timeout isn't enough on its own: the abandoned request keeps running in the
    // background regardless, and after enough of those pile up, the browser's
    // per-host connection limit (6 in most browsers) is exhausted, silently queueing
    // every later retry behind them forever — which is exactly what was happening.
    // AbortController actually cancels the request when the timeout fires, freeing
    // that connection slot immediately so the next retry can really go out.
    var controller = new AbortController();
    var timeoutId = setTimeout(function () { controller.abort(); }, 8000);
    return fetch("https://api.emailjs.com/api/v1.0/email/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    }).then(function (resp) {
      clearTimeout(timeoutId);
      if (resp.ok) {
        setSaveIndicator("ok");
        return { ok: true };
      }
      // We got an actual response — the connection is fine, EmailJS just rejected the
      // request. Most commonly this is their free-tier quota (200/month): once used
      // up, EmailJS returns HTTP 426 and silently ignores every request until the
      // quota resets. That's a completely different situation from "no internet" —
      // retrying identically will never succeed until the quota resets or the plan is
      // upgraded, and blaming the participant's connection for it is actively
      // misleading. Log the real reason so it's actually diagnosable later, and tell
      // callers this explicitly rather than lumping it in with genuine connectivity
      // failures.
      return resp.text().then(function (bodyText) {
        console.warn("EmailJS rejected the request — status " + resp.status + ": " + bodyText);
        setSaveIndicator("offline");
        return { ok: false, serverRejected: true, status: resp.status, quotaLikely: resp.status === 426 };
      });
    }).catch(function (err) {
      clearTimeout(timeoutId);
      // fetch() throwing (rather than resolving with a response) means the request
      // never reached a server at all — this is the genuine "no internet" case.
      console.warn("Checkpoint email failed before getting a response (genuine connectivity issue):", err);
      setSaveIndicator("offline");
      return { ok: false, serverRejected: false };
    });
  }

  // ---------------- Language ----------------
  function populateLanguageSelect() {
    var sel = $("language-select");
    sel.innerHTML = "";
    CONFIG.languages.forEach(function (code) {
      var opt = document.createElement("option");
      opt.value = code;
      opt.textContent = (CONFIG.languageLabels && CONFIG.languageLabels[code]) || code.toUpperCase();
      sel.appendChild(opt);
    });
    sel.value = lang;
    sel.addEventListener("change", function () {
      applyLanguage(sel.value);
    });
  }

  function applyLanguage(newLang) {
    lang = CONFIG.languages.indexOf(newLang) !== -1 ? newLang : CONFIG.languages[0];
    localStorage.setItem(LANG_KEY, lang);
    document.documentElement.lang = lang;
    document.title = CONFIG.siteName + " \u2014 " + t("siteTitleSuffix");
    $("site-title-label").textContent = CONFIG.siteName;
    $("language-label").textContent = t("languageLabel");

    $("welcome-title").textContent = t("welcomeTitle");
    $("welcome-body").textContent = t("welcomeBody");
    $("btn-resume-local").textContent = (state && !$("btn-resume-local").hidden) ? resumeLocalLabel(state) : t("resumeContinueLocal");
    $("btn-start-new").textContent = t("startNew");

    $("patient-id-title").textContent = t("patientIdTitle");
    $("patient-id-body").textContent = t("patientIdBody");
    $("patient-id-input").placeholder = t("patientIdPlaceholder");
    $("patient-id-error").textContent = t("patientIdError");
    $("btn-patient-id-continue").textContent = t("setupContinue");

    $("regions-label").textContent = t("regionsLabel");
    $("regions-note").textContent = t("regionsNote");
    $("btn-setup-continue").textContent = t("setupContinue");

    $("instructions-title").textContent = t("instructionsTitle");
    $("instructions-body").textContent = t("instructionsBody");
    $("instructions-controls-title").textContent = t("instructionsControlsTitle");
    $("instructions-controls-touch").textContent = t("instructionsControlsTouch");
    $("instructions-controls-keyboard").textContent = t("instructionsControlsKeyboard");
    $("instructions-controls-buttons").textContent = t("instructionsControlsButtons");
    $("instructions-image-placeholder").textContent = t("instructionsImagePlaceholder");
    $("btn-instructions-begin").textContent = t("instructionsBegin");

    $("task-reminder").textContent = t("taskReminder");
    $("btn-know-label").textContent = t("knowButton");
    $("btn-dont-know-label").textContent = t("dontKnowButton");

    $("finishing-title").textContent = t("finishingTitle");
    $("finishing-body").textContent = t("finishingBody");
    $("waiting-connection-title").textContent = t("waitingConnectionTitle");
    $("waiting-connection-body").textContent = t("waitingConnectionBody");
    $("redo-prompt-title").textContent = t("redoPromptTitle");
    $("redo-prompt-body").textContent = t("redoPromptBody");
    $("btn-redo-yes").textContent = t("redoYesButton");
    $("btn-redo-no").textContent = t("redoNoButton");
    $("continue-prompt-title").textContent = t("continuePromptTitle");
    $("continue-prompt-body").textContent = t("continuePromptBody");
    $("btn-continue-yes").textContent = t("continueYesButton");
    $("btn-continue-no").textContent = t("continueNoButton");
    $("done-title").textContent = t("doneTitle");
    var emailDisabledDone = CONFIG.emailEnabled === false && !!(state && state.finished);
    $("done-body").hidden = emailDisabledDone;
    if (emailDisabledDone) {
      $("done-body").textContent = "";
    } else {
      $("done-body").textContent = (state && state.finishUnconfirmed) ? t("doneBodyUnconfirmed") : t("doneBody");
    }
    document.querySelectorAll(".btn-download-backup").forEach(function (btn) {
      btn.textContent = t("downloadBackup");
    });
    var doneBtn = $("btn-download-backup-done");
    var doneBtnProminent = emailDisabledDone || !!(state && state.finishUnconfirmed);
    doneBtn.classList.toggle("btn-primary", doneBtnProminent);
    doneBtn.classList.toggle("btn-text", !doneBtnProminent);
    doneBtn.classList.toggle("btn-ghost", false);
    var retryBtn = $("btn-retry-send");
    retryBtn.hidden = emailDisabledDone || !(state && state.finishUnconfirmed);
    retryBtn.classList.toggle("btn-primary", false);
    retryBtn.classList.toggle("btn-ghost", true);
    if (!retryBtn.disabled) retryBtn.textContent = t("retrySendButton");

    populateRegionsGrid();
    renderInstructionsImage();

    // If mid-task, refresh the currently visible stimulus name in the new language
    if (state && state.current) renderCurrentStim();
  }

  var NONE_REGION_VALUE = "__none__";
  function populateRegionsGrid() {
    var grid = $("regions-grid");
    var wrap = $("regions-field");
    var regions = CONFIG.regions || [];
    if (!regions.length) { wrap.hidden = true; return; }
    wrap.hidden = false;
    var prevChecked = Array.prototype.slice.call(grid.querySelectorAll("input:checked")).map(function (i) { return i.value; });
    grid.innerHTML = "";

    var allCheckboxes = [];
    function buildTile(value, text) {
      var label = document.createElement("label");
      label.className = "tag-chip";
      var input = document.createElement("input");
      input.type = "checkbox";
      input.value = value;
      if (prevChecked.indexOf(value) !== -1) { input.checked = true; label.classList.add("checked"); }
      var span = document.createElement("span");
      span.textContent = text;
      label.appendChild(input);
      label.appendChild(span);
      grid.appendChild(label);
      allCheckboxes.push(input);
      return { label: label, input: input };
    }

    regions.forEach(function (region) {
      var text = (region.label && (region.label[lang] || region.label.en)) || region.code;
      var tile = buildTile(region.code, text);
      tile.input.addEventListener("change", function () {
        tile.label.classList.toggle("checked", tile.input.checked);
        // Picking an actual country deselects "None of these" - they're mutually
        // exclusive by definition (you can't mean both "none of these" and "this one").
        if (tile.input.checked) { noneTile.input.checked = false; noneTile.label.classList.remove("checked"); }
      });
    });

    // A country-selection question with only checkboxes never has an explicit "no"
    // - leaving everything blank looks identical to "hasn't answered yet". This tile
    // gives participants (and the data) a real, deliberate "none of these apply" to
    // select, distinct from simply not having engaged with the question at all.
    var noneTile = buildTile(NONE_REGION_VALUE, t("regionsNoneLabel"));
    noneTile.input.addEventListener("change", function () {
      noneTile.label.classList.toggle("checked", noneTile.input.checked);
      if (noneTile.input.checked) {
        allCheckboxes.forEach(function (cb) {
          if (cb !== noneTile.input) { cb.checked = false; cb.dispatchEvent(new Event("change")); }
        });
      }
    });
  }

  function renderInstructionsImage() {
    var frame = $("instructions-image-frame");
    var existingImg = frame.querySelector("img");
    if (existingImg) return; // already resolved (either loaded or we keep trying once)
    var probe = new Image();
    probe.onload = function () {
      var img = document.createElement("img");
      img.src = "images/instructions_example.jpg";
      img.alt = "";
      frame.innerHTML = "";
      frame.appendChild(img);
    };
    probe.onerror = function () { /* keep placeholder text */ };
    probe.src = "images/instructions_example.jpg";
  }

  // ---------------- Welcome screen ----------------
  function resumeLocalLabel(saved) {
    var known = (saved.knownPeopleCount || 0) + " " + t("peopleNoun") + ", " +
      (saved.knownPlacesCount || 0) + " " + t("placesNoun");
    return t("resumeContinueLocal") + " (" + known + " " + t("soFar") + ")";
  }

  function initWelcome() {
    var saved = loadState();
    var continueBtn = $("btn-resume-local");

    if (saved && !saved.finished && saved.order && (saved.order.length || saved.current)) {
      state = saved;
      continueBtn.hidden = false;
      continueBtn.textContent = resumeLocalLabel(saved);
    } else {
      state = null;
      continueBtn.hidden = true;
    }
    showScreen("screen-welcome");
  }

  $("btn-resume-local").addEventListener("click", function () {
    if (!state.current) advanceTrial();
    setSaveIndicator(null);
    showScreen("screen-task");
    renderCurrentStim();
    startKeyboardListening();
  });
  var pendingPatientId = "";
  function formatSubjectId(raw) {
    // Strip a "sub-" they might have typed themselves, so we never end up with
    // "sub-sub-0001" - then keep only filename-safe characters.
    var cleaned = (raw || "").trim().replace(/^sub-/i, "");
    cleaned = cleaned.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 30);
    // Auto zero-pad pure-numeric input to 4 digits, so typing "1" gives the same
    // "sub-0001" a full-width entry would - only touches short numeric input, so
    // anything non-numeric (a name-based scheme, say) or already 4+ digits is left
    // exactly as typed.
    if (/^\d+$/.test(cleaned) && cleaned.length < 4) {
      while (cleaned.length < 4) cleaned = "0" + cleaned;
    }
    return cleaned ? ("sub-" + cleaned) : "";
  }
  $("btn-start-new").addEventListener("click", function () {
    clearState();
    state = null;
    $("patient-id-input").value = "";
    $("patient-id-error").hidden = true;
    showScreen("screen-patient-id");
  });
  $("btn-patient-id-continue").addEventListener("click", function () {
    // Required, not optional: the researcher always hands this out ahead of time
    // (even when the patient runs the session themselves), so there's no legitimate
    // "I don't have one" case here the way there used to be.
    var formatted = formatSubjectId($("patient-id-input").value);
    if (!formatted) {
      $("patient-id-error").hidden = false;
      return;
    }
    $("patient-id-error").hidden = true;
    pendingPatientId = formatted;
    showScreen("screen-setup");
  });

  // ---------------- Setup screen ----------------
  $("btn-setup-continue").addEventListener("click", function () {
    var regionCodes = Array.prototype.slice.call(
      document.querySelectorAll("#regions-grid input:checked")
    ).map(function (i) { return i.value; }).filter(function (v) { return v !== NONE_REGION_VALUE; });

    var regionPopulations = regionsByCodes(regionCodes).map(function (r) { return r.population; });
    var pool = buildPool(regionPopulations);
    var order = buildOrder(pool, []);

    // The participant ID entered on the previous screen IS the identifier
    // throughout - always, on every site. No separate random code anymore.
    var code = pendingPatientId;

    state = {
      code: code,
      patientId: pendingPatientId,
      regionCodes: regionCodes,
      order: order,
      current: null,
      rows: [],
      knownPeopleCount: 0,
      knownPlacesCount: 0,
      seenPeopleCount: 0,
      seenPlacesCount: 0,
      sessionStartIso: nowIso(),
      trialIndex: 0,
      finished: false,
      redoOffered: false,
      continuePromptOffered: false,
      continuePastThreshold: false
    };
    saveState();
    showScreen("screen-instructions");
  });

  // ---------------- Instructions screen ----------------
  $("btn-instructions-begin").addEventListener("click", function () {
    advanceTrial();
    showScreen("screen-task");
    renderCurrentStim();
    startKeyboardListening();
  });

  $("btn-redo-yes").addEventListener("click", function () {
    state.order = shuffle(unknownFileNames());
    state.current = null;
    saveState();
    advanceTrial();
    showScreen("screen-task");
    renderCurrentStim();
    startKeyboardListening();
  });
  $("btn-redo-no").addEventListener("click", function () {
    finishSession();
  });

  $("btn-continue-yes").addEventListener("click", function () {
    state.continuePastThreshold = true;
    saveState();
    // state.current is still null here (that's what got us into this screen in
    // the first place) - advanceTrial() picks up the next item now that the
    // type-skip logic above is disabled for the rest of this session.
    advanceTrial();
    showScreen("screen-task");
    renderCurrentStim();
    startKeyboardListening();
  });
  $("btn-continue-no").addEventListener("click", function () {
    finishSession();
  });

  // ---------------- Task screen ----------------
  var stimCard = null, stimImage = null, stimName = null, flagKnow = null, flagUnknown = null;

  function thresholdsMet() {
    var peopleTarget = CONFIG.minPeopleKnown || 30;
    var placesTarget = CONFIG.minPlacesKnown || 60;
    return state.knownPeopleCount >= peopleTarget && state.knownPlacesCount >= placesTarget;
  }
  function poolExhausted() {
    return !state.current && state.order.length === 0;
  }
  function isFinished() {
    return thresholdsMet() || poolExhausted();
  }
  // The file_names of every response currently on record as "unknown" - what a
  // redo pass would go back through. Deliberately keyed by file_name (not just row
  // index) and deduplicated, since a redo pass itself adds more "unknown" rows for
  // the same items if they're still not recognised the second time - this always
  // reflects the CURRENT set of not-yet-known items, not a stale list from before
  // any earlier redo pass.
  // recordResponse() now guarantees at most one row per file_name (a redo-pass
  // response replaces the original rather than adding alongside it), so this is
  // just every file_name whose single current row says "unknown".
  function unknownFileNames() {
    return state.rows
      .filter(function (row) { return row.response === "unknown"; })
      .map(function (row) { return row.file_name; });
  }

  function advanceTrial() {
    if (state.current) return;
    // Thresholds freshly met, prompt not yet shown/answered: leave state.order
    // completely untouched. Otherwise the type-skip below would drain it (every
    // remaining item gets skipped once both types are "done") before
    // renderCurrentStim() even gets a chance to offer the choice - by the time
    // someone clicked "continue" there'd be nothing left to advance to.
    if (thresholdsMet() && !state.continuePromptOffered) return;
    // Once someone has chosen to continue past the thresholds, every remaining
    // item is fair game again - the type-skip below exists to stop wasting trials
    // on an already-satisfied type during the normal run, not to block someone who
    // deliberately asked to keep going.
    var extending = state.continuePastThreshold;
    var peopleDone = !extending && state.knownPeopleCount >= (CONFIG.minPeopleKnown || 30);
    var placesDone = !extending && state.knownPlacesCount >= (CONFIG.minPlacesKnown || 60);
    while (state.order.length > 0) {
      var candidate = state.order[0];
      var concept = conceptByFile[candidate];
      // Once a type's quota is met, stop showing that type — only the type still
      // needed keeps appearing, so no trials get spent on a quota already satisfied.
      if (concept && ((concept.type === "person" && peopleDone) || (concept.type === "place" && placesDone))) {
        state.order.shift();
        continue;
      }
      state.current = state.order.shift();
      saveState();
      return;
    }
    state.current = null;
    saveState();
  }

  // Read-only version of advanceTrial's own skip logic, for preloading — figures out
  // which file_name would be shown next without touching state.order or state.current.
  function peekNextFileName() {
    var extending = state.continuePastThreshold;
    var peopleDone = !extending && state.knownPeopleCount >= (CONFIG.minPeopleKnown || 30);
    var placesDone = !extending && state.knownPlacesCount >= (CONFIG.minPlacesKnown || 60);
    for (var i = 0; i < state.order.length; i++) {
      var candidate = state.order[i];
      var concept = conceptByFile[candidate];
      if (concept && ((concept.type === "person" && peopleDone) || (concept.type === "place" && placesDone))) {
        continue;
      }
      return candidate;
    }
    return null;
  }
  // Kicks off a background fetch only — deliberately never touches the visible
  // <img> element, so it can't interfere with the load/reveal sequence above.
  function preloadNextImage() {
    var next = peekNextFileName();
    if (!next) return;
    var img = new Image();
    img.src = "images/" + next;
  }

  function renderCurrentStim() {
    if (thresholdsMet()) {
      // Only asked once - if they've already chosen to continue, thresholds stay
      // "met" for the rest of the session, but that shouldn't mean asking again
      // every single trial. If they're back here AND still extending, it just
      // means the pool has now also run out - a normal finish, nothing left to ask.
      if (!state.continuePromptOffered) {
        state.continuePromptOffered = true;
        saveState();
        stopKeyboardListening();
        showScreen("screen-continue-prompt");
        return;
      }
      if (poolExhausted()) { finishSession(); return; }
    } else if (poolExhausted()) {
      // Give the participant a real choice here rather than ending the session
      // outright just because the pool ran dry before reaching the target -
      // maybe a name comes back to them on a second look, maybe it doesn't, either
      // is a completely fine outcome. unknownFileNames() already excludes anything
      // this same redo pass has since turned into "known", so re-declining an item
      // doesn't loop it back in for a third try.
      if (!state.redoOffered && unknownFileNames().length > 0) {
        state.redoOffered = true;
        saveState();
        stopKeyboardListening();
        showScreen("screen-redo-prompt");
        return;
      }
      finishSession();
      return;
    }
    var concept = conceptByFile[state.current];
    if (!concept) { // data mismatch safety net: skip unknown file and move on
      state.current = null; advanceTrial(); renderCurrentStim(); return;
    }
    resetCardTransform(true);

    // Stay locked, and hide the previous picture + name immediately, until the new
    // image is actually ready. Otherwise a slow-loading image leaves the OLD picture
    // on screen next to the NEW name for however long it takes to load — a mismatched
    // pairing that's confusing at best, and actively wrong for a task that's asking
    // "do you recognise this picture AND this name together."
    locked = true;
    stimName.textContent = "";
    stimImage.style.visibility = "hidden";
    var wrap = stimImage.parentNode;
    var oldFallback = wrap.querySelector(".stim-missing-fallback");
    if (oldFallback) oldFallback.remove();
    var loadingEl = wrap.querySelector(".stim-loading");
    if (!loadingEl) {
      loadingEl = document.createElement("div");
      loadingEl.className = "stim-loading spinner";
      wrap.appendChild(loadingEl);
    }
    loadingEl.hidden = false;

    function reveal() {
      loadingEl.hidden = true;
      stimImage.style.visibility = "visible";
      stimName.textContent = concept.names[lang] || concept.names.en;
      trialStartTs = performance.now();
      locked = false;
      // Start fetching the next image now, while this one's still on screen, so it's
      // very likely already cached by the time the response animation finishes and
      // it's actually needed — shrinks the "locked" window from image-load-time down
      // to close to just the animation's own 230ms.
      preloadNextImage();
    }

    stimImage.alt = "";
    stimImage.onload = reveal;
    stimImage.onerror = function () {
      stimImage.onerror = null;
      stimImage.style.display = "none";
      var fallback = wrap.querySelector(".stim-missing-fallback");
      if (!fallback) {
        fallback = document.createElement("div");
        fallback.className = "stim-missing-fallback";
        fallback.style.cssText = "padding:12px;text-align:center;color:#8a8a8a;font-size:13px;";
        wrap.appendChild(fallback);
      }
      fallback.textContent = concept.file_name;
      reveal();
    };
    stimImage.style.display = "";
    stimImage.src = "images/" + concept.file_name;
  }

  function recordResponse(responseValue) {
    var concept = conceptByFile[state.current];
    var rt = Math.round(performance.now() - trialStartTs);

    // A redo pass answers something already in state.rows - the new response should
    // replace that old row outright, not add a second row for the same item. Undo
    // the old row's contribution to the seen/known counts before removing it, so
    // those stay accurate no matter which way the response changes (known->unknown,
    // unknown->known, or unchanged).
    for (var i = 0; i < state.rows.length; i++) {
      if (state.rows[i].file_name === concept.file_name) {
        var oldRow = state.rows[i];
        if (oldRow.type === "person") {
          state.seenPeopleCount -= 1;
          if (oldRow.response === "known") state.knownPeopleCount -= 1;
        } else if (oldRow.type === "place") {
          state.seenPlacesCount -= 1;
          if (oldRow.response === "known") state.knownPlacesCount -= 1;
        }
        state.rows.splice(i, 1);
        break;
      }
    }

    var row = {
      patient_id: state.patientId || "",
      site: CONFIG.siteId,
      index: concept.index,
      file_name: concept.file_name,
      response: responseValue,
      session_start: state.sessionStartIso,
      response_time: nowIso(),
      trial_index: state.trialIndex,
      language: lang,
      regions_selected: state.regionCodes.join("|"),
      name_shown: concept.names[lang] || concept.names.en,
      type: concept.type,
      population: concept.population,
      response_time_ms: rt
    };
    state.rows.push(row);
    state.trialIndex += 1;
    if (concept.type === "person") {
      state.seenPeopleCount += 1;
      if (responseValue === "known") state.knownPeopleCount += 1;
    } else if (concept.type === "place") {
      state.seenPlacesCount += 1;
      if (responseValue === "known") state.knownPlacesCount += 1;
    }
    state.current = null;
    saveState();

    var every = CONFIG.checkpointEveryNResponses || 25;
    if (CONFIG.emailEnabled !== false && state.trialIndex > 0 && state.trialIndex % every === 0) {
      sendCheckpointEmail("periodic");
    }
  }

  function handleResponse(responseValue) {
    if (locked) return;
    locked = true;
    recordResponse(responseValue);
    // No animation delay here anymore, deliberately: recovery of every response,
    // regardless of how fast someone responds, matters more than the card-swipe
    // visual. The only wait left is the genuine one in renderCurrentStim/reveal()
    // below - the next image actually has to load before input unlocks again -
    // which is untouched, since that's protecting response validity, not pacing.
    advanceTrial();
    renderCurrentStim();
  }

  function resetCardTransform(instant) {
    if (instant) stimCard.style.transition = "none";
    stimCard.style.transform = "";
    flagKnow.style.opacity = 0;
    flagUnknown.style.opacity = 0;
    if (instant) {
      // force reflow then restore transition capability
      void stimCard.offsetWidth;
      stimCard.style.transition = "";
    }
  }

  // Pointer drag (mouse + touch, via Pointer Events)
  var dragging = false, dragStartX = 0, dragX = 0;
  var SWIPE_THRESHOLD = 90;
  function setupDrag() {
    stimCard.addEventListener("pointerdown", function (e) {
      if (locked) return;
      dragging = true;
      dragStartX = e.clientX;
      dragX = 0;
      stimCard.setPointerCapture(e.pointerId);
      stimCard.style.transition = "none";
    });
    stimCard.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      dragX = e.clientX - dragStartX;
      stimCard.style.transform = "translateX(" + dragX + "px) rotate(" + (dragX / 20) + "deg)";
      flagKnow.style.opacity = Math.max(0, Math.min(1, dragX / 80));
      flagUnknown.style.opacity = Math.max(0, Math.min(1, -dragX / 80));
    });
    function endDrag() {
      if (!dragging) return;
      dragging = false;
      if (dragX > SWIPE_THRESHOLD) handleResponse("known");
      else if (dragX < -SWIPE_THRESHOLD) handleResponse("unknown");
      else { stimCard.style.transition = "transform 0.2s ease"; resetCardTransform(false); }
    }
    stimCard.addEventListener("pointerup", endDrag);
    stimCard.addEventListener("pointercancel", endDrag);
  }

  var keyboardActive = false;
  function startKeyboardListening() { keyboardActive = true; }
  function stopKeyboardListening() { keyboardActive = false; }
  document.addEventListener("keydown", function (e) {
    if (!keyboardActive || locked) return;
    if (e.key === "ArrowRight") handleResponse("known");
    else if (e.key === "ArrowLeft") handleResponse("unknown");
  });

  $("btn-know").addEventListener("click", function () { handleResponse("known"); });
  $("btn-dont-know").addEventListener("click", function () { handleResponse("unknown"); });

  // ---------------- Done screen ----------------
  function finishSession() {
    stopKeyboardListening();
    state.finished = true;
    saveState();
    // A simple count of participation, not performance - there's no "right" number
    // of people/places to recognise, so this deliberately avoids anything that
    // could read as a score. How many pictures they looked at can't be a bad
    // number, so it's a safe, always-positive note to end on.
    $("done-stats").hidden = true;
    if (CONFIG.emailEnabled === false) {
      // No backend configured for this site at all — there's nothing to attempt or
      // retry, so go straight to "done" with the download option front and center,
      // since it's the only way this session's data reaches anyone.
      showDoneScreenNoEmail();
      return;
    }
    showScreen("screen-finishing");
    attemptFinishSend();
  }
  function showDoneScreenNoEmail() {
    $("done-body").hidden = true;
    $("done-body").textContent = "";
    var dlBtn = $("btn-download-backup-done");
    dlBtn.classList.remove("btn-text");
    dlBtn.classList.add("btn-primary");
    $("btn-retry-send").hidden = true;
    showScreen("screen-done");
  }

  var finishRetryTimer = null;
  var finishSendInFlight = false;
  function attemptFinishSend() {
    if (finishSendInFlight) return;
    finishSendInFlight = true;
    sendCheckpointEmail("finish").then(function (result) {
      finishSendInFlight = false;
      if (result && result.ok) {
        stopFinishRetrying();
        state.finishUnconfirmed = false;
        saveState();
        showDoneScreen();
        return;
      }
      // navigator.onLine === false means the browser itself has confirmed there's no
      // network connection at all — a plain, ordinary "wait for the internet to come
      // back" situation, worth actually waiting through since it will very likely
      // resolve on its own. Anything else (a real response that was rejected, a
      // request that failed or timed out while the browser believes it's online) is
      // NOT that — retrying identically won't necessarily help, and there's no reason
      // to make anyone wait through it. This is exactly the distinction that matters:
      // "no internet" is worth pausing for; "internet's fine, something else is wrong"
      // is not, and should never block finishing the task.
      if (navigator.onLine === false && $("screen-done").hidden) {
        showScreen("screen-waiting-connection");
      } else if ($("screen-done").hidden) {
        state.finishUnconfirmed = true;
        saveState();
        showDoneScreen();
      } else {
        // Already on screen-done (e.g. this was a manual retry click, or a background
        // attempt while already there) and it failed again — reset the retry button
        // so it doesn't stay stuck showing "Sending…" forever.
        var retryBtn = $("btn-retry-send");
        retryBtn.disabled = false;
        retryBtn.textContent = t("retrySendButton");
      }
      startFinishRetrying();
    });
  }
  function showDoneScreen() {
    $("done-body").hidden = false;
    $("done-body").textContent = state.finishUnconfirmed ? t("doneBodyUnconfirmed") : t("doneBody");
    var dlBtn = $("btn-download-backup-done");
    dlBtn.classList.toggle("btn-text", !state.finishUnconfirmed);
    dlBtn.classList.toggle("btn-primary", !!state.finishUnconfirmed);
    var retryBtn = $("btn-retry-send");
    retryBtn.hidden = !state.finishUnconfirmed;
    retryBtn.classList.add("btn-ghost");
    retryBtn.disabled = false;
    retryBtn.textContent = t("retrySendButton");
    showScreen("screen-done");
  }
  function startFinishRetrying() {
    if (finishRetryTimer) return; // already retrying
    finishRetryTimer = setInterval(attemptFinishSend, 8000);
    window.addEventListener("online", attemptFinishSend);
  }
  function stopFinishRetrying() {
    if (finishRetryTimer) { clearInterval(finishRetryTimer); finishRetryTimer = null; }
    window.removeEventListener("online", attemptFinishSend);
  }

  // Manual retry, for when someone doesn't want to just wait on the automatic
  // background attempts — same underlying send, just triggered on demand with
  // immediate feedback instead of silently happening (or not) in the background.
  // attemptFinishSend()'s own finishSendInFlight guard already makes this safe to
  // press even if a background retry happens to be in flight at the same moment.
  $("btn-retry-send").addEventListener("click", function () {
    var btn = $("btn-retry-send");
    btn.disabled = true;
    btn.textContent = t("retrySendButtonSending");
    attemptFinishSend();
  });

  function buildCsvContent() {
    var lines = [CSV_HEADER.join(",")];
    state.rows.forEach(function (row) {
      lines.push(CSV_HEADER.map(function (h) { return csvEscape(row[h]); }).join(","));
    });
    return lines.join("\n");
  }
  function backupFileName() {
    // Named after the participant ID directly (e.g. "sub-0001_prescreen.csv") —
    // much easier to pick out and read into MATLAB when you already know the ID
    // you're looking for.
    return state.code + "_prescreen.csv";
  }
  function downloadBackupCsv() {
    var blob = new Blob([buildCsvContent()], { type: "text/csv;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = backupFileName();
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }
  // Always available, on every screen that can follow the last trial — never
  // conditional, never automatic, always just a click away if wanted.
  document.querySelectorAll(".btn-download-backup").forEach(function (btn) {
    btn.addEventListener("click", downloadBackupCsv);
  });

  function csvEscape(v) {
    if (v === undefined || v === null) v = "";
    v = String(v);
    if (v.indexOf(",") !== -1 || v.indexOf('"') !== -1 || v.indexOf("\n") !== -1) {
      v = '"' + v.replace(/"/g, '""') + '"';
    }
    return v;
  }

  // ---------------- Init ----------------
  function init() {
    stimCard = $("stim-card");
    stimImage = $("stim-image");
    stimName = $("stim-name");
    flagKnow = $("flag-know");
    flagUnknown = $("flag-unknown");
    setupDrag();

    fetch("concepts.json").then(function (r) { return r.json(); }).then(function (json) {
      data = json;
      conceptByFile = {};
      data.concepts.forEach(function (c) { conceptByFile[c.file_name] = c; });

      var storedLang = localStorage.getItem(LANG_KEY);
      lang = (storedLang && CONFIG.languages.indexOf(storedLang) !== -1) ? storedLang : CONFIG.languages[0];

      populateLanguageSelect();
      applyLanguage(lang);
      initWelcome();
    }).catch(function (err) {
      document.body.innerHTML = "<p style='padding:40px;font-family:sans-serif'>" +
        "Could not load concepts.json. If you opened this file directly from disk, " +
        "you need to serve it over http:// (e.g. GitHub Pages, or run a local server) " +
        "rather than opening index.html directly. (" + err + ")</p>";
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
