// Bundled config: the Scry installer may drop `scry-config.json`
// ({"url": "...", "token": "..."}) next to manifest.json. On first run the
// background worker seeds the `scry` settings from it. Stored settings always
// win: we seed only when BOTH url and token are absent/empty.
// Pure logic only (testable); the fetch + storage glue lives in background.js.

const MIN_TOKEN_LENGTH = 16;

function parseBundledConfig(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return null;
  if (typeof cfg.url !== 'string' || typeof cfg.token !== 'string') return null;
  const token = cfg.token.trim();
  // Same minimum token length options.js enforces on Save.
  if (token.length < MIN_TOKEN_LENGTH) return null;
  const raw = cfg.url.trim();
  let parsed;
  try { parsed = new URL(raw); } catch { return null; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  // Same normalization as options.js: trailing slashes stripped.
  return { url: raw.replace(/\/+$/, ''), token };
}

function _isBlank(v) {
  return typeof v !== 'string' || !v.trim();
}

function shouldSeed(existing) {
  const s = existing || {};
  return _isBlank(s.url) && _isBlank(s.token);
}

// Returns the new `scry` object to store, or null when nothing should be written.
//  - Nothing stored (url and token both blank): seed, and record `seeded`.
//  - Stored url/token still equal what we seeded earlier (never hand-edited) and
//    the file now differs (token rotation): update url/token/seeded.
//  - Anything else (hand-edited settings, unchanged file, bad file): null.
function seedScrySettings(existing, cfg) {
  const parsed = parseBundledConfig(cfg);
  if (!parsed) return null;
  const base = existing || {};
  const next = { ...base, url: parsed.url, token: parsed.token, seeded: { url: parsed.url, token: parsed.token } };
  if (shouldSeed(base)) return next;
  const seeded = base.seeded;
  if (!seeded || typeof seeded !== 'object') return null;
  if (base.url !== seeded.url || base.token !== seeded.token) return null; // edited by hand
  if (seeded.url === parsed.url && seeded.token === parsed.token) return null; // unchanged
  return next;
}

// Impure glue (service worker): fetch the packaged file, seed/re-seed if appropriate.
// Never calls chrome.permissions.request (needs a user gesture; the popup's
// "Allow access to Scry" button is the only prompting caller).
// Silent on every failure: a missing file is a normal unbundled install.
async function seedFromBundledConfig() {
  try {
    const stored = await new Promise((resolve) =>
      chrome.storage.local.get(['scry'], (r) => resolve(r && r.scry)));
    const resp = await fetch(chrome.runtime.getURL('scry-config.json'));
    if (!resp.ok) return false;
    const next = seedScrySettings(stored, await resp.json());
    if (!next) return false;
    await new Promise((resolve) => chrome.storage.local.set({ scry: next }, resolve));
    return true;
  } catch {
    return false;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseBundledConfig, shouldSeed, seedScrySettings, seedFromBundledConfig };
}
