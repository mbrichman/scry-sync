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

document.addEventListener('DOMContentLoaded', () => {
  $('loadBtn').addEventListener('click', loadConversations);
  $('selectAll').addEventListener('click', () =>
    document.querySelectorAll('.conv-check').forEach((cb) => { cb.checked = true; }));
  $('selectNone').addEventListener('click', () =>
    document.querySelectorAll('.conv-check').forEach((cb) => { cb.checked = false; }));
  $('exportSelMd').addEventListener('click', () => exportSelected('md'));
  $('exportSelJson').addEventListener('click', () => exportSelected('json'));
});
