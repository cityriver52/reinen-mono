/**
 * Re:年モノ - core
 * Configで指定した複数フォルダ / 複数ユーザーについて、昨年同時期のEDIT activityだけで候補を評価する。
 */
const REINEN_TIME_ZONE = 'Asia/Tokyo';

function getReinenCoreSettings_() {
  const props = PropertiesService.getScriptProperties();
  return {
    seasonalWindowDays: getIntProperty_(props, 'SEASONAL_WINDOW_DAYS', 21),
    minSeasonalActiveDays: getIntProperty_(props, 'MIN_SEASONAL_ACTIVE_DAYS', 2),
    minSeasonalEditActivities: getIntProperty_(props, 'MIN_SEASONAL_EDIT_ACTIVITIES', 3),
    maxResults: getIntProperty_(props, 'MAX_RESULTS', 50),
    pageSize: getIntProperty_(props, 'PAGE_SIZE', 100),
    maxPages: getIntProperty_(props, 'MAX_PAGES', 500),
  };
}

function runReinenMono() {
  const runtime = readReinenRuntimeConfig_();
  const settings = getReinenCoreSettings_();
  const now = new Date();
  const windows = buildWindows_(now, settings);
  const stats = queryEditStatsForConfig_(runtime, windows.seasonalStart, windows.seasonalEnd, settings);
  const recommendations = buildRecommendations_(stats, now, settings)
    .sort((a, b) => b.score - a.score)
    .slice(0, settings.maxResults);
  writeDataSheet_(runtime.spreadsheet, recommendations, now);
  const result = { count: recommendations.length, spreadsheetUrl: runtime.spreadsheet.getUrl(), folders: runtime.folders.length, users: runtime.users.length };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

function diagnoseHistory() {
  const runtime = readReinenRuntimeConfig_();
  const settings = getReinenCoreSettings_();
  const center = shiftYears_(new Date(), -1);
  const start = addDays_(center, -30);
  const end = addDays_(center, 31);
  const values = Object.values(queryEditStatsForConfig_(runtime, start, end, settings)).map(finalizeStats_);
  const result = {
    folders: runtime.folders.map((x) => ({ id: x.id, name: x.name })),
    users: runtime.users.map((x) => ({ email: x.email, actorId: x.actorId })),
    filesFound: values.length,
    editActivitiesFound: values.reduce((sum, x) => sum + x.editActivities, 0),
    top20: values.sort((a,b) => b.activeDays - a.activeDays || b.editActivities - a.editActivities).slice(0,20),
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

function queryEditStatsForConfig_(runtime, start, end, settings) {
  const stats = {};
  const seenEvents = new Set();
  runtime.folders.forEach((folder) => queryEditStats_(folder, start, end, runtime.allowedActorIds, settings, stats, seenEvents));
  return stats;
}

function queryEditStats_(folder, start, end, allowedActorIds, settings, stats, seenEvents) {
  let pageToken = null;
  let pageCount = 0;
  do {
    pageCount += 1;
    if (pageCount > settings.maxPages) throw new Error(`Drive Activity API のページ数が ${settings.maxPages} を超えました。`);
    const request = {
      ancestorName: `items/${folder.id}`,
      consolidationStrategy: { none: {} },
      pageSize: settings.pageSize,
      filter: 'detail.action_detail_case:EDIT ' + `time >= "${start.toISOString()}" ` + `time < "${end.toISOString()}"`,
    };
    if (pageToken) request.pageToken = pageToken;
    const response = DriveActivity.Activity.query(request);

    for (const activity of response.activities || []) {
      const activityTime = getActivityTime_(activity);
      if (!activityTime) continue;
      const actorIds = getActivityActorIds_(activity);
      if (!actorIds.some((id) => allowedActorIds.has(id))) continue;
      const dayKey = Utilities.formatDate(activityTime, REINEN_TIME_ZONE, 'yyyy-MM-dd');
      const seenFileIds = new Set();

      for (const target of activity.targets || []) {
        const item = target.driveItem;
        if (!item || !item.name || item.driveFolder) continue;
        const fileId = item.name.replace(/^items\//, '');
        if (!fileId || seenFileIds.has(fileId)) continue;
        seenFileIds.add(fileId);
        const eventKey = [activityTime.toISOString(), fileId, actorIds.slice().sort().join(',')].join('|');
        if (seenEvents.has(eventKey)) {
          if (stats[fileId]) stats[fileId].folderIdSet.add(folder.id);
          continue;
        }
        seenEvents.add(eventKey);

        if (!stats[fileId]) {
          stats[fileId] = { fileId, title: item.title || '(無題)', editActivities: 0, activeDaySet: new Set(), actorIdSet: new Set(), folderIdSet: new Set(), firstActivity: null, lastActivity: null };
        }
        const stat = stats[fileId];
        stat.editActivities += 1;
        stat.activeDaySet.add(dayKey);
        actorIds.forEach((id) => { if (allowedActorIds.has(id)) stat.actorIdSet.add(id); });
        stat.folderIdSet.add(folder.id);
        if (item.title) stat.title = item.title;
        if (!stat.firstActivity || activityTime < stat.firstActivity) stat.firstActivity = activityTime;
        if (!stat.lastActivity || activityTime > stat.lastActivity) stat.lastActivity = activityTime;
      }
    }
    pageToken = response.nextPageToken || null;
  } while (pageToken);
}

function getActivityActorIds_(activity) {
  const ids = new Set();
  (activity.actors || []).forEach((actor) => {
    const knownUser = actor.user && actor.user.knownUser;
    if (knownUser && knownUser.personName) ids.add(knownUser.personName);
  });
  return Array.from(ids);
}

function buildRecommendations_(seasonalStats, now, settings) {
  const recommendations = [];
  Object.keys(seasonalStats).forEach((fileId) => {
    const past = finalizeStats_(seasonalStats[fileId]);
    if (!(past.activeDays >= settings.minSeasonalActiveDays || past.editActivities >= settings.minSeasonalEditActivities)) return;
    const expectedStart = past.firstActivity ? shiftYears_(past.firstActivity, 1) : null;
    recommendations.push({
      score: past.activeDays * 100 + Math.min(past.editActivities, 50) * 5,
      fileId,
      title: past.title,
      seasonalActiveDays: past.activeDays,
      seasonalEditActivities: past.editActivities,
      firstActivity: past.firstActivity,
      lastActivity: past.lastActivity,
      expectedStart,
      timingLabel: describeTiming_(expectedStart, now),
      url: `https://drive.google.com/open?id=${encodeURIComponent(fileId)}`,
      folderIds: past.folderIds,
      actorIds: past.actorIds,
    });
  });
  return recommendations;
}

function writeDataSheet_(spreadsheet, recommendations, generatedAt) {
  const sheet = getOrCreateSheet_(spreadsheet, REINEN_SHEET_CONFIG.DATA_SHEET);
  const filter = sheet.getFilter();
  if (filter) filter.remove();
  sheet.clearContents();
  const headers = ['score','file_name','last_year_active_days','last_year_edit_activities','last_year_first_activity','last_year_last_activity','expected_start','timing_label','drive_url','file_id','matched_folder_ids','matched_actor_ids','generated_at'];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#eeeeee');
  if (recommendations.length > 0) {
    const rows = recommendations.map((item) => [item.score,item.title,item.seasonalActiveDays,item.seasonalEditActivities,item.firstActivity || '',item.lastActivity || '',item.expectedStart || '',item.timingLabel,item.url,item.fileId,item.folderIds.join(','),item.actorIds.join(','),generatedAt]);
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
    sheet.getRange(2, 5, rows.length, 3).setNumberFormat('yyyy-mm-dd hh:mm');
    sheet.getRange(2, 13, rows.length, 1).setNumberFormat('yyyy-mm-dd hh:mm');
    sheet.getRange(1, 1, rows.length + 1, headers.length).createFilter();
  }
  sheet.setFrozenRows(1);
}

function finalizeStats_(stat) {
  return { fileId: stat.fileId, title: stat.title, editActivities: stat.editActivities, activeDays: stat.activeDaySet ? stat.activeDaySet.size : 0, actorIds: stat.actorIdSet ? Array.from(stat.actorIdSet).sort() : [], folderIds: stat.folderIdSet ? Array.from(stat.folderIdSet).sort() : [], firstActivity: stat.firstActivity, lastActivity: stat.lastActivity };
}
function getActivityTime_(activity) { if (activity.timestamp) return new Date(activity.timestamp); if (activity.timeRange) { const v = activity.timeRange.endTime || activity.timeRange.startTime; if (v) return new Date(v); } return null; }
function buildWindows_(now, settings) { const center = shiftYears_(now, -1); return { seasonalStart: addDays_(center, -settings.seasonalWindowDays), seasonalEnd: addDays_(center, settings.seasonalWindowDays + 1) }; }
function describeTiming_(expectedStart, now) { if (!expectedStart) return ''; const days = diffCalendarDays_(expectedStart, now); if (days < 0) return `あと${Math.abs(days)}日くらい`; if (days === 0) return '昨年は今日ごろ開始'; return `昨年は${days}日前ごろ開始`; }
function diffCalendarDays_(expected, now) { const e = Utilities.formatDate(expected, REINEN_TIME_ZONE, 'yyyy-MM-dd'); const n = Utilities.formatDate(now, REINEN_TIME_ZONE, 'yyyy-MM-dd'); return Math.round((new Date(`${n}T00:00:00Z`) - new Date(`${e}T00:00:00Z`)) / 86400000); }
function addDays_(date, days) { const v = new Date(date); v.setDate(v.getDate() + days); return v; }
function shiftYears_(date, years) { const v = new Date(date); v.setFullYear(v.getFullYear() + years); return v; }
function formatDate_(date) { return Utilities.formatDate(date, REINEN_TIME_ZONE, 'yyyy-MM-dd'); }
function getIntProperty_(props, key, fallback) { const value = Number(props.getProperty(key)); return Number.isFinite(value) ? Math.trunc(value) : fallback; }
