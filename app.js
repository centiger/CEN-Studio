const BUILD_VERSION = 'v0.1.3';

const fileInputs = {
  places: document.getElementById('placesFile'),
  maps: document.getElementById('mapsFile'),
  links: document.getElementById('linksFile'),
  runtime: document.getElementById('runtimeFile'),
};
const fileNames = {
  places: document.getElementById('placesName'),
  maps: document.getElementById('mapsName'),
  links: document.getElementById('linksName'),
  runtime: document.getElementById('runtimeName'),
};
const state = { data:{}, reports:null };

Object.entries(fileInputs).forEach(([key,input])=>{
  input.addEventListener('change',()=>{
    fileNames[key].textContent = input.files?.[0]?.name || '미선택';
  });
});

document.getElementById('runBtn').addEventListener('click', runQA);

async function readJsonFile(input, label){
  const file = input.files?.[0];
  if(!file) return { ok:false, missing:true, label, data:null, error:`${label} 파일이 선택되지 않았습니다.` };
  try{
    const text = await file.text();
    return { ok:true, label, data:JSON.parse(text), filename:file.name };
  }catch(err){
    return { ok:false, missing:false, label, data:null, error:`${label} JSON 파싱 오류: ${err.message}` };
  }
}

function pickId(item, keys){
  for(const key of keys){
    if(item && item[key] !== undefined && item[key] !== null && String(item[key]).trim()) return String(item[key]).trim();
  }
  return '';
}
function normalizeRelation(value){
  return String(value || '').trim().toLowerCase().replace(/[\s-]+/g,'_');
}
function looksLikePlaceId(id){ return /^P\d+/i.test(String(id||'').trim()); }
function looksLikeMapId(id){ return /^M\d+/i.test(String(id||'').trim()); }
function isUrl(value){ return /^https?:\/\//i.test(String(value||'')); }

function getArray(data, preferredKeys=[]){
  if(Array.isArray(data)) return data;
  if(!data || typeof data !== 'object') return [];
  for(const key of preferredKeys){
    if(Array.isArray(data[key])) return data[key];
  }
  for(const key of ['places','maps','links','items','data','records','list']){
    if(Array.isArray(data[key])) return data[key];
  }
  return Object.entries(data)
    .filter(([key])=>!['version','generated_at','generatedAt','metadata','meta','schema','stats','statistics'].includes(key))
    .map(([key,value])=> value && typeof value === 'object' && !Array.isArray(value) ? { _key:key, ...value } : { _key:key, value });
}

function collectTextValues(item, keys){
  const out = [];
  for(const key of keys){
    const v = item?.[key];
    if(v === undefined || v === null) continue;
    if(Array.isArray(v)){
      v.forEach(x=>{ if(x !== undefined && x !== null && String(x).trim()) out.push(String(x).trim()); });
    }else if(typeof v === 'object'){
      Object.values(v).forEach(x=>{ if(typeof x === 'string' && x.trim()) out.push(x.trim()); });
    }else if(String(v).trim()){
      out.push(String(v).trim());
    }
  }
  return [...new Set(out)];
}

function normalizeName(value){
  return String(value || '').trim().replace(/\s+/g,' ');
}

function normalizePlaces(data){
  const arr = getArray(data, ['places']);
  return arr.map((p,idx)=>{
    const id = pickId(p, ['place_id','placeId','id','_key','pid']);
    const names = collectTextValues(p, [
      'canonical_name','canonicalName','name','title','ko_name','label','place',
      'biblical_name','modern_name','display_name','search_name',
      'aliases','alias','search_keywords','keywords','variants'
    ]).map(normalizeName).filter(Boolean);
    return { raw:p, index:idx, id, name:names[0] || '', names };
  }).filter(p=>p.id || p.name || p.names.length);
}

function normalizeMaps(data){
  const arr = getArray(data, ['maps']);
  return arr.map((m,idx)=>({
    raw:m,
    index:idx,
    id: pickId(m, ['map_id','mapId','id','_key','mid']),
    title: pickId(m, ['title','name','map_title','label']),
    url: pickId(m, ['url','href','link','official_url','map_url'])
  })).filter(m=>m.id || m.title || m.url);
}

function pushLink(out, item, index, contextPlaceId='', contextMapId=''){
  let placeId = contextPlaceId || '';
  let mapId = contextMapId || '';
  let relation = '';
  let url = '';

  if(typeof item === 'string'){
    if(looksLikePlaceId(item)) placeId = item;
    if(looksLikeMapId(item)) mapId = item;
  }else if(item && typeof item === 'object'){
    placeId = pickId(item, ['place_id','placeId','pid','source_place_id','target_place_id']) || placeId;
    const placeText = pickId(item, ['place','place_name','placeName','canonical_name','canonicalName','name','title']);
    if(!placeId && placeText) placeId = placeText;
    mapId = pickId(item, ['map_id','mapId','map','mid','id','target_map_id']) || mapId;
    if(!mapId && item._key && looksLikeMapId(item._key)) mapId = item._key;
    if(!placeId && item._key && looksLikePlaceId(item._key)) placeId = item._key;
    relation = normalizeRelation(pickId(item, ['relation_type','relationship','relation','type','map_relation','mapRelationship','relationship_type']));
    url = pickId(item, ['url','href','link','map_url','official_url']);
  }

  placeId = String(placeId||'').trim();
  mapId = String(mapId||'').trim();
  if(placeId || mapId || relation || url){
    out.push({ raw:item, index, placeId, mapId, relation, url });
  }
}

function normalizeLinks(data){
  const out = [];
  const seen = new Set();
  const add = (item, index, place='', map='')=>{
    const before = out.length;
    pushLink(out, item, index, place, map);
    if(out.length > before){
      const l = out[out.length-1];
      const key = `${l.index}|${l.placeId}|${l.mapId}|${l.relation}|${l.url}`;
      if(seen.has(key)) out.pop(); else seen.add(key);
    }
  };

  function walk(node, path='root', contextPlace='', contextMap=''){
    if(node == null) return;

    if(typeof node === 'string'){
      if(contextPlace && looksLikeMapId(node)) add(node, path, contextPlace, node);
      return;
    }

    if(Array.isArray(node)){
      node.forEach((v,i)=>walk(v, `${path}[${i}]`, contextPlace, contextMap));
      return;
    }

    if(typeof node !== 'object') return;

    const keyName = String(node._key || '').trim();
    let localPlace = pickId(node, ['place_id','placeId','pid','source_place_id']) || contextPlace;
    const localPlaceText = pickId(node, ['place','place_name','placeName','canonical_name','canonicalName','name','title']);
    if(!localPlace && localPlaceText) localPlace = localPlaceText;
    let localMap = pickId(node, ['map_id','mapId','map','mid','target_map_id']) || contextMap;
    if(!localPlace && looksLikePlaceId(keyName)) localPlace = keyName;
    if(!localMap && looksLikeMapId(keyName)) localMap = keyName;

    // 현재 객체 자체가 link 레코드인 경우
    if(localPlace || localMap || pickId(node, ['relation_type','relationship','relation','type','map_relation'])){
      add(node, path, localPlace, localMap);
    }

    // place 하나 아래에 maps 배열/객체가 들어있는 경우 우선 처리
    const mapContainers = ['maps','map_refs','mapRefs','map_ids','mapIds','external_map_refs','externalMapRefs','related_maps','relatedMaps','links','place_map_links','placeMapLinks'];
    for(const k of mapContainers){
      if(node[k] !== undefined){
        walk(node[k], `${path}.${k}`, localPlace, localMap);
      }
    }

    // 일반 객체 순회. metadata 계열은 스킵
    for(const [k,v] of Object.entries(node)){
      if(k === '_key' || mapContainers.includes(k)) continue;
      if(['version','generated_at','generatedAt','metadata','meta','schema','stats','statistics','description','note','notes'].includes(k)) continue;
      let nextPlace = localPlace;
      let nextMap = localMap;
      if(looksLikePlaceId(k)) nextPlace = k;
      if(looksLikeMapId(k)) nextMap = k;
      walk(v, `${path}.${k}`, nextPlace, nextMap);
    }
  }

  if(Array.isArray(data)) data.forEach((v,i)=>walk(v, `[${i}]`));
  else if(data && typeof data === 'object'){
    for(const [k,v] of Object.entries(data)){
      if(['version','generated_at','generatedAt','metadata','meta','schema','stats','statistics'].includes(k)) continue;
      walk(v, k, looksLikePlaceId(k) ? k : '', looksLikeMapId(k) ? k : '');
    }
  }
  return out.filter(l=>l.placeId || l.mapId);
}

async function runQA(){
  const loaded = await Promise.all([
    readJsonFile(fileInputs.places,'Places Master'),
    readJsonFile(fileInputs.maps,'Maps Master'),
    readJsonFile(fileInputs.links,'Place-Map Links Master'),
    readJsonFile(fileInputs.runtime,'Runtime Links'),
  ]);

  const errors = [];
  const warnings = [];
  loaded.forEach(r=>{ if(!r.ok) errors.push({type:'JSON_LOAD', message:r.error}); });

  const places = normalizePlaces(loaded[0].data);
  const maps = normalizeMaps(loaded[1].data);
  const links = normalizeLinks(loaded[2].data);
  const runtimeLinks = normalizeLinks(loaded[3].data);

  const placeIds = new Set();
  const mapIds = new Set();
  const usedPlaceIds = new Set();
  const usedMapIds = new Set();
  const duplicatePlaces = [];
  const duplicateMaps = [];
  const duplicateLinks = [];
  const relationStats = {};
  const linkKeys = new Set();

  const placeNames = new Set();
  const placeKeyToId = new Map();

  places.forEach(p=>{
    if(!p.id) warnings.push({type:'PLACE_ID_MISSING', index:p.index, message:`Places[${p.index}] place_id/id 누락`});
    else if(placeIds.has(p.id)) duplicatePlaces.push(p.id);
    else placeIds.add(p.id);

    if(p.id) placeKeyToId.set(normalizeName(p.id), p.id);
    p.names.forEach(n=>{
      const key = normalizeName(n);
      if(key){ placeNames.add(key); if(p.id) placeKeyToId.set(key, p.id); }
    });
  });

  maps.forEach(m=>{
    if(!m.id) errors.push({type:'MAP_ID_MISSING', index:m.index, message:`Maps[${m.index}] map_id/id 누락`});
    else if(mapIds.has(m.id)) duplicateMaps.push(m.id);
    else mapIds.add(m.id);
    if(m.url && !isUrl(m.url)) warnings.push({type:'MAP_URL_FORMAT', map_id:m.id, message:`지도 URL 형식 확인 필요: ${m.url}`});
  });

  const validRelations = new Set([
    // CEN BibleMaps v1.x relation types
    'related_map','era_context','regional_context','route_context','narrative_context','recommended_context',
    'direct_map','regional_representative_map','era_representative_map',
    // earlier/fallback aliases
    'direct','directmap','direct_map_available',
    'regional','regional_map','regional_representative','regionalrepresentativemap',
    'era','era_map','era_representative','erarepresentativemap',
    'related','reference','representative','representative_map','primary','secondary'
  ]);

  function resolvePlaceKey(value){
    const key = normalizeName(value);
    if(!key) return { ok:false, key:'', kind:'missing' };
    if(placeIds.has(key)) return { ok:true, key, kind:'id', id:key };
    if(placeNames.has(key)) return { ok:true, key, kind:'name', id:placeKeyToId.get(key) || key };
    // Links Master는 Place Master보다 넓은 검색 인덱스일 수 있으므로 unknown은 error가 아니라 coverage warning이다.
    return { ok:false, key, kind:'external' };
  }

  links.forEach((l)=>{
    const placeKey = normalizeName(l.placeId);
    const mapId = l.mapId;
    const relation = l.relation;
    const resolvedPlace = resolvePlaceKey(placeKey);
    const key = `${placeKey}::${mapId}::${relation || 'none'}`;

    if(!placeKey) errors.push({type:'LINK_PLACE_MISSING', index:l.index, message:`Links[${l.index}] place/place_id 누락`});
    else if(!resolvedPlace.ok) warnings.push({type:'LINK_PLACE_NOT_IN_PLACE_MASTER', index:l.index, place:placeKey, message:`Links[${l.index}] place가 Places Master에는 없음(검색 링크 전용 가능): ${placeKey}`});
    else usedPlaceIds.add(resolvedPlace.id || resolvedPlace.key);

    if(!mapId) errors.push({type:'LINK_MAP_ID_MISSING', index:l.index, place:placeKey, message:`Links[${l.index}] map_id 누락`});
    else if(!mapIds.has(mapId)) errors.push({type:'LINK_MAP_ID_UNKNOWN', index:l.index, map_id:mapId, message:`Links[${l.index}] map_id가 Maps에 없음: ${mapId}`});
    else usedMapIds.add(mapId);

    if(l.url && !isUrl(l.url)) warnings.push({type:'LINK_URL_FORMAT', index:l.index, place:placeKey, map_id:mapId, message:`링크 URL 형식 확인 필요: ${l.url}`});

    if(!relation) warnings.push({type:'RELATION_MISSING', index:l.index, place:placeKey, map_id:mapId, message:`Links[${l.index}] relation_type 누락`});
    else if(!validRelations.has(relation)) warnings.push({type:'RELATION_UNKNOWN', index:l.index, relation_type:relation, message:`Links[${l.index}] 알 수 없는 relation_type: ${relation}`});
    relationStats[relation || 'missing'] = (relationStats[relation || 'missing'] || 0) + 1;

    if(placeKey && mapId){
      if(linkKeys.has(key)) duplicateLinks.push(key);
      else linkKeys.add(key);
    }
  });

  duplicatePlaces.forEach(id=>errors.push({type:'DUPLICATE_PLACE_ID', place_id:id, message:`중복 place_id: ${id}`}));
  duplicateMaps.forEach(id=>errors.push({type:'DUPLICATE_MAP_ID', map_id:id, message:`중복 map_id: ${id}`}));
  duplicateLinks.slice(0,200).forEach(key=>warnings.push({type:'DUPLICATE_LINK', key, message:`중복 링크: ${key}`}));

  const placesWithoutLinks = places.filter(p=>{
    const keys = [p.id, ...p.names].map(normalizeName).filter(Boolean);
    return !keys.some(k=>usedPlaceIds.has(k) || usedPlaceIds.has(placeKeyToId.get(k)));
  }).map(p=>p.id || p.name || `Places[${p.index}]`);
  const unusedMaps = [...mapIds].filter(id=>!usedMapIds.has(id));
  placesWithoutLinks.forEach(id=>warnings.push({type:'PLACE_WITHOUT_LINK', place_id:id, message:`링크 없는 Place: ${id}`}));
  unusedMaps.forEach(id=>warnings.push({type:'UNUSED_MAP', map_id:id, message:`사용되지 않는 Map: ${id}`}));

  const runtimeInfo = checkRuntime(runtimeLinks, placeIds, mapIds, linkKeys);
  runtimeInfo.errors.forEach(e=>errors.push(e));
  runtimeInfo.warnings.forEach(w=>warnings.push(w));

  const statistics = {
    build_version: BUILD_VERSION,
    generated_at: new Date().toISOString(),
    places: places.length,
    maps: maps.length,
    links: links.length,
    runtime_links: runtimeLinks.length,
    relation_stats: relationStats,
    places_without_links: placesWithoutLinks.length,
    unused_maps: unusedMaps.length,
    errors: errors.length,
    warnings: warnings.length,
  };

  const missingReport = { places_without_links: placesWithoutLinks, unused_maps: unusedMaps };
  const qaReport = { build_version: BUILD_VERSION, generated_at: statistics.generated_at, errors, warnings };
  const releaseCheck = {
    build_version: BUILD_VERSION,
    release_ready: errors.length === 0,
    errors: errors.length,
    warnings: warnings.length,
    verdict: errors.length === 0 ? 'YES' : 'NO',
  };
  state.reports = { qaReport, missingReport, statistics, releaseCheck };
  renderReports(state.reports);
}

function checkRuntime(runtimeLinks, placeIds, mapIds, masterLinkKeys){
  const errors=[]; const warnings=[];
  runtimeLinks.forEach((r,idx)=>{
    const placeKey = normalizeName(r.placeId);
    if(r.mapId && !mapIds.has(r.mapId)) errors.push({type:'RUNTIME_MAP_UNKNOWN', index:r.index ?? idx, map_id:r.mapId, message:`Runtime map_id가 Maps에 없음: ${r.mapId}`});
    // Runtime의 place는 place_id가 아니라 한글 place key일 수 있으므로 Places Master 존재 여부는 release 차단 오류로 보지 않는다.
    if(placeKey && r.mapId){
      const possible = [...masterLinkKeys].some(k=>k.startsWith(`${placeKey}::${r.mapId}::`));
      if(!possible) warnings.push({type:'RUNTIME_NOT_IN_MASTER', place:placeKey, map_id:r.mapId, message:`Runtime 링크가 Master Links에 없음: ${placeKey} → ${r.mapId}`});
    }
  });
  return {errors,warnings,count:runtimeLinks.length};
}

function renderReports({qaReport, missingReport, statistics, releaseCheck}){
  document.getElementById('placesCount').textContent = statistics.places;
  document.getElementById('mapsCount').textContent = statistics.maps;
  document.getElementById('linksCount').textContent = statistics.links;
  document.getElementById('releaseStatus').textContent = releaseCheck.verdict;
  const releaseCard = document.getElementById('releaseCard');
  releaseCard.classList.toggle('ok', releaseCheck.release_ready);
  releaseCard.classList.toggle('no', !releaseCheck.release_ready);

  document.getElementById('summary').innerHTML = `
    <strong>검사 완료 (${BUILD_VERSION})</strong><br>
    Errors: ${statistics.errors} / Warnings: ${statistics.warnings}<br>
    Master Links: ${statistics.links}<br>
    Runtime Links: ${statistics.runtime_links}<br>
    링크 없는 Place: ${statistics.places_without_links}<br>
    사용되지 않는 Map: ${statistics.unused_maps}<br>
    Release Ready: <strong>${releaseCheck.verdict}</strong>
  `;
  renderTopIssues(qaReport.errors, qaReport.warnings);
  document.getElementById('reportOutput').textContent = JSON.stringify({qaReport, missingReport, statistics, releaseCheck}, null, 2);

  setDownload('downloadQa','qa-report.json',qaReport);
  setDownload('downloadMissing','missing-report.json',missingReport);
  setDownload('downloadStats','statistics.json',statistics);
  setDownload('downloadRelease','release-check.json',releaseCheck);
}

function renderTopIssues(errors, warnings){
  const box = document.getElementById('topIssues');
  if(!box) return;
  const topErrors = errors.slice(0,10).map(e=>`<li><b>ERROR</b> ${escapeHtml(e.message || e.type)}</li>`).join('');
  const topWarnings = warnings.slice(0,10).map(w=>`<li><b>WARN</b> ${escapeHtml(w.message || w.type)}</li>`).join('');
  box.innerHTML = `<h3>상위 이슈 미리보기</h3><ul>${topErrors || '<li>ERROR 없음</li>'}${topWarnings || '<li>WARNING 없음</li>'}</ul>`;
}
function escapeHtml(s){
  return String(s).replace(/[&<>'"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}
function setDownload(buttonId, filename, data){
  const btn = document.getElementById(buttonId);
  btn.disabled = false;
  btn.onclick = ()=>downloadJson(filename,data);
}
function downloadJson(filename,data){
  const blob = new Blob([JSON.stringify(data,null,2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}

if('serviceWorker' in navigator){
  window.addEventListener('load',()=>{
    navigator.serviceWorker.register('./sw.js?v=0.1.2').catch(()=>{});
  });
}
