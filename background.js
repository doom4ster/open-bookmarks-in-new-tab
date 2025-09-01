// 防止循環處理與重入
const ignoreNavigations = new Set();

// 追蹤剛建立的分頁（例如：從書籤資料夾「全部開啟」、分頁群組開啟、多個書籤中鍵點擊等情境）
// 這些情境下，Chrome 已經「在新分頁開啟」，不需要我們再複製一次。
const justCreatedTabs = new Set();
const JUST_CREATED_TTL_MS = 6000; // 建立後 N 秒內視為「剛建立」

// 維護 justCreatedTabs
chrome.tabs.onCreated.addListener((tab) => {
  if (typeof tab.id === 'number') {
    justCreatedTabs.add(tab.id);
    setTimeout(() => justCreatedTabs.delete(tab.id), JUST_CREATED_TTL_MS);
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  justCreatedTabs.delete(tabId);
});

// 讀取使用者偏好
async function getPrefs() {
  return new Promise(resolve => {
    chrome.storage.sync.get(
      {
        openInBackground: false, // true: 背景開新分頁；false: 前景
        closeEmptySourceTab: false // 若原分頁是 new tab 或無法後退時，是否直接關閉
      },
      resolve
    );
  });
}

// 嘗試判斷分頁是否可後退（最佳努力，仍可能失敗）
async function tryGoBack(tabId) {
  try {
    await chrome.tabs.goBack(tabId);
    return true;
  } catch (e) {
    // goBack 可能拋錯：無歷史、特殊頁面等
    return false;
  }
}

// 判斷是否為 new tab（簡化判定）
function isNewTabUrl(url) {
  return url === 'chrome://newtab/' || url === 'about:blank' || url === '';
}

// 監聽由書籤觸發的導覽
chrome.webNavigation.onCommitted.addListener(async (details) => {
  const { tabId, url, transitionType, frameId } = details;

  // 只處理主框架導覽
  if (frameId !== 0) return;

  // 僅處理由書籤觸發
  if (transitionType !== 'auto_bookmark') return;

  // 若該分頁是「剛剛被建立」的，代表 Chrome 已經在新分頁開啟（例如分頁群組/資料夾一次開多個），直接略過
  if (justCreatedTabs.has(tabId)) {
    return;
  }

  // 避免重入
  const key = `${tabId}:${details.timeStamp}`;
  if (ignoreNavigations.has(key)) return;
  ignoreNavigations.add(key);
  setTimeout(() => ignoreNavigations.delete(key), 5000);

  const prefs = await getPrefs();

  // 1) 在新分頁開啟相同 URL（前景或背景）
  await chrome.tabs.create({
    url,
    active: !prefs.openInBackground
  });

  // 2) 嘗試讓原分頁回上一頁（還原點書籤前的畫面）
  const wentBack = await tryGoBack(tabId);

  // 3) 若無法後退，視設定處理原分頁
  if (!wentBack) {
    try {
      const srcTab = await chrome.tabs.get(tabId);
      if (prefs.closeEmptySourceTab && isNewTabUrl(srcTab.pendingUrl || srcTab.url || '')) {
        // 若原分頁只是 new tab / blank，就關掉它
        await chrome.tabs.remove(tabId);
      } else {
        // 否則改導向 new tab，避免與新分頁重複
        if (!isNewTabUrl(srcTab.url || '')) {
          await chrome.tabs.update(tabId, { url: 'chrome://newtab/' });
        }
      }
    } catch (e) {
      // ignore
    }
  }
});
