import {mkdir,copyFile,readFile} from 'node:fs/promises';
await mkdir('public',{recursive:true});
for(const name of ['index.html','app.js','style.css','colun-logo.png']) await copyFile('static/'+name,'public/'+name);
const html=await readFile('public/index.html','utf8');
if(!html.includes('id="table"') || !html.includes('id="export"')) throw new Error('La interfaz está incompleta.');
console.log('Vercel: interfaz estática y API PostgreSQL listas.');
