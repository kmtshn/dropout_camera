const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const statusEl = document.getElementById('status');
const startBtn = document.getElementById('startBtn');
const captureBtn = document.getElementById('captureBtn');
const flipBtn = document.getElementById('flipBtn');
const modeGroup = document.getElementById('modeGroup');
const dropStrength = document.getElementById('dropStrength');
const satMin = document.getElementById('satMin');
const binaryThreshold = document.getElementById('binaryThreshold');
const whiteBoost = document.getElementById('whiteBoost');
const saveMode = document.getElementById('saveMode');
const originalPreview = document.getElementById('originalPreview');
const processedPreview = document.getElementById('processedPreview');
const downloadOriginal = document.getElementById('downloadOriginal');
const downloadProcessed = document.getElementById('downloadProcessed');
const captureTime = document.getElementById('captureTime');
const toast = document.getElementById('toast');

let stream = null;
let facingMode = 'environment';
let running = false;
let displayMode = 'dropout';
let raf = 0;
let lastRender = 0;
const PREVIEW_FPS = 15;
const PREVIEW_MAX_WIDTH = 960;
let originalBlob = null;
let processedBlob = null;
let workCanvas = document.createElement('canvas');
let workCtx = workCanvas.getContext('2d', { willReadFrequently: true });

function showToast(msg){
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(showToast.t);
  showToast.t = setTimeout(()=>toast.classList.remove('show'), 1800);
}

function updateLabels(){
  document.getElementById('dropStrengthVal').textContent = dropStrength.value;
  document.getElementById('satMinVal').textContent = satMin.value + '%';
  document.getElementById('binaryThresholdVal').textContent = binaryThreshold.value;
}
['input','change'].forEach(ev=>{
  dropStrength.addEventListener(ev, updateLabels);
  satMin.addEventListener(ev, updateLabels);
  binaryThreshold.addEventListener(ev, updateLabels);
});
updateLabels();

function setMode(mode){
  displayMode = mode;
  [...modeGroup.querySelectorAll('.modeBtn')].forEach(b=>b.classList.toggle('active', b.dataset.mode===mode));
}
modeGroup.addEventListener('click',e=>{
  const btn=e.target.closest('[data-mode]');
  if(btn) setMode(btn.dataset.mode);
});

async function stopCamera(){
  cancelAnimationFrame(raf);
  running = false;
  if(stream){ stream.getTracks().forEach(t=>t.stop()); stream=null; }
  video.srcObject = null;
  startBtn.textContent='カメラ開始';
  captureBtn.disabled=true;
  statusEl.textContent='カメラ停止中';
}

async function startCamera(){
  if(running){ await stopCamera(); return; }
  try{
    stream = await navigator.mediaDevices.getUserMedia({
      video:{facingMode:{ideal:facingMode},width:{ideal:1920},height:{ideal:1080}}, audio:false
    });
    video.srcObject=stream;
    await video.play();
    running=true;
    startBtn.textContent='カメラ停止';
    captureBtn.disabled=false;
    statusEl.textContent='リアルタイム処理中';
    renderLoop();
  }catch(err){
    console.error(err);
    statusEl.textContent='カメラを利用できません';
    showToast('カメラ権限を確認してください');
  }
}

startBtn.addEventListener('click',startCamera);
flipBtn.addEventListener('click',async()=>{
  facingMode = facingMode==='environment'?'user':'environment';
  if(running){ await stopCamera(); await startCamera(); }
});

function ensureCanvasSize(){
  const vw = video.videoWidth || 1280;
  const vh = video.videoHeight || 720;
  const scale = Math.min(1, PREVIEW_MAX_WIDTH / vw);
  const w = Math.max(1, Math.round(vw * scale));
  const h = Math.max(1, Math.round(vh * scale));
  if(canvas.width!==w || canvas.height!==h){ canvas.width=w; canvas.height=h; }
}

function rgbToHsv(r,g,b){
  r/=255; g/=255; b/=255;
  const max=Math.max(r,g,b), min=Math.min(r,g,b), d=max-min;
  let h=0;
  if(d!==0){
    if(max===r) h=60*(((g-b)/d)%6);
    else if(max===g) h=60*(((b-r)/d)+2);
    else h=60*(((r-g)/d)+4);
  }
  if(h<0) h+=360;
  const s=max===0?0:d/max;
  return [h,s,max];
}

