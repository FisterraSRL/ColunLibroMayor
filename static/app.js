const $ = id => document.getElementById(id);
const number = new Intl.NumberFormat('es-AR');
const state = {page:1,pages:1,total:0,columns:[],visibleColumns:new Set(),lastData:null,activeUntil:null,busy:false,job:null,exportStarting:false,downloadUrl:null};
const preferred = ['fecha','empresa','cuentacodigo','cuenta','documento','organizacion','saldomonedappal','moneda','dimension','dimensionvalor'];
const titles = {fecha:'Fecha',empresa:'Empresa',cuentacodigo:'Código de cuenta',cuenta:'Cuenta contable',documento:'Documento',organizacion:'Organización',saldomonedappal:'Saldo · moneda principal',moneda:'Moneda',dimension:'Dimensión',dimensionvalor:'Valor de dimensión'};

async function api(path, options={}) {
  const response=await fetch(path,{cache:'no-store',...options});
  let data;
  try {data=await response.json();} catch {throw new Error('La conexión no está disponible. Volvé a intentar.');}
  if(!response.ok) throw new Error(data.error || 'No se pudo completar la consulta.');
  return data;
}

function error(message) {$('error-text').textContent=message;$('error').hidden=false;}
function online(value) {
  $('connection').classList.toggle('offline',!value);
  $('connection').lastElementChild.textContent=value?'Conectado':'Sin conexión';
  $('live').hidden=!value;
}
function periodStart(value) {
  const [year,month,day]=value.split('-').map(Number);
  if(!year || !month || !day) return null;
  const lastDay=new Date(Date.UTC(year-1,month,0)).getUTCDate();
  return new Date(Date.UTC(year-1,month-1,Math.min(day,lastDay)+1)).toISOString().slice(0,10);
}
function displayDate(value) {return value?value.slice(8,10)+'/'+value.slice(5,7)+'/'+value.slice(0,4):'—';}
function updateFilterHint() {
  const until=$('until-input').value;
  $('from-date').textContent=displayDate(periodStart(until));
  const pending=!!state.activeUntil && until!==state.activeUntil;
  $('filter-hint').classList.toggle('pending',pending);
  $('filter-hint').textContent=pending?'Pulsá Actualizar para aplicar el nuevo período.':'Un año completo hasta la fecha elegida, con ambas fechas incluidas.';
  updateExportControl();
}
function visibleColumns() {
  return [...preferred.filter(name=>state.columns.includes(name) && state.visibleColumns.has(name)),
    ...state.columns.filter(name=>!preferred.includes(name) && state.visibleColumns.has(name))];
}
function updateExportControl() {
  $('export').disabled=state.busy || state.exportStarting || !!state.job || !state.visibleColumns.size ||
    !state.activeUntil || $('until-input').value!==state.activeUntil || !$('error').hidden;
}
function controls(busy) {
  state.busy=busy;
  $('refresh').disabled=busy;
  $('first').disabled=$('prev').disabled=busy || state.page<=1;
  $('next').disabled=$('last').disabled=busy || state.page>=state.pages;
  $('page-input').disabled=busy || !state.columns.length;
  $('column-jump').disabled=busy || !state.visibleColumns.size;
  $('grid').setAttribute('aria-busy',String(busy));
  $('grid').classList.toggle('is-loading',busy);
  $('refresh').querySelector('span').textContent=busy?'Consultando…':'Actualizar';
  updateExportControl();
}

function setMetadata(data) {
  if(!state.columns.length) {
    let saved;
    try {saved=JSON.parse(localStorage.getItem('colun-visible-columns'));} catch {}
    state.visibleColumns=new Set(Array.isArray(saved)?saved.filter(name=>data.columns.includes(name)):data.columns);
  } else state.visibleColumns=new Set([...state.visibleColumns].filter(name=>data.columns.includes(name)));
  state.columns=data.columns;state.total=data.total;state.pages=data.pages;
  $('total').textContent=number.format(data.total);
  $('columns-count').textContent=number.format(data.columns.length);
  $('pages').textContent='de '+number.format(data.pages);
  $('page-input').max=data.pages;
  const checked=new Date(data.checkedAt);
  $('checked-at').textContent='Última consulta · '+checked.toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  $('checked-at').title=checked.toLocaleString('es-AR');
  const options=$('column-options');options.replaceChildren();
  for(const name of data.columns) {
    const label=document.createElement('label');label.className='column-option';
    label.dataset.search=(name+' '+(titles[name] || '')).toLocaleLowerCase('es-AR');
    const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.value=name;checkbox.checked=state.visibleColumns.has(name);
    label.append(checkbox,document.createTextNode(titles[name] || name));
    options.append(label);
  }
  updateColumnControls();
  updateExportControl();
}

function updateColumnControls() {
  $('visible-count').textContent=state.visibleColumns.size+' / '+state.columns.length;
  const selector=$('column-jump');selector.replaceChildren(new Option('Ir a una columna…',''));
  for(const name of state.columns) if(state.visibleColumns.has(name)) selector.add(new Option(titles[name] || name,name));
  selector.disabled=state.busy || !state.visibleColumns.size;
}

