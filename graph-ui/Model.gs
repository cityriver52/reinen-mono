/**
 * ファイル共起グラフを生成する。
 * ノード = Driveファイル / エッジ = 同じactorが7日以内に編集した関係。
 */
function buildGraphModel_(stats, runtime) {
  const statValues = Object.values(stats || {});
  const candidatePairs = discoverGraphCandidatePairs_(statValues);
  const edges = [];

  candidatePairs.forEach((pairKey) => {
    const parts = pairKey.split('|');
    const statA = stats[parts[0]];
    const statB = stats[parts[1]];
    if (!statA || !statB) return;

    const metric = calculateGraphPairMetric_(statA, statB, runtime);
    if (!metric) return;
    if (metric.matchedPairs < GRAPH_SETTINGS.minMatches) return;
    if (metric.score < GRAPH_SETTINGS.minScore) return;

    edges.push({
      id: pairKey,
      source: statA.fileId,
      target: statB.fileId,
      score: roundGraph_(metric.score, 5),
      jaccard: roundGraph_(metric.weightedJaccard, 5),
      lift: roundGraph_(metric.lift, 3),
      matches: metric.matchedPairs,
      averageGapDays: roundGraph_(metric.averageGapDays, 1),
    });
  });

  edges.sort((a, b) => b.score - a.score || b.matches - a.matches);
  let selectedEdges = edges.slice(0, GRAPH_SETTINGS.maxEdges);

  const strength = new Map();
  selectedEdges.forEach((edge) => {
    strength.set(edge.source, (strength.get(edge.source) || 0) + edge.score);
    strength.set(edge.target, (strength.get(edge.target) || 0) + edge.score);
  });

  let nodeIds = Array.from(strength.keys());
  if (nodeIds.length > GRAPH_SETTINGS.maxNodes) {
    nodeIds.sort((a, b) =>
      (strength.get(b) || 0) - (strength.get(a) || 0) ||
      (stats[b].activeDaySet.size || 0) - (stats[a].activeDaySet.size || 0)
    );
    nodeIds = nodeIds.slice(0, GRAPH_SETTINGS.maxNodes);
    const keep = new Set(nodeIds);
    selectedEdges = selectedEdges.filter((edge) => keep.has(edge.source) && keep.has(edge.target));
  }

  // 最終エッジでdegree/strengthを再計算する。
  const degree = new Map();
  const finalStrength = new Map();
  selectedEdges.forEach((edge) => {
    degree.set(edge.source, (degree.get(edge.source) || 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) || 0) + 1);
    finalStrength.set(edge.source, (finalStrength.get(edge.source) || 0) + edge.score);
    finalStrength.set(edge.target, (finalStrength.get(edge.target) || 0) + edge.score);
  });

  const finalNodeIds = Array.from(new Set(selectedEdges.flatMap((edge) => [edge.source, edge.target])));
  const groups = detectGraphCommunities_(finalNodeIds, selectedEdges);

  const nodes = finalNodeIds.map((fileId) => {
    const stat = stats[fileId];
    return {
      id: fileId,
      label: stat.title || '(無題)',
      url: `https://drive.google.com/open?id=${encodeURIComponent(fileId)}`,
      activeDays: stat.activeDaySet.size,
      editActivities: stat.editActivities,
      degree: degree.get(fileId) || 0,
      strength: roundGraph_(finalStrength.get(fileId) || 0, 4),
      group: groups[fileId] || 0,
    };
  });

  nodes.sort((a, b) => b.strength - a.strength || b.degree - a.degree);

  return {
    generatedAt: new Date().toISOString(),
    fiscalYear: runtime.fiscalYear,
    comparisonStart: runtime.comparisonStart.toISOString(),
    comparisonEndExclusive: runtime.comparisonEnd.toISOString(),
    windowDays: GRAPH_SETTINGS.cooccurrenceWindowDays,
    nodeCount: nodes.length,
    edgeCount: selectedEdges.length,
    nodes,
    edges: selectedEdges,
  };
}

function discoverGraphCandidatePairs_(stats) {
  const actorEvents = {};

  stats.forEach((stat) => {
    Object.keys(stat.actorDayMap || {}).forEach((actorId) => {
      if (!actorEvents[actorId]) actorEvents[actorId] = [];
      Array.from(stat.actorDayMap[actorId]).forEach((dayKey) => {
        actorEvents[actorId].push({
          fileId: stat.fileId,
          day: graphDateKeyToDayNumber_(dayKey),
        });
      });
    });
  });

  const pairs = new Set();
  const windowDays = GRAPH_SETTINGS.cooccurrenceWindowDays;

  Object.values(actorEvents).forEach((events) => {
    events.sort((a, b) => a.day - b.day || a.fileId.localeCompare(b.fileId));
    let left = 0;
    for (let right = 0; right < events.length; right += 1) {
      while (events[right].day - events[left].day > windowDays) left += 1;
      for (let i = left; i < right; i += 1) {
        if (events[i].fileId === events[right].fileId) continue;
        const pair = [events[i].fileId, events[right].fileId].sort().join('|');
        pairs.add(pair);
      }
    }
  });

  return pairs;
}