function processPixels(imageData, mode){
  const d=imageData.data;
  const hueWidth=Number(dropStrength.value);
  const minSat=Number(satMin.value)/100;
  const th=Number(binaryThreshold.value);
  const boost=whiteBoost.checked;

  for(let i=0;i<d.length;i+=4){
    let r=d[i], g=d[i+1], b=d[i+2];

    if(mode!=='original'){
      const [h,s,v]=rgbToHsv(r,g,b);
      const isRed=(h<=hueWidth || h>=360-hueWidth) && s>=minSat && v>0.20;
      if(isRed){ r=g=b=255; }
    }

    if(boost && mode!=='original'){
      // Lift near-white paper/background while preserving dark text.
      const lum=0.2126*r+0.7152*g+0.0722*b;
      if(lum>180){
        const k=Math.min(1,(lum-180)/75);
        r=Math.round(r+(255-r)*k*.72);
        g=Math.round(g+(255-g)*k*.72);
        b=Math.round(b+(255-b)*k*.72);
      }
    }

    if(mode==='gray' || mode==='binary'){
      const y=Math.round(0.299*r+0.587*g+0.114*b);
      if(mode==='gray') r=g=b=y;
      else r=g=b=(y>=th?255:0);
    }

    d[i]=r; d[i+1]=g; d[i+2]=b;
  }
  return imageData;
}

function drawFrame(targetCtx,targetCanvas,mode,source=video){
  const w=source.videoWidth||source.width;
  const h=source.videoHeight||source.height;
  targetCanvas.width=w; targetCanvas.height=h;
  targetCtx.drawImage(source,0,0,w,h);
  if(mode!=='original'){
    const img=targetCtx.getImageData(0,0,w,h);
    targetCtx.putImageData(processPixels(img,mode),0,0);
  }
}

function renderLoop(ts=0){
  if(!running) return;
  raf=requestAnimationFrame(renderLoop);
  if(ts-lastRender < 1000/PREVIEW_FPS) return;
  lastRender=ts;
  ensureCanvasSize();
  ctx.drawImage(video,0,0,canvas.width,canvas.height);
  if(displayMode!=='original'){
    const frame=ctx.getImageData(0,0,canvas.width,canvas.height);
    ctx.putImageData(processPixels(frame,displayMode),0,0);
  }
}

function canvasToBlob(canvas,type='image/png',quality=.95){
  return new Promise(resolve=>canvas.toBlob(resolve,type,quality));
}

captureBtn.addEventListener('click',async()=>{
  if(!running) return;
  const captureCanvas=document.createElement('canvas');
  const cctx=captureCanvas.getContext('2d',{willReadFrequently:true});
  captureCanvas.width=video.videoWidth;
  captureCanvas.height=video.videoHeight;
  cctx.drawImage(video,0,0,captureCanvas.width,captureCanvas.height);
  originalBlob=await canvasToBlob(captureCanvas,'image/jpeg',.96);

  workCanvas.width=captureCanvas.width;
  workCanvas.height=captureCanvas.height;
  workCtx.drawImage(captureCanvas,0,0);
  const img=workCtx.getImageData(0,0,workCanvas.width,workCanvas.height);
  workCtx.putImageData(processPixels(img,saveMode.value),0,0);
  processedBlob=await canvasToBlob(workCanvas,'image/png');

  originalPreview.src=URL.createObjectURL(originalBlob);
  processedPreview.src=URL.createObjectURL(processedBlob);
  downloadOriginal.disabled=false;
  downloadProcessed.disabled=false;
  captureTime.textContent=new Date().toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'});
  showToast('撮影しました');
});

function downloadBlob(blob,filename){
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download=filename; a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function stamp(){
  const d=new Date();
  const p=n=>String(n).padStart(2,'0');
  return \`\${d.getFullYear()}\${p(d.getMonth()+1)}\${p(d.getDate())}_\${p(d.getHours())}\${p(d.getMinutes())}\${p(d.getSeconds())}\`;
}
downloadOriginal.addEventListener('click',()=>originalBlob&&downloadBlob(originalBlob,\`original_\${stamp()}.jpg\`));
downloadProcessed.addEventListener('click',()=>processedBlob&&downloadBlob(processedBlob,\`ocr_\${saveMode.value}_\${stamp()}.png\`));

saveMode.addEventListener('change',()=>{
  if(originalBlob) showToast('次回撮影から保存形式に反映');
});

if('serviceWorker' in navigator){
  window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(console.warn));
}

if(!navigator.mediaDevices?.getUserMedia){
  startBtn.disabled=true;
  statusEl.textContent='このブラウザはカメラAPI非対応です';
}
