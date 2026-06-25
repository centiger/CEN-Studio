/* CEN Studio v0.1 - BibleMaps QA Checker
   원칙: 사람은 판단하고, 프로그램은 반복한다.
*/

const state = {
  places: null,
  maps: null,
  links: null,
  runtime: null,
  reports: null,
};

const fileInputs = [
  ["placesFile", "placesName", "places"],
  ["mapsFile", "mapsName", "maps"],
  ["linksFile", "linksName", "links"],
  ["runtimeFile", "runtimeName", "runtime"],
];

fileInputs.forEach(([inputId, labelId, key]) => {
  document.getElementById(inputId).addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    document.getElementById(labelId).textContent = file.name;
    try {
      state[key] = await readJsonFile(file);
      toastReport(`${file.name} 로드 성공`);
    } catch (error) {
      state[key] = null;
      toastReport(`JSON 로드 실패: ${file.name}\n${error.message}`);
    }
  });
});

document.getElementById("runBtn").addEventListener("click", runQA);
document.getElementById("clearBtn").addEventListener("click", () => location.reload());

document.getElementById("downloadQa").addEventListener("click", () => downloadJson("qa-report.json", state.reports?.qaReport));
document.getElementById("downloadMissing").addEventListener("click", () => downloadJson("missing-report.json", state.reports?.missingReport));
document.getElementById("downloadStats").addEventListener("click", () => downloadJson("statistics.json", state.reports?.statistics));
document.getElementById("downloadRelease").addEventListener("click", () => downloadJson("release-check.json", state.reports?.releaseCheck));

function readJsonFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try { resolve(JSON.parse(reader.result)); }
      catch (e) { reject(e); }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file, "utf-8");
  });
}

function runQA() {
  const qa = createQaCollector();

  const placesArr = normalizeArray(state.places);
  const mapsArr = normalizeArray(state.maps);
  const linksArr = normalizeArray(state.links);
  const runtimeArr = normalizeArray(state.runtime);

  checkFileLoaded(qa, "places-master", state.places, placesArr);
  checkFileLoaded(qa, "maps-master", state.maps, mapsArr);
  checkFileLoaded(qa, "place-map-links-master", state.links, linksArr);
  checkFileLoaded(qa, "place-map-links.runtime", state.runtime, runtimeArr, false);

  const placeIds = new Set();
  const mapIds = new Set();

  checkPlaces(qa, placesArr, placeIds);
  checkMaps(qa, mapsArr, mapIds);
  checkLinks(qa, linksArr, placeIds, mapIds);
  checkRuntime(qa, runtimeArr, linksArr, placeIds, mapIds);

  const missingReport = buildMissingReport(placesArr, mapsArr, linksArr, placeIds, mapIds);
  const statistics = buildStatistics(placesArr, mapsArr, linksArr, runtimeArr, qa);
  const releaseCheck = buildReleaseCheck(qa, statistics);

  const qaReport = {
    generated_at: new Date().toISOString(),
    app: "CEN Studio",
    version: "0.1",
    summary: qa.summary,
    issues: qa.issues,
  };

  state.reports = { qaReport, missingReport, statistics, releaseCheck };
  renderResults(qaReport, missingReport, statistics, releaseCheck);
}

function createQaCollector() {
  return {
    summary: { errors: 0, warnings: 0, info: 0 },
    issues: [],
    add(level, area, code, message, item = null) {
      if (level === "error") this.summary.errors++;
      else if (level === "warning") this.summary.warnings++;
      else this.summary.info++;
      this.issues.push({ level, area, code, message, item });
    }
  };
}

function normalizeArray(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.places)) return data.places;
  if (Array.isArray(data.maps)) return data.maps;
  if (Array.isArray(data.links)) return data.links;
  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(data.data)) return data.data;
  return [];
}

function checkFileLoaded(qa, label, raw, arr, required = true) {
  if (!raw) {
    qa.add(required ? "error" : "warning", "File Loader", "FILE_NOT_LOADED", `${label} 파일이 로드되지 않았습니다.`);
    return;
  }
  if (!Array.isArray(arr) || arr.length === 0) {
    qa.add(required ? "error" : "warning", "File Loader", "EMPTY_OR_UNKNOWN_STRUCTURE", `${label} 배열을 찾지 못했거나 비어 있습니다.`);
  }
}

