/**
 * Re:年モノ - core
 *
 * Configで指定した複数フォルダ / 複数ユーザーについて、
 * 「昨年の今頃が、昨年度の他時期より特に活発だった」ファイルを評価する。
 *
 * Performance strategy:
 * 1. まず季節ウィンドウ（通常43日）だけをフォルダ配下で検索する。
 * 2. その期間で最低活動量を満たしたファイルだけ、年度内のその他期間をitemNameで照会する。
 * 3. itemName照会は UrlFetchApp.fetchAll() で並列化する。
 *
 * 年度全体を対象フォルダ配下で総なめしないことが重要。
 */
const REINEN_TIME_ZONE = 'Asia/Tokyo';
const REINEN_DRIVE_ACTIVITY_ENDPOINT = 'https://driveactivity.googleapis.com/v2/activity:query';

function getReinenCoreSettings_() {
  const props = PropertiesService.getScriptProperties();
  return {
    seasonalWindowDays: getIntProperty_(props, 'SEASONAL_WINDOW_DAYS', 21),
    minSeasonalActiveDays: getIntProperty_(props, 'MIN_SEASONAL_ACTIVE_DAYS', 2),
    minSeasonalEditActivities: getIntProperty_(props, 'MIN_SEASONAL_EDIT_ACTIVITIES', 3),
    minSeasonalLift: getNumberProperty_(props, 'MIN_SEASONAL_LIFT', 2.0),
    maxResults: getIntProperty_(props, 'MAX_RESULTS', 50),
    pageSize: getIntProperty_(props, 'PAGE_SIZE', 100),
    maxPages: getIntProperty_(props, 'MAX_PAGES', 500),
    backgroundParallelBatchSize: 20,
  };
}

