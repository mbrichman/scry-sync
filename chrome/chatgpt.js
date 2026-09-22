// PoC page controller for the ChatGPT read-only exporter.
// Wires the DOM to chatgpt_adapter.js's fetchers + pure renderers. No Scry calls.

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

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
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

    const actions = document.createElement('div');
    actions.className = 'conv-actions';
    const mdBtn = document.createElement('button');
    mdBtn.className = 'ghost';
    mdBtn.textContent = 'Markdown';
    mdBtn.addEventListener('click', () => exportOne(conv, 'md'));
    const jsonBtn = document.createElement('button');
    jsonBtn.className = 'ghost';
    jsonBtn.textContent = 'JSON';
    jsonBtn.addEventListener('click', () => exportOne(conv, 'json'));
    actions.appendChild(mdBtn);
    actions.appendChild(jsonBtn);

    li.appendChild(cb);
    li.appendChild(main);
    li.appendChild(actions);
    ul.appendChild(li);
  }
}

function wantImages() {
  const el = $('includeImages');
  return el ? el.checked : false;
}

// Resolve every image pointer in a fetched body to a { pointer -> data URL } map,
// reporting progress. Returns {} when images are disabled or there are none.
async function buildImageMap(body, label) {
  if (!wantImages()) return {};
  const pointers = collectChatGptImagePointers(body);
  if (pointers.length === 0) return {};
  let done = 0;
  return fetchChatGptImageDataUrls(accessToken, pointers, null, () => {
    done++;
    setStatus(`${label}: fetching images ${done}/${pointers.length}…`);
  });
}

async function exportOne(conv, format) {
  setStatus(`Fetching "${conv.title || conv.id}"…`);
  try {
    await ensureToken();
    const body = await fetchChatGptConversation(accessToken, conv.id);
    const imageMap = await buildImageMap(body, conv.title || conv.id);
    const slug = slugifyChatGptTitle(body.title || conv.title);
    if (format === 'md') {
      const md = convertChatGptToMarkdown(body, imageMap);
      triggerDownload(new Blob([md], { type: 'text/markdown' }), `${slug}.md`);
    } else {
      const json = chatGptConversationToJson(body, imageMap);
      triggerDownload(new Blob([json], { type: 'application/json' }), `${slug}.json`);
    }
    setStatus('Exported ✓');
  } catch (err) {
    console.error(err);
    setStatus(err.message || String(err), true);
  }
}

function selectedIds() {
  return Array.from(document.querySelectorAll('.conv-check'))
    .filter((cb) => cb.checked)
    .map((cb) => cb.dataset.id);
}

async function exportSelected(format) {
  const ids = selectedIds();
  if (ids.length === 0) { setStatus('Select at least one conversation first.', true); return; }
  const byId = new Map(conversations.map((c) => [c.id, c]));

  try {
    await ensureToken();
    const zip = new JSZip();
    const usedNames = new Set();
    let done = 0;
    for (const id of ids) {
      const conv = byId.get(id);
      setStatus(`Fetching ${done + 1}/${ids.length}: "${(conv && conv.title) || id}"…`);
      const body = await fetchChatGptConversation(accessToken, id);
      const imageMap = await buildImageMap(body, `${done + 1}/${ids.length}`);
      let name = slugifyChatGptTitle(body.title || (conv && conv.title));
      // Guarantee unique zip entries when titles collide or repeat.
      let entry = `${name}.${format === 'md' ? 'md' : 'json'}`;
      let n = 2;
      while (usedNames.has(entry)) entry = `${name}-${n++}.${format === 'md' ? 'md' : 'json'}`;
      usedNames.add(entry);
      const content = format === 'md'
        ? convertChatGptToMarkdown(body, imageMap)
        : chatGptConversationToJson(body, imageMap);
      zip.file(entry, content);
      done++;
    }
    setStatus('Building ZIP…');
    const blob = await zip.generateAsync({ type: 'blob' });
    const stamp = new Date().toISOString().slice(0, 10);
    triggerDownload(blob, `chatgpt-export-${format}-${stamp}.zip`);
    setStatus(`Exported ${done} conversation${done === 1 ? '' : 's'} ✓`);
  } catch (err) {
    console.error(err);
    setStatus(err.message || String(err), true);
  }
}

// Push the selected conversations into Scry as first-class conversations.
//
// Each body goes VERBATIM — Scry walks current_node -> root itself, so the
// client never decides what the visible branch is. One conversation failing
// does not abort the run; failures are collected and reported, because a single
// unreadable conversation shouldn't cost you the other forty.
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
  let pushed = 0;
  let filesStored = 0;
  let discardedImages = 0;
  const failures = [];
  const imageFailures = [];

  try {
    await ensureToken();
    for (const id of ids) {
      const conv = byId.get(id);
      const label = (conv && conv.title) || id;
      setStatus(`Pushing ${pushed + failures.length + 1}/${ids.length}: "${label}"…`);
      try {
        const body = await withChatGptRateLimitRetry(
          () => fetchChatGptConversation(accessToken, id),
          { onRetry: (ms) => setStatus(`Rate limited by chatgpt.com — waiting ${Math.ceil(ms / 1000)}s before retrying "${label}"…`) }
        );
        let fileBlobs = [];
        if (wantImages()) {
          const total = collectChatGptImagePointers(body, { wholeTree: true }).length;
          let done = 0;
          const got = await fetchChatGptFileBlobs(accessToken, body, null, () => {
            done++;
            setStatus(`Pushing ${pushed + failures.length + 1}/${ids.length}: "${label}" — images ${done}/${total}…`);
          });
          fileBlobs = got.blobs;
          const real = got.failures.filter((f) => f.onBranch);
          const dead = got.failures.length - real.length;
          if (real.length) {
            // Surface it. A push whose images silently vanished reads as success.
            imageFailures.push(`"${label}": ${real.length}/${total} visible image(s) not fetched — ${real[0].error}`);
          }
          if (dead) discardedImages += dead; // regenerated-away attempts chatgpt.com no longer serves
        }
        const resp = await postToScry(scry, buildChatGptIngestPayload(body, fileBlobs, id));
        if (resp.body && typeof resp.body.files_stored === 'number') filesStored += resp.body.files_stored;
        if (!resp.ok || !resp.body || !resp.body.success) {
          throw new Error((resp.body && resp.body.error) || `HTTP ${resp.status}`);
        }
        pushed++;
      } catch (err) {
        console.error('Scry push failed for', id, err);
        failures.push(`"${label}": ${err.message || err}`);
      }
    }

    const deadNote = discardedImages ? `; ${discardedImages} regenerated-away image${discardedImages === 1 ? '' : 's'} no longer served by chatgpt.com, skipped` : '';
    const filesNote = wantImages() ? ` (${filesStored} image file${filesStored === 1 ? '' : 's'} stored${deadNote})` : '';
    if (failures.length === 0 && imageFailures.length === 0) {
      setStatus(`Pushed ${pushed} conversation${pushed === 1 ? '' : 's'} to Scry ✓${filesNote}`);
    } else if (failures.length === 0) {
      setStatus(`Pushed ${pushed} conversation${pushed === 1 ? '' : 's'}${filesNote}, but images failed — ${imageFailures.join('; ')}`, true);
    } else {
      setStatus(
        `Pushed ${pushed}/${ids.length}. ${failures.length} failed — ${failures.join('; ')}`,
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
  $('exportSelMd').addEventListener('click', () => exportSelected('md'));
  $('exportSelJson').addEventListener('click', () => exportSelected('json'));
});
