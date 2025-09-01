const openInBackgroundEl = document.getElementById('openInBackground');
const closeEmptySourceTabEl = document.getElementById('closeEmptySourceTab');
const statusEl = document.getElementById('status');

function showStatus(msg) {
  statusEl.textContent = msg;
  setTimeout(() => (statusEl.textContent = ''), 1200);
}

function load() {
  chrome.storage.sync.get(
    {
      openInBackground: false,
      closeEmptySourceTab: false
    },
    (prefs) => {
      openInBackgroundEl.checked = prefs.openInBackground;
      closeEmptySourceTabEl.checked = prefs.closeEmptySourceTab;
    }
  );
}

function save() {
  chrome.storage.sync.set(
    {
      openInBackground: openInBackgroundEl.checked,
      closeEmptySourceTab: closeEmptySourceTabEl.checked
    },
    () => showStatus('已儲存')
  );
}

openInBackgroundEl.addEventListener('change', save);
closeEmptySourceTabEl.addEventListener('change', save);
document.addEventListener('DOMContentLoaded', load);
