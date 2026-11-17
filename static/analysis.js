const analysisState={active:false,busy:false,until:null,dimensionUntil:null,page:1,pages:1,selection:'all',lastData:null};
window.ColunAnalysis={get active(){return analysisState.active;},get until(){return analysisState.until;},refresh(){return loadAnalysis(1,true);}};

function analysisBusy(value){
  analysisState.busy=value;
  $('analysis-loading').hidden=!value;
  if(value){$('analysis-table').hidden=true;$('analysis-empty').hidden=true;}
  $('analysis-grid').setAttribute('aria-busy',String(value));
  $('analysis-dimension').disabled=value || !analysisState.dimensionUntil;
  for(const [id,disabled] of [['analysis-first',analysisState.page<=1],['analysis-prev',analysisState.page<=1],
    ['analysis-next',analysisState.page>=analysisState.pages],['analysis-last',analysisState.page>=analysisState.pages]])
    $(id).disabled=value || disabled;
  if(analysisState.active){
    $('refresh').disabled=value;
    $('refresh').querySelector('span').textContent=value?'Consultando…':'Actualizar';
  }
}

function dimensionLabel(value){return value===null?'(Sin valor)':String(value);}
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
  const body=document.createDocumentFragment();
  let previousBranch;
  for(const row of data.rows){
    const tr=document.createElement('tr');
    const firstOfGroup=previousBranch!==row.cuentaraman;
    if(firstOfGroup) tr.classList.add('analysis-group-start');
    const branch=document.createElement('td');branch.textContent=firstOfGroup?row.cuentaraman??'(Sin rama)':'';
    branch.title=row.cuentaraman??'(Sin rama)';tr.append(branch);
    const account=document.createElement('td');account.textContent=row.cuenta??'(Sin cuenta)';account.title=row.cuenta??'(Sin cuenta)';tr.append(account);
    for(const amount of row.amounts){
      const cell=document.createElement('td');cell.className='analysis-amount';
      cell.textContent=formattedAmount(amount);cell.title=amount===null?'Sin movimientos':String(amount);tr.append(cell);
    }
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
  $('refresh').disabled=analysisState.active?analysisState.busy:state.busy;
  $('refresh').querySelector('span').textContent=$('refresh').disabled?'Consultando…':'Actualizar';
  updateFilterHint();
  if(analysisState.active){
    if(!analysisState.lastData || analysisState.until!==$('until-input').value) loadAnalysis(1,true);
  }else if(!state.busy && state.activeUntil!==$('until-input').value) load(1,true);
}

$('tab-grid').addEventListener('click',()=>selectView('grid'));
$('tab-analysis').addEventListener('click',()=>selectView('analysis'));
$('analysis-dimension').addEventListener('change',event=>{
  analysisState.selection=event.target.value;loadAnalysis(1);
});
for(const [id,page] of [['analysis-first',()=>1],['analysis-prev',()=>analysisState.page-1],
  ['analysis-next',()=>analysisState.page+1],['analysis-last',()=>analysisState.pages]])
  $(id).addEventListener('click',()=>loadAnalysis(page()));
