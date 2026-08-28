function loadGraphCache_() {
  const ss = getGraphSpreadsheet_();
  const sheet = ss.getSheetByName(GRAPH_SETTINGS.cacheSheet);
  if (!sheet) return null;

  const generatedRaw = sheet.getRange('A1').getValue();
  if (!generatedRaw) return null;
  const generatedAt = generatedRaw instanceof Date ? generatedRaw : new Date(generatedRaw);
  if (Number.isNaN(generatedAt.getTime())) return null;

  const ageMs = Date.now() - generatedAt.getTime();
  if (ageMs > GRAPH_SETTINGS.cacheMaxAgeHours * 3600000) return null;

  const chunkCount = Number(sheet.getRange('B1').getValue() || 0);
  if (!Number.isInteger(chunkCount) || chunkCount <= 0) return null;
  const chunks = sheet.getRange(2, 1, chunkCount, 1).getDisplayValues().flat();
  const json = chunks.join('');
  if (!json) return null;

  try {
    return JSON.parse(json);
  } catch (error) {
    return null;
  }
}

function saveGraphCache_(payload) {
  const ss = getGraphSpreadsheet_();
  let sheet = ss.getSheetByName(GRAPH_SETTINGS.cacheSheet);
  if (!sheet) {
    sheet = ss.insertSheet(GRAPH_SETTINGS.cacheSheet);
    sheet.hideSheet();
  }

  const json = JSON.stringify(payload);
  const chunks = [];
  for (let offset = 0; offset < json.length; offset += GRAPH_SETTINGS.cacheChunkChars) {
    chunks.push([json.slice(offset, offset + GRAPH_SETTINGS.cacheChunkChars)]);
  }

  sheet.clearContents();
  sheet.getRange('A1').setValue(new Date());
  sheet.getRange('B1').setValue(chunks.length);
  sheet.getRange('C1').setValue(payload.fiscalYear || '');
  if (chunks.length) sheet.getRange(2, 1, chunks.length, 1).setValues(chunks);
  if (!sheet.isSheetHidden()) sheet.hideSheet();
}

function clearGraphCache_() {
  const sheet = getGraphSpreadsheet_().getSheetByName(GRAPH_SETTINGS.cacheSheet);
  if (sheet) sheet.clearContents();
}
