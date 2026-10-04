/* HintLab web UI — plain vanilla JS, no build step. */

"use strict";

const LEVEL_LABELS = {
  1: "Level 1: nudge",
  2: "Level 2: where to look",
  3: "Level 3: the concept",
};

const state = {
  assignments: [],
  sessionId: null,
  eventSource: null,
  hintLevels: new Set(),
  allDone: false,
  agentBusy: false,
  nextInFlight: false,
  manualClose: false,
};

const $ = (id) => document.getElementById(id);
const select = $("assignment-select");
const langBadge = $("assignment-language");
const statement = $("assignment-statement");
const codeBox = $("code");
const runBtn = $("run");
const formError = $("form-error");
const testResults = $("test-results");
const hintCards = $("hint-cards");
const hintStatus = $("hint-status");
const nextBtn = $("next-hint");
const feed = $("feed");

function setStatusText(msg, spinning) {
  hintStatus.replaceChildren();
  if (spinning) {
    const sp = document.createElement("span");
    sp.className = "spinner";
    hintStatus.appendChild(sp);
  }
  if (msg) {
    const t = document.createElement("span");
    t.textContent = msg;
    hintStatus.appendChild(t);
  }
}

function feedLine(cls, icon, label, codeValue) {
  const line = document.createElement("div");
  line.className = "feed-line " + cls;
  const ic = document.createElement("span");
  ic.className = "icon";
  ic.textContent = icon;
  const lab = document.createElement("span");
  lab.textContent = label;
  line.appendChild(ic);
  line.appendChild(lab);
  if (codeValue !== undefined && codeValue !== null && codeValue !== "") {
    const code = document.createElement("code");
    code.textContent = codeValue;
    line.appendChild(code);
  }
  feed.appendChild(line);
  feed.scrollTop = feed.scrollHeight;
}

function showFormError(msg) {
  formError.textContent = msg;
  formError.hidden = false;
}

function clearFormError() {
  formError.textContent = "";
  formError.hidden = true;
}

/* ------------------------------------------------------------------ */
/* Assignment picker                                                   */
/* ------------------------------------------------------------------ */

async function loadAssignments() {
  try {
    const res = await fetch("/api/assignments");
    if (!res.ok) throw new Error("bad status");
    state.assignments = await res.json();
    select.replaceChildren();
    for (const a of state.assignments) {
      const opt = document.createElement("option");
      opt.value = a.id;
      opt.textContent = a.id;
      select.appendChild(opt);
    }
    if (state.assignments.length > 0) {
      select.value = state.assignments[0].id;
      showAssignment(state.assignments[0]);
    }
  } catch {
    select.replaceChildren();
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Could not load assignments";
    select.appendChild(opt);
  }
}

function showAssignment(a) {
  langBadge.textContent = a.language;
  langBadge.hidden = false;
  statement.textContent = a.statement || "";
  codeBox.value = a.starterCode || "";
}

select.addEventListener("change", () => {
  const a = state.assignments.find((x) => x.id === select.value);
  if (a) showAssignment(a);
});


/* ------------------------------------------------------------------ */
/* Test results table                                                  */
/* ------------------------------------------------------------------ */

function renderTestResults(tr) {
  testResults.replaceChildren();

  if (tr.build && tr.build.ok === false) {
    const note = document.createElement("p");
    note.className = "test-note";
    note.textContent = "Build failed" + (tr.build.stderr ? ": " + tr.build.stderr : "");
    testResults.appendChild(note);
  }

  if (!Array.isArray(tr.tests) || tr.tests.length === 0) {
    if (!(tr.build && tr.build.ok === false)) {
      const p = document.createElement("p");
      p.className = "test-note";
      p.textContent = "No tests ran.";
      testResults.appendChild(p);
    }
    return;
  }

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const h of ["Test", "Input", "Expected", "Got", "Result"]) {
    const th = document.createElement("th");
    th.textContent = h;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const t of tr.tests) {
    const row = document.createElement("tr");
    const name = document.createElement("td");
    name.textContent = t.name;

    const input = document.createElement("td");
    const inputCode = document.createElement("code");
    inputCode.textContent = t.input;
    input.appendChild(inputCode);

    const expected = document.createElement("td");
    const expCode = document.createElement("code");
    expCode.textContent = t.expected;
    expected.appendChild(expCode);

    const got = document.createElement("td");
    const gotCode = document.createElement("code");
    gotCode.textContent = t.got;
    got.appendChild(gotCode);

    const verdict = document.createElement("td");
    verdict.className = "verdict " + (t.passed ? "pass" : "fail");
    if (t.timedOut) verdict.textContent = "TIMEOUT";
    else if (t.signal) verdict.textContent = "CRASH (" + t.signal + ")";
    else verdict.textContent = t.passed ? "PASS" : "FAIL";

    row.appendChild(name);
    row.appendChild(input);
    row.appendChild(expected);
    row.appendChild(got);
    row.appendChild(verdict);
    tbody.appendChild(row);

    if (t.signal) {
      const noteRow = document.createElement("tr");
      const noteCell = document.createElement("td");
      noteCell.colSpan = 5;
      noteCell.className = "test-note";
      noteCell.textContent = "terminated by signal " + t.signal;
      noteRow.appendChild(noteCell);
      tbody.appendChild(noteRow);
    }
  }
  table.appendChild(tbody);
  testResults.appendChild(table);
}

