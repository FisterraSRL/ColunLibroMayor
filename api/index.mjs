import {randomBytes} from 'node:crypto';
import {Readable} from 'node:stream';
import {gzipSync,createGunzip} from 'node:zlib';
import readline from 'node:readline';
import {ZipArchive} from 'archiver';
import pg from 'pg';
import QueryStream from 'pg-query-stream';
import {put,get,del,BlobPreconditionFailedError} from '@vercel/blob';
import {waitUntil,attachDatabasePool} from '@vercel/functions';

const TABLE='public.colun_colun_cuadroresultado';
const PAGE_SIZE=50;
const SNAPSHOT_BATCH=10000;
const EXCEL_LIMIT=1048575;
const JOB_TTL=24*60*60*1000;
const LEASE_MS=260000;
let pool;
let cached;
const pending=new Set();
const jsonHeaders={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};

function databasePool(){
  if(!process.env.PGPASSWORD) throw new Error('DB_NOT_CONFIGURED');
  if(!pool){
    pool=new pg.Pool({host:process.env.PGHOST || 'finnegans-bi-1.postgres.database.azure.com',
      port:Number(process.env.PGPORT || 5432),database:process.env.PGDATABASE || 'finnegansbi',
      user:process.env.PGUSER || 'colunuser',password:process.env.PGPASSWORD,
      ssl:{rejectUnauthorized:true},max:3,idleTimeoutMillis:5000,connectionTimeoutMillis:15000,
      application_name:'COLUN_Vercel_ReadOnly',statement_timeout:55000});
    pool.on('error',e=>console.error('PostgreSQL pool:',e.code || e.name));
    attachDatabasePool(pool);
  }
  return pool;
}

async function transaction(fn,exporting=false){
  const client=await databasePool().connect();
  try{
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query(exporting?"SET LOCAL statement_timeout='245s'":"SET LOCAL statement_timeout='50s'");
    return await fn(client);
  }finally{
    try{await client.query('ROLLBACK');}finally{client.release();}
  }
}

async function metadata(refresh=false){
  if(cached && !refresh && Date.now()-cached.created<60000) return cached.data;
  const data=await transaction(async client=>{
    const columns=(await client.query('SELECT * FROM '+TABLE+' LIMIT 0')).fields.map(f=>f.name);
    const total=Number((await client.query('SELECT count(*) AS total FROM '+TABLE)).rows[0].total);
    return {columns,total,pageSize:PAGE_SIZE,pages:Math.max(1,Math.ceil(total/PAGE_SIZE)),table:TABLE,checkedAt:new Date().toISOString()};
  });
  cached={created:Date.now(),data};return data;
}

async function pageRows(page){
  const meta=await metadata();
  if(!Number.isSafeInteger(page) || page<1 || page>meta.pages) throw new Error('INVALID_PAGE');
  const rows=await transaction(async client=>(await client.query({
    text:'SELECT * FROM '+TABLE+' ORDER BY ctid LIMIT $1 OFFSET $2',
    values:[PAGE_SIZE,(page-1)*PAGE_SIZE],rowMode:'array'})).rows);
  return {...meta,page,rows};
}

function jobPath(id){return 'colun/exports/'+id+'/state.json';}
async function readState(id){
  const result=await get(jobPath(id),{access:'private',useCache:false});
  if(!result || result.statusCode!==200) return null;
  return {job:await new Response(result.stream).json(),etag:result.blob.etag};
}
async function saveState(job,etag){
  return put(jobPath(job.id),JSON.stringify({...job,updatedAt:new Date().toISOString()}),{
    access:'private',addRandomSuffix:false,allowOverwrite:!!etag,...(etag?{ifMatch:etag}:{}),
    contentType:'application/json',cacheControlMaxAge:60});
}

async function startExport(){
  const path='colun/current-export.json';
  const pointer=await get(path,{access:'private',useCache:false});
  let previousJob;
  if(pointer?.stream){
    const current=await new Response(pointer.stream).json();
    const state=await readState(current.id);
    previousJob=state?.job;
    if(state && state.job.expiresAt>Date.now() && ['queued','running'].includes(state.job.status)){
      scheduleStage(current.id);return state.job;
    }
  }
  const id=randomBytes(16).toString('hex');
  const job={id,status:'queued',phase:'reading',processed:0,captured:0,total:0,
    createdAt:new Date().toISOString(),expiresAt:Date.now()+JOB_TTL};
  await saveState(job);
  try{
    await put(path,JSON.stringify({id}),{access:'private',addRandomSuffix:false,
      allowOverwrite:!!pointer,...(pointer?{ifMatch:pointer.blob.etag}:{}),contentType:'application/json',cacheControlMaxAge:60});
  }catch(e){
    if(e instanceof BlobPreconditionFailedError){
      const latest=await get(path,{access:'private',useCache:false});
      const active=await new Response(latest.stream).json();
      const state=await readState(active.id);
      if(state){scheduleStage(active.id);return state.job;}
    }
    throw e;
  }
  // Only the latest export is retained, as in the original local gateway.
  if(previousJob){
    const obsolete=[...(previousJob.parts || []),...(previousJob.file?[previousJob.file]:[]),jobPath(previousJob.id)];
    await del(obsolete).catch(e=>console.error('Export cleanup:',e.name));
  }
  scheduleStage(id);return job;
}
function publicState(job){
  const {parts,file,leaseUntil,...safe}=job;return safe;
}

