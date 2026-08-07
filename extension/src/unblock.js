(function initialiseNexusUnblockQueue() {
  "use strict";

  if (!/^\/settings\/content-blocking(?:\/|$)/.test(location.pathname)) return;
  if (document.getElementById("nlc-unblock-panel")) return;

  const Core = globalThis.NexusUnblockCore;
  const panel = document.createElement("aside");
  panel.id = "nlc-unblock-panel";
  panel.dataset.nlcOwned = "true";

  const heading = document.createElement("strong");
  heading.textContent = "Nexus ignored users";
  const status = document.createElement("span");
  status.className = "nlc-unblock-status";
  const start = document.createElement("button");
  start.type = "button";
  start.textContent = "Start verified queue";
  const speed = document.createElement("select");
  speed.setAttribute("aria-label", "Unignore queue speed");
  for (const [value, label] of [["2000", "Safe · one every 2 sec"], ["1000", "Balanced · one/sec"], ["500", "Fast · two/sec"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    speed.appendChild(option);
  }
  const stop = document.createElement("button");
  stop.type = "button";
  stop.textContent = "Stop";
  stop.disabled = true;
  panel.append(heading, status, speed, start, stop);
  document.body.appendChild(panel);

  let running = false;
  let runToken = 0;
  let removed = 0;
  let emptyChecks = 0;
  let attempted = new WeakSet();

  function availableControls() {
    return Core.findUnblockControls(document).filter(control =>
      (!running || !attempted.has(control)) && !control.disabled && control.getAttribute("aria-disabled") !== "true"
    );
  }

  function updateStatus(message) {
    if (status.textContent !== message) status.textContent = message;
  }

  function finish(message) {
    running = false;
    runToken += 1;
    start.disabled = false;
    speed.disabled = false;
    stop.disabled = true;
    updateStatus(message);
  }

  function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
  }

  async function waitForRemoval(control, token) {
    const deadline = Date.now() + 10000;
    while (running && token === runToken && Date.now() < deadline) {
      if (!control.isConnected) return true;
      if (Core.pageShowsFailure(document)) return false;
      await delay(100);
    }
    return !control.isConnected;
  }

  async function runQueue(token) {
    while (running && token === runToken) {
      if (Core.pageShowsFailure(document)) {
        finish(`Stopped after ${removed}: Nexus reported an error.`);
        return;
      }

      const [control] = availableControls();
      if (!control) {
        emptyChecks += 1;
        if (emptyChecks >= 6) {
          finish(removed ? `Finished: ${removed} removals confirmed.` : "No safe unblock controls found.");
          return;
        }
        await delay(500);
        continue;
      }

      emptyChecks = 0;
      attempted.add(control);
      const username = Core.normaliseText(control.textContent || control.getAttribute("aria-label")) || "the next user";
      updateStatus(`Requesting removal of ${username}… ${removed} confirmed so far.`);
      control.click();
      const confirmed = await waitForRemoval(control, token);
      if (!running || token !== runToken) return;
      if (!confirmed) {
        finish(`Stopped after ${removed}: Nexus did not confirm removing ${username}.`);
        return;
      }

      removed += 1;
      updateStatus(`${removed} removals confirmed.`);
      if (removed % 100 === 0) {
        updateStatus(`${removed} confirmed · cooling down for 30 seconds.`);
        await delay(30000);
      } else await delay(Number(speed.value));
    }
  }

  start.addEventListener("click", () => {
    const count = availableControls().length;
    if (!count) {
      updateStatus("No safe unblock controls found. Nothing was clicked.");
      return;
    }
    const confirmed = confirm(
      `Remove every user from your Nexus ignored-users list?\n\n` +
      `The extension currently sees ${count} username controls. It will wait for Nexus to confirm each removal and pause for 30 seconds after every 100.`
    );
    if (!confirmed) return;
    removed = 0;
    emptyChecks = 0;
    attempted = new WeakSet();
    running = true;
    runToken += 1;
    start.disabled = true;
    speed.disabled = true;
    stop.disabled = false;
    updateStatus("Starting…");
    runQueue(runToken).catch(error => finish(`Stopped after ${removed}: ${error.message}`));
  });

  stop.addEventListener("click", () => finish(`Stopped after ${removed} authors.`));
  updateStatus(`${availableControls().length} unblock controls detected.`);

  let countRefresh = null;
  const listObserver = new MutationObserver(mutations => {
    if (running || mutations.every(mutation => panel.contains(mutation.target))) return;
    if (countRefresh) clearTimeout(countRefresh);
    countRefresh = setTimeout(() => {
      countRefresh = null;
      updateStatus(`${availableControls().length} username controls detected.`);
    }, 150);
  });
  listObserver.observe(document.body, { childList: true, subtree: true });
})();