/* ------------------------------------------------------------------ */
/* Hint cards                                                          */
/* ------------------------------------------------------------------ */

function addHintCard(level, text) {
  const card = document.createElement("div");
  card.className = "hint-card";
  const label = document.createElement("div");
  label.className = "level-label";
  label.textContent = LEVEL_LABELS[level] || "Level " + level;
  const body = document.createElement("div");
  body.className = "hint-text";
  body.textContent = text; // textContent only — never innerHTML
  card.appendChild(label);
  card.appendChild(body);
  hintCards.appendChild(card);
}

function updateNextButton() {
  const hasLevel1 = state.hintLevels.has(1);
  nextBtn.disabled = !(hasLevel1 && !state.agentBusy && !state.nextInFlight && !state.allDone);
  if (state.allDone) setStatusText("All hints given", false);
}


/* ------------------------------------------------------------------ */
/* Live feed handlers                                                  */
/* ------------------------------------------------------------------ */

function handleToolCall(d) {
  if (d.toolName === "run_commands") {
    feedLine("tool", "⚙️", "Tutor ran: ", d.command);
  } else if (d.toolName === "read_files") {
    feedLine("tool", "📄", "Tutor read: ", d.file);
  } else if (d.toolName === "run_tests") {
    feedLine("tool", "🧪", "Tutor ran tests" + (d.testName ? " (" + d.testName + ")" : ""));
  }
}

function handleToolResult(d) {
  if (d.toolName === "run_commands") {
    feedLine("tool", "⚙️", "Result: ", d.output);
  } else if (d.toolName === "run_tests") {
    const summary = (d.passed ?? 0) + "/" + (d.total ?? 0) + " passed";
    feedLine("tool", "🧪", "Test run result: ", summary);
  }
}

function handleApproval(d) {
  if (d.allowed) {
    feedLine("approve", "✅", "Approved", d.command || d.toolName);
  } else {
    feedLine("deny", "🚫", d.reason || "Blocked", d.command || d.toolName);
  }
}

function handleHint(d) {
  state.hintLevels.add(d.level);
  addHintCard(d.level, d.text);
  feedLine("hint", "💡", "Hint level " + d.level);
  if (d.level >= 3) state.allDone = true;
  setStatusText("", false);
  state.nextInFlight = false;
  updateNextButton();
}

function handleHintRejected(d) {
  const reason =
    d.reason === "wrong level"
      ? "wrong level, asking the tutor to retry"
      : d.reason === "empty hint"
        ? "empty hint, asking the tutor to rephrase"
        : "contained code, asking the tutor to rephrase";
  feedLine("deny", "🚫", "Hint blocked: ", reason);
}

function handleStatus(d) {
  if (typeof d.status === "string") {
    if (d.status === "running") state.agentBusy = true;
    else if (d.status === "idle" || d.status === "complete" || d.status === "error") {
      state.agentBusy = false;
    }
    updateNextButton();
  }
}

function handleError(d) {
  const message = d.message || "Something went wrong.";
  feedLine("error", "⚠️", message);
  if (d.code === "auth") {
    // Show the friendly "not connected" message in the form error area (the
    // student can retry after authenticating) and un-stick the busy state.
    showFormError(message);
    state.agentBusy = false;
    updateNextButton();
  }
}

function handleDone() {
  feedLine("status", "✓", "Tutor finished.");
}

