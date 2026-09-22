// ChatGPT -> Scry page controller: enumerate the account's conversations and
// push the selected ones (verbatim body + image bytes) into Scry. Sync-only:
// file export was removed in v2.8.0 per the owner's ruling (Scry is the archive).

let accessToken = null;
let conversations = []; // list items from the enumeration endpoint

const $ = (id) => document.getElementById(id);

function setStatus(msg, isError) {
  const el = $('status');
  el.textContent = msg || '';
  el.className = 'status' + (isError ? ' error' : '');
}

// The list endpoint returns create/update times as ISO strings; be tolerant.
function fmtDate(t) {
  if (!t) return '';
  const d = new Date(typeof t === 'number' ? t * 1000 : t);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

async function ensureToken() {
  if (accessToken) return accessToken;
  accessToken = await getChatGptAccessToken();
  return accessToken;
}

async function loadConversations() {
  $('loadBtn').disabled = true;
  setStatus('Authenticating with chatgpt.com…');
  try {
    await ensureToken();
    setStatus('Fetching conversation list…');
    conversations = await listAllChatGptConversations(accessToken, (n) => {
      setStatus(`Fetched ${n} conversation${n === 1 ? '' : 's'}…`);
    });
    renderList();
    $('listCard').style.display = conversations.length ? 'block' : 'none';
    $('count').textContent = `${conversations.length} conversation${conversations.length === 1 ? '' : 's'}`;
    setStatus(conversations.length ? '' : 'No conversations found on this account.');
  } catch (err) {
    console.error(err);
    setStatus(err.message || String(err), true);
  } finally {
    $('loadBtn').disabled = false;
  }
}

function renderList() {
  const ul = $('convList');
  ul.innerHTML = '';
  for (const conv of conversations) {
    const li = document.createElement('li');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'conv-check';
    cb.dataset.id = conv.id;

    const main = document.createElement('div');
    main.className = 'conv-main';
    const title = document.createElement('div');
    title.className = 'conv-title';
    title.textContent = conv.title || 'Untitled conversation';
    const meta = document.createElement('div');
    meta.className = 'conv-meta';
    meta.textContent = `Updated ${fmtDate(conv.update_time)}`;
    main.appendChild(title);
    main.appendChild(meta);

    li.appendChild(cb);
    li.appendChild(main);
    ul.appendChild(li);
  }
}

function wantImages() {
  const el = $('includeImages');
  return el ? el.checked : false;
}

function selectedIds() {
  return Array.from(document.querySelectorAll('.conv-check'))
    .filter((cb) => cb.checked)
    .map((cb) => cb.dataset.id);
}

// Push the selected conversations into Scry as first-class conversations, via
// the shared sync core (chrome/sync_core.js's syncBatch) with SOURCES.chatgpt
// (chrome/sources.js) — the SAME per-conversation fetch/image/ingest logic
// continuous_sync.js's background engine uses, instead of a third copy of
// that loop living on this page.
//
// Each body goes VERBATIM — Scry walks current_node -> root itself, so the
// client never decides what the visible branch is. One conversation failing
// does not abort the run; failures are collected and reported, because a single
// unreadable conversation shouldn't cost you the other forty.
//
// Two disclosed simplifications from moving the fetch loop into the shared
// core: the live "images N/M" sub-status while a single conversation's images
// are being fetched, and the "waiting Ns" rate-limit status, are gone — the
// page now shows conversation-level progress only (done/total). The
// per-conversation image-failure SUMMARY this page has always shown (visible
// vs. regenerated-away misses, files-stored count) is unchanged.
async function pushSelectedToScry() {
  const ids = selectedIds();
  if (ids.length === 0) { setStatus('Select at least one conversation first.', true); return; }

  const scry = await loadScrySettings();
  if (!scry.url) {
    setStatus('Set your Scry URL and service token in the extension options first.', true);
    return;
  }
  if (!(await ensureScryPermission(scry.url))) {
    setStatus(`Permission to reach ${scry.url} was denied.`, true);
    return;
  }

  const byId = new Map(conversations.map((c) => [c.id, c]));
  const btn = $('pushScry');
  btn.disabled = true;

  try {
    await ensureToken();
    const items = ids.map((id) => normalizeChatGptListItem(byId.get(id) || { id }));
    // ctx.wantImages threads the page's "Include image bytes" checkbox through
    // to SOURCES.chatgpt.syncOne (default true there, matching continuous
    // sync's always-include-images behavior when this ctx field is absent).
    const ctx = { token: accessToken, wantImages: wantImages() };

    const result = await syncBatch(SOURCES.chatgpt, ctx, scry, items, {
      onProgress: ({ done, total, item }) => {
        setStatus(`Pushing ${done}/${total}: "${item.title || item.uuid}"…`);
      },
    });

    let filesStored = 0;
    let discardedImages = 0;
    const imageFailureMsgs = [];
    for (const { item, result: r } of result.succeeded) {
      if (!r) continue; // ChatGPT has no stub-skip path (isStubError is always false); defensive only.
      filesStored += r.filesStored || 0;
      const imgFailures = r.imageFailures || [];
      const real = imgFailures.filter((f) => f.onBranch);
      const dead = imgFailures.length - real.length;
      if (real.length) {
        // Surface it. A push whose images silently vanished reads as success.
        imageFailureMsgs.push(`"${item.title || item.uuid}": ${real.length} visible image(s) not fetched — ${real[0].error}`);
      }
      if (dead) discardedImages += dead; // regenerated-away attempts chatgpt.com no longer serves
    }

    const failureMsgs = result.failed.map(({ item, error }) =>
      `"${item.title || item.uuid}": ${error.message || error}`);

    const pushed = result.pushed;
    const deadNote = discardedImages ? `; ${discardedImages} regenerated-away image${discardedImages === 1 ? '' : 's'} no longer served by chatgpt.com, skipped` : '';
    const filesNote = wantImages() ? ` (${filesStored} image file${filesStored === 1 ? '' : 's'} stored${deadNote})` : '';
    if (failureMsgs.length === 0 && imageFailureMsgs.length === 0) {
      setStatus(`Pushed ${pushed} conversation${pushed === 1 ? '' : 's'} to Scry ✓${filesNote}`);
    } else if (failureMsgs.length === 0) {
      setStatus(`Pushed ${pushed} conversation${pushed === 1 ? '' : 's'}${filesNote}, but images failed — ${imageFailureMsgs.join('; ')}`, true);
    } else {
      setStatus(
        `Pushed ${pushed}/${ids.length}. ${failureMsgs.length} failed — ${failureMsgs.join('; ')}`,
        true
      );
    }
  } catch (err) {
    // Only auth/setup failures reach here; per-conversation errors are caught above.
    console.error(err);
    setStatus(err.message || String(err), true);
  } finally {
    btn.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  $('loadBtn').addEventListener('click', loadConversations);
  $('pushScry').addEventListener('click', pushSelectedToScry);
  $('selectAll').addEventListener('click', () =>
    document.querySelectorAll('.conv-check').forEach((cb) => { cb.checked = true; }));
  $('selectNone').addEventListener('click', () =>
    document.querySelectorAll('.conv-check').forEach((cb) => { cb.checked = false; }));
});