function changeColumns(names) {
  state.visibleColumns=new Set(names);
  for(const checkbox of $('column-options').querySelectorAll('input')) checkbox.checked=state.visibleColumns.has(checkbox.value);
  try {localStorage.setItem('colun-visible-columns',JSON.stringify([...state.visibleColumns]));} catch {}
  updateColumnControls();
  if(state.lastData) render(state.lastData);
  if(!state.job) $('export-panel').hidden=true;
  updateExportControl();
}

function render(data) {
  state.lastData=data;
  state.page=data.page;state.pages=data.pages;state.total=data.total;
  const cols=visibleColumns();
  const indexes=cols.map(name=>data.columns.indexOf(name));
  const header=document.createElement('tr');
  const indexHeader=document.createElement('th');indexHeader.textContent='#';indexHeader.scope='col';header.append(indexHeader);
  for(const name of cols) {
    const th=document.createElement('th');th.scope='col';th.id='col-'+name;th.dataset.column=name;th.title=name;
    th.append(document.createTextNode(titles[name] || name));
    const badge=document.createElement('span');badge.className='col-index';badge.textContent=String(data.columns.indexOf(name)+1).padStart(2,'0');th.append(badge);header.append(th);
  }
  $('thead').replaceChildren(header);
  const fragment=document.createDocumentFragment();
  data.rows.forEach((values,index)=>{
    const tr=document.createElement('tr');
    const rowNum=document.createElement('td');rowNum.textContent=number.format((data.page-1)*data.pageSize+index+1);tr.append(rowNum);
    for(let col=0;col<cols.length;col++) {
      const td=document.createElement('td');const value=values[indexes[col]];
      if(value===null) {td.textContent='—';td.className='null';td.title='NULL';}
      else {td.textContent=String(value);td.title=String(value);}
      if(/^(debe|haber|saldo|importe|cotizacion)/.test(cols[col])) td.classList.add('cell-amount');
      tr.append(td);
    }
    fragment.append(tr);
  });
  $('tbody').replaceChildren(fragment);
  $('loading').hidden=true;$('table').hidden=data.rows.length===0 || !cols.length;
  $('empty').hidden=data.rows.length!==0 || !cols.length;
  $('no-columns').hidden=!!cols.length;
  $('page-label').textContent='Página '+number.format(data.page)+' de '+number.format(data.pages);
  $('page-input').value=data.page;
  const from=data.rows.length?(data.page-1)*data.pageSize+1:0;const to=(data.page-1)*data.pageSize+data.rows.length;
  $('range').replaceChildren('Mostrando ');
  const range=document.createElement('strong');range.textContent=number.format(from)+'–'+number.format(to);$('range').append(range,' de '+number.format(data.total)+' registros');
  $('grid').scrollTop=0;
  online(true);controls(false);
}

async function load(page=1,refresh=false) {
  if(state.busy) return;
  const until=refresh || !state.activeUntil?$('until-input').value:state.activeUntil;
  if(!until || ((refresh || !state.activeUntil) && !$('until-input').validity.valid)) {$('until-input').reportValidity();return;}
  const previous=state.page;
  controls(true);$('error').hidden=true;
  if(refresh && !state.job) $('export-panel').hidden=true;
  if(!$('tbody').children.length) {$('loading').hidden=false;$('table').hidden=true;}
  try {
    if(refresh || !state.columns.length) setMetadata(await api('/api/metadata?until='+until+(refresh?'&refresh=1':'')));
    const safePage=Math.min(Math.max(1,page),state.pages);
    const data=await api('/api/rows?page='+safePage+'&until='+until);
    state.activeUntil=until;
    render(data);updateFilterHint();
  } catch(err) {
    state.page=previous;$('page-input').value=previous;
    $('loading').hidden=true;online(false);error(err.message);controls(false);updateFilterHint();
    if(!state.columns.length) $('checked-at').textContent='Conexión no disponible';
  }
}

$('refresh').addEventListener('click',()=>load(1,true));
$('retry').addEventListener('click',()=>load(1,true));
$('until-input').addEventListener('input',updateFilterHint);
$('until-input').addEventListener('change',updateFilterHint);
$('first').addEventListener('click',()=>load(1));
$('prev').addEventListener('click',()=>load(state.page-1));
$('next').addEventListener('click',()=>load(state.page+1));
$('last').addEventListener('click',()=>load(state.pages));
$('page-form').addEventListener('submit',event=>{
  event.preventDefault();const page=Number($('page-input').value);
  if(!Number.isInteger(page) || page<1 || page>state.pages) {$('page-input').reportValidity();return;}
  load(page);
});
$('column-jump').addEventListener('change',event=>{
  if(!event.target.value) return;
  const th=document.getElementById('col-'+event.target.value);
  $('grid').scrollTo({left:th.offsetLeft-56,behavior:'smooth'});
  th.classList.remove('flash');void th.offsetWidth;th.classList.add('flash');
});
$('column-options').addEventListener('change',event=>{
  if(event.target.type!=='checkbox') return;
  const names=new Set(state.visibleColumns);
  if(event.target.checked) names.add(event.target.value);else names.delete(event.target.value);
  changeColumns(names);
});
$('select-all-columns').addEventListener('click',()=>changeColumns(state.columns));
$('clear-columns').addEventListener('click',()=>changeColumns([]));
$('column-search').addEventListener('input',event=>{
  const query=event.target.value.trim().toLocaleLowerCase('es-AR');
  for(const option of $('column-options').children) option.hidden=!option.dataset.search.includes(query);
});
document.addEventListener('click',event=>{
  if(!event.target.closest('#column-picker')) $('column-picker').open=false;
});

