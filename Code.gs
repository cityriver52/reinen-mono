/**
 * Re:年モノ - core
 *
 * Configで指定した複数フォルダ / 複数ユーザーについて、
 * 「昨年の今頃が、昨年の他時期より特に活発だった」ファイルを評価する。
 */
const REINEN_TIME_ZONE = 'Asia/Tokyo';

function getReinenCoreSettings_() {
  const props = PropertiesService.getScriptProperties();
  return {
    seasonalWindowDays: getIntProperty_(props, 'SEASONAL_WINDOW_DAYS', 21),
    comparisonDays: getIntProperty_(props, 'SEASONAL_COMPARISON_DAYS', 365),
    minSeasonalActiveDays: getIntProperty_(props, 'MIN_SEASONAL_ACTIVE_DAYS', 2),
    minSeasonalEditActivities: getIntProperty_(props, 'MIN_SEASONAL_EDIT_ACTIVITIES', 3),
    minSeasonalLift: getNumberProperty_(props, 'MIN_SEASONAL_LIFT', 2.0),
    minSeasonalActivityShare: getNumberProperty_(props, 'MIN_SEASONAL_ACTIVITY_SHARE', 0.30),
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

  const stats = querySeasonalityStatsForConfig_(runtime, windows, settings);
  let recommendations = buildRecommendations_(stats, now, settings)
    .sort((a, b) => b.score - a.score)
    .slice(0, settings.maxResults);

  recommendations = hydrateRecommendationLocations_(recommendations);
  writeDataSheet_(runtime.spreadsheet, recommendations, now);

  const result = {
    count: recommendations.length,
    spreadsheetUrl: runtime.spreadsheet.getUrl(),
    folders: runtime.folders.length,
    users: runtime.users.length,
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

function diagnoseHistory() {
  const runtime = readReinenRuntimeConfig_();
  const settings = getReinenCoreSettings_();
  const now = new Date();
  const windows = buildWindows_(now, settings);

  const values = Object.values(
    querySeasonalityStatsForConfig_(runtime, windows, settings)
  ).map((stat) => finalizeSeasonalityStats_(stat, windows));

  const result = {
    folders: runtime.folders.map((x) => ({ id: x.id, name: x.name })),
    users: runtime.users.map((x) => ({ email: x.email, actorId: x.actorId })),
    comparisonStart: windows.comparisonStart.toISOString(),
    comparisonEndExclusive: windows.comparisonEnd.toISOString(),
    seasonalStart: windows.seasonalStart.toISOString(),
    seasonalEndExclusive: windows.seasonalEnd.toISOString(),
    filesFound: values.length,
    top20: values
      .filter((x) => x.seasonalActiveDays > 0)
      .sort((a, b) => b.seasonalLift - a.seasonalLift || b.seasonalActiveDays - a.seasonalActiveDays)
      .slice(0, 20),
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * 365日前後の比較期間を一度取得し、その中で「今頃」と「その他」を分けて集計する。
 */
function querySeasonalityStatsForConfig_(runtime, windows, settings) {
  const stats = {};
  const seenEvents = new Set();
  runtime.folders.forEach((folder) =>
    querySeasonalityStats_(
      folder,
      windows,
      runtime.allowedActorIds,
      settings,
      stats,
      seenEvents
    )
  );
  return stats;
}

function querySeasonalityStats_(folder, windows, allowedActorIds, settings, stats, seenEvents) {
  let pageToken = null;
  let pageCount = 0;

  do {
    pageCount += 1;
    if (pageCount > settings.maxPages) {
      throw new Error(
        `Drive Activity API のページ数が ${settings.maxPages} を超えました。対象フォルダを絞るか MAX_PAGES を調整してください。`
      );
    }

    const request = {
      ancestorName: `items/${folder.id}`,
      consolidationStrategy: { none: {} },
      pageSize: settings.pageSize,
      filter:
        'detail.action_detail_case:EDIT ' +
        `time >= \"${windows.comparisonStart.toISOString()}\" ` +
        `time < \"${windows.comparisonEnd.toISOString()}\"`,
    };
    if (pageToken) request.pageToken = pageToken;

    const response = DriveActivity.Activity.query(request);

    for (const activity of response.activities || []) {
      const activityTime = getActivityTime_(activity);
      if (!activityTime) continue;

      const actorIds = getActivityActorIds_(activity);
      if (!actorIds.some((id) => allowedActorIds.has(id))) continue;

      const dayKey = Utilities.formatDate(
        activityTime,
        REINEN_TIME_ZONE,
        'yyyy-MM-dd'
      );
      const isSeasonal =
        activityTime >= windows.seasonalStart &&
        activityTime < windows.seasonalEnd;
      const seenFileIds = new Set();

      for (const target of activity.targets || []) {
        const item = target.driveItem;
        if (!item || !item.name || item.driveFolder) continue;

        const fileId = item.name.replace(/^items\//, '');
        if (!fileId || seenFileIds.has(fileId)) continue;
        seenFileIds.add(fileId);

        const eventKey = [
          activityTime.toISOString(),
          fileId,
          actorIds.slice().sort().join(','),
        ].join('|');

        if (seenEvents.has(eventKey)) {
          if (stats[fileId]) stats[fileId].folderIdSet.add(folder.id);
          continue;
        }
        seenEvents.add(eventKey);

        if (!stats[fileId]) {
          stats[fileId] = {
            fileId,
            title: item.title || '(無題)',
            totalEditActivities: 0,
            totalActiveDaySet: new Set(),
            seasonalEditActivities: 0,
            seasonalActiveDaySet: new Set(),
            actorIdSet: new Set(),
            folderIdSet: new Set(),
            seasonalFirstActivity: null,
            seasonalLastActivity: null,
          };
        }

        const stat = stats[fileId];
        stat.totalEditActivities += 1;
        stat.totalActiveDaySet.add(dayKey);
        stat.folderIdSet.add(folder.id);
        actorIds.forEach((id) => {
          if (allowedActorIds.has(id)) stat.actorIdSet.add(id);
        });
        if (item.title) stat.title = item.title;

        if (isSeasonal) {
          stat.seasonalEditActivities += 1;
          stat.seasonalActiveDaySet.add(dayKey);
          if (!stat.seasonalFirstActivity || activityTime < stat.seasonalFirstActivity) {
            stat.seasonalFirstActivity = activityTime;
          }
          if (!stat.seasonalLastActivity || activityTime > stat.seasonalLastActivity) {
            stat.seasonalLastActivity = activityTime;
          }
        }
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

function buildRecommendations_(seasonalityStats, now, settings) {
  const windows = buildWindows_(now, settings);
  const recommendations = [];

  Object.keys(seasonalityStats).forEach((fileId) => {
    const past = finalizeSeasonalityStats_(seasonalityStats[fileId], windows);

    const seasonalEnough =
      past.seasonalActiveDays >= settings.minSeasonalActiveDays ||
      past.seasonalEditActivities >= settings.minSeasonalEditActivities;
    if (!seasonalEnough) return;

    if (past.seasonalLift < settings.minSeasonalLift) return;
    if (past.seasonalActivityShare < settings.minSeasonalActivityShare) return;

    const expectedStart = past.firstActivity
      ? shiftYears_(past.firstActivity, 1)
      : null;

    const baseScore =
      past.seasonalActiveDays * 100 +
      Math.min(past.seasonalEditActivities, 50) * 5;
    const score = Math.round(baseScore * Math.min(past.seasonalLift, 5));

    recommendations.push({
      score,
      fileId,
      title: past.title,
      seasonalActiveDays: past.seasonalActiveDays,
      seasonalEditActivities: past.seasonalEditActivities,
      backgroundActiveDays: past.backgroundActiveDays,
      backgroundEditActivities: past.backgroundEditActivities,
      seasonalLift: past.seasonalLift,
      seasonalActivityShare: past.seasonalActivityShare,
      firstActivity: past.firstActivity,
      lastActivity: past.lastActivity,
      expectedStart,
      timingLabel: describeTiming_(expectedStart, now),
      url: `https://drive.google.com/open?id=${encodeURIComponent(fileId)}`,
      folderIds: past.folderIds,
      actorIds: past.actorIds,
      folderPath: '',
    });
  });

  return recommendations;
}

function finalizeSeasonalityStats_(stat, windows) {
  const totalActiveDays = stat.totalActiveDaySet
    ? stat.totalActiveDaySet.size
    : 0;
  const seasonalActiveDays = stat.seasonalActiveDaySet
    ? stat.seasonalActiveDaySet.size
    : 0;
  const backgroundActiveDays = Math.max(
    totalActiveDays - seasonalActiveDays,
    0
  );
  const backgroundEditActivities = Math.max(
    stat.totalEditActivities - stat.seasonalEditActivities,
    0
  );

  const seasonalDays = Math.max(
    calendarDaySpan_(windows.seasonalStart, windows.seasonalEnd),
    1
  );
  const comparisonDays = Math.max(
    calendarDaySpan_(windows.comparisonStart, windows.comparisonEnd),
    seasonalDays + 1
  );
  const backgroundDays = Math.max(comparisonDays - seasonalDays, 1);

  const seasonalRate = seasonalActiveDays / seasonalDays;
  const backgroundRate = backgroundActiveDays / backgroundDays;
  // 他時期が0日の場合も無限大にせず、「比較期間に1日使った」相当を下限にする。
  const backgroundFloor = 1 / backgroundDays;
  const seasonalLift = seasonalRate / Math.max(backgroundRate, backgroundFloor);
  const seasonalActivityShare =
    totalActiveDays > 0 ? seasonalActiveDays / totalActiveDays : 0;

  return {
    fileId: stat.fileId,
    title: stat.title,
    seasonalActiveDays,
    seasonalEditActivities: stat.seasonalEditActivities || 0,
    backgroundActiveDays,
    backgroundEditActivities,
    seasonalLift,
    seasonalActivityShare,
    actorIds: stat.actorIdSet ? Array.from(stat.actorIdSet).sort() : [],
    folderIds: stat.folderIdSet ? Array.from(stat.folderIdSet).sort() : [],
    firstActivity: stat.seasonalFirstActivity,
    lastActivity: stat.seasonalLastActivity,
  };
}

/**
 * 候補に絞った後でDrive階層を解決する。API呼び出しを増やしすぎないため全ファイルには行わない。
 */
function hydrateRecommendationLocations_(recommendations) {
  return recommendations.map((item) => ({
    ...item,
    folderPath: resolveFileFolderPath_(item.fileId),
  }));
}

function resolveFileFolderPath_(fileId) {
  const cache = CacheService.getScriptCache();
  const cacheKey = `REINEN_PATH_${fileId}`;
  const cached = cache.get(cacheKey);
  if (cached !== null) return cached;

  let path = '';
  try {
    const file = DriveApp.getFileById(fileId);
    const parentIterator = file.getParents();
    const paths = [];
    while (parentIterator.hasNext()) {
      paths.push(buildFolderPath_(parentIterator.next()));
    }
    path = Array.from(new Set(paths.filter(Boolean))).join(' | ');
  } catch (error) {
    path = '(フォルダ階層を取得できません)';
  }

  try {
    cache.put(cacheKey, path, 21600);
  } catch (error) {}
  return path;
}

function buildFolderPath_(folder) {
  const names = [];
  const seen = new Set();
  let current = folder;
  let guard = 0;

  while (current && guard < 50) {
    guard += 1;
    let id = '';
    try {
      id = current.getId();
    } catch (error) {
      break;
    }
    if (!id || seen.has(id)) break;
    seen.add(id);

    try {
      names.unshift(current.getName());
    } catch (error) {
      names.unshift(id);
    }

    const parents = current.getParents();
    if (!parents.hasNext()) break;
    current = parents.next();
  }

  return names.join(' / ');
}

function writeDataSheet_(spreadsheet, recommendations, generatedAt) {
  const sheet = getOrCreateSheet_(spreadsheet, REINEN_SHEET_CONFIG.DATA_SHEET);
  const filter = sheet.getFilter();
  if (filter) filter.remove();
  sheet.clearContents();

  const headers = [
    'score',
    'file_name',
    'folder_path',
    'last_year_active_days',
    'last_year_edit_activities',
    'other_period_active_days',
    'other_period_edit_activities',
    'seasonal_lift',
    'seasonal_activity_share',
    'last_year_first_activity',
    'last_year_last_activity',
    'expected_start',
    'timing_label',
    'drive_url',
    'file_id',
    'matched_folder_ids',
    'matched_actor_ids',
    'generated_at',
  ];

  if (sheet.getMaxColumns() < headers.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), headers.length - sheet.getMaxColumns());
  }

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.getRange(1, 1, 1, headers.length)
    .setFontWeight('bold')
    .setBackground('#eeeeee');

  if (recommendations.length > 0) {
    const rows = recommendations.map((item) => [
      item.score,
      item.title,
      item.folderPath,
      item.seasonalActiveDays,
      item.seasonalEditActivities,
      item.backgroundActiveDays,
      item.backgroundEditActivities,
      item.seasonalLift,
      item.seasonalActivityShare,
      item.firstActivity || '',
      item.lastActivity || '',
      item.expectedStart || '',
      item.timingLabel,
      item.url,
      item.fileId,
      item.folderIds.join(','),
      item.actorIds.join(','),
      generatedAt,
    ]);

    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
    sheet.getRange(2, 8, rows.length, 1).setNumberFormat('0.00');
    sheet.getRange(2, 9, rows.length, 1).setNumberFormat('0.0%');
    sheet.getRange(2, 10, rows.length, 3).setNumberFormat('yyyy-mm-dd hh:mm');
    sheet.getRange(2, 18, rows.length, 1).setNumberFormat('yyyy-mm-dd hh:mm');
    sheet.getRange(1, 1, rows.length + 1, headers.length).createFilter();
  }

  sheet.setFrozenRows(1);
  sheet.setColumnWidth(2, 300);
  sheet.setColumnWidth(3, 420);
}

function buildWindows_(now, settings) {
  const center = shiftYears_(now, -1);
  const seasonalStart = addDays_(center, -settings.seasonalWindowDays);
  const seasonalEnd = addDays_(center, settings.seasonalWindowDays + 1);
  const seasonalLength = calendarDaySpan_(seasonalStart, seasonalEnd);
  const comparisonDays = Math.max(settings.comparisonDays, seasonalLength + 1);
  const beforeDays = Math.floor((comparisonDays - 1) / 2);
  const comparisonStart = addDays_(center, -beforeDays);
  const comparisonEnd = addDays_(comparisonStart, comparisonDays);

  return {
    seasonalStart,
    seasonalEnd,
    comparisonStart,
    comparisonEnd,
  };
}

function describeTiming_(expectedStart, now) {
  if (!expectedStart) return '';
  const days = diffCalendarDays_(expectedStart, now);
  if (days < 0) return `あと${Math.abs(days)}日くらい`;
  if (days === 0) return '昨年は今日ごろ開始';
  return `昨年は${days}日前ごろ開始`;
}

function diffCalendarDays_(expected, now) {
  const e = Utilities.formatDate(expected, REINEN_TIME_ZONE, 'yyyy-MM-dd');
  const n = Utilities.formatDate(now, REINEN_TIME_ZONE, 'yyyy-MM-dd');
  return Math.round(
    (new Date(`${n}T00:00:00Z`) - new Date(`${e}T00:00:00Z`)) / 86400000
  );
}

function calendarDaySpan_(start, endExclusive) {
  const s = Utilities.formatDate(start, REINEN_TIME_ZONE, 'yyyy-MM-dd');
  const e = Utilities.formatDate(endExclusive, REINEN_TIME_ZONE, 'yyyy-MM-dd');
  return Math.max(
    Math.round(
      (new Date(`${e}T00:00:00Z`) - new Date(`${s}T00:00:00Z`)) / 86400000
    ),
    0
  );
}

function getActivityTime_(activity) {
  if (activity.timestamp) return new Date(activity.timestamp);
  if (activity.timeRange) {
    const value = activity.timeRange.endTime || activity.timeRange.startTime;
    if (value) return new Date(value);
  }
  return null;
}

function addDays_(date, days) {
  const value = new Date(date);
  value.setDate(value.getDate() + days);
  return value;
}

function shiftYears_(date, years) {
  const value = new Date(date);
  value.setFullYear(value.getFullYear() + years);
  return value;
}

function formatDate_(date) {
  return Utilities.formatDate(date, REINEN_TIME_ZONE, 'yyyy-MM-dd');
}

function getIntProperty_(props, key, fallback) {
  const value = Number(props.getProperty(key));
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function getNumberProperty_(props, key, fallback) {
  const value = Number(props.getProperty(key));
  return Number.isFinite(value) ? value : fallback;
}
