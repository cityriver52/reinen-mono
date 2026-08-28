/**
 * Drive Activity APIから、比較年度内のEDIT活動をファイル×actor×活動日に集約する。
 * グラフではファイル本文を読まない。
 */
function queryGraphActivityStats_(runtime) {
  const stats = {};
  const seenEvents = new Set();
  const limiter = { timestamps: [], limit: 75, windowMs: 60000 };

  runtime.folders.forEach((folder) => {
    queryGraphFolderActivities_(folder, runtime, stats, seenEvents, limiter);
  });

  return stats;
}

function queryGraphFolderActivities_(folder, runtime, stats, seenEvents, limiter) {
  let pageToken = null;
  let pageCount = 0;

  do {
    pageCount += 1;
    if (pageCount > GRAPH_SETTINGS.maxPages) {
      throw new Error(
        `Drive Activity APIのページ数が${GRAPH_SETTINGS.maxPages}を超えました。` +
        '対象フォルダを絞ってください。'
      );
    }

    const request = {
      ancestorName: `items/${folder.id}`,
      consolidationStrategy: { none: {} },
      pageSize: GRAPH_SETTINGS.pageSize,
      filter:
        'detail.action_detail_case:EDIT ' +
        `time >= \"${runtime.comparisonStart.toISOString()}\" ` +
        `time < \"${runtime.comparisonEnd.toISOString()}\"`,
    };
    if (pageToken) request.pageToken = pageToken;

    waitGraphActivitySlot_(limiter);
    const response = queryGraphDriveActivityWithBackoff_(request, limiter);

    (response.activities || []).forEach((activity) => {
      const activityTime = getGraphActivityTime_(activity);
      if (!activityTime) return;

      const actorIds = getGraphActivityActorIds_(activity)
        .map((id) => canonicalGraphActorId_(id, runtime))
        .filter((id) => runtime.allowedActorIds.has(id) || runtime.users.some((u) => u.actorId === id));
      const uniqueActorIds = Array.from(new Set(actorIds));
      if (uniqueActorIds.length === 0) return;

      const dayKey = Utilities.formatDate(activityTime, GRAPH_TIME_ZONE, 'yyyy-MM-dd');
      const targetFileIds = new Set();

      (activity.targets || []).forEach((target) => {
        const item = target.driveItem;
        if (!item || !item.name || item.driveFolder) return;
        const fileId = item.name.replace(/^items\//, '');
        if (!fileId || targetFileIds.has(fileId)) return;
        targetFileIds.add(fileId);

        const eventKey = [
          activityTime.toISOString(),
          fileId,
          uniqueActorIds.slice().sort().join(','),
        ].join('|');
        if (seenEvents.has(eventKey)) return;
        seenEvents.add(eventKey);

        if (!stats[fileId]) {
          stats[fileId] = {
            fileId,
            title: item.title || '(無題)',
            editActivities: 0,
            activeDaySet: new Set(),
            actorDayMap: {},
          };
        }

        const stat = stats[fileId];
        stat.editActivities += 1;
        stat.activeDaySet.add(dayKey);
        if (item.title) stat.title = item.title;

        uniqueActorIds.forEach((actorId) => {
          if (!stat.actorDayMap[actorId]) stat.actorDayMap[actorId] = new Set();
          stat.actorDayMap[actorId].add(dayKey);
        });
      });
    });

    pageToken = response.nextPageToken || null;
  } while (pageToken);
}

function canonicalGraphActorId_(actorId, runtime) {
  if (actorId !== 'people/me') return actorId;

  const ownEmail = normalizeGraphEmail_(Session.getActiveUser().getEmail());
  const ownUser = runtime.users.find((user) => ownEmail && user.email === ownEmail);
  return ownUser ? ownUser.actorId : actorId;
}

function getGraphActivityActorIds_(activity) {
  const ids = new Set();
  (activity.actors || []).forEach((actor) => {
    const knownUser = actor.user && actor.user.knownUser;
    if (knownUser && knownUser.personName) ids.add(knownUser.personName);
  });
  return Array.from(ids);
}

function getGraphActivityTime_(activity) {
  if (activity.timestamp) return new Date(activity.timestamp);
  if (activity.timeRange) {
    const value = activity.timeRange.endTime || activity.timeRange.startTime;
    if (value) return new Date(value);
  }
  return null;
}

function waitGraphActivitySlot_(limiter) {
  while (true) {
    const now = Date.now();
    limiter.timestamps = limiter.timestamps.filter((time) => now - time < limiter.windowMs);
    if (limiter.timestamps.length < limiter.limit) {
      limiter.timestamps.push(now);
      return;
    }
    const waitMs = Math.max(1000, limiter.windowMs - (now - limiter.timestamps[0]) + 300);
    Utilities.sleep(waitMs);
  }
}

function queryGraphDriveActivityWithBackoff_(request, limiter) {
  const maxRetries = 4;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return DriveActivity.Activity.query(request);
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      const retryable = /429|RESOURCE_EXHAUSTED|RATE_LIMIT|500|502|503|504/i.test(message);
      if (!retryable || attempt >= maxRetries) throw error;

      const waitMs = Math.min(
        30000,
        Math.pow(2, attempt) * 1800 + Math.floor(Math.random() * 800)
      );
      Utilities.sleep(waitMs);
      waitGraphActivitySlot_(limiter);
    }
  }
}
