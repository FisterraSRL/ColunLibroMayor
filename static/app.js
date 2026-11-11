const $ = id => document.getElementById(id);
const number = new Intl.NumberFormat('es-AR');
const state = {page:1,pages:1,total:0,columns:[],busy:false,job:null};
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
function controls(busy) {
  state.busy=busy;
  $('refresh').disabled=busy;
  $('first').disabled=$('prev').disabled=busy || state.page<=1;
  $('next').disabled=$('last').disabled=busy || state.page>=state.pages;
  $('page-input').disabled=busy || !state.columns.length;
  $('column-jump').disabled=busy || !state.columns.length;
  $('grid').setAttribute('aria-busy',String(busy));
  $('grid').classList.toggle('is-loading',busy);
  $('refresh').querySelector('span').textContent=busy?'Consultando…':'Actualizar';
}

function setMetadata(data) {
  state.columns=data.columns;state.total=data.total;state.pages=data.pages;
  $('total').textContent=number.format(data.total);
  $('columns-count').textContent=number.format(data.columns.length);
  $('pages').textContent='de '+number.format(data.pages);
  $('page-input').max=data.pages;
  const checked=new Date(data.checkedAt);
  $('checked-at').textContent='Última consulta · '+checked.toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  $('checked-at').title=checked.toLocaleString('es-AR');
  const selector=$('column-jump');selector.replaceChildren(new Option('Ir a una columna…',''));
  for(const name of data.columns) selector.add(new Option(titles[name] || name,name));
  $('export').disabled=!!state.job;
}

function render(data) {
  state.page=data.page;state.pages=data.pages;state.total=data.total;
  const cols=[...preferred.filter(x=>data.columns.includes(x)),...data.columns.filter(x=>!preferred.includes(x))];
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
    const rowNum=document.createElement('td');rowNum.textContent=number.format((data.page-1)*50+index+1);tr.append(rowNum);
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
  $('loading').hidden=true;$('table').hidden=data.rows.length===0;$('empty').hidden=data.rows.length!==0;
  $('page-label').textContent='Página '+number.format(data.page)+' de '+number.format(data.pages);
  $('page-input').value=data.page;
  const from=data.rows.length?(data.page-1)*50+1:0;const to=(data.page-1)*50+data.rows.length;
  $('range').replaceChildren('Mostrando ');
  const range=document.createElement('strong');range.textContent=number.format(from)+'–'+number.format(to);$('range').append(range,' de '+number.format(data.total)+' registros');
  $('grid').scrollTop=0;
  online(true);controls(false);
}

async function load(page=1,refresh=false) {
  if(state.busy) return;
  const previous=state.page;
  controls(true);$('error').hidden=true;
  if(!$('tbody').children.length) {$('loading').hidden=false;$('table').hidden=true;}
  try {
    if(refresh || !state.columns.length) setMetadata(await api('/api/metadata'+(refresh?'?refresh=1':'')));
    const safePage=Math.min(Math.max(1,page),state.pages);
    render(await api('/api/rows?page='+safePage));
  } catch(err) {
    state.page=previous;$('page-input').value=previous;
    $('loading').hidden=true;online(false);error(err.message);controls(false);
    if(!state.columns.length) $('checked-at').textContent='Pasarela no disponible';
  }
}

$('refresh').addEventListener('click',()=>load(1,true));
$('retry').addEventListener('click',()=>load(state.page,true));
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

function showJob(job) {
  $('export-panel').hidden=false;
  const processed=number.format(job.processed || 0);const total=number.format(job.total || state.total);
  if(job.phase==='reading') $('export-progress').removeAttribute('value');
  else $('export-progress').value=job.total?Math.min(100,100*job.processed/job.total):0;
  $('export-title').textContent=job.status==='ready'?'Tu Excel está listo':job.phase==='finalizing'?'Comprimiendo el archivo Excel…':'Preparando Excel completo';
  $('export-detail').textContent=job.status==='ready'?processed+' registros · '+state.columns.length+' columnas · '+number.format(Math.ceil(job.bytes/1024/1024))+' MB':job.phase==='reading'?'Copiando '+total+' registros del origen. Luego se liberará la conexión para generar Excel.':processed+' de '+total+' registros procesados';
  $('download').hidden=job.status!=='ready';
  if(job.status==='ready') {$('export-progress').value=100;$('download').href='/api/exports/'+job.id+'/file';$('download').setAttribute('download','COLUN_CuadroResultado.xlsx');}
}

function schedulePoll(jobId,delay=2500) {
  setTimeout(async()=>{
    if(state.job!==jobId) return;
    try {
      const job=await api('/api/exports/'+jobId);showJob(job);
      if(job.status==='error') throw new Error(job.error);
      if(job.status==='ready') {state.job=null;$('export').disabled=false;$('export').querySelector('span').textContent='Exportar a Excel';return;}
      schedulePoll(jobId);
    } catch(err) {
      error(err.message);
      if(err.message.includes('venció') || err.message.includes('completar la exportación') || err.message.includes('32.767')) {
        state.job=null;$('export').disabled=false;$('export').querySelector('span').textContent='Reintentar exportación';
        $('export-title').textContent='La exportación no se completó';
      } else {$('export-title').textContent='Reconectando con la exportación…';schedulePoll(jobId,8000);}
    }
  },delay);
}
$('export').addEventListener('click',async()=>{
  $('export').disabled=true;$('error').hidden=true;$('download').hidden=true;
  $('export').querySelector('span').textContent='Generando Excel…';
  try {
    const job=await api('/api/exports',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    state.job=job.id;showJob(job);schedulePoll(job.id);
  } catch(err) {error(err.message);$('export').disabled=false;$('export').querySelector('span').textContent='Exportar a Excel';}
});
load();
