// Options-page glue for the artifact collector: a checkbox, two buttons and a
// result box fed from chrome.storage.local[artifactsRun] (written by the
// background run). Shows only the counts/statuses the run stored.
(() => {
  const KEY = 'artifactsRun';
  const out = document.getElementById('artifactsOutput');
  const collectBtn = document.getElementById('artifactsCollectBtn');
  const diagBtn = document.getElementById('artifactsDiagBtn');
  const copyBtn = document.getElementById('artifactsCopyBtn');
  const enabled = document.getElementById('scryArtifactsEnabled');
  if (!out || !collectBtn) return;

  function render(run) {
    if (!run) { out.textContent = ''; return; }
    const busy = run.state === 'running' && Date.now() - run.startedAt < 2 * 3600 * 1000;
    collectBtn.disabled = busy;
    diagBtn.disabled = busy;
    const head = `${run.mode === 'diagnose' ? 'Test capture' : 'Collect'} - ${busy ? 'running: ' + (run.progress || '') : 'finished ' + new Date(run.finishedAt || Date.now()).toLocaleString()}`;
    out.textContent = busy ? head : `${head}\n${run.text || ''}`;
  }

  chrome.storage.local.get([KEY, 'scry'], (r) => {
    render(r[KEY]);
    enabled.checked = (r.scry || {}).artifactsEnabled === true;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[KEY]) render(changes[KEY].newValue);
  });

  function start(mode) {
    out.textContent = 'starting...';
    chrome.runtime.sendMessage({ action: 'artifactsRun', mode }, (resp) => {
      if (chrome.runtime.lastError) { out.textContent = `Could not reach the background worker: ${chrome.runtime.lastError.message}`; return; }
      if (resp && resp.started === false) out.textContent = `Not started: ${resp.reason}`;
    });
  }
  collectBtn.addEventListener('click', () => start('collect'));
  diagBtn.addEventListener('click', () => start('diagnose'));
  copyBtn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(out.textContent); copyBtn.textContent = 'Copied'; }
    catch { const r = document.createRange(); r.selectNodeContents(out); getSelection().removeAllRanges(); getSelection().addRange(r); copyBtn.textContent = 'Selected - press Cmd+C'; }
    setTimeout(() => { copyBtn.textContent = 'Copy result'; }, 2000);
  });
  enabled.addEventListener('change', (e) => {
    chrome.storage.local.get(['scry'], (r) => {
      chrome.storage.local.set({ scry: mergeScrySetting(r.scry, 'artifactsEnabled', e.target.checked) }, () => {
        const el = document.getElementById('scryArtifactsEnabledSaved');
        el.style.display = 'inline';
        setTimeout(() => { el.style.display = 'none'; }, 1500);
      });
    });
  });
})();