function checkPlaces(qa, places, placeIds) {
  const names = new Map();
  const aliases = new Map();

  places.forEach((p, idx) => {
    const id = p.id || p.place_id;
    const name = p.canonical_name || p.name || p.title;

    if (!id) qa.add("error", "Places", "PLACE_ID_MISSING", "Place id가 없습니다.", { index: idx, item: p });
    else {
      if (placeIds.has(id)) qa.add("error", "Places", "PLACE_ID_DUPLICATE", `Place id 중복: ${id}`, p);
      placeIds.add(id);
      if (!/^P\d{3,5}$/.test(String(id))) qa.add("warning", "Places", "PLACE_ID_FORMAT", `Place id 형식 확인 필요: ${id}`, p);
    }

    if (!name) qa.add("warning", "Places", "PLACE_NAME_MISSING", `Place 이름이 없습니다: ${id || idx}`, p);
    else {
      if (names.has(name)) qa.add("warning", "Places", "PLACE_NAME_DUPLICATE", `Place 이름 중복 가능성: ${name}`, [names.get(name), p]);
      names.set(name, p);
    }

    const aliasList = Array.isArray(p.aliases) ? p.aliases : [];
    aliasList.forEach(alias => {
      if (!alias) return;
      if (aliases.has(alias)) qa.add("warning", "Places", "ALIAS_DUPLICATE", `alias 중복 가능성: ${alias}`, { first: aliases.get(alias), current: id });
      aliases.set(alias, id);
    });
  });
}

function checkMaps(qa, maps, mapIds) {
  const urls = new Map();

  maps.forEach((m, idx) => {
    const id = m.id || m.map_id;
    const title = m.title || m.name;
    const url = m.url || m.href || m.link;

    if (!id) qa.add("error", "Maps", "MAP_ID_MISSING", "map_id가 없습니다.", { index: idx, item: m });
    else {
      if (mapIds.has(id)) qa.add("error", "Maps", "MAP_ID_DUPLICATE", `map_id 중복: ${id}`, m);
      mapIds.add(id);
      if (!/^M\d{3,5}$|^[a-zA-Z0-9_-]+$/.test(String(id))) qa.add("warning", "Maps", "MAP_ID_FORMAT", `map_id 형식 확인 필요: ${id}`, m);
    }

    if (!title) qa.add("warning", "Maps", "MAP_TITLE_MISSING", `지도 제목이 없습니다: ${id || idx}`, m);

    if (!url) qa.add("error", "Maps", "MAP_URL_MISSING", `지도 URL이 없습니다: ${id || idx}`, m);
    else {
      if (!isValidHttpUrl(url)) qa.add("error", "Maps", "MAP_URL_INVALID", `URL 형식 오류: ${url}`, m);
      if (urls.has(url)) qa.add("warning", "Maps", "MAP_URL_DUPLICATE", `지도 URL 중복 가능성: ${url}`, [urls.get(url), m]);
      urls.set(url, m);
    }
  });
}

function checkLinks(qa, links, placeIds, mapIds) {
  const validRelations = new Set([
    "direct", "regional_representative", "era_representative",
    "Direct Map", "Regional Representative Map", "Era Representative Map",
    "직접지도", "지역대표지도", "시대대표지도"
  ]);
  const pairSet = new Set();

  links.forEach((l, idx) => {
    const placeId = l.place_id || l.placeId;
    const mapId = l.map_id || l.mapId;
    const relation = l.relation_type || l.relation || l.type || l.relationship;

    if (!placeId) qa.add("error", "Links", "LINK_PLACE_ID_MISSING", "link에 place_id가 없습니다.", { index: idx, item: l });
    else if (!placeIds.has(placeId)) qa.add("error", "Links", "LINK_PLACE_ID_NOT_FOUND", `존재하지 않는 place_id: ${placeId}`, l);

    if (!mapId) qa.add("error", "Links", "LINK_MAP_ID_MISSING", "link에 map_id가 없습니다.", { index: idx, item: l });
    else if (!mapIds.has(mapId)) qa.add("error", "Links", "LINK_MAP_ID_NOT_FOUND", `존재하지 않는 map_id: ${mapId}`, l);

    if (!relation) qa.add("warning", "Links", "RELATION_TYPE_MISSING", `relation_type이 없습니다: ${placeId || "?"} → ${mapId || "?"}`, l);
    else if (!validRelations.has(relation)) qa.add("warning", "Links", "RELATION_TYPE_UNKNOWN", `알 수 없는 relation_type: ${relation}`, l);

    const key = `${placeId}::${mapId}::${relation}`;
    if (pairSet.has(key)) qa.add("warning", "Links", "LINK_DUPLICATE", `중복 link 가능성: ${key}`, l);
    pairSet.add(key);
  });
}