function calculateGraphPairMetric_(statA, statB, runtime) {
  const mapA = getGraphNumericActorDays_(statA);
  const mapB = getGraphNumericActorDays_(statB);
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

  const fiscalStart = graphDateToDayNumber_(runtime.comparisonStart);
  const fiscalEnd = graphDateToDayNumber_(runtime.comparisonEnd);
  const fiscalDays = Math.max(fiscalEnd - fiscalStart, 1);
  const windowDays = GRAPH_SETTINGS.cooccurrenceWindowDays;

  sharedActors.forEach((actorId) => {
    const daysA = mapA[actorId];
    const daysB = mapB[actorId];
    if (!daysA.length || !daysB.length) return;

    supportA += daysA.length;
    supportB += daysB.length;

    const matches = greedyGraphDayPairs_(daysA, daysB, windowDays);
    matches.forEach((match) => {
      matchedPairs += 1;
      gapSum += match.gapDays;
      weightedMatches += graphTemporalWeight_(match.gapDays);
    });

    const actorHitsA = countGraphDaysWithNeighbor_(daysA, daysB, windowDays);
    const actorHitsB = countGraphDaysWithNeighbor_(daysB, daysA, windowDays);
    hitsA += actorHitsA;
    hitsB += actorHitsB;

    const coverageB = graphExpandedCoverage_(daysB, windowDays, fiscalStart, fiscalEnd);
    const coverageA = graphExpandedCoverage_(daysA, windowDays, fiscalStart, fiscalEnd);
    expectedHitsA += daysA.length * (coverageB / fiscalDays);
    expectedHitsB += daysB.length * (coverageA / fiscalDays);
  });

  if (!supportA || !supportB || !matchedPairs) return null;

  const weightedUnion = supportA + supportB - weightedMatches;
  const weightedJaccard = weightedUnion > 0 ? weightedMatches / weightedUnion : 0;
  const coverageAtoB = hitsA / supportA;
  const coverageBtoA = hitsB / supportB;
  const expectedRateA = expectedHitsA / supportA;
  const expectedRateB = expectedHitsB / supportB;
  const liftAtoB = expectedRateA > 0 ? coverageAtoB / expectedRateA : 1;
  const liftBtoA = expectedRateB > 0 ? coverageBtoA / expectedRateB : 1;
  const lift = Math.sqrt(Math.max(liftAtoB, 0) * Math.max(liftBtoA, 0));
  const score = weightedJaccard * Math.min(Math.max(lift, 0), 3);

  return {
    score,
    weightedJaccard,
    lift,
    matchedPairs,
    averageGapDays: gapSum / matchedPairs,
  };
}

function getGraphNumericActorDays_(stat) {
  if (stat._numericActorDays) return stat._numericActorDays;
  const result = {};
  Object.keys(stat.actorDayMap || {}).forEach((actorId) => {
    result[actorId] = Array.from(stat.actorDayMap[actorId] || [])
      .map(graphDateKeyToDayNumber_)
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
  });
  stat._numericActorDays = result;
  return result;
}

function greedyGraphDayPairs_(daysA, daysB, windowDays) {
  const result = [];
  let i = 0;
  let j = 0;
  while (i < daysA.length && j < daysB.length) {
    const diff = daysB[j] - daysA[i];
    if (Math.abs(diff) <= windowDays) {
      result.push({ gapDays: Math.abs(diff) });
      i += 1;
      j += 1;
    } else if (diff < -windowDays) {
      j += 1;
    } else {
      i += 1;
    }
  }
  return result;
}

function countGraphDaysWithNeighbor_(sourceDays, targetDays, windowDays) {
  let hits = 0;
  let j = 0;
  sourceDays.forEach((day) => {
    while (j < targetDays.length && targetDays[j] < day - windowDays) j += 1;
    if (j < targetDays.length && Math.abs(targetDays[j] - day) <= windowDays) hits += 1;
  });
  return hits;
}

function graphExpandedCoverage_(days, windowDays, startDay, endDayExclusive) {
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

function graphTemporalWeight_(gapDays) {
  return Math.pow(0.5, gapDays / GRAPH_SETTINGS.cooccurrenceHalfLifeDays);
}

function detectGraphCommunities_(nodeIds, edges) {
  const labels = {};
  const adjacency = {};
  nodeIds.forEach((id) => {
    labels[id] = id;
    adjacency[id] = [];
  });
  edges.forEach((edge) => {
    if (!adjacency[edge.source] || !adjacency[edge.target]) return;
    adjacency[edge.source].push({ id: edge.target, weight: edge.score });
    adjacency[edge.target].push({ id: edge.source, weight: edge.score });
  });

  const ordered = nodeIds.slice().sort((a, b) => adjacency[b].length - adjacency[a].length);
  for (let iteration = 0; iteration < 10; iteration += 1) {
    let changed = 0;
    ordered.forEach((id) => {
      const weights = {};
      adjacency[id].forEach((neighbor) => {
        const label = labels[neighbor.id];
        weights[label] = (weights[label] || 0) + neighbor.weight;
      });
      const candidates = Object.keys(weights).sort((a, b) =>
        weights[b] - weights[a] || String(a).localeCompare(String(b))
      );
      if (candidates.length && candidates[0] !== labels[id]) {
        labels[id] = candidates[0];
        changed += 1;
      }
    });
    if (!changed) break;
  }

  const compact = {};
  let next = 0;
  const result = {};
  nodeIds.forEach((id) => {
    const label = labels[id];
    if (!Object.prototype.hasOwnProperty.call(compact, label)) compact[label] = next++;
    result[id] = compact[label];
  });
  return result;
}

function graphDateKeyToDayNumber_(dayKey) {
  return Math.floor(new Date(`${dayKey}T00:00:00Z`).getTime() / 86400000);
}

function graphDateToDayNumber_(date) {
  return graphDateKeyToDayNumber_(Utilities.formatDate(date, GRAPH_TIME_ZONE, 'yyyy-MM-dd'));
}

function roundGraph_(value, digits) {
  const scale = Math.pow(10, digits || 0);
  return Math.round(Number(value || 0) * scale) / scale;
}
