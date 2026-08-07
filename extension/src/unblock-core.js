(function exposeNexusUnblockCore(root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.NexusUnblockCore = api;
})(typeof globalThis === "object" ? globalThis : this, function createNexusUnblockCore() {
  "use strict";

  const AUTHOR_HEADING = /^(?:(?:currently\s+)?blocked(?:\s+mod)?\s+authors?|ignored\s+users?)$/i;
  const REMOVE_ACTION = /\b(unblock|remove|delete)\b/i;
  const REMOVE_ALL_ACTION = /\b(unblock|remove|delete)\s+all\b/i;
  const DISMISS_SYMBOL = /^(?:×|✕|✖|x|close(?:\s+icon)?)$/i;
  const NON_AUTHOR_BUTTON = /^(?:block|ignore|add|search|clear|save|cancel|stop|manage)(?:\s|$)/i;
  const RED_VARIANT = /\b(?:danger|destructive|error|negative|red)\b/i;
  const CONTROL_SELECTOR = "button, [role='button']";

  function normaliseText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function controlName(control) {
    return normaliseText([
      control.getAttribute("aria-label"),
      control.getAttribute("title"),
      control.getAttribute("data-e2eid"),
      control.getAttribute("data-testid"),
      control.textContent
    ].filter(Boolean).join(" "));
  }

  function isExplicitUnblockControl(control) {
    const name = controlName(control);
    return REMOVE_ACTION.test(name) && !REMOVE_ALL_ACTION.test(name);
  }

  function isDismissControl(control) {
    const names = [
      control.getAttribute("aria-label"),
      control.getAttribute("title"),
      control.textContent
    ].map(normaliseText).filter(Boolean);
    if (names.some(name => DISMISS_SYMBOL.test(name))) return true;
    if (names.length) return false;
    return Boolean(control.querySelector("svg, [data-icon], [class*='icon']"));
  }

  function isRedColour(value) {
    const match = String(value || "").match(/rgba?\(\s*(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)/i);
    if (!match) return false;
    const red = Number(match[1]);
    const green = Number(match[2]);
    const blue = Number(match[3]);
    return red >= 110 && red >= green + 30 && red >= blue + 20;
  }

  function isRedAuthorControl(control) {
    const label = normaliseText(control.textContent || control.getAttribute("aria-label"));
    if (!label || label.length > 100 || NON_AUTHOR_BUTTON.test(label) || REMOVE_ALL_ACTION.test(label)) return false;
    const variant = [
      control.className,
      control.getAttribute("data-variant"),
      control.getAttribute("data-color"),
      control.getAttribute("data-tone")
    ].filter(Boolean).join(" ");
    if (RED_VARIANT.test(variant)) return true;
    const view = control.ownerDocument && control.ownerDocument.defaultView;
    if (!view || typeof view.getComputedStyle !== "function") return false;
    const style = view.getComputedStyle(control);
    return [style.backgroundColor, style.borderColor, style.color].some(isRedColour);
  }

  function headingCandidates(document) {
    return Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6, [role='heading'], legend, p, span, div"))
      .filter(element => AUTHOR_HEADING.test(normaliseText(element.textContent)));
  }

  function findAuthorSection(document) {
    for (const heading of headingCandidates(document)) {
      let scope = heading.parentElement;
      while (scope && scope !== document.body) {
        const controls = Array.from(scope.querySelectorAll(CONTROL_SELECTOR));
        if (controls.some(control =>
          isExplicitUnblockControl(control) || isDismissControl(control) || isRedAuthorControl(control)
        )) return scope;
        scope = scope.parentElement;
      }
    }
    return null;
  }

  function findUnblockControls(document) {
    const section = findAuthorSection(document);
    if (!section) return [];
    return Array.from(section.querySelectorAll(CONTROL_SELECTOR)).filter(control =>
      isExplicitUnblockControl(control) || isDismissControl(control) || isRedAuthorControl(control)
    );
  }

  function pageShowsFailure(document) {
    const notices = Array.from(document.querySelectorAll("[role='alert'], [aria-live], [data-e2eid*='toast'], [data-testid*='toast']"));
    return notices.some(notice => /rate\s*limit|too many requests|failed|error/i.test(normaliseText(notice.textContent)));
  }

  return Object.freeze({
    controlName,
    findAuthorSection,
    findUnblockControls,
    isDismissControl,
    isRedAuthorControl,
    isExplicitUnblockControl,
    normaliseText,
    pageShowsFailure
  });
});
