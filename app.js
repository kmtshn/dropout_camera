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
const barcodeEnabled = document.getElementById('barcodeEnabled');
const barcodeSupport = document.getElementById('barcodeSupport');
const barcodeValue = document.getElementById('barcodeValue');
const barcodeMeta = document.getElementById('barcodeMeta');
const copyBarcode = document.getElementById('copyBarcode');
const clearBarcode = document.getElementById('clearBarcode');
const barcodeHistory = document.getElementById('barcodeHistory');

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

let barcodeDetector = null;
let barcodeScanning = false;
let lastBarcodeScan = 0;
let lastBarcodeValue = '';
let barcodeBoxes = [];
let barcodeHistoryItems = [];
const BARCODE_SCAN_INTERVAL = 280;

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
  barcodeBoxes = [];
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
  drawBarcodeBoxes();
  scanBarcodes(ts);
}

async function initBarcodeScanner(){
  if(!('BarcodeDetector' in window)){
    barcodeEnabled.checked=false;
    barcodeEnabled.disabled=true;
    barcodeSupport.textContent='このブラウザは非対応';
    barcodeMeta.textContent='Android版Chromeなど、BarcodeDetector対応ブラウザで利用できます';
    return;
  }

  try{
    const supported = await BarcodeDetector.getSupportedFormats();
    const preferred = [
      'code_128','code_39','code_93','codabar',
      'ean_13','ean_8','itf','upc_a','upc_e',
      'qr_code','data_matrix','pdf417','aztec'
    ];
    const formats = preferred.filter(format=>supported.includes(format));
    barcodeDetector = formats.length
      ? new BarcodeDetector({formats})
      : new BarcodeDetector();
    barcodeSupport.textContent='利用可能';
    barcodeSupport.title='対応形式: ' + (formats.length ? formats.join(', ') : supported.join(', '));
  }catch(err){
    console.error(err);
    barcodeEnabled.checked=false;
    barcodeEnabled.disabled=true;
    barcodeSupport.textContent='初期化できません';
    barcodeMeta.textContent='この端末ではバーコード検出を開始できませんでした';
  }
}

async function scanBarcodes(ts){
  if(!running || !barcodeDetector || !barcodeEnabled.checked || barcodeScanning || video.readyState < 2) return;
  if(ts-lastBarcodeScan < BARCODE_SCAN_INTERVAL) return;

  lastBarcodeScan=ts;
  barcodeScanning=true;
  try{
    const found=await barcodeDetector.detect(video);
    barcodeBoxes=found || [];
    if(found && found.length){
      acceptBarcode(found[0]);
    }
  }catch(err){
    // A transient frame error can occur while the camera is switching.
    if(running) console.debug('Barcode scan skipped:', err);
  }finally{
    barcodeScanning=false;
  }
}

function acceptBarcode(item){
  const raw=(item.rawValue || '').trim();
  if(!raw) return;
  const format=item.format || 'unknown';

  barcodeValue.textContent=raw;
  barcodeValue.classList.remove('empty');
  barcodeMeta.textContent='形式: ' + format;
  copyBarcode.disabled=false;

  if(raw!==lastBarcodeValue){
    lastBarcodeValue=raw;
    if(navigator.vibrate) navigator.vibrate(60);
    addBarcodeHistory(raw,format);
  }
}

function addBarcodeHistory(raw,format){
  barcodeHistoryItems = [
    {raw,format},
    ...barcodeHistoryItems.filter(item=>item.raw!==raw)
  ].slice(0,5);
  renderBarcodeHistory();
}

function renderBarcodeHistory(){
  barcodeHistory.textContent='';
  for(const item of barcodeHistoryItems){
    const row=document.createElement('div');
    row.className='historyItem';

    const code=document.createElement('span');
    code.className='historyCode';
    code.textContent=item.raw;

    const fmt=document.createElement('span');
    fmt.className='historyFormat';
    fmt.textContent=item.format;

    row.append(code,fmt);
    barcodeHistory.appendChild(row);
  }
}

function drawBarcodeBoxes(){
  if(!barcodeEnabled.checked || !barcodeBoxes.length || !video.videoWidth || !video.videoHeight) return;
  const sx=canvas.width/video.videoWidth;
  const sy=canvas.height/video.videoHeight;

  ctx.save();
  ctx.lineWidth=Math.max(2,canvas.width/320);
  ctx.strokeStyle='rgba(52,211,153,.95)';
  ctx.fillStyle='rgba(17,24,39,.82)';
  ctx.font=Math.max(11,Math.round(canvas.width/65)) + 'px sans-serif';

  for(const item of barcodeBoxes){
    const box=item.boundingBox;
    if(!box) continue;
    const x=box.x*sx;
    const y=box.y*sy;
    const w=box.width*sx;
    const h=box.height*sy;
    ctx.strokeRect(x,y,w,h);

    const label=item.format || 'barcode';
    const tw=ctx.measureText(label).width+12;
    const labelY=Math.max(0,y-24);
    ctx.fillRect(x,labelY,tw,22);
    ctx.fillStyle='#fff';
    ctx.fillText(label,x+6,labelY+16);
    ctx.fillStyle='rgba(17,24,39,.82)';
  }
  ctx.restore();
}

async function copyText(text){
  if(navigator.clipboard && window.isSecureContext){
    await navigator.clipboard.writeText(text);
    return;
  }
  const area=document.createElement('textarea');
  area.value=text;
  area.style.position='fixed';
  area.style.opacity='0';
  document.body.appendChild(area);
  area.select();
  document.execCommand('copy');
  area.remove();
}

copyBarcode.addEventListener('click',async()=>{
  if(!lastBarcodeValue) return;
  try{
    await copyText(lastBarcodeValue);
    showToast('バーコードの値をコピーしました');
  }catch(err){
    console.error(err);
    showToast('コピーできませんでした');
  }
});

clearBarcode.addEventListener('click',()=>{
  lastBarcodeValue='';
  barcodeBoxes=[];
  barcodeHistoryItems=[];
  barcodeValue.textContent='カメラをバーコードに向けてください';
  barcodeValue.classList.add('empty');
  barcodeMeta.textContent='検出結果は端末内だけで処理します';
  copyBarcode.disabled=true;
  renderBarcodeHistory();
});

barcodeEnabled.addEventListener('change',()=>{
  if(!barcodeEnabled.checked){
    barcodeBoxes=[];
    barcodeSupport.textContent=barcodeDetector ? '停止中' : barcodeSupport.textContent;
  }else if(barcodeDetector){
    barcodeSupport.textContent='利用可能';
  }
});

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
  return String(d.getFullYear()) + p(d.getMonth()+1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}
downloadOriginal.addEventListener('click',()=>originalBlob&&downloadBlob(originalBlob,'original_' + stamp() + '.jpg'));
downloadProcessed.addEventListener('click',()=>processedBlob&&downloadBlob(processedBlob,'ocr_' + saveMode.value + '_' + stamp() + '.png'));

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

initBarcodeScanner();
