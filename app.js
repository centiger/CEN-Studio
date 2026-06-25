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
  return String(value || '').trim().toLowerCase().replace(/-/g,'_');
}
function looksLikePlaceId(id){ return /^P\d+/i.test(String(id||'')); }
function looksLikeMapId(id){ return /^M\d+/i.test(String(id||'')); }
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
  // 객체 자체가 { P001:{...}, P002:{...} } 또는 { M001:{...} } 형태일 때 보존
  return Object.entries(data).map(([key,value])=>{
    if(value && typeof value === 'object' && !Array.isArray(value)) return { _key:key, ...value };
    return { _key:key, value };
  });
}

function normalizePlaces(data){
  const arr = getArray(data, ['places']);
  return arr.map((p,idx)=>{
    const id = pickId(p, ['place_id','placeId','id','_key']);
    const name = pickId(p, ['canonical_name','name','title','ko_name','label']);
    return { raw:p, index:idx, id, name };
  });
}

function normalizeMaps(data){
  const arr = getArray(data, ['maps']);
  return arr.map((m,idx)=>{
    const id = pickId(m, ['map_id','mapId','id','_key']);
    const title = pickId(m, ['title','name','map_title','label']);
    const url = pickId(m, ['url','href','link','official_url','map_url']);
    return { raw:m, index:idx, id, title, url };
  });
}

function normalizeLinks(data){
  const out = [];
  if(!data) return out;

  // 배열형: [{place_id,map_id,...}, ...]
  if(Array.isArray(data)){
    data.forEach((item,idx)=>pushLinkItem(out, item, idx));
    return out;
  }

  if(typeof data !== 'object') return out;

  // 래퍼형: { links:[...] } / { place_map_links:[...] }
  for(const key of ['links','place_map_links','placeMapLinks','items','data','records']){
    if(Array.isArray(data[key])){
      data[key].forEach((item,idx)=>pushLinkItem(out, item, idx));
      return out;
    }
  }

  // 객체형: { P001:[{map_id...}, "M001"], P002:{maps:[...]}, ... }
  Object.entries(data).forEach(([placeKey,value],idx)=>{
    if(Array.isArray(value)){
      value.forEach((v,j)=>pushLinkItem(out, v, `${placeKey}.${j}`, placeKey));
    }else if(value && typeof value === 'object'){
      const nested = value.maps || value.map_ids || value.links || value.items || value.data;
      if(Array.isArray(nested)){
        nested.forEach((v,j)=>pushLinkItem(out, v, `${placeKey}.${j}`, placeKey, value));
      }else{
        pushLinkItem(out, value, idx, placeKey);
      }
    }else if(typeof value === 'string'){
      pushLinkItem(out, value, idx, placeKey);
    }
  });
  return out;
}

function pushLinkItem(out, item, index, fallbackPlaceId='', parent={}){
  let placeId='', mapId='', relation='', url='';
  if(typeof item === 'string'){
    placeId = fallbackPlaceId;
    mapId = item;
  }else if(item && typeof item === 'object'){
    placeId = pickId(item, ['place_id','placeId','place','pid']) || fallbackPlaceId || pickId(parent,['place_id','placeId','id']);
    mapId = pickId(item, ['map_id','mapId','map','mid','id']);
    relation = normalizeRelation(pickId(item, ['relation_type','relationship','relation','type','map_relation']));
    url = pickId(item, ['url','href','link','map_url']);
    // {M001:{...}}에서 key가 map_id일 수 있음
    if(!mapId && item._key && looksLikeMapId(item._key)) mapId = item._key;
  }
  out.push({ raw:item, index, placeId:String(placeId||'').trim(), mapId:String(mapId||'').trim(), relation, url });
}

