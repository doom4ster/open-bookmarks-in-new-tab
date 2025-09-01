// background.js (MV3)

// 會話級暫存工具：包一層，避免重複 get/set boilerplate
const session = chrome.storage.session;

// 參數
const JUST_CREATED_TTL_MS = 6000;  // 建立分頁後 N 秒內視為「剛建立」
const IGNORE_TTL_MS = 5000;        // 去重鍵的存活時間

// 初始化會話儲存結構
async function ensureSessionStruct() {
  const { justCreated = {}, ignoreMap = {} } = await session.get(['justCreated', 'ignoreMap']);
  if (!justCreated || !ignoreMap) {
    await session.set({
      justCreated: justCreated || {},
      ignoreMap: ignoreMap || {}
    });
  }
}

// 讀偏好
async function getPrefs() {
  return new Promise(resolve => {
    chrome.storage.sync.get(
      {
        openInBackground: false,   // true: 背景開新分頁；false: 前景
        closeEmptySourceTab: false // 若原分頁是 new tab 或無法後退時，是否直接關閉
      },
      resolve
    );
  });
}

// 工具：現在時間
const now = () => Date.now();

// 工具：清理過期鍵
async function gcSessionMaps() {
  const { justCreated = {}, ignoreMap = {} } = await session.get(['justCreated', 'ignoreMap']);
  const t = now();
  let dirty = false;

  for (const k of Object.keys(justCreated)) {
    if (justCreated[k] <= t) { delete justCreated[k]; dirty = true; }
  }
  for (const k of Object.keys(ignoreMap)) {
    if (ignoreMap[k] <= t) { delete ignoreMap[k]; dirty = true; }
  }
  if (dirty) await session.set({ justCreated, ignoreMap });
}

// 標記 tabId 為剛建立
async function markTabJustCreated(tabId) {
  const { justCreated = {} } = await session.get('justCreated');
  justCreated[String(tabId)] = now() + JUST_CREATED_TTL_MS;
  await session.set({ justCreated });
}

// 查詢是否剛建立
async function isTabJustCreated(tabId) {
  const { justCreated = {} } = await session.get('justCreated');
  const exp = justCreated[String(tabId)] || 0;
  return exp > now();
}

// 標記忽略鍵（避免重入）
async function markIgnore(key, ttl = IGNORE_TTL_MS) {
  const { ignoreMap = {} } = await session.get('ignoreMap');
  ignoreMap[key] = now() + ttl;
  await session.set({ ignoreMap });
}

// 是否應忽略
async function shouldIgnore(key) {
  const { ignoreMap = {} } = await session.get('ignoreMap');
  return (ignoreMap[key] || 0) > now();
}

// 嘗試後退
async function tryGoBack(tabId) {
  try {
    await chrome.tabs.goBack(tabId);
    return true;
  } catch {
    return false;
  }
}

// 粗略判定 new tab / 空白頁
function isEmptyLikeUrl(u) {
  // 各平台 newtab 可能不同實作；盡量涵蓋
  return (
    u === 'about:blank' ||
    u === '' ||
    u?.startsWith('chrome-search://') || // Windows 有時是 chrome-search://local-ntp
    u === 'chrome://newtab/' ||
    u === 'chrome://newtab'
  );
}

// 監聽剛建立的分頁（批次/群組/資料夾一鍵開啟時，Chrome 本來就會在新分頁開）
chrome.tabs.onCreated.addListener(async (tab) => {
  if (typeof tab.id === 'number') {
    await ensureSessionStruct();
    await gcSessionMaps();
    await markTabJustCreated(tab.id);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { justCreated = {} } = await session.get('justCreated');
  if (justCreated[String(tabId)]) {
    delete justCreated[String(tabId)];
    await session.set({ justCreated });
  }
});

// 僅對主框架 + 書籤導覽處理；加上 URL 濾器降低觸發面
chrome.webNavigation.onCommitted.addListener(async (details) => {
  const { tabId, url, transitionType, frameId } = details;

  // 只處理主框架
  if (frameId !== 0) return;

  // 僅處理由書籤觸發
  if (transitionType !== 'auto_bookmark') return;

  await ensureSessionStruct();
  await gcSessionMaps();

  // 若該分頁「剛建立」，代表 Chrome 已在新分頁開啟 → 略過
  if (await isTabJustCreated(tabId)) return;

  // 去重鍵：來源 tab + URL（時間窗內只處理一次）
  const ignoreKey = `src:${tabId}|url:${url}`;
  if (await shouldIgnore(ignoreKey)) return;
  await markIgnore(ignoreKey);

  const prefs = await getPrefs();

  // 1) 在新分頁開啟同一 URL
  try {
    const created = await chrome.tabs.create({
      url,
      active: !prefs.openInBackground
    });
    if (created?.id != null) {
      await markTabJustCreated(created.id);
    }
  } catch {
    // 若新分頁建立失敗就不再處理
    return;
  }

  // 2) 嘗試讓原分頁回上一頁
  const wentBack = await tryGoBack(tabId);

  // 3) 無法後退 → 視偏好處理原分頁
  if (!wentBack) {
    try {
      const srcTab = await chrome.tabs.get(tabId);
      const currUrl = srcTab.pendingUrl || srcTab.url || '';

      if (prefs.closeEmptySourceTab && isEmptyLikeUrl(currUrl)) {
        // 原分頁只是空白/新分頁 → 直接關閉（比導向 chrome://newtab 穩）
        await chrome.tabs.remove(tabId);
      } else {
        // 保守作法：不強制導向 chrome://newtab，避免權限/平台差異
        // 如果真的要清空，可改為 about:blank（通常允許）
        if (!isEmptyLikeUrl(currUrl)) {
          await chrome.tabs.update(tabId, { url: 'about:blank' }).catch(() => {/*忽略*/});
        }
      }
    } catch {
      // 忽略
    }
  }
}, {
  // 事件濾器：只監聽需要的協定，降低觸發面與審核疑慮
  url: [
    { schemes: ['http', 'https'] }
    // 若真的需要 file/ftp 等，再加上：
    // ,{ schemes: ['file'] }
  ]
});
