import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const browser=[process.env.CHROME_BIN,'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','/usr/bin/chromium','/usr/bin/google-chrome','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(name=>name&&existsSync(name));
test('compat film updates keep the same live author document and the same reserved height', {skip:!browser&&'Set CHROME_BIN to run the browser fixture'},async()=>{
    const directory=await mkdtemp(path.join(tmpdir(),'tipsy-film-test-'));
    try{const script=(await build({stdin:{resolveDir:process.cwd(),contents:`import {filmGeometry} from './src/compatibility/media-geometry';
        const article=document.querySelector('article'),iframe=article.querySelector('iframe');let loads=0;
        iframe.onload=()=>{if(++loads!==1)return;const doc=iframe.contentDocument;doc.querySelector('input').value='edited';const geometry=filmGeometry(()=>article,()=>{});
        const spec={key:'film',message:'one',swipe:'first',ratio:'3:2',folded:false,anchor:{kind:'paragraph',index:0}};
        geometry.sync([spec]);const slot=article.querySelector('.compat-native-media-slot'),before=slot.getBoundingClientRect().height;
        geometry.sync([spec]);const anchored=slot.previousElementSibling.textContent==='第一段'&&slot.nextElementSibling.textContent==='第二段';geometry.sync([{...spec,folded:true}]);geometry.sync([spec]);const after=slot.getBoundingClientRect().height;
        setTimeout(()=>{document.body.dataset.result=anchored&&before>0&&before===after&&loads===1&&iframe.contentDocument===doc&&doc.querySelector('input').value==='edited'?'passed':'failed';},30);};iframe.srcdoc='<input value="original">';`},bundle:true,write:false,format:'iife'})).outputFiles[0].text;
        const file=path.join(directory,'film.html');await writeFile(file,`<meta charset="utf-8"><article data-reading-swipe="first"><div class="mes_text"><div class="message-markdown"><p>第一段</p><p>第二段</p></div><iframe></iframe></div></article><script>${script}</script>`);
        const {stdout}=await promisify(execFile)(browser,['--headless','--disable-gpu','--disable-extensions','--no-first-run',`--user-data-dir=${path.join(directory,'profile')}`,'--virtual-time-budget=2000','--dump-dom',pathToFileURL(file).href],{timeout:45000,windowsHide:true,maxBuffer:2e6});assert.match(stdout,/<body data-result="passed">/);
    }finally{await rm(directory,{recursive:true,force:true,maxRetries:6,retryDelay:150});}
});