function runtimeEntries(data){
  return normalizeLinks(data);
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
  const runtimeLinks = runtimeEntries(loaded[3].data);

  const placeIds = new Set();
  const mapIds = new Set();
  const usedPlaceIds = new Set();
  const usedMapIds = new Set();
  const duplicatePlaces = [];
  const duplicateMaps = [];
  const duplicateLinks = [];
  const relationStats = {};
  const linkKeys = new Set();

  places.forEach(p=>{
    if(!p.id) errors.push({type:'PLACE_ID_MISSING', index:p.index, message:`Places[${p.index}] place_id/id 누락`});
    else if(placeIds.has(p.id)) duplicatePlaces.push(p.id);
    else placeIds.add(p.id);
  });

  maps.forEach(m=>{
    if(!m.id) errors.push({type:'MAP_ID_MISSING', index:m.index, message:`Maps[${m.index}] map_id/id 누락`});
    else if(mapIds.has(m.id)) duplicateMaps.push(m.id);
    else mapIds.add(m.id);
    if(m.url && !isUrl(m.url)) warnings.push({type:'MAP_URL_FORMAT', map_id:m.id, message:`지도 URL 형식 확인 필요: ${m.url}`});
  });

  const validRelations = new Set([
    'direct','direct_map','regional','regional_map','regional_representative','regional_representative_map',
    'era','era_map','era_representative','era_representative_map','related','reference','representative'
  ]);

  links.forEach((l,idx)=>{
    const placeId = l.placeId;
    const mapId = l.mapId;
    const relation = l.relation;
    const key = `${placeId}::${mapId}::${relation || 'none'}`;

    if(!placeId) errors.push({type:'LINK_PLACE_ID_MISSING', index:l.index, message:`Links[${l.index}] place_id 누락`});
    else if(!placeIds.has(placeId)) errors.push({type:'LINK_PLACE_ID_UNKNOWN', index:l.index, place_id:placeId, message:`Links[${l.index}] place_id가 Places에 없음: ${placeId}`});
    else usedPlaceIds.add(placeId);

    if(!mapId) errors.push({type:'LINK_MAP_ID_MISSING', index:l.index, place_id:placeId, message:`Links[${l.index}] map_id 누락`});
    else if(!mapIds.has(mapId)) errors.push({type:'LINK_MAP_ID_UNKNOWN', index:l.index, map_id:mapId, message:`Links[${l.index}] map_id가 Maps에 없음: ${mapId}`});
    else usedMapIds.add(mapId);

    if(l.url && !isUrl(l.url)) warnings.push({type:'LINK_URL_FORMAT', index:l.index, place_id:placeId, map_id:mapId, message:`링크 URL 형식 확인 필요: ${l.url}`});

    if(!relation) warnings.push({type:'RELATION_MISSING', index:l.index, place_id:placeId, map_id:mapId, message:`Links[${l.index}] relation_type 누락`});
    else if(!validRelations.has(relation)) warnings.push({type:'RELATION_UNKNOWN', index:l.index, relation_type:relation, message:`Links[${l.index}] 알 수 없는 relation_type: ${relation}`});
    relationStats[relation || 'missing'] = (relationStats[relation || 'missing'] || 0) + 1;

    if(placeId && mapId){
      if(linkKeys.has(key)) duplicateLinks.push(key);
      else linkKeys.add(key);
    }
  });

  duplicatePlaces.forEach(id=>errors.push({type:'DUPLICATE_PLACE_ID', place_id:id, message:`중복 place_id: ${id}`}));
  duplicateMaps.forEach(id=>errors.push({type:'DUPLICATE_MAP_ID', map_id:id, message:`중복 map_id: ${id}`}));
  duplicateLinks.forEach(key=>warnings.push({type:'DUPLICATE_LINK', key, message:`중복 링크: ${key}`}));

  const placesWithoutLinks = [...placeIds].filter(id=>!usedPlaceIds.has(id));
  const unusedMaps = [...mapIds].filter(id=>!usedMapIds.has(id));
  placesWithoutLinks.forEach(id=>warnings.push({type:'PLACE_WITHOUT_LINK', place_id:id, message:`링크 없는 Place: ${id}`}));
  unusedMaps.forEach(id=>warnings.push({type:'UNUSED_MAP', map_id:id, message:`사용되지 않는 Map: ${id}`}));

  const runtimeInfo = checkRuntime(runtimeLinks, placeIds, mapIds, linkKeys);
  runtimeInfo.errors.forEach(e=>errors.push(e));
  runtimeInfo.warnings.forEach(w=>warnings.push(w));

  const statistics = {
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
  const qaReport = { generated_at: statistics.generated_at, errors, warnings };
  const releaseCheck = {
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
    if(r.placeId && !placeIds.has(r.placeId)) errors.push({type:'RUNTIME_PLACE_UNKNOWN', index:r.index ?? idx, place_id:r.placeId, message:`Runtime place_id가 Places에 없음: ${r.placeId}`});
    if(r.mapId && !mapIds.has(r.mapId)) errors.push({type:'RUNTIME_MAP_UNKNOWN', index:r.index ?? idx, map_id:r.mapId, message:`Runtime map_id가 Maps에 없음: ${r.mapId}`});
    if(r.placeId && r.mapId){
      const possible = [...masterLinkKeys].some(k=>k.startsWith(`${r.placeId}::${r.mapId}::`));
      if(!possible) warnings.push({type:'RUNTIME_NOT_IN_MASTER', place_id:r.placeId, map_id:r.mapId, message:`Runtime 링크가 Master Links에 없음: ${r.placeId} → ${r.mapId}`});
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
    <strong>검사 완료</strong><br>
    Errors: ${statistics.errors} / Warnings: ${statistics.warnings}<br>
    Runtime Links: ${statistics.runtime_links}<br>
    링크 없는 Place: ${statistics.places_without_links}<br>
    사용되지 않는 Map: ${statistics.unused_maps}<br>
    Release Ready: <strong>${releaseCheck.verdict}</strong>
  `;
  document.getElementById('reportOutput').textContent = JSON.stringify({qaReport, missingReport, statistics, releaseCheck}, null, 2);

  setDownload('downloadQa','qa-report.json',qaReport);
  setDownload('downloadMissing','missing-report.json',missingReport);
  setDownload('downloadStats','statistics.json',statistics);
  setDownload('downloadRelease','release-check.json',releaseCheck);
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
    navigator.serviceWorker.register('./sw.js').catch(()=>{});
  });
}
