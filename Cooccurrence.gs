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

    // 単一ユーザー運用で people/me が返る場合は、実Actor IDと同一人物としてまとめる。
    // 複数ユーザー時は誤帰属を避けるため people/me のまま保持する。
    let actorKey = actorId;
    if (actorId === 'people/me' && allowedActorIds.has('people/me')) {
      const canonicalIds = Array.from(allowedActorIds).filter((id) => id !== 'people/me');
      if (canonicalIds.length === 1) actorKey = canonicalIds[0];
    }

    if (!stat.actorActivityDayMap[actorKey]) {
      stat.actorActivityDayMap[actorKey] = new Set();
    }
    stat.actorActivityDayMap[actorKey].add(dayKey);
  });
}

function attachCooccurrenceRelations_(recommendations, seasonalityStats, windows) {
  const items = recommendations || [];
  if (items.length === 0) return items;

  // 関連先は最終推薦だけに限定しない。
  // 季節ウィンドウで最低活動量を満たして年度履歴まで取得済みの候補全体と比較する。
  const candidateStats = Object.values(seasonalityStats || {});
  const metricCache = new Map();

  return items.map((item) => {
    const statA = seasonalityStats[item.fileId];
    const relatedFiles = [];

    if (statA) {
      candidateStats.forEach((statB) => {
        if (!statB || statB.fileId === item.fileId) return;

        const cacheKey = [item.fileId, statB.fileId].sort().join('|');
        let cached = metricCache.get(cacheKey);
        if (!cached) {
          const firstId = item.fileId < statB.fileId ? item.fileId : statB.fileId;
          const firstStat = seasonalityStats[firstId];
          const secondStat = firstId === item.fileId ? statB : statA;
          cached = {
            firstId,
            metric: calculateCooccurrenceMetric_(firstStat, secondStat, windows),
          };
          metricCache.set(cacheKey, cached);
        }

        const metric = cached.metric;
        if (!metric) return;
        if (metric.matchedPairs < REINEN_COOCCURRENCE_MIN_MATCHES) return;
        if (metric.score < REINEN_COOCCURRENCE_MIN_SCORE) return;

        const itemIsFirst = cached.firstId === item.fileId;
        relatedFiles.push({
          fileId: statB.fileId,
          title: statB.title || '(無題)',
          url: `https://drive.google.com/open?id=${encodeURIComponent(statB.fileId)}`,
          score: metric.score,
          weightedJaccard: metric.weightedJaccard,
          lift: metric.lift,
          matchedPairs: metric.matchedPairs,
          averageGapDays: metric.averageGapDays,
          directionalCoverage: itemIsFirst
            ? metric.coverageAtoB
            : metric.coverageBtoA,
        });
      });
    }

    relatedFiles.sort((a, b) =>
      b.score - a.score ||
      b.matchedPairs - a.matchedPairs ||
      a.averageGapDays - b.averageGapDays
    );
    const topRelated = relatedFiles.slice(0, REINEN_COOCCURRENCE_MAX_RELATED);
    const top = topRelated[0] || null;

    return {
      ...item,
      relatedFiles: topRelated,
      relatedFileSummary: formatRelatedFileSummary_(topRelated),
      cooccurrenceScore: top ? top.score : 0,
      cooccurrenceMatches: top ? top.matchedPairs : 0,
      cooccurrenceLift: top ? top.lift : 0,
      cooccurrenceAverageGapDays: top ? top.averageGapDays : null,
    };
  });
}

function calculateCooccurrenceMetric_(statA, statB, windows) {
  const mapA = getCooccurrenceDayNumberMap_(statA);
  const mapB = getCooccurrenceDayNumberMap_(statB);
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
    const daysA = mapA[actorId];
    const daysB = mapB[actorId];
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

  // Lift < 1 は通年・高頻度ファイルの偶然の近接を抑制する。
  // Lift > 3 は暴れやすいため上限を設け、Jaccardを主役にする。
  const score = weightedJaccard * Math.min(Math.max(lift, 0), 3);

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

function getCooccurrenceDayNumberMap_(stat) {
  if (stat._cooccurrenceDayNumberMap) return stat._cooccurrenceDayNumberMap;

  const result = {};
  const source = stat.actorActivityDayMap || {};
  Object.keys(source).forEach((actorId) => {
    result[actorId] = Array.from(source[actorId] || [])
      .map((dayKey) => dateKeyToDayNumber_(dayKey))
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => a - b);
  });
  stat._cooccurrenceDayNumberMap = result;
  return result;
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
  if (!days || days.length === 0) return 0;

  let total = 0;
  let currentStart = null;
  let currentEnd = null;

  days.forEach((day) => {
    const from = Math.max(startDay, day - windowDays);
    const to = Math.min(endDayExclusive - 1, day + windowDays);
    if (from > to) return;

    if (currentStart === null) {
      currentStart = from;
      currentEnd = to;
      return;
    }

    if (from <= currentEnd + 1) {
      currentEnd = Math.max(currentEnd, to);
      return;
    }

    total += currentEnd - currentStart + 1;
    currentStart = from;
    currentEnd = to;
  });

  if (currentStart !== null) total += currentEnd - currentStart + 1;
  return total;
}

function temporalWeight_(gapDays) {
  return Math.pow(0.5, gapDays / REINEN_COOCCURRENCE_HALF_LIFE_DAYS);
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
