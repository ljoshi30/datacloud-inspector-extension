/*
 * PUBLIC build — Data 360 Inspector (Chrome Web Store / Firefox AMO).
 * Toolbar-icon click injects the inspector into the page's MAIN world.
 * MAIN world is required to read Salesforce Lightning component properties
 * that hold the API names we display. Clicking again tears it down (toggle).
 * READ-ONLY. No network calls of any kind — nothing leaves the browser.
 */
var api = (typeof browser !== "undefined") ? browser : chrome;
api.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;
  try {
    await api.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      world: "MAIN",
      files: ["inject.js"],
    });
  } catch (e) {}
});