async function claim(id){
  const state=await readState(id);
  if(!state) return null;
  const {job,etag}=state;
  if(job.status==='ready' || job.status==='error') return null;
  if(job.leaseUntil && Date.now()<job.leaseUntil) return null;
  if(job.status==='running'){
    job.status='error';job.error='No se pudo completar la exportación dentro del tiempo disponible. Volvé a intentar.';
    await saveState(job,etag);return null;
  }
  job.status='running';job.leaseUntil=Date.now()+LEASE_MS;
  const written=await saveState(job,etag);
  return {job,etag:written.etag};
}

async function runStage(id){
  let state;
  try{state=await claim(id);}catch(e){if(e instanceof BlobPreconditionFailedError) return;throw e;}
  if(!state) return;
  const job=state.job;
  const update=async values=>{
    Object.assign(job,values);const result=await saveState(job,state.etag);state.etag=result.etag;
  };
  const abort=new AbortController();
  const timer=setTimeout(()=>abort.abort(new Error('Export time limit')),245000);
  try{
    if(job.phase==='reading'){
      const parts=[];let processed=0;let lines=[];
      await transaction(async client=>{
        job.columns=(await client.query('SELECT * FROM '+TABLE+' LIMIT 0')).fields.map(f=>f.name);
        job.total=Number((await client.query('SELECT count(*) AS n FROM '+TABLE)).rows[0].n);
        await update({total:job.total,columns:job.columns,processed:0});
        const stream=client.query(new QueryStream('SELECT * FROM '+TABLE,[],{rowMode:'array',batchSize:2048}));
        const onAbort=()=>stream.destroy(abort.signal.reason);
        abort.signal.addEventListener('abort',onAbort,{once:true});
        const flush=async()=>{
          if(!lines.length) return;
          const body=gzipSync(Buffer.from(lines.join('\n')+'\n'),{level:1});lines=[];
          const part=await put('colun/exports/'+id+'/snapshot-'+String(parts.length).padStart(4,'0')+'.ndjson.gz',body,
            {access:'private',addRandomSuffix:false,contentType:'application/gzip',abortSignal:abort.signal});
          parts.push(part.url);await update({captured:processed,parts:[...parts]});
        };
        try{
          for await(const row of stream){lines.push(JSON.stringify(row));processed++;if(lines.length===SNAPSHOT_BATCH) await flush();}
          await flush();
        }finally{abort.signal.removeEventListener('abort',onAbort);stream.destroy();}
        if(processed!==job.total) throw new Error('Snapshot count mismatch');
      },true);
      // PostgreSQL is released before the independent workbook stage starts.
      await update({parts,status:'queued',phase:'writing',processed:0,leaseUntil:null});
    }else{
      const rows=snapshotRows(job.parts,abort.signal);
      const book=createXlsxStream(job.columns,job.total,rows,async n=>update({processed:n,phase:n===job.total?'finalizing':'writing'}));
      abort.signal.addEventListener('abort',()=>book.stream.destroy(abort.signal.reason),{once:true});
      const uploaded=await put('colun/exports/'+id+'/COLUN_CuadroResultado.xlsx',book.stream,
        {access:'private',addRandomSuffix:false,multipart:true,
         contentType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',abortSignal:abort.signal});
      await book.completion;
      const info=await get(uploaded.url,{access:'private',useCache:false});
      const bytes=info?.blob.size || 0;await info?.stream?.cancel();
      await update({file:uploaded.url,status:'ready',phase:'ready',processed:job.total,bytes,
        sheets:Math.max(1,Math.ceil(job.total/EXCEL_LIMIT)),completedAt:new Date().toISOString(),leaseUntil:null});
      if(job.parts.length) await del(job.parts);
    }
  }catch(e){
    abort.abort(e);
    console.error('Export stage:',e.code || e.name);
    await update({status:'error',leaseUntil:null,error:e.message?.startsWith('Un campo')?e.message:'No se pudo completar la exportación. Volvé a intentar.'}).catch(()=>{});
  }finally{clearTimeout(timer);}
}

function scheduleStage(id){
  if(pending.has(id)) return;
  pending.add(id);
  const work=runStage(id).catch(e=>console.error('Export dispatch:',e.code || e.name)).finally(()=>pending.delete(id));
  if(process.env.VERCEL) waitUntil(work);
}

async function* snapshotRows(parts,signal){
  for(const url of parts){
    const result=await get(url,{access:'private',useCache:false,abortSignal:signal});
    if(!result?.stream) throw new Error('Missing snapshot part');
    const raw=Readable.fromWeb(result.stream).pipe(createGunzip());
    const lines=readline.createInterface({input:raw,crlfDelay:Infinity});
    try{for await(const line of lines){if(line) yield JSON.parse(line);}}
    finally{lines.close();raw.destroy();}
  }
}

function columnName(index){let result='';for(let n=index+1;n;n=Math.floor((n-1)/26)) result=String.fromCharCode(65+(n-1)%26)+result;return result;}
export function xmlText(value){
  let text=String(value);
  if(text.length>32767) throw new Error('Un campo supera los 32.767 caracteres admitidos por Excel. No se truncó el dato.');
  text=text.replace(/_x([0-9a-f]{4})_/gi,'_x005F_x$1_');
  return text.replace(/[\x00-\x08\x0b-\x1f&<>]/g,c=>c==='&'?'&amp;':c==='<'?'&lt;':c==='>'?'&gt;':'_x'+c.charCodeAt(0).toString(16).padStart(4,'0').toUpperCase()+'_');
}

export function createXlsxStream(columns,total,source,onProgress=async()=>{},sheetLimit=EXCEL_LIMIT){
  const zip=new ZipArchive({forceZip64:true,zlib:{level:1}});
  const iterator=source[Symbol.asyncIterator]();
  const sheets=Math.max(1,Math.ceil(total/sheetLimit));let processed=0;
  const names=columns.map((_,i)=>columnName(i));
  const cell=(value,index,row,header=false)=>value===null || value===undefined?'':
    '<c r="'+names[index]+row+'" s="'+(header?1:0)+'" t="inlineStr"><is><t xml:space="preserve">'+xmlText(value)+'</t></is></c>';
  const ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const rel='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  zip.append('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'+Array.from({length:sheets},(_,i)=>'<Override PartName="/xl/worksheets/sheet'+(i+1)+'.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('')+'</Types>',{name:'[Content_Types].xml'});
  zip.append('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="'+rel+'/officeDocument" Target="xl/workbook.xml"/></Relationships>',{name:'_rels/.rels'});
  zip.append('<?xml version="1.0"?><workbook xmlns="'+ns+'" xmlns:r="'+rel+'"><sheets>'+Array.from({length:sheets},(_,i)=>'<sheet name="CuadroResultado'+(i?'_'+(i+1):'')+'" sheetId="'+(i+1)+'" r:id="rId'+(i+1)+'"/>').join('')+'</sheets></workbook>',{name:'xl/workbook.xml'});
  zip.append('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+Array.from({length:sheets},(_,i)=>'<Relationship Id="rId'+(i+1)+'" Type="'+rel+'/worksheet" Target="worksheets/sheet'+(i+1)+'.xml"/>').join('')+'<Relationship Id="rIdStyles" Type="'+rel+'/styles" Target="styles.xml"/></Relationships>',{name:'xl/_rels/workbook.xml.rels'});
  zip.append('<?xml version="1.0"?><styleSheet xmlns="'+ns+'"><fonts count="2"><font><sz val="10"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="10"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF147966"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="49" fontId="1" fillId="2" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',{name:'xl/styles.xml'});
  let previousSheet=Promise.resolve();
  const worksheetStreams=[];
  for(let sheet=0;sheet<sheets;sheet++){
    const expected=Math.min(sheetLimit,total-sheet*sheetLimit);
    const gate=previousSheet;let releaseSheet;
    previousSheet=new Promise(resolve=>{releaseSheet=resolve;});
    async function* worksheet(){
      await gate;
      try{
      yield '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="'+ns+'"><dimension ref="A1:'+names.at(-1)+(expected+1)+'"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="'+columns.length+'" width="24" customWidth="1"/></cols><sheetData><row r="1">'+columns.map((v,i)=>cell(v,i,1,true)).join('')+'</row>';
      let buffer='';
      for(let row=0;row<expected;row++){
        const next=await iterator.next();
        if(next.done || next.value.length!==columns.length) throw new Error('Snapshot shape mismatch');
        buffer+='<row r="'+(row+2)+'">'+next.value.map((v,i)=>cell(v,i,row+2)).join('')+'</row>';
        processed++;
        if(row%200===199){yield buffer;buffer='';}
        if(processed%10000===0) await onProgress(processed);
      }
      if(buffer) yield buffer;
      if(sheet===sheets-1){if(!(await iterator.next()).done || processed!==total) throw new Error('Snapshot count mismatch');await onProgress(processed);}
      yield '</sheetData><autoFilter ref="A1:'+names.at(-1)+(expected+1)+'"/></worksheet>';
      }finally{releaseSheet();}
    }
    const input=Readable.from(worksheet(),{objectMode:false});
    input.on('error',e=>zip.destroy(e));worksheetStreams.push(input);
    zip.append(input,{name:'xl/worksheets/sheet'+(sheet+1)+'.xml'});
  }
  zip.once('error',error=>{for(const input of worksheetStreams) input.destroy(error);});
  zip.once('close',()=>{Promise.resolve(iterator.return?.()).catch(()=>{});});
  const completion=new Promise((resolve,reject)=>{zip.once('end',resolve);zip.once('error',reject);});
  completion.catch(()=>{});
  zip.finalize().catch(e=>zip.destroy(e));
  return {stream:zip,completion};
}

function send(res,status,data){res.writeHead(status,jsonHeaders);res.end(JSON.stringify(data));}
function errorMessage(e){
  if(e.message==='DB_NOT_CONFIGURED') return 'Falta configurar la conexión a PostgreSQL en Vercel.';
  if(e.code==='28P01') return 'PostgreSQL rechazó las credenciales configuradas.';
  if(['28000','42501'].includes(e.code)) return 'PostgreSQL rechazó el acceso. Revisá los permisos y Seguridad IP de Finnegans.';
  if(['55P03','57014'].includes(e.code)) return 'Finnegans está actualizando los datos. Esperá unos segundos y volvé a actualizar.';
  return 'No se pudo consultar PostgreSQL desde Vercel. Revisá la conexión y Seguridad IP de Finnegans.';
}

export default async function handler(req,res){
  const url=new URL(req.url,'https://'+(req.headers.host || 'localhost'));
  try{
    if(req.method==='GET' && url.pathname==='/api/health') return send(res,200,{ok:true,platform:'vercel',databaseConfigured:!!process.env.PGPASSWORD,exportsConfigured:!!process.env.BLOB_READ_WRITE_TOKEN || !!process.env.BLOB_STORE_ID});
    if(req.method==='GET' && url.pathname==='/api/metadata') return send(res,200,await metadata(url.searchParams.get('refresh')==='1'));
    if(req.method==='GET' && url.pathname==='/api/rows') return send(res,200,await pageRows(Number(url.searchParams.get('page') || 1)));
    if(req.method==='POST' && url.pathname==='/api/exports'){
      if(!process.env.BLOB_READ_WRITE_TOKEN && !process.env.BLOB_STORE_ID) return send(res,503,{error:'Falta conectar el almacenamiento privado de exportaciones en Vercel.'});
      const origin=req.headers.origin;
      if(origin && new URL(origin).host!==req.headers.host) return send(res,403,{error:'Origen no permitido.'});
      return send(res,202,publicState(await startExport()));
    }
    const match=url.pathname.match(/^\/api\/exports\/([a-f0-9]{32})(\/file)?$/);
    if(req.method==='GET' && match){
      const state=await readState(match[1]);
      if(!state || state.job.expiresAt<Date.now()) return send(res,404,{error:'La exportación venció o no existe.'});
      const job=state.job;
      if(!match[2]){scheduleStage(job.id);return send(res,200,publicState(job));}
      if(job.status!=='ready') return send(res,409,{error:'El archivo todavía no está listo.'});
      const result=await get(job.file,{access:'private',useCache:false});
      if(!result?.stream) return send(res,404,{error:'El archivo ya no está disponible.'});
      res.writeHead(200,{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition':'attachment; filename="COLUN_CuadroResultado.xlsx"','Cache-Control':'no-store'});
      const stream=Readable.fromWeb(result.stream);stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);return;
    }
    send(res,404,{error:'Recurso no encontrado.'});
  }catch(e){
    console.error('COLUN API:',e.code || e.name);
    if(e.message==='INVALID_PAGE') return send(res,400,{error:'Número de página inválido.'});
    if(!res.headersSent) send(res,503,{error:errorMessage(e)});
    else res.destroy();
  }
}
