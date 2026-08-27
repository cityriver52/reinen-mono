/**
 * Re:年モノ - co-occurrence / 「一緒に使う」
 *
 * 同じ対象ユーザーが同一年度内で近い日に編集したファイル同士を関連付ける。
 * 季節性スコアそのものは変更せず、候補ファイルへ explainable な関連情報を付加する。
 *
 * 設計:
 * - 近接窓: 7日以内
 * - 時間減衰: 半減期3日
 * - 正規化: 時間重み付き Jaccard
 * - 通年ファイル対策: 「近くにBがある」基礎確率に対する Lift で補正
 * - 最低2回の近接がある関係だけ採用
 */
const REINEN_COOCCURRENCE_WINDOW_DAYS = 7;
const REINEN_COOCCURRENCE_HALF_LIFE_DAYS = 3;
const REINEN_COOCCURRENCE_MIN_MATCHES = 2;
const REINEN_COOCCURRENCE_MIN_SCORE = 0.08;
const REINEN_COOCCURRENCE_MAX_RELATED = 3;

function recordCooccurrenceActivity_(stat, actorIds, allowedActorIds, dayKey) {
  if (!stat || !dayKey) return;
  if (!stat.actorActivityDayMap) stat.actorActivityDayMap = {};

  (actorIds || []).forEach((actorId) => {
    if (!allowedActorIds.has(actorId)) return;
    if (!stat.actorActivityDayMap[actorId]) {
      stat.actorActivityDayMap[actorId] = new Set();
    }
    stat.actorActivityDayMap[actorId].add(dayKey);
  });
}

function attachCooccurrenceRelations_(recommendations, seasonalityStats, windows) {
  const items = recommendations || [];
  if (items.length === 0) return items;

  const relationsByFileId = new Map();
  items.forEach((item) => relationsByFileId.set(item.fileId, []));

  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i];
      const b = items[j];
      const statA = seasonalityStats[a.fileId];
      const statB = seasonalityStats[b.fileId];
      if (!statA || !statB) continue;

      const metric = calculateCooccurrenceMetric_(statA, statB, windows);
      if (!metric) continue;
      if (metric.matchedPairs < REINEN_COOCCURRENCE_MIN_MATCHES) continue;
      if (metric.score < REINEN_COOCCURRENCE_MIN_SCORE) continue;

      relationsByFileId.get(a.fileId).push({
        fileId: b.fileId,
        title: b.title,
        url: b.url,
        score: metric.score,
        weightedJaccard: metric.weightedJaccard,
        lift: metric.lift,
        matchedPairs: metric.matchedPairs,
        averageGapDays: metric.averageGapDays,
        directionalCoverage: metric.coverageAtoB,
      });

      relationsByFileId.get(b.fileId).push({
        fileId: a.fileId,
        title: a.title,
        url: a.url,
        score: metric.score,
        weightedJaccard: metric.weightedJaccard,
        lift: metric.lift,
        matchedPairs: metric.matchedPairs,
        averageGapDays: metric.averageGapDays,
        directionalCoverage: metric.coverageBtoA,
      });
    }
  }

  return items.map((item) => {
    const relatedFiles = (relationsByFileId.get(item.fileId) || [])
      .sort((a, b) =>
        b.score - a.score ||
        b.matchedPairs - a.matchedPairs ||
        a.averageGapDays - b.averageGapDays
      )
      .slice(0, REINEN_COOCCURRENCE_MAX_RELATED);

    const top = relatedFiles[0] || null;
    return {
      ...item,
      relatedFiles,
      relatedFileSummary: formatRelatedFileSummary_(relatedFiles),
      cooccurrenceScore: top ? top.score : 0,
      cooccurrenceMatches: top ? top.matchedPairs : 0,
      cooccurrenceLift: top ? top.lift : 0,
      cooccurrenceAverageGapDays: top ? top.averageGapDays : null,
    };
  });
}

