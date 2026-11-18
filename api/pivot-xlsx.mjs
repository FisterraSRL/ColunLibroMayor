import {Readable} from 'node:stream';
import {ZipArchive} from 'archiver';

const ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const rel='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const axisNames=['cuentaraman','cuenta','empresa','dimensionvalor'];
const numberNames=new Set(['debemonedappal','habermonedappal','Saldo']);

function text(value){
  const string=String(value);
  if(string.length>32767) throw new Error('Un campo supera los 32.767 caracteres admitidos por Excel. No se truncó el dato.');
  return string.replace(/_x([0-9a-f]{4})_/gi,'_x005F_x$1_')
    .replace(/[\x00-\x08\x0b-\x1f&<>"']/g,c=>c==='&'?'&amp;':c==='<'?'&lt;':c==='>'?'&gt;':c==='"'?'&quot;':c==="'"?'&apos;':'_x'+c.charCodeAt(0).toString(16).padStart(4,'0').toUpperCase()+'_');
}
function col(index){let result='';for(let n=index+1;n;n=Math.floor((n-1)/26)) result=String.fromCharCode(65+(n-1)%26)+result;return result;}
function header(name,i){return '<c r="'+col(i)+'1" s="1" t="inlineStr"><is><t>'+text(name)+'</t></is></c>';}
function sourceCell(value,i,row,numeric){
  if(value===null || value===undefined) return '';
  const ref=col(i)+row;
  if(numeric && value!=='' && Number.isFinite(Number(value))) return '<c r="'+ref+'" s="2"><v>'+text(value)+'</v></c>';
  return '<c r="'+ref+'" t="inlineStr"><is><t xml:space="preserve">'+text(value)+'</t></is></c>';
}
function shared(value){return value===null || value===undefined?'<m/>':'<s v="'+text(value)+'"/>';}
function cacheValue(value,numeric){
  if(value===null || value===undefined) return '<m/>';
  if(numeric && value!=='' && Number.isFinite(Number(value))) return '<n v="'+text(value)+'"/>';
  return '<s v="'+text(value)+'"/>';
}
function pivotDefinition(columns,items){
  const idx=name=>columns.indexOf(name);
  const axis=axisNames.map(idx);
  if(axis.some(i=>i<0) || idx('Saldo')<0) throw new Error('Pivot columns missing');
  const fields=columns.map((name,i)=>{
    const axisType=axis.indexOf(i);
    if(axisType<0) return '<pivotField'+(name==='Saldo'?' dataField="1"':'')+' showAll="0"/>';
    const orientation=axisType<2?'axisRow':axisType===2?'axisCol':'axisPage';
    const members=items[name];
    return '<pivotField axis="'+orientation+'" compact="0" outline="0" showAll="0" defaultSubtotal="0"><items count="'+members.length+'">'+members.map((_,j)=>'<item x="'+j+'"/>').join('')+'</items></pivotField>';
  }).join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><pivotTableDefinition xmlns="'+ns+'" name="COLUN_Analisis" cacheId="1" dataCaption="Valores" updatedVersion="8" minRefreshableVersion="3" createdVersion="8" useAutoFormatting="1" applyWidthHeightFormats="0" compact="0" compactData="0" enableDrill="1" showHeaders="1"><location ref="A6:E24" firstHeaderRow="1" firstDataRow="3" firstDataCol="2" rowPageCount="1"/><pivotFields count="'+columns.length+'">'+fields+'</pivotFields><rowFields count="2"><field x="'+axis[0]+'"/><field x="'+axis[1]+'"/></rowFields><rowItems count="1"><i t="grand"><x/></i></rowItems><colFields count="1"><field x="'+axis[2]+'"/></colFields><colItems count="1"><i t="grand"><x/></i></colItems><pageFields count="1"><pageField fld="'+axis[3]+'" hier="-1"/></pageFields><dataFields count="1"><dataField name="Suma de Saldo" fld="'+idx('Saldo')+'" subtotal="sum" numFmtId="4"/></dataFields><pivotTableStyleInfo name="PivotStyleLight16" showRowHeaders="1" showColHeaders="1" showRowStripes="0" showColStripes="0" showLastColumn="1"/></pivotTableDefinition>';
}

export function createPivotXlsxStream(columns,total,sourceFactory,items,period,onProgress=async()=>{}){
  if(total>1048575) throw new Error('El período supera el límite de filas de una hoja de Excel. Elegí otro período o dimensión.');
  if(!columns.length || columns.at(-1)!=='Saldo') throw new Error('Pivot columns missing');
  for(const name of axisNames) if(!Array.isArray(items[name])) throw new Error('Pivot items missing');
  const zip=new ZipArchive({forceZip64:true,zlib:{level:1}});
  const append=(name,xml)=>zip.append(xml,{name});
  const types='application/vnd.openxmlformats-officedocument.spreadsheetml.';
  append('[Content_Types].xml','<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'+
    [['/xl/workbook.xml',types+'sheet.main+xml'],['/xl/styles.xml',types+'styles+xml'],['/xl/worksheets/sheet1.xml',types+'worksheet+xml'],['/xl/worksheets/sheet2.xml',types+'worksheet+xml'],['/xl/pivotTables/pivotTable1.xml',types+'pivotTable+xml'],['/xl/pivotCache/pivotCacheDefinition1.xml',types+'pivotCacheDefinition+xml'],['/xl/pivotCache/pivotCacheRecords1.xml',types+'pivotCacheRecords+xml']].map(([part,kind])=>'<Override PartName="'+part+'" ContentType="'+kind+'"/>').join('')+'</Types>');
  append('_rels/.rels','<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="'+rel+'/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  append('xl/workbook.xml','<?xml version="1.0"?><workbook xmlns="'+ns+'" xmlns:r="'+rel+'"><sheets><sheet name="Análisis" sheetId="1" r:id="rId1"/><sheet name="Datos" sheetId="2" r:id="rId2"/></sheets><pivotCaches><pivotCache cacheId="1" r:id="rId3"/></pivotCaches></workbook>');
  append('xl/_rels/workbook.xml.rels','<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="'+rel+'/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="'+rel+'/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="'+rel+'/pivotCacheDefinition" Target="pivotCache/pivotCacheDefinition1.xml"/><Relationship Id="rId4" Type="'+rel+'/styles" Target="styles.xml"/></Relationships>');
  append('xl/styles.xml','<?xml version="1.0"?><styleSheet xmlns="'+ns+'"><fonts count="2"><font><sz val="10"/><name val="Aptos"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="10"/><name val="Aptos"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF008DCC"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" applyFill="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>');
  append('xl/worksheets/sheet1.xml','<?xml version="1.0"?><worksheet xmlns="'+ns+'" xmlns:r="'+rel+'"><dimension ref="A1:E24"/><cols><col min="1" max="2" width="27" customWidth="1"/><col min="3" max="105" width="18" customWidth="1"/></cols><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>COLUN · Análisis por cuenta y empresa</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>'+text(period.from+' al '+period.until)+'</t></is></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>Saldo = Debe - Haber. Doble clic en un importe para ver los movimientos.</t></is></c></row></sheetData></worksheet>');
  append('xl/worksheets/_rels/sheet1.xml.rels','<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="'+rel+'/pivotTable" Target="../pivotTables/pivotTable1.xml"/></Relationships>');
  append('xl/pivotTables/pivotTable1.xml',pivotDefinition(columns,items));
  append('xl/pivotTables/_rels/pivotTable1.xml.rels','<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="'+rel+'/pivotCacheDefinition" Target="../pivotCache/pivotCacheDefinition1.xml"/></Relationships>');
  const fields=columns.map(name=>'<cacheField name="'+text(name)+'" numFmtId="0"><sharedItems'+(axisNames.includes(name)?' count="'+items[name].length+'"':' count="0"')+'>'+ (axisNames.includes(name)?items[name].map(shared).join(''):'')+'</sharedItems></cacheField>').join('');
  append('xl/pivotCache/pivotCacheDefinition1.xml','<?xml version="1.0"?><pivotCacheDefinition xmlns="'+ns+'" xmlns:r="'+rel+'" r:id="rId1" refreshOnLoad="1" enableRefresh="1" saveData="1" createdVersion="8" refreshedVersion="8" minRefreshableVersion="3" recordCount="'+total+'"><cacheSource type="worksheet"><worksheetSource ref="A1:'+col(columns.length-1)+(total+1)+'" sheet="Datos"/></cacheSource><cacheFields count="'+columns.length+'">'+fields+'</cacheFields></pivotCacheDefinition>');
  append('xl/pivotCache/_rels/pivotCacheDefinition1.xml.rels','<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="'+rel+'/pivotCacheRecords" Target="pivotCacheRecords1.xml"/></Relationships>');
  const lookup=Object.fromEntries(axisNames.map(name=>[name,new Map(items[name].map((value,index)=>[JSON.stringify(value),index]))]));
  async function* dataSheet(){
    yield '<?xml version="1.0"?><worksheet xmlns="'+ns+'"><dimension ref="A1:'+col(columns.length-1)+(total+1)+'"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="'+columns.length+'" width="22" customWidth="1"/></cols><sheetData><row r="1">'+columns.map(header).join('')+'</row>';
    let count=0,buffer='';
    for await(const values of sourceFactory()){
      if(values.length!==columns.length) throw new Error('Snapshot shape mismatch');
      count++;buffer+='<row r="'+(count+1)+'">'+values.map((value,i)=>sourceCell(value,i,count+1,numberNames.has(columns[i]))).join('')+'</row>';
      if(count%200===0){yield buffer;buffer='';}
      if(count%10000===0) await onProgress(count,'writing');
    }
    if(buffer) yield buffer;
    if(count!==total) throw new Error('Snapshot count mismatch');
    yield '</sheetData><autoFilter ref="A1:'+col(columns.length-1)+(total+1)+'"/></worksheet>';
  }
  async function* cacheRecords(){
    yield '<?xml version="1.0"?><pivotCacheRecords xmlns="'+ns+'" count="'+total+'">';
    let count=0,buffer='';
    for await(const values of sourceFactory()){
      if(values.length!==columns.length) throw new Error('Snapshot shape mismatch');
      buffer+='<r>'+values.map((value,i)=>{
        const name=columns[i];
        if(axisNames.includes(name)){
          const index=lookup[name].get(JSON.stringify(value));
          if(index===undefined) throw new Error('Pivot item missing');
          return '<x v="'+index+'"/>';
        }
        return cacheValue(value,numberNames.has(name));
      }).join('')+'</r>';
      count++;if(count%200===0){yield buffer;buffer='';}
      if(count%10000===0) await onProgress(count,'cache');
    }
    if(buffer) yield buffer;
    if(count!==total) throw new Error('Snapshot count mismatch');
    yield '</pivotCacheRecords>';
  }
  const data=Readable.from(dataSheet(),{objectMode:false});
  const cache=Readable.from(cacheRecords(),{objectMode:false});
  for(const input of [data,cache]) input.on('error',error=>zip.destroy(error));
  zip.append(data,{name:'xl/worksheets/sheet2.xml'});
  zip.append(cache,{name:'xl/pivotCache/pivotCacheRecords1.xml'});
  zip.once('error',error=>{data.destroy(error);cache.destroy(error);});
  const completion=new Promise((resolve,reject)=>{zip.once('end',resolve);zip.once('error',reject);});
  completion.catch(()=>{});
  zip.finalize().catch(error=>zip.destroy(error));
  return {stream:zip,completion};
}
