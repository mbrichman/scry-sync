# Installation Guide

Scry Sync is a Chrome (MV3) extension, installed from source. It is not published to a browser store, and the Firefox build was retired in v2.8.0.

## Install from source (Chrome and Chromium-based browsers)

1. Clone the repository.
2. Open `chrome://extensions`, enable **Developer mode**.
3. Click **Load unpacked** and select the repository's `chrome/` folder.
4. Pin the extension. Open its **Options** to configure Scry (below) and to enable the sources you use.

To update: pull, click the extension's **reload** button on `chrome://extensions`, then terminate its service worker (click the *service worker* link → *terminate*) or toggle the extension off and on. An MV3 reload alone does not refresh the running background worker.

## Configuration

After installing the extension in either browser:

1. Click the extension icon in your browser toolbar
2. You'll see a notice about configuring your Organization ID
3. Click "Click here to set it up" (or right-click the extension icon → Options)
4. In a new tab, go to `https://claude.ai/settings/account`
5. Copy your Organization ID from the URL
   - It looks like: `organization_id=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`
   - Copy only the UUID part (the `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`)
6. Return to the extension options and paste the Organization ID
7. Click **Save**
8. Click **Test Connection** to verify it works
9. You should see a success message if everything is configured correctly!

---

## Troubleshooting

### Common Issues

#### "Organization ID not configured"
- Follow the [Configuration](#configuration) steps above
- Make sure you're copying the complete UUID from the URL
- The format should be: `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`

#### "Not authenticated" error
- Make sure you're logged into Claude.ai
- Try refreshing the Claude.ai page
- Check that cookies are enabled for claude.ai

#### "downloadFile is not defined" error
If you see this error when trying to export the current conversation:
1. **Refresh the Claude.ai page** (F5 or Ctrl+R)
2. Try the export again
3. This happens when the content script hasn't fully loaded yet

#### Export fails for some conversations
- Some very old conversations might have different data structures
- Check the browser console for specific error messages
- The ZIP export includes a summary file listing any failed exports

### Chrome-Specific Issues

#### Extension doesn't appear after loading
- Make sure you selected the `chrome` folder, not a subfolder
- Check that Developer mode is enabled
- Look in the Extensions page for any error messages

#### Content Security Policy errors
- Make sure you're using the latest version of the extension
- Try removing and re-adding the extension from `chrome://extensions/`