function runReinenMono() {
  const startedAt = Date.now();
  const runtime = readReinenRuntimeConfig_();
  const settings = getReinenCoreSettings_();
  const now = new Date();
  const windows = buildWindows_(now, settings);

  const stats = querySeasonalityStatsForConfig_(runtime, windows, settings);
  let recommendations = buildRecommendations_(stats, now, windows, settings)
    .sort((a, b) => b.score - a.score)
    .slice(0, settings.maxResults);

  recommendations = hydrateRecommendationLocations_(recommendations);
  writeDataSheet_(runtime.spreadsheet, recommendations, now);

  const result = {
    count: recommendations.length,
    spreadsheetUrl: runtime.spreadsheet.getUrl(),
    comparisonFiscalYear: windows.fiscalYear,
    folders: runtime.folders.length,
    users: runtime.users.length,
    elapsedSeconds: Math.round((Date.now() - startedAt) / 100) / 10,
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

function diagnoseHistory() {
  const startedAt = Date.now();
  const runtime = readReinenRuntimeConfig_();
  const settings = getReinenCoreSettings_();
  const now = new Date();
  const windows = buildWindows_(now, settings);

  const values = Object.values(
    querySeasonalityStatsForConfig_(runtime, windows, settings)
  ).map((stat) => finalizeSeasonalityStats_(stat, windows));

  const result = {
    comparisonFiscalYear: windows.fiscalYear,
    comparisonStart: windows.comparisonStart.toISOString(),
    comparisonEndExclusive: windows.comparisonEnd.toISOString(),
    seasonalStart: windows.seasonalStart.toISOString(),
    seasonalEndExclusive: windows.seasonalEnd.toISOString(),
    filesFound: values.length,
    elapsedSeconds: Math.round((Date.now() - startedAt) / 100) / 10,
    top20: values
      .filter((x) => x.seasonalActiveDays > 0)
      .sort((a, b) =>
        b.seasonalLift - a.seasonalLift ||
        b.seasonalActiveDays - a.seasonalActiveDays
      )
      .slice(0, 20),
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * Two-stage query.
 *
 * 旧方式:
 *   フォルダ配下の昨年度1年分を全取得 → 今頃 / その他へ分割
 *
 * 新方式:
 *   A. フォルダ配下の今頃だけ取得
 *   B. Aで最低活動量を満たすファイルだけ、年度内その他をitemNameで取得
 *
 * 年中大量に動くフォルダほど削減効果が大きい。
 */
function querySeasonalityStatsForConfig_(runtime, windows, settings) {
  const startedAt = Date.now();
  const stats = {};
  const seenSeasonalEvents = new Set();

  runtime.folders.forEach((folder) => {
    querySeasonalWindowForFolder_(
      folder,
      windows,
      runtime.allowedActorIds,
      settings,
      stats,
      seenSeasonalEvents
    );
  });

  const candidates = Object.values(stats).filter((stat) => {
    const activeDays = stat.seasonalActiveDaySet
      ? stat.seasonalActiveDaySet.size
      : 0;
    return (
      activeDays >= settings.minSeasonalActiveDays ||
      stat.seasonalEditActivities >= settings.minSeasonalEditActivities
    );
  });

  console.log(
    `[Re:年モノ] seasonal scan: ${Object.keys(stats).length} files, ` +
    `${candidates.length} background candidates, ` +
    `${Math.round((Date.now() - startedAt) / 100) / 10}s`
  );

  if (candidates.length > 0) {
    queryBackgroundForCandidatesInParallel_(
      candidates,
      windows,
      runtime.allowedActorIds,
      settings
    );
  }

  console.log(
    `[Re:年モノ] seasonality query total: ` +
    `${Math.round((Date.now() - startedAt) / 100) / 10}s`
  );

  // 季節窓に現れたが最低活動量を満たさなかったファイルは、
  // 年度背景を取得していないのでここで除外して返す。
  const candidateIds = new Set(candidates.map((stat) => stat.fileId));
  Object.keys(stats).forEach((fileId) => {
    if (!candidateIds.has(fileId)) delete stats[fileId];
  });

  return stats;
}

/**
 * Phase A: 通常43日程度の季節ウィンドウだけをフォルダ配下で検索する。
 */
function querySeasonalWindowForFolder_(
  folder,
  windows,
  allowedActorIds,
  settings,
  stats,
  seenEvents
) {
  let pageToken = null;
  let pageCount = 0;

  do {
    pageCount += 1;
    if (pageCount > settings.maxPages) {
      throw new Error(
        `Drive Activity API のページ数が ${settings.maxPages} を超えました。` +
        '対象フォルダを絞るか MAX_PAGES を調整してください。'
      );
    }

    const request = {
      ancestorName: `items/${folder.id}`,
      consolidationStrategy: { none: {} },
      pageSize: settings.pageSize,
      filter:
        'detail.action_detail_case:EDIT ' +
        `time >= \"${windows.seasonalStart.toISOString()}\" ` +
        `time < \"${windows.seasonalEnd.toISOString()}\"`,
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
          stats[fileId] = createEmptySeasonalityStat_(
            fileId,
            item.title || '(無題)'
          );
        }

        const stat = stats[fileId];
        stat.totalEditActivities += 1;
        stat.totalActiveDaySet.add(dayKey);
        stat.seasonalEditActivities += 1;
        stat.seasonalActiveDaySet.add(dayKey);
        stat.folderIdSet.add(folder.id);
        actorIds.forEach((id) => {
          if (allowedActorIds.has(id)) stat.actorIdSet.add(id);
        });
        if (item.title) stat.title = item.title;

        if (
          !stat.seasonalFirstActivity ||
          activityTime < stat.seasonalFirstActivity
        ) {
          stat.seasonalFirstActivity = activityTime;
        }
        if (
          !stat.seasonalLastActivity ||
          activityTime > stat.seasonalLastActivity
        ) {
          stat.seasonalLastActivity = activityTime;
        }
      }
    }

    pageToken = response.nextPageToken || null;
  } while (pageToken);
}

function createEmptySeasonalityStat_(fileId, title) {
  return {
    fileId,
    title: title || '(無題)',
    totalEditActivities: 0,
    totalActiveDaySet: new Set(),
    seasonalEditActivities: 0,
    seasonalActiveDaySet: new Set(),
    actorIdSet: new Set(),
    folderIdSet: new Set(),
    seasonalFirstActivity: null,
    seasonalLastActivity: null,
    backgroundSeenEventSet: new Set(),
  };
}

/**
 * Phase B: 季節候補だけについて、年度内の季節窓以外をitemNameで照会する。
 * 各ファイルの照会は独立しているため fetchAll() で並列化する。
 */
function queryBackgroundForCandidatesInParallel_(
  candidates,
  windows,
  allowedActorIds,
  settings
) {
  const jobs = [];

  candidates.forEach((stat) => {
    if (windows.comparisonStart < windows.seasonalStart) {
      jobs.push(createBackgroundQueryJob_(
        stat,
        windows.comparisonStart,
        windows.seasonalStart
      ));
    }
    if (windows.seasonalEnd < windows.comparisonEnd) {
      jobs.push(createBackgroundQueryJob_(
        stat,
        windows.seasonalEnd,
        windows.comparisonEnd
      ));
    }
  });

  const token = ScriptApp.getOAuthToken();
  const batchSize = Math.max(
    1,
    Math.min(settings.backgroundParallelBatchSize || 20, 50)
  );
  let pending = jobs;

  while (pending.length > 0) {
    const nextPending = [];

    for (let offset = 0; offset < pending.length; offset += batchSize) {
      const batch = pending.slice(offset, offset + batchSize);
      const requests = batch.map((job) =>
        buildBackgroundFetchRequest_(job, token, settings)
      );
      const responses = UrlFetchApp.fetchAll(requests);

      responses.forEach((response, index) => {
        const job = batch[index];
        const status = response.getResponseCode();
        if (status < 200 || status >= 300) {
          throw new Error(
            `Drive Activity API の候補別照会に失敗しました (${status}): ` +
            response.getContentText().slice(0, 500)
          );
        }

        let body;
        try {
          body = JSON.parse(response.getContentText() || '{}');
        } catch (error) {
          throw new Error('Drive Activity API の応答JSONを解析できませんでした。');
        }

        processBackgroundActivities_(
          job.stat,
          body.activities || [],
          allowedActorIds
        );

        job.pages += 1;
        if (job.pages > settings.maxPages) {
          throw new Error(
            `${job.stat.title}: Drive Activity API のページ数が ` +
            `${settings.maxPages} を超えました。`
          );
        }

        if (body.nextPageToken) {
          job.pageToken = body.nextPageToken;
          nextPending.push(job);
        }
      });
    }

    pending = nextPending;
  }

  candidates.forEach((stat) => {
    delete stat.backgroundSeenEventSet;
  });
}

function createBackgroundQueryJob_(stat, start, end) {
  return {
    stat,
    start,
    end,
    pageToken: '',
    pages: 0,
  };
}

function buildBackgroundFetchRequest_(job, token, settings) {
  const body = {
    itemName: `items/${job.stat.fileId}`,
    consolidationStrategy: { none: {} },
    pageSize: settings.pageSize,
    filter:
      'detail.action_detail_case:EDIT ' +
      `time >= \"${job.start.toISOString()}\" ` +
      `time < \"${job.end.toISOString()}\"`,
  };
  if (job.pageToken) body.pageToken = job.pageToken;

  return {
    url: REINEN_DRIVE_ACTIVITY_ENDPOINT,
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    headers: {
      Authorization: `Bearer ${token}`,
    },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  };
}

function processBackgroundActivities_(stat, activities, allowedActorIds) {
  for (const activity of activities) {
    const activityTime = getActivityTime_(activity);
    if (!activityTime) continue;

    const actorIds = getActivityActorIds_(activity);
    if (!actorIds.some((id) => allowedActorIds.has(id))) continue;

    const dayKey = Utilities.formatDate(
      activityTime,
      REINEN_TIME_ZONE,
      'yyyy-MM-dd'
    );

    let targetsFile = false;
    for (const target of activity.targets || []) {
      const item = target.driveItem;
      if (!item || !item.name || item.driveFolder) continue;
      const fileId = item.name.replace(/^items\//, '');
      if (fileId !== stat.fileId) continue;
      targetsFile = true;
      if (item.title) stat.title = item.title;
      break;
    }
    if (!targetsFile) continue;

    const eventKey = [
      activityTime.toISOString(),
      stat.fileId,
      actorIds.slice().sort().join(','),
    ].join('|');
    if (stat.backgroundSeenEventSet.has(eventKey)) continue;
    stat.backgroundSeenEventSet.add(eventKey);

    stat.totalEditActivities += 1;
    stat.totalActiveDaySet.add(dayKey);
    actorIds.forEach((id) => {
      if (allowedActorIds.has(id)) stat.actorIdSet.add(id);
    });
  }
}

function getActivityActorIds_(activity) {
  const ids = new Set();
  (activity.actors || []).forEach((actor) => {
    const knownUser = actor.user && actor.user.knownUser;
    if (knownUser && knownUser.personName) ids.add(knownUser.personName);
  });
  return Array.from(ids);
}

function buildRecommendations_(seasonalityStats, now, windows, settings) {
  const recommendations = [];

  Object.keys(seasonalityStats).forEach((fileId) => {
    const past = finalizeSeasonalityStats_(seasonalityStats[fileId], windows);

    const seasonalEnough =
      past.seasonalActiveDays >= settings.minSeasonalActiveDays ||
      past.seasonalEditActivities >= settings.minSeasonalEditActivities;
    if (!seasonalEnough) return;

    if (past.seasonalLift < settings.minSeasonalLift) return;

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
 * 候補に絞った後で、ファイルの格納先をルートからのパスとして解決する。
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
    const meta = getDriveMeta_(fileId);
    const parentIds = meta.parents || [];
    if (parentIds.length === 0) {
      path = '(ルート階層なし)';
    } else {
      const paths = parentIds
        .map((parentId) => buildFolderPathById_(parentId))
        .filter(Boolean);
      path = Array.from(new Set(paths)).join(' | ');
    }
  } catch (error) {
    path = '(フォルダ階層を取得できません)';
  }

  try {
    cache.put(cacheKey, path, 21600);
  } catch (error) {}
  return path;
}

function buildFolderPathById_(folderId) {
  const names = [];
  const seen = new Set();
  let currentId = folderId;
  let guard = 0;

  while (currentId && guard < 60) {
    guard += 1;
    if (seen.has(currentId)) break;
    seen.add(currentId);

    const meta = getDriveMeta_(currentId);
    names.unshift(meta.name || currentId);

    const parents = meta.parents || [];
    if (parents.length === 0) break;
    currentId = parents[0];
  }

  return names.join(' / ');
}

function getDriveMeta_(fileId) {
  const cache = CacheService.getScriptCache();
  const key = `REINEN_META_${fileId}`;
  const cached = cache.get(key);
  if (cached) return JSON.parse(cached);

  const meta = Drive.Files.get(fileId, {
    fields: 'id,name,parents,driveId,mimeType',
    supportsAllDrives: true,
  });

  const compact = {
    id: meta.id || fileId,
    name: meta.name || '',
    parents: meta.parents || [],
    driveId: meta.driveId || '',
    mimeType: meta.mimeType || '',
  };

  try {
    cache.put(key, JSON.stringify(compact), 21600);
  } catch (error) {}
  return compact;
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
    sheet.insertColumnsAfter(
      sheet.getMaxColumns(),
      headers.length - sheet.getMaxColumns()
    );
  }

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet
    .getRange(1, 1, 1, headers.length)
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
  sheet.setColumnWidth(3, 440);
}

/**
 * 比較対象は「昨年度」（4/1〜翌3/31）。
 * その年度の中で、1年前の今日を中心に±N日の活動密度を比較する。
 * 4月初旬 / 3月末付近では季節窓をその年度内にクリップする。
 */
function buildWindows_(now, settings) {
  const center = shiftYears_(now, -1);
  const centerYear = Number(
    Utilities.formatDate(center, REINEN_TIME_ZONE, 'yyyy')
  );
  const centerMonth = Number(
    Utilities.formatDate(center, REINEN_TIME_ZONE, 'M')
  );

  const fiscalYear = centerMonth >= 4 ? centerYear : centerYear - 1;
  const comparisonStart = makeTokyoDate_(fiscalYear, 4, 1);
  const comparisonEnd = makeTokyoDate_(fiscalYear + 1, 4, 1);

  const rawSeasonalStart = addDays_(center, -settings.seasonalWindowDays);
  const rawSeasonalEnd = addDays_(center, settings.seasonalWindowDays + 1);

  const seasonalStart = new Date(
    Math.max(rawSeasonalStart.getTime(), comparisonStart.getTime())
  );
  const seasonalEnd = new Date(
    Math.min(rawSeasonalEnd.getTime(), comparisonEnd.getTime())
  );

  return {
    fiscalYear,
    seasonalStart,
    seasonalEnd,
    comparisonStart,
    comparisonEnd,
  };
}

function makeTokyoDate_(year, month, day) {
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return new Date(`${year}-${mm}-${dd}T00:00:00+09:00`);
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
