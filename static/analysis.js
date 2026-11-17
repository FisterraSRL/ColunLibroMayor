const analysisState={active:false,busy:false,until:null,dimensionUntil:null,page:1,pages:1,selection:'all',lastData:null,detail:null,detailPage:1,detailPages:1,exporting:false};
window.ColunAnalysis={get active(){return analysisState.active;},get until(){return analysisState.until;},refresh(){return loadAnalysis(1,true);}};

function analysisBusy(value){
  analysisState.busy=value;
  $('analysis-loading').hidden=!value;
  if(value){$('analysis-table').hidden=true;$('analysis-empty').hidden=true;}
  $('analysis-grid').setAttribute('aria-busy',String(value));
  $('analysis-dimension').disabled=value || !analysisState.dimensionUntil;
  $('analysis-company-jump').disabled=value || !analysisState.lastData?.companies.length;
  $('analysis-export').disabled=value || analysisState.exporting || !analysisState.lastData || $('until-input').value!==analysisState.until;
  for(const [id,disabled] of [['analysis-first',analysisState.page<=1],['analysis-prev',analysisState.page<=1],
    ['analysis-next',analysisState.page>=analysisState.pages],['analysis-last',analysisState.page>=analysisState.pages]])
    $(id).disabled=value || disabled;
  if(analysisState.active){
    $('refresh').disabled=value;
    $('refresh').querySelector('span').textContent=value?'Consultando…':'Actualizar';
  }
}

function dimensionLabel(value){return value===null?'(Sin valor)':value===''?'(Vacío)':String(value);}
function populateDimensions(data){
  const select=$('analysis-dimension');
  const previous=analysisState.selection;
  select.replaceChildren(new Option('Todos los valores','all'));
  for(const value of data.values){
    select.add(new Option(dimensionLabel(value),value===null?'null':'value:'+value));
  }
  select.value=[...select.options].some(option=>option.value===previous)?previous:'all';
  analysisState.selection=select.value;
  analysisState.dimensionUntil=data.until;
}

function formattedAmount(value){
  if(value===null || value===undefined) return '—';
  const [whole,fraction='']=String(value).split('.');
  const grouped=whole.replace(/\B(?=(\d{3})+(?!\d))/g,'.');
  const decimals=fraction.replace(/0+$/,'').padEnd(2,'0');
  return grouped+','+decimals;
}

function renderAnalysis(data){
  analysisState.lastData=data;analysisState.until=data.until;
  analysisState.page=data.page;analysisState.pages=data.pages;
  const head=document.createElement('tr');
  for(const label of ['cuentaraman','Cuenta',...data.companies.map(name=>name??'(Sin empresa)')]){
    const th=document.createElement('th');th.scope='col';th.textContent=label;head.append(th);
  }
  $('analysis-head').replaceChildren(head);
  const jump=$('analysis-company-jump');jump.replaceChildren(new Option('Elegí una empresa…',''));
  data.companies.forEach((name,index)=>jump.add(new Option(name??'(Sin empresa)',String(index))));
  jump.disabled=!data.companies.length;
  const body=document.createDocumentFragment();
  let previousBranch;
  for(const row of data.rows){
    const tr=document.createElement('tr');
    const firstOfGroup=previousBranch!==row.cuentaraman;
    if(firstOfGroup) tr.classList.add('analysis-group-start');
    const branch=document.createElement('td');branch.textContent=firstOfGroup?row.cuentaraman??'(Sin rama)':'';
    branch.title=row.cuentaraman??'(Sin rama)';tr.append(branch);
    const account=document.createElement('td');account.textContent=row.cuenta??'(Sin cuenta)';account.title=row.cuenta??'(Sin cuenta)';tr.append(account);
    row.amounts.forEach((amount,index)=>{
      const cell=document.createElement('td');cell.className='analysis-amount';
      if(amount!==null){
        const button=document.createElement('button');button.type='button';button.className='amount-link';
        button.textContent=formattedAmount(amount);button.title='Ver movimientos que componen este saldo';
        button.setAttribute('aria-label','Ver detalle de '+(row.cuenta??'cuenta sin nombre')+' en '+(data.companies[index]??'empresa sin nombre')+': '+formattedAmount(amount));
        button.addEventListener('click',()=>openAnalysisDetail(row,data.companies[index]));cell.append(button);
      }else{cell.textContent='—';cell.title='Sin movimientos';}
      tr.append(cell);
    });
    body.append(tr);previousBranch=row.cuentaraman;
  }
  $('analysis-body').replaceChildren(body);
  $('analysis-table').hidden=!data.rows.length;
  $('analysis-empty').hidden=!!data.rows.length;
  $('analysis-summary').textContent=number.format(data.total)+' cuentas · '+number.format(data.companies.length)+
    ' empresas · '+displayDate(data.from)+' al '+displayDate(data.until)+' · Saldo = Debe − Haber';
  const from=data.rows.length?(data.page-1)*data.pageSize+1:0;
  const to=(data.page-1)*data.pageSize+data.rows.length;
  $('analysis-range').textContent='Mostrando '+number.format(from)+'–'+number.format(to)+' de '+number.format(data.total)+' cuentas';
  $('analysis-page').textContent='Página '+number.format(data.page)+' de '+number.format(data.pages);
  $('analysis-grid').scrollTo({top:0,left:0});
  analysisBusy(false);updateFilterHint();
}

