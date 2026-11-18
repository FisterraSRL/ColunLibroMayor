import {mkdir,copyFile,readFile,writeFile} from 'node:fs/promises';

// Este commit incorporó la etiqueta visual; el siguiente inicia en 1.0.0.
const versionBaseCommit = '75c372ef1c44ad05f1552eb8fe75120a1f927478';
const commit = process.env.VERCEL_GIT_COMMIT_SHA;
let version = '1.0.0';
if (process.env.VERCEL) {
  if (!commit || !/^[a-f0-9]{40}$/i.test(commit)) {
    throw new Error('Falta VERCEL_GIT_COMMIT_SHA para calcular la versión.');
  }
  const url = `https://api.github.com/repos/FisterraSRL/ColunLibroMayor/compare/${versionBaseCommit}...${commit}`;
  const response = await fetch(url, {
    headers: {Accept: 'application/vnd.github+json', 'User-Agent': 'colun-libro-mayor-build'},
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`No se pudo consultar la historia de GitHub (${response.status}).`);
  const comparison = await response.json();
  if (!['ahead', 'identical'].includes(comparison.status) || !Number.isInteger(comparison.total_commits)) {
    throw new Error('El commit publicado no desciende de la versión base.');
  }
  version = `1.0.${Math.max(0, comparison.total_commits - 1)}`;
}
await mkdir('public',{recursive:true});
for(const name of ['index.html','app.js','analysis.js','style.css','colun-logo.png']) await copyFile('static/'+name,'public/'+name);
let html=await readFile('public/index.html','utf8');
const versionLabel = '<span id="app-version" class="version-tag">v1.0.0</span>';
if (!html.includes(versionLabel)) throw new Error('Falta la etiqueta de versión.');
html = html.replace(versionLabel, `<span id="app-version" class="version-tag">v${version}</span>`);
await writeFile('public/index.html', html);
if(!html.includes('id="table"') || !html.includes('id="export"')) throw new Error('La interfaz está incompleta.');
console.log(`Vercel: versión ${version}, interfaz estática y API PostgreSQL listas.`);
