// MV3 classic (non-module) service worker: pull in the sync engines so
// continuous sync can reuse the exact same helpers as the manual sync UI
// (utils.js -> scry_sync.js -> scry_client.js -> chatgpt_adapter.js ->
// sources.js -> sync_core.js -> continuous_sync.js, matching each file's own
// internal require/global expectations). chatgpt_adapter.js MUST load before
// sources.js — sources.js's SOURCES.chatgpt entry references its globals
// (getChatGptAccessToken, listAllChatGptConversations, etc.) directly.
// sources.js MUST load before sync_core.js (syncBatch resolves
// classifyStubAfterReconcile as a global) and before continuous_sync.js
// (which resolves SOURCES/SOURCE_ORDER the same way); sync_core.js MUST load
// before continuous_sync.js (which resolves syncBatch/reconcileAndSync).
importScripts('utils.js', 'scry_sync.js', 'scry_client.js', 'chatgpt_adapter.js', 'sources.js', 'sync_core.js', 'continuous_sync.js');

const INCREMENTAL_ALARM = 'scry-incremental';
const DEEP_RECONCILE_ALARM = 'scry-deep-reconcile';

// Idempotent: chrome.alarms.create with the same name just resets the alarm,
// it does not create a duplicate. Re-registering on every onStartup/onInstalled
// is the recommended MV3 pattern since alarms do NOT reliably survive a
// browser restart on their own.
function registerContinuousSyncAlarms() {
  chrome.alarms.create(INCREMENTAL_ALARM, { periodInMinutes: 15 });
  chrome.alarms.create(DEEP_RECONCILE_ALARM, { periodInMinutes: 1440 });
}

chrome.runtime.onStartup.addListener(registerContinuousSyncAlarms);
chrome.runtime.onInstalled.addListener(registerContinuousSyncAlarms);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === INCREMENTAL_ALARM) {
    runAllContinuousSyncs('incremental').catch((e) => console.error('Scry incremental sync wake failed', e));
  } else if (alarm.name === DEEP_RECONCILE_ALARM) {
    runAllContinuousSyncs('deep').catch((e) => console.error('Scry deep reconcile wake failed', e));
  }
});

// Handle extension installation
chrome.runtime.onInstalled.addListener(() => {
  console.log('Claude Conversation Exporter installed');
});

// Inject content script into already-open Claude.ai tabs when extension is installed/updated
chrome.runtime.onInstalled.addListener(() => {
  chrome.tabs.query({ url: 'https://claude.ai/*' }, (tabs) => {
    tabs.forEach(tab => {
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['jszip.min.js', 'utils.js', 'content.js']
      }).catch(err => console.log('Could not inject into tab', tab.id, err));
    });
  });
});

// Handle messages from popup when content script might not be injected
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'ensureContentScript') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.scripting.executeScript({
          target: { tabId: tabs[0].id },
          files: ['jszip.min.js', 'utils.js', 'content.js']
        }, () => {
          sendResponse({ success: true });
        });
      }
    });
    return true;
  }
});