function showJob(job) {
  $('export-panel').hidden=false;
  const processed=number.format(job.processed || 0);const total=number.format(job.total ?? state.total);
  if(job.phase==='reading') $('export-progress').removeAttribute('value');
  else $('export-progress').value=job.total?Math.min(100,100*job.processed/job.total):0;
  $('export-title').textContent=job.status==='ready'?'Tu Excel está listo':job.phase==='finalizing'?'Comprimiendo el archivo Excel…':'Preparando Excel completo';
  const period=job.from && job.until?' · '+displayDate(job.from)+' al '+displayDate(job.until):'';
  $('export-detail').textContent=job.status==='ready'?processed+' registros · '+job.columns.length+' columnas'+period+' · '+number.format(Math.ceil(job.bytes/1024/1024))+' MB':job.phase==='reading'?'Preparando copia del período'+period+' · '+number.format(job.captured || 0)+' registros leídos':processed+' de '+total+' registros procesados'+period;
  $('download').hidden=job.status!=='ready';
  if(job.status==='ready') {$('export-progress').value=100;$('download').href='/api/exports/'+job.id+'/file';$('download').setAttribute('download','COLUN_CuadroResultado.xlsx');}
}

function schedulePoll(jobId,delay=2500) {
  setTimeout(async()=>{
    if(state.job!==jobId) return;
    try {
      const job=await api('/api/exports/'+jobId);
      if(!job.until){state.job=null;sessionStorage.removeItem('colun-export');$('export-panel').hidden=true;updateExportControl();return;}
      showJob(job);
      if(job.status==='error') throw new Error(job.error);
      if(job.status==='ready') {state.job=null;sessionStorage.removeItem('colun-export');updateExportControl();$('export').querySelector('span').textContent='Exportar a Excel';return;}
      schedulePoll(jobId);
    } catch(err) {
      error(err.message);
      if(err.message.includes('venció') || err.message.includes('completar la exportación') || err.message.includes('32.767')) {
        state.job=null;sessionStorage.removeItem('colun-export');updateExportControl();$('export').querySelector('span').textContent='Reintentar exportación';
        $('export-title').textContent='La exportación no se completó';
      } else {$('export-title').textContent='Reconectando con la exportación…';schedulePoll(jobId,8000);}
    }
  },delay);
}
$('export').addEventListener('click',async()=>{
  state.exportStarting=true;updateExportControl();$('error').hidden=true;$('download').hidden=true;
  $('export-panel').hidden=false;$('export-title').textContent='Preparando Excel completo…';
  $('export-detail').textContent=number.format(state.total)+' registros · '+visibleColumns().length+' columnas · '+
    displayDate(periodStart(state.activeUntil))+' al '+displayDate(state.activeUntil);
  $('export-progress').removeAttribute('value');
  $('export').querySelector('span').textContent='Generando Excel…';
  try {
    const path='/api/export-direct?until='+encodeURIComponent(state.activeUntil)+
      '&columns='+encodeURIComponent(JSON.stringify(visibleColumns()));
    const response=await fetch(path,{cache:'no-store'});
    if(!response.ok){let data;try{data=await response.json();}catch{}throw new Error(data?.error || 'No se pudo generar el Excel. Volvé a intentar.');}
    const file=await response.blob();
    if(!file.size) throw new Error('El Excel llegó vacío. Volvé a intentar.');
    if(state.downloadUrl) URL.revokeObjectURL(state.downloadUrl);
    state.downloadUrl=URL.createObjectURL(file);
    $('download').href=state.downloadUrl;$('download').download='COLUN_CuadroResultado.xlsx';
    $('download').hidden=false;$('export-progress').value=100;$('export-title').textContent='Tu Excel está listo';
    $('export-detail').textContent=number.format(state.total)+' registros · '+visibleColumns().length+' columnas · '+
      displayDate(periodStart(state.activeUntil))+' al '+displayDate(state.activeUntil)+' · '+number.format(Math.ceil(file.size/1024/1024))+' MB';
    $('download').click();
  } catch(err) {$('export-title').textContent='No se pudo crear el Excel';error(err.message);}
  finally {state.exportStarting=false;updateExportControl();$('export').querySelector('span').textContent='Exportar a Excel';}
});
const today=new Date();
$('until-input').value=[today.getFullYear(),String(today.getMonth()+1).padStart(2,'0'),String(today.getDate()).padStart(2,'0')].join('-');
updateFilterHint();
load();
sessionStorage.removeItem('colun-export');
