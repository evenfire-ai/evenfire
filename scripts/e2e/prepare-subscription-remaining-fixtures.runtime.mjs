// E2E_GUARDIAN_IPC_FLOW: Main calls these under its verified branch mutation
// lease. Only fresh QA Host metadata and owned QA desktop data are accessed.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const codec = createRequire(import.meta.url)('./fixtures/subscription-image-challenge.cjs')
const dns = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const fail = code => { throw new Error(code) }
function kubectl(context, args, input) {
  if (!dns.test(context) || context === 'clerum-test' || /(^|-)(prod|production)(-|$)/i.test(context)) fail('REMAINING_RUNTIME_CONTEXT_INVALID')
  return execFileSync('kubectl', [`--context=${context}`, '--request-timeout=15s', ...args],
    { input, encoding: 'utf8', timeout: 20_000, maxBuffer: 5 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] })
}
const rows = text => text.trim().split('\n').filter(Boolean).map(line => line.split('\t'))
const digestId = raw => {
  const matched = /(?:^|[@/:])sha256:([a-f0-9]{64})$/.exec(raw ?? '')
  if (!matched) fail('REMAINING_RUNTIME_IMAGE_ID_MISSING')
  return `sha256:${matched[1]}`
}

/** No Ready, UID, image, deployment or pod is inferred from a planned name. */
export function observeQaHostRuntime({ context, hostNamespace, hostRef, hostUid }) {
  if (!dns.test(hostNamespace) || !dns.test(hostRef) || !uuid.test(hostUid ?? '')) fail('REMAINING_RUNTIME_HOST_INVALID')
  const host = kubectl(context, ['-n', hostNamespace, 'get', 'host', hostRef,
    '-o=jsonpath={.metadata.uid}{"\\n"}{.spec.desktop.x11}{"\\n"}{range .spec.llmPolicy.fallbacks[*]}{.provider}{"\\t"}{.model}{"\\n"}{end}']).trim().split('\n')
  if (host[0] !== hostUid) fail('REMAINING_RUNTIME_HOST_RECREATED')
  const deployments = rows(kubectl(context, ['-n', hostNamespace, 'get', 'deployment',
    '-o=jsonpath={range .items[*]}{.metadata.name}{"\\t"}{.metadata.uid}{"\\t"}{.metadata.ownerReferences[*].uid}{"\\t"}{.spec.replicas}{"\\t"}{.status.readyReplicas}{"\\n"}{end}']))
    .filter(row => row[2]?.split(' ').includes(hostUid))
  if (deployments.length !== 1 || deployments[0][3] !== '1' || deployments[0][4] !== '1') fail('REMAINING_RUNTIME_DEPLOYMENT_NOT_UNIQUE_READY')
  const replicaSets = rows(kubectl(context, ['-n', hostNamespace, 'get', 'replicaset',
    '-o=jsonpath={range .items[*]}{.metadata.uid}{"\\t"}{.metadata.ownerReferences[*].uid}{"\\n"}{end}']))
    .filter(row => row[1]?.split(' ').includes(deployments[0][1])).map(row => row[0])
  const pods = rows(kubectl(context, ['-n', hostNamespace, 'get', 'pod',
    '-o=jsonpath={range .items[*]}{.metadata.name}{"\\t"}{.metadata.uid}{"\\t"}{.metadata.ownerReferences[*].uid}{"\\t"}{.metadata.deletionTimestamp}{"\\t"}{.status.phase}{"\\t"}{range .status.containerStatuses[*]}{.name}{":"}{.ready}{":"}{.imageID}{" "}{end}{"\\n"}{end}']))
    .filter(row => row[2]?.split(' ').some(owner => replicaSets.includes(owner)) && !row[3] && row[4] === 'Running')
  if (pods.length !== 1 || !uuid.test(pods[0][1] ?? '')) fail('REMAINING_RUNTIME_POD_NOT_UNIQUE_READY')
  const containers = pods[0][5]?.trim().split(' ').filter(Boolean) ?? []
  if (containers.length !== 1) fail('REMAINING_RUNTIME_CONTAINER_AMBIGUOUS')
  const match = /^([^:]+):true:(.+)$/.exec(containers[0])
  if (!match) fail('REMAINING_RUNTIME_CONTAINER_NOT_READY')
  return { context, hostNamespace, hostRef, hostUid, deploymentUid: deployments[0][1],
    podName: pods[0][0], podUid: pods[0][1], containerName: match[1], imageId: digestId(match[2]),
    desktopX11: host[1] === 'true', fallbacks: host.slice(2).filter(Boolean).map(line => {
      const [provider, model] = line.split('\t')
      if (!provider || !model) fail('REMAINING_RUNTIME_FALLBACK_INVALID')
      return { provider, model }
    }) }
}

