/* global process, fetch, AbortSignal, Buffer, localStorage, sessionStorage, URL, console */
// Manual, isolated, read-only presentation capture. No wallet/chain operations.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
const out=process.env.CAPTURE_DIR;
const root=process.env.SOURCE_ROOT;
if(!out||!root)throw Error('Explicit CAPTURE_DIR and SOURCE_ROOT required');
const manifest=JSON.parse(await fs.readFile(path.join(root,'scripts/capture-manifest.json'),'utf8'));
const hash=b=>createHash('sha256').update(b).digest('hex');
const receipt={status:'failure',sourceCommit:manifest.sourceCommit,workflowCommit:process.env.GITHUB_SHA,sourceHashes:{},assetHashes:{},states:[],violations:[],videoPath:null,error:null};
await fs.mkdir(out,{recursive:true});
let browser,context,page,video;
const begun=Date.now();
const save=()=>fs.writeFile(path.join(out,'capture-receipt.json'),JSON.stringify(receipt,null,2));
async function getBytes(url){const r=await fetch(url,{signal:AbortSignal.timeout(30000),headers:{'Cache-Control':'no-cache'}});if(!r.ok)throw Error(`Public asset HTTP ${r.status}`);return Buffer.from(await r.arrayBuffer());}
async function observed(label,holdMs=3500){
 const state=await page.evaluate(()=>({appStatePresent:localStorage.getItem('silenttip-state-v1')!==null,sessionStatePresent:sessionStorage.length!==0}));
 receipt.states.push({label,seconds:(Date.now()-begun)/1000,...state});
 if(state.appStatePresent||state.sessionStatePresent||receipt.violations.length)throw Error('Unexpected state or mutation attempt');
 await page.screenshot({path:path.join(out,`${label}.png`)});
 // Genuine readability hold after the observed state, not simulated activity.
 await page.waitForTimeout(holdMs);
 await save();
}
try{
 for(const [file,expected] of Object.entries(manifest.sourceHashes)){
  const actual=hash(await fs.readFile(path.join(root,file)));receipt.sourceHashes[file]=actual;
  if(actual!==expected)throw Error('Audited source hash mismatch: '+file);
 }
 const html=await getBytes(manifest.demo);receipt.assetHashes.indexHtml=hash(html);
 const asset=html.toString().match(/src="\.\/([^"\s]+\.js)"/)?.[1];
 if(asset!==manifest.assetPath)throw Error('Live asset path differs from reviewed deployment');
 const js=await getBytes(new URL(asset,manifest.demo));receipt.assetHashes.javascript=hash(js);
 if(hash(js)!==manifest.assetSha256)throw Error('Live asset hash differs from reviewed deployment');
 if(!html.toString().includes('./'+manifest.cssPath))throw Error('Live stylesheet path differs from reviewed deployment');
 receipt.assetHashes.stylesheet=hash(await getBytes(new URL(manifest.cssPath,manifest.demo)));
 if(receipt.assetHashes.stylesheet!==manifest.cssSha256)throw Error('Live stylesheet hash differs from reviewed deployment');
 receipt.assetHashes.regtestProof=hash(await getBytes(new URL('regtest-proof.mp4',manifest.demo)));
 if(receipt.assetHashes.regtestProof!==manifest.regtestProofSha256)throw Error('Existing regtest proof changed');
 browser=await chromium.launch({headless:true});
 context=await browser.newContext({viewport:{width:1920,height:1080},recordVideo:{dir:out,size:{width:1920,height:1080}}});
 await context.route('**/*',async route=>{
  if(!['GET','HEAD'].includes(route.request().method())){receipt.violations.push('HTTP mutation blocked');return route.abort();}
  return route.continue();
 });
 page=await context.newPage();video=page.video();
 await page.routeWebSocket(/wss:\/\//,ws=>{
  if(!manifest.relays.includes(ws.url().replace(/\/$/,''))){receipt.violations.push('Unexpected relay blocked');ws.close();return;}
  const server=ws.connectToServer();
  ws.onMessage(message=>{
   let frame;try{frame=JSON.parse(String(message));}catch{ /* Malformed frames are blocked below. */ }
   if(!Array.isArray(frame)||!['REQ','CLOSE'].includes(frame[0])){receipt.violations.push('Non-read Nostr frame blocked');return;}
   server.send(message); // Actual relay responses pass through unchanged.
  });
 });
 await page.goto(manifest.demo,{waitUntil:'networkidle'});
 await page.getByText('One reusable Nostr tipping identity.',{exact:false}).waitFor();
 await observed('01-receive');
 await page.getByRole('button',{name:'Tip',exact:true}).click();
 await observed('02-tip-empty',2000);
 await page.getByPlaceholder('npub1… / name@domain / tsp1…').fill(manifest.npub);
 await page.getByRole('button',{name:'Resolve',exact:true}).click();
 await page.getByText('Binding verified.',{exact:true}).waitFor({timeout:30000});
 await page.getByText('signature valid · event '+manifest.eventId.slice(0,16)+'…',{exact:true}).waitFor();
 await observed('03-binding-verified',6000);
 await page.getByRole('button',{name:'Scan',exact:true}).click();
 await page.getByText('Create or restore an identity on the Receive tab first.').waitFor();
 await observed('04-scan-instructions');
 await page.getByRole('button',{name:'Receive',exact:true}).click();
 await observed('05-return-receive');
 receipt.status='success';
}catch(error){
 receipt.error=String(error.message||error);process.exitCode=1;
 // Do not falsify relay failures, rerun actions, or dump private state.
}finally{
 if(context)await context.close();
 if(video)receipt.videoPath=await video.path();
 if(browser)await browser.close();
 await save();
 console.log(JSON.stringify({status:receipt.status,videoPath:receipt.videoPath,error:receipt.error,violationCount:receipt.violations.length}));
}
