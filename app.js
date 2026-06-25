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

function asArray(data){
  if(Array.isArray(data)) return data;
  if(!data || typeof data !== 'object') return [];
  for(const key of ['places','maps','links','items','data']){
    if(Array.isArray(data[key])) return data[key];
  }
  return Object.values(data).filter(v=>v && typeof v === 'object');
}

function pickId(item, keys){
  for(const key of keys){
    if(item && item[key] !== undefined && item[key] !== null && String(item[key]).trim()) return String(item[key]).trim();
  }
  return '';
}

function normalizeRelation(value){
  return String(value || '').trim().toLowerCase();
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

  const places = asArray(loaded[0].data);
  const maps = asArray(loaded[1].data);
  const links = asArray(loaded[2].data);
  const runtime = loaded[3].data;

  const placeIds = new Set();
  const mapIds = new Set();
  const linkKeys = new Set();
  const duplicatePlaces = [];
  const duplicateMaps = [];
  const duplicateLinks = [];
  const usedPlaceIds = new Set();
  const usedMapIds = new Set();
  const relationStats = {};

  places.forEach((p,idx)=>{
    const id = pickId(p,['place_id','id']);
    if(!id) errors.push({type:'PLACE_ID_MISSING', index:idx, message:`Places[${idx}] place_id/id 누락`});
    else if(placeIds.has(id)) duplicatePlaces.push(id);
    else placeIds.add(id);
  });

  maps.forEach((m,idx)=>{
    const id = pickId(m,['map_id','id']);
    if(!id) errors.push({type:'MAP_ID_MISSING', index:idx, message:`Maps[${idx}] map_id/id 누락`});
    else if(mapIds.has(id)) duplicateMaps.push(id);
    else mapIds.add(id);
    const url = pickId(m,['url','href','link']);
    if(url && !/^https?:\/\//i.test(url)) warnings.push({type:'MAP_URL_FORMAT', map_id:id, message:`지도 URL 형식 확인 필요: ${url}`});
  });

  const validRelations = new Set(['direct','direct_map','regional','regional_representative','regional_representative_map','era','era_representative','era_representative_map']);

  links.forEach((l,idx)=>{
    const placeId = pickId(l,['place_id','placeId','place']);
    const mapId = pickId(l,['map_id','mapId','map']);
    const relation = normalizeRelation(pickId(l,['relation_type','relationship','relation','type']));
    const key = `${placeId}::${mapId}::${relation}`;

    if(!placeId) errors.push({type:'LINK_PLACE_ID_MISSING', index:idx, message:`Links[${idx}] place_id 누락`});
    else if(!placeIds.has(placeId)) errors.push({type:'LINK_PLACE_ID_UNKNOWN', index:idx, place_id:placeId, message:`Links[${idx}] place_id가 Places에 없음: ${placeId}`});
    else usedPlaceIds.add(placeId);

    if(!mapId) errors.push({type:'LINK_MAP_ID_MISSING', index:idx, message:`Links[${idx}] map_id 누락`});
    else if(!mapIds.has(mapId)) errors.push({type:'LINK_MAP_ID_UNKNOWN', index:idx, map_id:mapId, message:`Links[${idx}] map_id가 Maps에 없음: ${mapId}`});
    else usedMapIds.add(mapId);

    if(!relation) warnings.push({type:'RELATION_MISSING', index:idx, place_id:placeId, map_id:mapId, message:`Links[${idx}] relation_type 누락`});
    else if(!validRelations.has(relation)) warnings.push({type:'RELATION_UNKNOWN', index:idx, relation_type:relation, message:`Links[${idx}] 알 수 없는 relation_type: ${relation}`});
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

  const runtimeInfo = checkRuntime(runtime, placeIds, mapIds);
  runtimeInfo.errors.forEach(e=>errors.push(e));
  runtimeInfo.warnings.forEach(w=>warnings.push(w));

  const statistics = {
    generated_at: new Date().toISOString(),
    places: places.length,
    maps: maps.length,
    links: links.length,
    runtime_items: runtimeInfo.count,
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

function checkRuntime(runtime, placeIds, mapIds){
  const errors=[]; const warnings=[]; let count=0;
  if(!runtime) return {errors,warnings,count};
  if(Array.isArray(runtime)){
    count = runtime.length;
    runtime.forEach((r,idx)=>{
      const placeId = pickId(r,['place_id','placeId','place']);
      const mapId = pickId(r,['map_id','mapId','map']);
      if(placeId && !placeIds.has(placeId)) errors.push({type:'RUNTIME_PLACE_UNKNOWN', index:idx, place_id:placeId, message:`Runtime place_id가 Places에 없음: ${placeId}`});
      if(mapId && !mapIds.has(mapId)) errors.push({type:'RUNTIME_MAP_UNKNOWN', index:idx, map_id:mapId, message:`Runtime map_id가 Maps에 없음: ${mapId}`});
    });
  } else if(typeof runtime === 'object'){
    const entries = Object.entries(runtime);
    count = entries.length;
    entries.forEach(([placeId,value])=>{
      if(/^P/i.test(placeId) && !placeIds.has(placeId)) errors.push({type:'RUNTIME_PLACE_UNKNOWN', place_id:placeId, message:`Runtime key place_id가 Places에 없음: ${placeId}`});
      const maps = Array.isArray(value) ? value : (value?.maps || value?.map_ids || []);
      if(Array.isArray(maps)){
        maps.forEach(mapId=>{
          const id = typeof mapId === 'string' ? mapId : pickId(mapId,['map_id','id']);
          if(id && /^M/i.test(id) && !mapIds.has(id)) errors.push({type:'RUNTIME_MAP_UNKNOWN', place_id:placeId, map_id:id, message:`Runtime map_id가 Maps에 없음: ${id}`});
        });
      }
    });
  } else {
    warnings.push({type:'RUNTIME_UNKNOWN_SHAPE', message:'Runtime 구조를 해석하지 못했습니다.'});
  }
  return {errors,warnings,count};
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
