/* Recognition pretest — main app logic.
 * Reads CONFIG from config.js and STRINGS from i18n.js.
 * No build step, no external dependencies — plain JS so it runs on old browsers/hardware.
 */
(function () {
  "use strict";

  var STATE_KEY = "expstate_" + CONFIG.siteId;
  var LANG_KEY = "explang_" + CONFIG.siteId;

  var CSV_HEADER = ["participant_code", "site", "session_start_iso", "response_timestamp_iso",
    "trial_index", "language", "regions_selected", "age_group_code", "interests_selected",
    "file_name", "name_shown", "type", "population", "min_age_group", "max_age_group", "interest_tags",
    "response", "response_time_ms"];

  var data = null;        // { concepts: [...], age_groups: [...] }
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
  function generateCode() {
    var charset = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L ambiguity
    var out = "";
    for (var i = 0; i < 6; i++) out += charset[Math.floor(Math.random() * charset.length)];
    return out;
  }
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

  function buildPool(regionPopulations, ageGroupCode) {
    return data.concepts.filter(function (c) {
      var popOk = (c.population === "global") || (regionPopulations.indexOf(c.population) !== -1);
      var ageOk = ageGroupCode >= c.min_age_group && ageGroupCode <= c.max_age_group;
      return popOk && ageOk;
    });
  }

  function buildOrder(pool, selectedInterests, excludeFileNames) {
    var excl = {};
    (excludeFileNames || []).forEach(function (f) { excl[f] = true; });
    var bucketA = [], bucketB = [];
    pool.forEach(function (c) {
      if (excl[c.file_name]) return;
      var match = c.interest_tags.some(function (tag) { return selectedInterests.indexOf(tag) !== -1; });
      (match ? bucketA : bucketB).push(c.file_name);
    });
    shuffle(bucketA); shuffle(bucketB);
    return bucketA.concat(bucketB);
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
  var emailjsReady = null;
  function ensureEmailjsLoaded() {
    if (emailjsReady) return emailjsReady;
    emailjsReady = new Promise(function (resolve, reject) {
      function initAndResolve() {
        try { window.emailjs.init({ publicKey: (CONFIG.emailjs || {}).publicKey }); } catch (e) { /* older SDK: init not required */ }
        resolve();
      }
      if (typeof window.emailjs !== "undefined") { initAndResolve(); return; }
      var script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/@emailjs/browser@4/dist/email.min.js";
      script.onload = initAndResolve;
      script.onerror = function () { reject(new Error("emailjs_sdk_load_failed")); };
      document.head.appendChild(script);
    });
    return emailjsReady;
  }

  function buildCheckpointBody() {
    return state.rows.map(function (row) { return JSON.stringify(row); }).join("\n");
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
    var params = {
      to_email: cfg.ingressTo,
      subject: subject,
      message: buildCheckpointBody()
    };
    setSaveIndicator("pending");
    return ensureEmailjsLoaded().then(function () {
      return window.emailjs.send(cfg.serviceId, cfg.templateId, params);
    }).then(function () {
      setSaveIndicator("ok");
      return { ok: true };
    }).catch(function (err) {
      console.warn("Checkpoint email failed (the next checkpoint will resend everything):", err);
      setSaveIndicator("offline");
      return { ok: false };
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

    $("setup-title").textContent = t("setupTitle");
    $("regions-label").textContent = t("regionsLabel");
    $("regions-note").textContent = t("regionsNote");
    $("age-label").textContent = t("ageLabel");
    $("age-error").textContent = t("ageError");
    $("interests-label").textContent = t("interestsLabel");
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
    $("connection-issue-title").textContent = t("connectionIssueTitle");
    $("connection-issue-body").textContent = t("connectionIssueBody");
    $("done-title").textContent = t("doneTitle");
    $("done-body").textContent = t("doneBody");
    document.querySelectorAll(".btn-download-backup").forEach(function (btn) {
      btn.textContent = t("downloadBackup");
    });

    populateRegionsGrid();
    populateAgeGroupGrid();
    populateInterestsGrid();
    renderInstructionsImage();

    // If mid-task, refresh the currently visible stimulus name in the new language
    if (state && state.current) renderCurrentStim();
  }

  function populateRegionsGrid() {
    var grid = $("regions-grid");
    var wrap = $("regions-field");
    var regions = CONFIG.regions || [];
    if (!regions.length) { wrap.hidden = true; return; }
    wrap.hidden = false;
    var prevChecked = Array.prototype.slice.call(grid.querySelectorAll("input:checked")).map(function (i) { return i.value; });
    grid.innerHTML = "";
    regions.forEach(function (region) {
      var label = document.createElement("label");
      label.className = "tag-chip";
      var input = document.createElement("input");
      input.type = "checkbox";
      input.value = region.code;
      if (prevChecked.indexOf(region.code) !== -1) { input.checked = true; label.classList.add("checked"); }
      input.addEventListener("change", function () {
        label.classList.toggle("checked", input.checked);
      });
      var span = document.createElement("span");
      span.textContent = (region.label && (region.label[lang] || region.label.en)) || region.code;
      label.appendChild(input);
      label.appendChild(span);
      grid.appendChild(label);
    });
  }

  function ageGroupDisplayLabel(group, allGroupsSorted) {
    var isLast = group.code === allGroupsSorted[allGroupsSorted.length - 1].code;
    return isLast ? (group.age_min + "+") : (group.age_min + "\u2013" + group.age_max);
  }

  function populateAgeGroupGrid() {
    var grid = $("age-group-grid");
    var prevChecked = grid.querySelector("input:checked");
    var prevValue = prevChecked ? prevChecked.value : null;
    grid.innerHTML = "";
    var groups = (data.age_groups || []).slice().sort(function (a, b) { return a.age_min - b.age_min; });
    groups.forEach(function (group) {
      var label = document.createElement("label");
      label.className = "tag-chip";
      var input = document.createElement("input");
      input.type = "radio";
      input.name = "age-group";
      input.value = String(group.code);
      if (prevValue === String(group.code)) { input.checked = true; label.classList.add("checked"); }
      input.addEventListener("change", function () {
        grid.querySelectorAll(".tag-chip").forEach(function (chip) { chip.classList.remove("checked"); });
        label.classList.add("checked");
      });
      var span = document.createElement("span");
      span.textContent = ageGroupDisplayLabel(group, groups);
      label.appendChild(input);
      label.appendChild(span);
      grid.appendChild(label);
    });
  }

  var INTEREST_TAG_ORDER = ["Sports", "Music", "Movies/TV", "Comedy/Entertainment", "Politics",
    "Business/Tech", "Royalty", "Religion", "History/Ancient", "Architecture", "Nature/Outdoors"];

  function populateInterestsGrid() {
    var grid = $("interests-grid");
    var prevChecked = Array.prototype.slice.call(grid.querySelectorAll("input:checked")).map(function (i) { return i.value; });
    grid.innerHTML = "";
    INTEREST_TAG_ORDER.forEach(function (tag) {
      var label = document.createElement("label");
      label.className = "tag-chip";
      var input = document.createElement("input");
      input.type = "checkbox";
      input.value = tag;
      if (prevChecked.indexOf(tag) !== -1) { input.checked = true; label.classList.add("checked"); }
      input.addEventListener("change", function () {
        label.classList.toggle("checked", input.checked);
      });
      var span = document.createElement("span");
      span.textContent = (STRINGS[lang] && STRINGS[lang].interestTags[tag]) || STRINGS.en.interestTags[tag];
      label.appendChild(input);
      label.appendChild(span);
      grid.appendChild(label);
    });
  }

  function renderInstructionsImage() {
    var frame = $("instructions-image-frame");
    var existingImg = frame.querySelector("img");
    if (existingImg) return; // already resolved (either loaded or we keep trying once)
    var probe = new Image();
    probe.onload = function () {
      var img = document.createElement("img");
      img.src = "images/instructions_example.png";
      img.alt = "";
      frame.innerHTML = "";
      frame.appendChild(img);
    };
    probe.onerror = function () { /* keep placeholder text */ };
    probe.src = "images/instructions_example.png";
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
    ensureEmailjsLoaded().catch(function () { /* handled per-send */ });
    showScreen("screen-task");
    renderCurrentStim();
    startKeyboardListening();
  });
  $("btn-start-new").addEventListener("click", function () {
    clearState();
    state = null;
    showScreen("screen-setup");
  });

  // ---------------- Setup screen ----------------
  $("btn-setup-continue").addEventListener("click", function () {
    var regionCodes = Array.prototype.slice.call(
      document.querySelectorAll("#regions-grid input:checked")
    ).map(function (i) { return i.value; });

    var ageGroupInput = document.querySelector('#age-group-grid input:checked');
    var ageErr = $("age-error");
    if (!ageGroupInput) {
      ageErr.hidden = false;
      return;
    }
    ageErr.hidden = true;
    var ageGroupCode = parseInt(ageGroupInput.value, 10);

    var interests = Array.prototype.slice.call(
      document.querySelectorAll("#interests-grid input:checked")
    ).map(function (i) { return i.value; });

    var regionPopulations = regionsByCodes(regionCodes).map(function (r) { return r.population; });
    var pool = buildPool(regionPopulations, ageGroupCode);
    var order = buildOrder(pool, interests, []);

    state = {
      code: generateCode(),
      regionCodes: regionCodes,
      ageGroupCode: ageGroupCode,
      interests: interests,
      order: order,
      current: null,
      rows: [],
      knownPeopleCount: 0,
      knownPlacesCount: 0,
      seenPeopleCount: 0,
      seenPlacesCount: 0,
      sessionStartIso: nowIso(),
      trialIndex: 0,
      finished: false
    };
    saveState();
    showScreen("screen-instructions");
  });

  // ---------------- Instructions screen ----------------
  $("btn-instructions-begin").addEventListener("click", function () {
    ensureEmailjsLoaded().catch(function () { /* handled per-send */ });
    advanceTrial();
    showScreen("screen-task");
    renderCurrentStim();
    startKeyboardListening();
  });

  // ---------------- Task screen ----------------
  var stimCard = null, stimImage = null, stimName = null, flagKnow = null, flagUnknown = null;

  function isFinished() {
    var peopleTarget = CONFIG.minPeopleKnown || 30;
    var placesTarget = CONFIG.minPlacesKnown || 60;
    var thresholdsMet = state.knownPeopleCount >= peopleTarget && state.knownPlacesCount >= placesTarget;
    var poolExhausted = !state.current && state.order.length === 0;
    return thresholdsMet || poolExhausted;
  }

  function advanceTrial() {
    if (state.current) return;
    var peopleDone = state.knownPeopleCount >= (CONFIG.minPeopleKnown || 30);
    var placesDone = state.knownPlacesCount >= (CONFIG.minPlacesKnown || 60);
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

  function renderCurrentStim() {
    if (isFinished()) { finishSession(); return; }
    var concept = conceptByFile[state.current];
    if (!concept) { // data mismatch safety net: skip unknown file and move on
      state.current = null; advanceTrial(); renderCurrentStim(); return;
    }
    resetCardTransform(true);
    stimImage.alt = "";
    stimImage.onerror = function () {
      stimImage.onerror = null;
      stimImage.style.display = "none";
      var wrap = stimImage.parentNode;
      var fallback = wrap.querySelector(".stim-missing-fallback");
      if (!fallback) {
        fallback = document.createElement("div");
        fallback.className = "stim-missing-fallback";
        fallback.style.cssText = "padding:12px;text-align:center;color:#8a8a8a;font-size:13px;";
        wrap.appendChild(fallback);
      }
      fallback.textContent = concept.file_name;
    };
    stimImage.style.display = "";
    var oldFallback = stimImage.parentNode.querySelector(".stim-missing-fallback");
    if (oldFallback) oldFallback.remove();
    stimImage.src = "images/" + concept.file_name;
    stimName.textContent = concept.names[lang] || concept.names.en;
    trialStartTs = performance.now();
    locked = false;
  }

  function recordResponse(responseValue) {
    var concept = conceptByFile[state.current];
    var rt = Math.round(performance.now() - trialStartTs);
    var row = {
      participant_code: state.code,
      site: CONFIG.siteId,
      session_start_iso: state.sessionStartIso,
      response_timestamp_iso: nowIso(),
      trial_index: state.trialIndex,
      language: lang,
      regions_selected: state.regionCodes.join("|"),
      age_group_code: state.ageGroupCode,
      interests_selected: state.interests.join("|"),
      file_name: concept.file_name,
      name_shown: concept.names[lang] || concept.names.en,
      type: concept.type,
      population: concept.population,
      min_age_group: concept.min_age_group,
      max_age_group: concept.max_age_group,
      interest_tags: concept.interest_tags.join("|"),
      response: responseValue,
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
    if (state.trialIndex > 0 && state.trialIndex % every === 0) {
      sendCheckpointEmail("periodic");
    }
  }

  function handleResponse(responseValue) {
    if (locked) return;
    locked = true;
    var dir = responseValue === "known" ? 1 : -1;
    flagKnow.style.opacity = dir > 0 ? 1 : 0;
    flagUnknown.style.opacity = dir < 0 ? 1 : 0;
    stimCard.style.transition = "transform 0.22s ease";
    stimCard.style.transform = "translateX(" + (dir * 500) + "px) rotate(" + (dir * 18) + "deg)";
    recordResponse(responseValue);
    setTimeout(function () {
      advanceTrial();
      renderCurrentStim();
    }, 230);
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
  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise(function (resolve) { setTimeout(function () { resolve({ ok: false, timedOut: true }); }, ms); })
    ]);
  }

  function finishSession() {
    stopKeyboardListening();
    state.finished = true;
    saveState();
    $("done-stats").hidden = true;
    // Show "done" only once the final save has actually completed — not before.
    // Showing "thank you" regardless, with the send still in flight or having failed
    // in the background, would give a false sense that everything reached the
    // researcher even if (e.g.) the internet connection dropped right at the end.
    showScreen("screen-finishing");
    attemptFinishSend();
  }

  var finishRetryTimer = null;
  var finishSendInFlight = false;
  function attemptFinishSend() {
    if (finishSendInFlight) return;
    finishSendInFlight = true;
    withTimeout(sendCheckpointEmail("finish"), 8000).then(function (result) {
      finishSendInFlight = false;
      if (result && result.ok) {
        stopFinishRetrying();
        showScreen("screen-done");
      } else {
        showScreen("screen-connection-issue");
        startFinishRetrying();
      }
    });
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

  function downloadBackupCsv() {
    var lines = [CSV_HEADER.join(",")];
    state.rows.forEach(function (row) {
      lines.push(CSV_HEADER.map(function (h) { return csvEscape(row[h]); }).join(","));
    });
    var blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = CONFIG.siteId + "_" + state.code + ".csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }
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