function calculateCooccurrenceMetric_(statA, statB, windows) {
  const mapA = statA.actorActivityDayMap || {};
  const mapB = statB.actorActivityDayMap || {};
  const sharedActors = Object.keys(mapA).filter((actorId) => mapB[actorId]);
  if (sharedActors.length === 0) return null;

  let supportA = 0;
  let supportB = 0;
  let matchedPairs = 0;
  let weightedMatches = 0;
  let gapSum = 0;
  let hitsA = 0;
  let hitsB = 0;
  let expectedHitsA = 0;
  let expectedHitsB = 0;

  const fiscalDays = Math.max(
    calendarDaySpan_(windows.comparisonStart, windows.comparisonEnd),
    1
  );
  const fiscalStartDay = dateToDayNumber_(windows.comparisonStart);
  const fiscalEndDayExclusive = dateToDayNumber_(windows.comparisonEnd);

  sharedActors.forEach((actorId) => {
    const daysA = setToSortedDayNumbers_(mapA[actorId]);
    const daysB = setToSortedDayNumbers_(mapB[actorId]);
    if (daysA.length === 0 || daysB.length === 0) return;

    supportA += daysA.length;
    supportB += daysB.length;

    const pairs = greedyNearDayPairs_(
      daysA,
      daysB,
      REINEN_COOCCURRENCE_WINDOW_DAYS
    );
    pairs.forEach((pair) => {
      matchedPairs += 1;
      gapSum += pair.gapDays;
      weightedMatches += temporalWeight_(pair.gapDays);
    });

    const actorHitsA = countDaysWithNeighbor_(
      daysA,
      daysB,
      REINEN_COOCCURRENCE_WINDOW_DAYS
    );
    const actorHitsB = countDaysWithNeighbor_(
      daysB,
      daysA,
      REINEN_COOCCURRENCE_WINDOW_DAYS
    );
    hitsA += actorHitsA;
    hitsB += actorHitsB;

    const coverageB = expandedDayCoverage_(
      daysB,
      REINEN_COOCCURRENCE_WINDOW_DAYS,
      fiscalStartDay,
      fiscalEndDayExclusive
    );
    const coverageA = expandedDayCoverage_(
      daysA,
      REINEN_COOCCURRENCE_WINDOW_DAYS,
      fiscalStartDay,
      fiscalEndDayExclusive
    );

    expectedHitsA += daysA.length * (coverageB / fiscalDays);
    expectedHitsB += daysB.length * (coverageA / fiscalDays);
  });

  if (supportA === 0 || supportB === 0 || matchedPairs === 0) return null;

  const weightedUnion = supportA + supportB - weightedMatches;
  const weightedJaccard = weightedUnion > 0
    ? weightedMatches / weightedUnion
    : 0;

  const coverageAtoB = hitsA / supportA;
  const coverageBtoA = hitsB / supportB;
  const expectedRateA = expectedHitsA / supportA;
  const expectedRateB = expectedHitsB / supportB;
  const liftAtoB = expectedRateA > 0 ? coverageAtoB / expectedRateA : 1;
  const liftBtoA = expectedRateB > 0 ? coverageBtoA / expectedRateB : 1;
  const lift = Math.sqrt(Math.max(liftAtoB, 0) * Math.max(liftBtoA, 0));

  // Liftは暴れやすいので最大3倍まで。Jaccardを主役にして説明可能性を保つ。
  const score = weightedJaccard * Math.min(Math.max(lift, 1), 3);

  return {
    score,
    weightedJaccard,
    lift,
    matchedPairs,
    averageGapDays: gapSum / matchedPairs,
    coverageAtoB,
    coverageBtoA,
    sharedActors: sharedActors.length,
  };
}

function greedyNearDayPairs_(daysA, daysB, windowDays) {
  const pairs = [];
  let i = 0;
  let j = 0;

  while (i < daysA.length && j < daysB.length) {
    const diff = daysB[j] - daysA[i];
    if (Math.abs(diff) <= windowDays) {
      pairs.push({ gapDays: Math.abs(diff) });
      i += 1;
      j += 1;
    } else if (diff < -windowDays) {
      j += 1;
    } else {
      i += 1;
    }
  }
  return pairs;
}

function countDaysWithNeighbor_(sourceDays, targetDays, windowDays) {
  let hits = 0;
  let j = 0;

  sourceDays.forEach((sourceDay) => {
    while (j < targetDays.length && targetDays[j] < sourceDay - windowDays) {
      j += 1;
    }
    if (j < targetDays.length && Math.abs(targetDays[j] - sourceDay) <= windowDays) {
      hits += 1;
    }
  });
  return hits;
}

function expandedDayCoverage_(days, windowDays, startDay, endDayExclusive) {
  const covered = new Set();
  days.forEach((day) => {
    const from = Math.max(startDay, day - windowDays);
    const to = Math.min(endDayExclusive - 1, day + windowDays);
    for (let value = from; value <= to; value += 1) covered.add(value);
  });
  return covered.size;
}

function temporalWeight_(gapDays) {
  return Math.pow(0.5, gapDays / REINEN_COOCCURRENCE_HALF_LIFE_DAYS);
}

function setToSortedDayNumbers_(value) {
  return Array.from(value || [])
    .map((dayKey) => dateKeyToDayNumber_(dayKey))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
}

function dateKeyToDayNumber_(dayKey) {
  return Math.floor(new Date(`${dayKey}T00:00:00Z`).getTime() / 86400000);
}

function dateToDayNumber_(date) {
  const dayKey = Utilities.formatDate(date, REINEN_TIME_ZONE, 'yyyy-MM-dd');
  return dateKeyToDayNumber_(dayKey);
}

function formatRelatedFileSummary_(relatedFiles) {
  if (!relatedFiles || relatedFiles.length === 0) return '';
  return relatedFiles.map((item) => {
    const gap = Number(item.averageGapDays || 0);
    const gapText = gap < 0.5
      ? '同日中心'
      : `平均${Math.round(gap * 10) / 10}日差`;
    return `${item.title}（近接${item.matchedPairs}回・${gapText}）`;
  }).join('\n');
}
