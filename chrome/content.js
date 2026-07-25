// Prevent double-injection of content script
if (window.claudeExporterContentScriptLoaded) {
  console.log('Scry Sync content script already loaded, skipping re-injection');
} else {
  window.claudeExporterContentScriptLoaded = true;

// Capture unhandled errors for diagnostics (sanitized, stored in chrome.storage.local)
if (typeof initErrorCapture === 'function') initErrorCapture('content');

// Note: Organization ID is now stored in extension settings
// Users need to configure it in the extension options page

// Record export timestamp for a conversation
function recordExportTimestamp(conversationId) {
  chrome.storage.local.get(['exportTimestamps'], (result) => {
    const timestamps = result.exportTimestamps || {};
    timestamps[conversationId] = new Date().toISOString();
    chrome.storage.local.set({ exportTimestamps: timestamps });
  });
}

// Record export timestamps for multiple conversations
function recordExportTimestamps(conversationIds) {
  chrome.storage.local.get(['exportTimestamps'], (result) => {
    const timestamps = result.exportTimestamps || {};
    const now = new Date().toISOString();
    for (const id of conversationIds) {
      timestamps[id] = now;
    }
    chrome.storage.local.set({ exportTimestamps: timestamps });
  });
}

// Snapshot each conversation's current model so it survives a model bounce
// (e.g. when a model retires and Claude silently moves old chats onto a new
// one). Only the raw API model is recorded — never an inferred guess.
function recordModelSnapshots(conversations) {
  if (!Array.isArray(conversations)) return;
  chrome.storage.local.get(['modelSnapshots'], (result) => {
    const snapshots = result.modelSnapshots || {};
    const now = new Date().toISOString();
    let changed = false;
    for (const conv of conversations) {
      const model = conv && conv.model;
      const id = conv && conv.uuid;
      if (!model || !id) continue; // skip null-model chats — don't snapshot a guess
      const existing = snapshots[id];
      if (!existing) {
        snapshots[id] = {
          firstSeen: model,
          firstSeenAt: now,
          current: model,
          currentAt: now,
          history: [{ model, at: now }]
        };
        changed = true;
      } else if (existing.current !== model) {
        existing.current = model;
        existing.currentAt = now;
        existing.history = existing.history || [];
        existing.history.push({ model, at: now });
        changed = true;
      }
    }
    if (changed) {
      chrome.storage.local.set({ modelSnapshots: snapshots });
    }
  });
}

// Helper function to format datetime in local time for filenames
function getLocalDateTimeString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

  // Fetch conversation data
  async function fetchConversation(orgId, conversationId) {
    const url = `https://claude.ai/api/organizations/${orgId}/chat_conversations/${conversationId}?tree=True&rendering_mode=messages&render_all_tools=true`;

    const response = await fetch(url, {
      credentials: 'include',
      headers: {
        'Accept': 'application/json',
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch conversation: ${response.status}`);
    }

    return await response.json();
  }
  
  // Fetch all conversations
  async function fetchAllConversations(orgId) {
    const url = `https://claude.ai/api/organizations/${orgId}/chat_conversations`;
    
    const response = await fetch(url, {
      credentials: 'include',
      headers: {
        'Accept': 'application/json',
      }
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch conversations: ${response.status}`);
    }

    const conversations = await response.json();
    recordModelSnapshots(conversations); // capture current models before any bounce
    return conversations;
  }

  // Handle messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Auto-detect organization ID from Claude.ai API
  if (request.action === 'detectOrgId') {
    console.log('Auto-detecting organization ID...');

    fetch('https://claude.ai/api/organizations', {
      credentials: 'include',
      headers: { 'Accept': 'application/json' }
    })
      .then(response => {
        if (!response.ok) {
          throw new Error(`Failed to fetch organizations: ${response.status}`);
        }
        return response.json();
      })
      .then(orgs => {
        if (Array.isArray(orgs) && orgs.length > 0) {
          // Find the org with "chat" capability (the Claude.ai org, not the API org)
          const chatOrg = orgs.find(org =>
            org.capabilities && org.capabilities.includes('chat')
          );
          const orgId = chatOrg ? chatOrg.uuid : orgs[0].uuid;
          console.log('Auto-detected organization ID:', orgId, chatOrg ? '(chat org)' : '(fallback to first)');
          sendResponse({ success: true, orgId });
        } else {
          throw new Error('No organizations found');
        }
      })
      .catch(error => {
        console.error('Auto-detect org ID failed:', error);
        sendResponse({ success: false, error: error.message });
      });

    return true;
  }


  // Handle loadConversations request from browse page
  if (request.action === 'loadConversations') {
    console.log('Load conversations request received from browse page');

    fetchAllConversations(request.orgId)
      .then(conversations => {
        sendResponse({ success: true, conversations: conversations });
      })
      .catch(error => {
        console.error('Load conversations error:', error);
        sendResponse({
          success: false,
          error: error.message
        });
      });

    return true;
  }

  // Handle loadProjects request from browse page
  if (request.action === 'loadProjects') {
    console.log('Load projects request received from browse page');

    fetch(`https://claude.ai/api/organizations/${request.orgId}/projects`, {
      credentials: 'include',
      headers: { 'Accept': 'application/json' }
    })
      .then(response => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return response.json();
      })
      .then(projects => {
        sendResponse({ success: true, projects: projects });
      })
      .catch(error => {
        console.error('Load projects error:', error);
        sendResponse({
          success: false,
          error: error.message
        });
      });

    return true;
  }
  });

} // End of double-injection guard