// This program touches only a unique QA PNG and its own ImageMagick viewer.
// It reads no environment, credentials, keychain, process command lines or logs.
export const SCREEN_PROGRAM = String.raw`
const fs = require('node:fs'), cp = require('node:child_process');
let chunks=[], count=0;
process.stdin.on('data',chunk=>{count+=chunk.length;if(count>4*1024*1024)throw Error('SCREEN_INPUT_BOUND');chunks.push(chunk)});
process.stdin.on('end',()=>{
 const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
 if(!/^\/tmp\/evenfire-qa-screen-[a-f0-9-]{36}\.png$/.test(input.filename)||!/^evenfire-qa-[a-f0-9-]{36}$/.test(input.title))throw Error('SCREEN_INPUT_INVALID');
 for(const command of ['scrot','import','display','xdotool'])cp.execFileSync('sh',['-c','command -v '+command],{timeout:5000,stdio:'pipe'});
 // The existing Dockerfile.desktop starts mcp-host and XFCE as abc. Other
 // images must fail this concrete runtime contract instead of guessing a UID.
 const uid=Number(cp.execFileSync('id',['-u','abc'],{encoding:'utf8',timeout:5000}).trim());
 const gid=Number(cp.execFileSync('id',['-g','abc'],{encoding:'utf8',timeout:5000}).trim());
 if(!Number.isSafeInteger(uid)||uid<=0||!Number.isSafeInteger(gid)||gid<=0)throw Error('SCREEN_RUNTIME_USER_INVALID');
 if(process.getuid()===0){process.setgroups([]);process.setgid(gid);process.setuid(uid)}
 if(process.getuid()!==uid||process.getgid()!==gid)throw Error('SCREEN_RUNTIME_USER_MISMATCH');
 let viewerPid=input.viewerPid, viewerStartTime=input.viewerStartTime;
 if(input.kind==='install'){
  const bytes=Buffer.from(input.contentsBase64,'base64');
  if(!bytes.length||bytes.length>3*1024*1024||bytes.toString('base64')!==input.contentsBase64)throw Error('SCREEN_IMAGE_INVALID');
  fs.writeFileSync(input.filename,bytes,{flag:'wx',mode:0o600});
  const viewer=cp.spawn('display',['-display',':1','-borderwidth','0','-geometry','512x512+64+64','-title',input.title,'-immutable',input.filename],{env:{DISPLAY:':1',HOME:'/config'},stdio:'ignore',detached:true});
  viewer.unref();viewerPid=viewer.pid;
  viewerStartTime=fs.readFileSync('/proc/'+viewerPid+'/stat','utf8').split(') ')[1].split(' ')[19];
 }else if(input.kind!=='capture')throw Error('SCREEN_ACTION_INVALID');
 if(!Number.isSafeInteger(viewerPid)||viewerPid<=0||fs.readFileSync('/proc/'+viewerPid+'/stat','utf8').split(') ')[1].split(' ')[19]!==viewerStartTime)throw Error('SCREEN_VIEWER_OWNERSHIP_CHANGED');
 const windowIds=cp.execFileSync('xdotool',['search','--sync','--onlyvisible','--name','^'+input.title+'$'],{env:{DISPLAY:':1'},encoding:'utf8',timeout:8000}).trim().split(/\s+/);
 if(windowIds.length!==1||!/^\d+$/.test(windowIds[0]))throw Error('SCREEN_WINDOW_AMBIGUOUS');
 const geometry=Object.fromEntries(cp.execFileSync('xdotool',['getwindowgeometry','--shell',windowIds[0]],{env:{DISPLAY:':1'},encoding:'utf8',timeout:5000}).trim().split('\n').map(line=>line.split('=')));
 const region={x:Number(geometry.X),y:Number(geometry.Y),w:Number(geometry.WIDTH),h:Number(geometry.HEIGHT)};
 if(!Number.isSafeInteger(region.x)||region.x<0||!Number.isSafeInteger(region.y)||region.y<0||region.w!==512||region.h!==512)throw Error('SCREEN_WINDOW_GEOMETRY_INVALID');
 const png=cp.execFileSync('import',['-display',':1','-window','root','-crop','512x512+'+region.x+'+'+region.y,'png:-'],{timeout:8000,maxBuffer:3*1024*1024});
 process.stdout.write(JSON.stringify({uid,gid,viewerPid,viewerStartTime,region,contentsBase64:png.toString('base64')}));
});`

/** Physical X11 pixels are decoded before a fixture receipt can be produced. */
export async function prepareQaScreen({ runtime, asset, deadlineMs = 20_000 }) {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > 60_000) fail('SCREENSHOT_RUNTIME_DEADLINE_INVALID')
  if (!runtime.desktopX11 || asset.mimeType !== 'image/png') fail('SCREENSHOT_RUNTIME_X11_NOT_ENABLED')
  const filename = `/tmp/evenfire-qa-screen-${randomUUID()}.png`, title = `evenfire-qa-${randomUUID()}`
  const source = Buffer.from(asset.contentsBase64, 'base64')
  const expected = await codec.decodeTileChallenge(source)
  let viewer, latest, kind = 'install'
  const started = Date.now()
  do {
    const payload = { kind, filename, title, ...(kind === 'install' ? { contentsBase64: asset.contentsBase64 } : viewer) }
    latest = JSON.parse(kubectl(runtime.context, ['-n', runtime.hostNamespace, 'exec', '-i', runtime.podName,
      '-c', runtime.containerName, '--', 'node', '-e', SCREEN_PROGRAM], JSON.stringify(payload)))
    viewer = { viewerPid: latest.viewerPid, viewerStartTime: latest.viewerStartTime }
    let decoded
    try { decoded = await codec.decodeTileChallenge(Buffer.from(latest.contentsBase64, 'base64')) }
    catch { decoded = null } // A newly mapped window may not have drawn the pixels yet.
    if (decoded === expected) {
      const fresh = observeQaHostRuntime(runtime)
      if (fresh.podUid !== runtime.podUid || fresh.imageId !== runtime.imageId) fail('SCREENSHOT_RUNTIME_RECREATED')
      return { hostImagePath: filename, region: latest.region,
        evidence: { podUid: runtime.podUid, imageId: runtime.imageId, viewerPid: latest.viewerPid,
          viewerStartTime: latest.viewerStartTime, uid: latest.uid, gid: latest.gid, pixelChallengeMatched: true } }
    }
    kind = 'capture'
    // Each retry reads a real X11 frame; no fixed sleep advances readiness.
  } while (Date.now() - started < deadlineMs)
  fail('SCREENSHOT_RUNTIME_PIXELS_NOT_READY')
}
