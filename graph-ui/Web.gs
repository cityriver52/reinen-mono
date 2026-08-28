function doGet() {
  const template = HtmlService.createTemplateFromFile('Index');
  return template
    .evaluate()
    .setTitle('Re:年モノ Graph')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function includeGraphHtml_(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function getGraphPayload(forceRefresh) {
  const fingerprint = getGraphConfigFingerprint_();
  if (!forceRefresh) {
    const cached = loadGraphCache_(fingerprint);
    if (cached) return cached;
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (!forceRefresh) {
      const secondLook = loadGraphCache_(fingerprint);
      if (secondLook) return secondLook;
    }

    const startedAt = Date.now();
    const runtime = readGraphRuntimeConfig_();
    const stats = queryGraphActivityStats_(runtime);
    const payload = buildGraphModel_(stats, runtime);
    payload.configFingerprint = fingerprint;
    payload.elapsedSeconds = Math.round((Date.now() - startedAt) / 100) / 10;
    payload.sourceFileCount = Object.keys(stats).length;
    saveGraphCache_(payload);
    return payload;
  } finally {
    lock.releaseLock();
  }
}

function refreshGraphPayload() {
  return getGraphPayload(true);
}

function getGraphConfigFingerprint_() {
  const sheet = getGraphSpreadsheet_().getSheetByName(GRAPH_SETTINGS.configSheet);
  if (!sheet) return '';
  const rowCount = GRAPH_SETTINGS.folderLastRow - GRAPH_SETTINGS.folderFirstRow + 1;
  const rows = sheet
    .getRange(GRAPH_SETTINGS.folderFirstRow, 1, rowCount, 5)
    .getDisplayValues();
  const relevant = rows.map((row) => [row[0], row[2], row[4]]);
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    JSON.stringify(relevant),
    Utilities.Charset.UTF_8
  );
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

function getGraphNodeDetails(fileId) {
  const id = String(fileId || '').trim();
  if (!id) throw new Error('File IDがありません。');

  const meta = Drive.Files.get(id, {
    fields: 'id,name,mimeType,parents,modifiedTime,webViewLink',
    supportsAllDrives: true,
  });

  return {
    id: meta.id || id,
    name: meta.name || '(無題)',
    mimeType: meta.mimeType || '',
    modifiedTime: meta.modifiedTime || '',
    url: meta.webViewLink || `https://drive.google.com/open?id=${encodeURIComponent(id)}`,
    folderPath: resolveGraphFolderPath_(meta.parents || []),
  };
}

function resolveGraphFolderPath_(parentIds) {
  if (!parentIds || !parentIds.length) return '';
  return parentIds
    .map((parentId) => buildGraphFolderPath_(parentId))
    .filter(Boolean)
    .join(' | ');
}

function buildGraphFolderPath_(folderId) {
  const names = [];
  const seen = new Set();
  let currentId = folderId;
  let guard = 0;

  while (currentId && guard < 50) {
    guard += 1;
    if (seen.has(currentId)) break;
    seen.add(currentId);

    const meta = Drive.Files.get(currentId, {
      fields: 'id,name,parents',
      supportsAllDrives: true,
    });
    names.unshift(meta.name || currentId);
    const parents = meta.parents || [];
    currentId = parents.length ? parents[0] : null;
  }

  return names.join(' / ');
}