function checkRuntime(qa, runtime, links, placeIds, mapIds) {
  if (!runtime.length) return;

  runtime.forEach((r, idx) => {
    const placeId = r.place_id || r.placeId;
    const mapId = r.map_id || r.mapId;

    if (placeId && !placeIds.has(placeId)) qa.add("error", "Runtime", "RUNTIME_PLACE_ID_NOT_FOUND", `runtime의 place_id가 master에 없습니다: ${placeId}`, r);
    if (mapId && !mapIds.has(mapId)) qa.add("error", "Runtime", "RUNTIME_MAP_ID_NOT_FOUND", `runtime의 map_id가 master에 없습니다: ${mapId}`, r);

    if (!placeId && !r.maps && !r.map_refs) qa.add("warning", "Runtime", "RUNTIME_UNKNOWN_STRUCTURE", `runtime 구조 확인 필요: index ${idx}`, r);
  });

  if (runtime.length && links.length && runtime.length !== links.length) {
    qa.add("warning", "Runtime", "RUNTIME_LINK_COUNT_DIFFERENT", `runtime(${runtime.length})과 links master(${links.length}) 개수가 다릅니다. 구조상 정상일 수도 있습니다.`);
  }
}

function buildMissingReport(places, maps, links) {
  const linkedPlaceIds = new Set(links.map(l => l.place_id || l.placeId).filter(Boolean));
  const usedMapIds = new Set(links.map(l => l.map_id || l.mapId).filter(Boolean));

  const placesWithoutLinks = places
    .map(p => ({ id: p.id || p.place_id, name: p.canonical_name || p.name || p.title }))
    .filter(p => p.id && !linkedPlaceIds.has(p.id));

  const unusedMaps = maps
    .map(m => ({ id: m.id || m.map_id, title: m.title || m.name, url: m.url || m.href || m.link }))
    .filter(m => m.id && !usedMapIds.has(m.id));

  return {
    generated_at: new Date().toISOString(),
    places_without_links: placesWithoutLinks,
    unused_maps: unusedMaps,
    counts: {
      places_without_links: placesWithoutLinks.length,
      unused_maps: unusedMaps.length,
    }
  };
}

function buildStatistics(places, maps, links, runtime, qa) {
  const relationCounts = {};
  links.forEach(l => {
    const rel = l.relation_type || l.relation || l.type || l.relationship || "unknown";
    relationCounts[rel] = (relationCounts[rel] || 0) + 1;
  });

  return {
    generated_at: new Date().toISOString(),
    counts: {
      places: places.length,
      maps: maps.length,
      links: links.length,
      runtime: runtime.length,
      errors: qa.summary.errors,
      warnings: qa.summary.warnings,
      info: qa.summary.info,
    },
    relation_counts: relationCounts,
  };
}

function buildReleaseCheck(qa, statistics) {
  const releaseReady = qa.summary.errors === 0;
  return {
    generated_at: new Date().toISOString(),
    release_ready: releaseReady,
    status: releaseReady ? "YES" : "NO",
    reason: releaseReady ? "치명 오류 없음" : "error 항목 수정 필요",
    errors: qa.summary.errors,
    warnings: qa.summary.warnings,
    statistics,
  };
}

function renderResults(qaReport, missingReport, statistics, releaseCheck) {
  const summary = document.getElementById("summary");
  const ready = releaseCheck.release_ready;
  summary.className = `summary ${ready ? (qaReport.summary.warnings ? "warn" : "ok") : "fail"}`;
  summary.innerHTML = `
    Release Ready: <strong>${releaseCheck.status}</strong><br>
    Places: ${statistics.counts.places} / Maps: ${statistics.counts.maps} / Links: ${statistics.counts.links} / Runtime: ${statistics.counts.runtime}<br>
    Errors: ${qaReport.summary.errors} / Warnings: ${qaReport.summary.warnings}<br>
    링크 없는 Place: ${missingReport.counts.places_without_links} / 사용 안 된 Map: ${missingReport.counts.unused_maps}
  `;

  document.getElementById("reportBox").textContent = JSON.stringify({ qaReport, missingReport, statistics, releaseCheck }, null, 2);
  ["downloadQa", "downloadMissing", "downloadStats", "downloadRelease"].forEach(id => {
    document.getElementById(id).disabled = false;
  });
}

function toastReport(text) {
  document.getElementById("reportBox").textContent = text;
}

function downloadJson(filename, data) {
  if (!data) return;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function isValidHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