async function loadAnalysis(page=1,refresh=false){
  if(analysisState.busy) return;
  const until=refresh || !analysisState.until?$('until-input').value:analysisState.until;
  if(!until || ((refresh || !analysisState.until) && !$('until-input').validity.valid)){
    $('until-input').reportValidity();return;
  }
  analysisBusy(true);$('analysis-error').hidden=true;
  $('analysis-summary').textContent='Consultando cuentas y empresas…';
  try{
    if(analysisState.dimensionUntil!==until || refresh){
      populateDimensions(await api('/api/analysis/dimensions?until='+encodeURIComponent(until)));
    }
    const params=new URLSearchParams({until,page:String(page)});
    if(analysisState.selection==='null') params.set('dimensionNull','1');
    else if(analysisState.selection.startsWith('value:')) params.set('dimensionvalor',analysisState.selection.slice(6));
    renderAnalysis(await api('/api/analysis?'+params));
  }catch(err){
    $('analysis-error').textContent=err.message;$('analysis-error').hidden=false;
    $('analysis-summary').textContent='No se pudo cargar el análisis.';
    analysisBusy(false);
  }
}

function selectView(view){
  analysisState.active=view==='analysis';
  $('tab-grid').setAttribute('aria-selected',String(!analysisState.active));
  $('tab-analysis').setAttribute('aria-selected',String(analysisState.active));
  $('grid-view').hidden=analysisState.active;
  $('analysis-view').hidden=!analysisState.active;
  $('export').hidden=analysisState.active;
  $('analysis-export').hidden=!analysisState.active;
  $('refresh').disabled=analysisState.active?analysisState.busy:state.busy;
  $('refresh').querySelector('span').textContent=$('refresh').disabled?'Consultando…':'Actualizar';
  updateFilterHint();
  if(analysisState.active){
    if(!analysisState.lastData || analysisState.until!==$('until-input').value) loadAnalysis(1,true);
    else analysisBusy(false);
  }else if(!state.busy && state.activeUntil!==$('until-input').value) load(1,true);
}