function attachStreamListeners(es) {
  es.addEventListener("test_results", (e) => {
    const d = JSON.parse(e.data);
    const total = d.total ?? 0;
    const passed = d.passed ?? 0;
    feedLine("status", "🧪", "Test results: " + passed + "/" + total + " passed");
  });
  es.addEventListener("tool_call", (e) => handleToolCall(JSON.parse(e.data)));
  es.addEventListener("tool_result", (e) => handleToolResult(JSON.parse(e.data)));
  es.addEventListener("approval", (e) => handleApproval(JSON.parse(e.data)));
  es.addEventListener("hint", (e) => handleHint(JSON.parse(e.data)));
  es.addEventListener("hint_rejected", (e) => handleHintRejected(JSON.parse(e.data)));
  es.addEventListener("hint_status", (e) => handleHintRejected(JSON.parse(e.data)));
  es.addEventListener("status", (e) => handleStatus(JSON.parse(e.data)));
  es.addEventListener("error", (e) => handleError(JSON.parse(e.data)));
  es.addEventListener("done", (e) => handleDone());
}


/* ------------------------------------------------------------------ */
/* Run + stream                                                        */
/* ------------------------------------------------------------------ */

function resetRun() {
  state.sessionId = null;
  state.hintLevels = new Set();
  state.allDone = false;
  state.agentBusy = false;
  state.nextInFlight = false;
  hintCards.replaceChildren();
  testResults.replaceChildren();
  feed.replaceChildren();
  nextBtn.disabled = true;
  clearFormError();
}

function closeStream() {
  if (state.eventSource) {
    state.manualClose = true;
    state.eventSource.close();
    state.eventSource = null;
  }
}

async function run() {
  const assignmentId = select.value;
  const code = codeBox.value;

  if (!assignmentId) {
    showFormError("Please choose an assignment first.");
    return;
  }
  if (!code || !code.trim()) {
    showFormError("Please paste your code (or pick an assignment to load its starter).");
    return;
  }

  resetRun();
  closeStream();
  state.agentBusy = true;
  nextBtn.disabled = true;
  setStatusText("Tutor is reading your code…", true);

  let res;
  try {
    res = await fetch("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assignmentId, code }),
    });
  } catch {
    showFormError("Could not reach the server. Is it running?");
    setStatusText("", false);
    state.agentBusy = false;
    return;
  }

  if (!res.ok) {
    let msg = "Could not start the session.";
    try {
      const body = await res.json();
      if (body && body.error) msg = body.error;
    } catch {
      /* ignore */
    }
    showFormError("Error: " + msg);
    setStatusText("", false);
    state.agentBusy = false;
    return;
  }

  const body = await res.json();
  state.sessionId = body.sessionId;
  renderTestResults(body.testResults);

  state.manualClose = false;
  const es = new EventSource("/api/session/" + state.sessionId + "/stream");
  state.eventSource = es;
  attachStreamListeners(es);

  es.onerror = () => {
    if (state.manualClose) return;
    feedLine("error", "⚠️", "Live connection lost. Try running again.");
    state.agentBusy = false;
    setStatusText("", false);
    updateNextButton();
  };
}

/* ------------------------------------------------------------------ */
/* Next hint                                                           */
/* ------------------------------------------------------------------ */

async function requestNextHint() {
  if (!state.sessionId) return;
  if (state.nextInFlight || state.agentBusy) {
    setStatusText("Tutor is still busy, please wait", false);
    return;
  }

  state.nextInFlight = true;
  setStatusText("Thinking about the next hint…", true);
  nextBtn.disabled = true;

  let res;
  try {
    res = await fetch("/api/session/" + state.sessionId + "/next-hint", { method: "POST" });
  } catch {
    feedLine("error", "⚠️", "Could not reach the server.");
    state.nextInFlight = false;
    setStatusText("", false);
    updateNextButton();
    return;
  }

  if (res.status === 409) {
    state.nextInFlight = false;
    state.agentBusy = true;
    setStatusText("Tutor is still busy, please wait", false);
    updateNextButton();
    return;
  }

  if (!res.ok) {
    let msg = "Could not get the next hint.";
    try {
      const body = await res.json();
      if (body && body.error) msg = body.error;
    } catch {
      /* ignore */
    }
    feedLine("error", "⚠️", msg);
    state.nextInFlight = false;
    setStatusText("", false);
    updateNextButton();
    return;
  }

  // The actual hint arrives over the SSE stream; keep the spinner going.
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

runBtn.addEventListener("click", run);
nextBtn.addEventListener("click", requestNextHint);

loadAssignments();