function detailParams(page){
  const {row,company,until,selection}=analysisState.detail;
  const params=new URLSearchParams({page:String(page),until});
  for(const [key,value,nullFlag] of [['branch',row.cuentaraman,'branchNull'],['account',row.cuenta,'accountNull'],['company',company,'companyNull']]){
    if(value===null) params.set(nullFlag,'1');else params.set(key,value);
  }
  if(selection==='null') params.set('dimensionNull','1');
  else if(selection.startsWith('value:')) params.set('dimensionvalor',selection.slice(6));
  return params;
}
async function loadAnalysisDetail(page){
  $('analysis-detail-status').textContent='Consultando movimientos…';
  $('analysis-detail-prev').disabled=$('analysis-detail-next').disabled=true;
  try{
    const data=await api('/api/analysis/detail?'+detailParams(page));
    analysisState.detailPage=data.page;analysisState.detailPages=data.pages;
    const body=document.createDocumentFragment();
    for(const row of data.rows){
      const tr=document.createElement('tr');
      const saldo=Number(row.debemonedappal||0)-Number(row.habermonedappal||0);
      for(const value of [displayDate(String(row.fecha||'').slice(0,10)),row.documento,row.descripcion,
        formattedAmount(row.debemonedappal),formattedAmount(row.habermonedappal),formattedAmount(saldo),dimensionLabel(row.dimensionvalor)]){
        const td=document.createElement('td');td.textContent=value??'—';tr.append(td);
      }
      body.append(tr);
    }
    $('analysis-detail-body').replaceChildren(body);
    $('analysis-detail-status').textContent=number.format(data.total)+' movimientos';
    $('analysis-detail-page').textContent='Página '+data.page+' de '+data.pages;
    $('analysis-detail-prev').disabled=data.page<=1;$('analysis-detail-next').disabled=data.page>=data.pages;
  }catch(error){$('analysis-detail-status').textContent=error.message;}
}
function openAnalysisDetail(row,company){
  analysisState.detail={row,company,until:analysisState.until,selection:analysisState.selection};
  $('analysis-detail-context').textContent=[row.cuentaraman??'(Sin rama)',row.cuenta??'(Sin cuenta)',company??'(Sin empresa)',
    analysisState.selection==='all'?'Todas las dimensiones':$('analysis-dimension').selectedOptions[0]?.textContent].join(' · ');
  $('analysis-detail-body').replaceChildren();
  $('analysis-detail').showModal();loadAnalysisDetail(1);
}
function showAnalysisExport(message,job){
  const panel=$('analysis-export-status');panel.hidden=false;panel.replaceChildren(document.createTextNode(message));
  if(job?.status==='ready'){
    const link=document.createElement('a');link.className='button primary';link.textContent='Descargar Excel';
    link.href='/api/exports/'+job.id+'/file';link.download='COLUN_Analisis.xlsx';panel.append(' ',link);
  }
}
async function pollAnalysisExport(id){
  try{
    const job=await api('/api/exports/'+id);
    if(job.status==='ready'){
      analysisState.exporting=false;sessionStorage.removeItem('colun-analysis-export');analysisBusy(false);
      showAnalysisExport('Excel listo: '+number.format(job.total)+' movimientos y tabla dinámica.',job);return;
    }
    if(job.status==='error'){
      analysisState.exporting=false;sessionStorage.removeItem('colun-analysis-export');analysisBusy(false);
      showAnalysisExport(job.error || 'No se pudo crear el Excel.');return;
    }
    const stage=job.phase==='reading'?'Guardando movimientos':job.progressStage==='cache'?'Armando la tabla dinámica':'Escribiendo el Excel';
    showAnalysisExport(stage+' · '+number.format(job.captured || job.processed || 0)+' de '+number.format(job.total || 0));
  }catch(error){showAnalysisExport('Reconectando con la exportación…');}
  setTimeout(()=>pollAnalysisExport(id),5000);
}
$('analysis-export').addEventListener('click',async()=>{
  if(analysisState.exporting || !analysisState.lastData) return;
  analysisState.exporting=true;analysisBusy(false);showAnalysisExport('Preparando los movimientos y la tabla dinámica…');
  const body={until:analysisState.until};
  if(analysisState.selection==='null') body.dimensionNull=true;
  else if(analysisState.selection.startsWith('value:')) body.dimensionvalor=analysisState.selection.slice(6);
  try{
    const job=await api('/api/analysis/exports',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    sessionStorage.setItem('colun-analysis-export',job.id);pollAnalysisExport(job.id);
  }catch(error){analysisState.exporting=false;analysisBusy(false);showAnalysisExport(error.message);}
});
{
  const previous=sessionStorage.getItem('colun-analysis-export');
  if(previous && /^[a-f0-9]{32}$/.test(previous)){analysisState.exporting=true;pollAnalysisExport(previous);}
}
$('analysis-detail-close').addEventListener('click',()=>$('analysis-detail').close());
$('analysis-detail-prev').addEventListener('click',()=>loadAnalysisDetail(analysisState.detailPage-1));
$('analysis-detail-next').addEventListener('click',()=>loadAnalysisDetail(analysisState.detailPage+1));

$('tab-grid').addEventListener('click',()=>selectView('grid'));
$('tab-analysis').addEventListener('click',()=>selectView('analysis'));
$('analysis-dimension').addEventListener('change',event=>{
  analysisState.selection=event.target.value;loadAnalysis(1);
});
$('analysis-company-jump').addEventListener('change',event=>{
  if(event.target.value==='') return;
  const th=$('analysis-head').querySelectorAll('th')[Number(event.target.value)+2];
  if(!th) return;
  $('analysis-grid').scrollTo({left:th.offsetLeft-440,behavior:'smooth'});
  th.classList.remove('flash');void th.offsetWidth;th.classList.add('flash');
});
for(const [id,page] of [['analysis-first',()=>1],['analysis-prev',()=>analysisState.page-1],
  ['analysis-next',()=>analysisState.page+1],['analysis-last',()=>analysisState.pages]])
  $(id).addEventListener('click',()=>loadAnalysis(page()));
