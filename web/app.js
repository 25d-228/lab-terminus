(function () {
"use strict";
const $ = id => document.getElementById(id);
function esc(s){const d=document.createElement('div');d.textContent=s==null?'':String(s);return d.innerHTML;}
function bytes(n){if(n==null||n<0||isNaN(n))return '';const u=['B','KB','MB','GB','TB','PB'];let i=0,v=n;while(v>=1024&&i<u.length-1){v/=1024;i++;}return (v>=10||i===0?Math.round(v):v.toFixed(1))+' '+u[i];}
function mib(n){return bytes((n||0)*1048576);}
function pct(u,s){return s>0?Math.round(u/s*100):0;}
function ago(ep){if(!ep)return '';let s=Math.floor(Date.now()/1000-ep);if(s<0)return '';if(s<60)return 'just now';const m=(s/60)|0;if(m<60)return m+' min ago';const h=(m/60)|0;if(h<24)return h+' h ago';const d=(h/24)|0;if(d<30)return d+' d ago';const mo=(d/30)|0;if(mo<12)return mo+' mo ago';return ((mo/12)|0)+' y ago';}
function gpuClass(u){return u>=70?'':u>=30?'mid':'low';}
function utilColor(u){const p=Math.max(0,Math.min(100,Math.round(u)));return p<=50?`color-mix(in srgb,var(--ok),var(--warn) ${p*2}%)`:`color-mix(in srgb,var(--warn),var(--hot) ${(p-50)*2}%)`;}
function parentOf(p){if(!p||p==='/')return '/';const q=p.replace(/\/+$/,'');const i=q.lastIndexOf('/');return i>0?q.slice(0,i):'/';}
async function api(p,opts){const r=await fetch(p,opts);if(!r.ok)throw new Error('HTTP '+r.status);return r.json();}

let SERVERS=[], byId={}, FOLDERS=[], SIDX={}, _modal={mode:'server',folder:null}, _sendto=null;
const FLEET={};
const ST={view:'fleet',active:null,tab:'explorer',cwd:{},sel:null,hidden:false,sort:{key:'name',asc:true},filter:'',ovq:'',ovmode:'grid',termTabs:{},termActive:{},broadcast:false,sessSeq:0,listing:null,loadSeq:0,alert:false,collapsed:{},hist:{},procOpen:{},chart:null,monTimer:null};

let toastT;function toast(m){const t=$('lt-toast');t.textContent=m;t.classList.add('show');clearTimeout(toastT);toastT=setTimeout(()=>t.classList.remove('show'),2600);}

const gpus=d=>(d&&d.gpus)||[];
const disks=d=>(d&&d.disks)||[];
function diskPrimary(d){const a=disks(d);return a.length?a.reduce((x,y)=>y.size>x.size?y:x):null;}
function gpuSummary(d){const a=gpus(d);if(!a.length)return null;const busy=a.filter(g=>g.util>=10).length,idle=a.filter(g=>g.util<10).length;return{busy,idle,total:a.length,avg:Math.round(a.reduce((s,g)=>s+g.util,0)/a.length)};}
function statusDot(d){if(!d||d.online===false)return 'off';const g=gpuSummary(d);if(!g)return 'ok';if(g.idle===g.total)return 'ok';if(g.avg>=70)return 'hot';return 'busy';}
function tabsFor(s){return s.kind==='nas'?[['explorer','Explorer','▤'],['monitor','Storage','◷']]:[['explorer','Explorer','▤'],['terminal','Terminal','▸'],['monitor','Monitor','◷']];}
function shortTag(s){return (s.gpuLabel||'').replace('x ','×').replace('RTX ','').replace('GTX ','').replace(' Laptop','').replace('Synology DSM','DSM').replace('CPU only','CPU')||s.kind;}

/* ---------------- sidebar + registry (folders, add/remove) ---------------- */
function hueOf(id){return ((SIDX[id]||0)*47)%360;}
function svTile(id){const h=hueOf(id);return `--t1:hsl(${h} 62% 55%);--t2:hsl(${(h+34)%360} 56% 45%)`;}
function svCode(s){return s.kind==='wsl'?'WS':s.kind==='nas'?'NS':((s.name||'').replace(/[^0-9]/g,'')||(s.name||'??').slice(0,2).toUpperCase());}
function svSub(s){return s.kind==='nas'?'Synology DSM':s.kind==='wsl'?'Ubuntu · WSL':(s.gpuLabel||s.host||'server');}
function folderCollapsed(key){return (key in ST.collapsed)?!!ST.collapsed[key]:true;}
function renderSide(){
 let free=0;SERVERS.forEach(s=>{const g=gpuSummary(FLEET[s.id]);if(g&&g.idle>0)free++;});
 let h=`<div class="lt-ov${ST.view==='fleet'?' on':''}" data-view="fleet"><span class="gly">▦</span>Overview<span class="ct">${free?free+' GPU FREE':''}</span></div>`;
 h+=`<div class="lt-side-h"><span>MACHINES</span><span class="lt-addbtn" data-add="server" title="Add a server or folder">+</span></div>`;
 (FOLDERS.length?FOLDERS:[{key:'lab',title:'Lab Servers'}]).forEach(f=>{
  const list=SERVERS.filter(s=>(s.group||'lab')===f.key);
  const col=folderCollapsed(f.key);
  h+=`<div class="lt-sec${col?' col':''}" data-grp="${esc(f.key)}"><span class="chev">▾</span><span class="lt-sec-t">${esc(f.title)}</span><span class="gn">${list.length}</span><span class="lt-sec-add" data-add="server" data-folder="${esc(f.key)}" title="Add server here">+</span></div>`;
  if(col)return;
  if(!list.length){h+=`<div class="lt-sv-empty">empty · <b data-add="server" data-folder="${esc(f.key)}">add server</b></div>`;return;}
  list.forEach(s=>{const d=FLEET[s.id],g=gpuSummary(d),dk=diskPrimary(d);
   let rt='';if(g&&g.idle===g.total)rt='<span class="lt-sv-free">FREE</span>';else if(g)rt=`<span class="lt-sv-pct" style="color:${utilColor(g.avg)}">${g.avg}%</span>`;else if(dk&&s.kind==='nas')rt=`<span class="lt-sv-pct">${pct(dk.used,dk.size)}%</span>`;
   h+=`<div class="lt-sv${(ST.view==='server'&&s.id===ST.active)?' on':''}" data-sv="${s.id}"><span class="lt-svi" style="${svTile(s.id)}">${esc(svCode(s))}<span class="lt-st ${statusDot(d)}"></span></span><span class="lt-svt"><span class="lt-sv-name">${esc(s.name)}</span><span class="lt-sv-sub">${esc(svSub(s))}</span></span>${rt}</div>`;});
 });
 $('lt-side').innerHTML=h;
}
async function refreshRegistry(){try{const[sv,fo]=await Promise.all([api('/api/servers'),api('/api/folders')]);SERVERS=sv;FOLDERS=fo;byId=Object.fromEntries(SERVERS.map(s=>[s.id,s]));SIDX=Object.fromEntries(SERVERS.map((s,i)=>[s.id,i]));renderSide();}catch(e){}}
/* add server / folder modal */
function openAddModal(mode,folder){_modal={mode:mode||'server',folder:folder||(FOLDERS[0]&&FOLDERS[0].key)||'lab'};let el=$('lt-modal');if(!el){el=document.createElement('div');el.id='lt-modal';el.className='lt-modal';(document.querySelector('.lt-window')||document.body).appendChild(el);}renderModal();}
function closeModal(){const el=$('lt-modal');if(el)el.remove();}
function _ensureModal(){let el=$('lt-modal');if(!el){el=document.createElement('div');el.id='lt-modal';el.className='lt-modal';(document.querySelector('.lt-window')||document.body).appendChild(el);}return el;}
function openEditServer(sid){const s=byId[sid];if(!s)return;_modal={mode:'server',folder:s.group||'lab',editId:sid};_ensureModal();renderModal();}
function openRenameFolder(key){_modal={mode:'folder',folder:key,editId:key};_ensureModal();renderModal();}
function removeServer(id){api('/api/servers/'+id,{method:'DELETE'}).then(()=>{if(ST.active===id)ST.view='fleet';return refreshRegistry();}).then(()=>{renderAll();toast('Server removed');}).catch(()=>toast('Remove failed'));}
function removeFolder(key){api('/api/folders/'+key,{method:'DELETE'}).then(()=>refreshRegistry()).then(()=>{renderAll();toast('Folder removed');}).catch(()=>toast('Could not remove folder'));}
function closeCtx(){const m=$('lt-ctx');if(m)m.remove();}
function showCtx(x,y,items){closeCtx();const m=document.createElement('div');m.id='lt-ctx';m.className='lt-ctx';
 m.innerHTML=items.map((it,i)=>`<div class="lt-ctx-i${it.danger?' danger':''}" data-ci="${i}">${esc(it.label)}</div>`).join('');
 (document.querySelector('.lt-window')||document.body).appendChild(m);
 m.style.left=Math.min(x,window.innerWidth-198)+'px';m.style.top=Math.min(y,window.innerHeight-14-items.length*34)+'px';
 m.addEventListener('click',ev=>{const t=ev.target.closest('[data-ci]');if(!t)return;const it=items[+t.getAttribute('data-ci')];closeCtx();if(it&&it.fn)it.fn();});
 const off=()=>{document.removeEventListener('mousedown',close,true);document.removeEventListener('keydown',esckey,true);};
 const close=ev=>{if(!ev.target.closest('#lt-ctx')){closeCtx();off();}};
 const esckey=ev=>{if(ev.key==='Escape'){closeCtx();off();}};
 setTimeout(()=>{document.addEventListener('mousedown',close,true);document.addEventListener('keydown',esckey,true);},0);
}
document.addEventListener('contextmenu',e=>{
 if(!e.target.closest('.lt-side'))return;
 const sv=e.target.closest('[data-sv]');
 if(sv){e.preventDefault();const id=sv.getAttribute('data-sv'),s=byId[id];showCtx(e.clientX,e.clientY,[{label:'Edit server…',fn:()=>openEditServer(id)},...(s&&s.kind!=='nas'?[{label:'Open terminal',fn:()=>openServer(id,'terminal')}]:[]),{label:'Remove server',danger:true,fn:()=>removeServer(id)}]);return;}
 const sec=e.target.closest('[data-grp]');
 if(sec){e.preventDefault();const k=sec.getAttribute('data-grp');showCtx(e.clientX,e.clientY,[{label:'Rename folder…',fn:()=>openRenameFolder(k)},{label:'Add server here…',fn:()=>openAddModal('server',k)},{label:'Remove folder',danger:true,fn:()=>removeFolder(k)}]);return;}
});
function renderModal(){const el=$('lt-modal');if(!el)return;const m=_modal.mode,ed=_modal.editId,sv=(ed&&m==='server')?(byId[ed]||{}):{};
 const fopts=FOLDERS.map(f=>`<option value="${esc(f.key)}" ${f.key===_modal.folder?'selected':''}>${esc(f.title)}</option>`).join('');
 const ks=k=>sv.kind===k?'selected':'';
 let body;
 if(m==='folder'){const cur=ed?((FOLDERS.find(f=>f.key===ed)||{}).title||''):'';body=`<label class="lt-f-l">Folder name</label><input class="lt-f-in" id="m-fname" placeholder="e.g. Cloud GPUs" value="${esc(cur)}">`;}
 else{body=`<div class="lt-f-grid"><div><label class="lt-f-l">Kind</label><select class="lt-f-in" id="m-kind"><option value="ssh" ${ks('ssh')}>SSH server</option><option value="wsl" ${ks('wsl')}>WSL</option><option value="nas" ${ks('nas')}>Synology NAS</option></select></div><div><label class="lt-f-l">Name</label><input class="lt-f-in" id="m-name" placeholder="Exp19" value="${esc(sv.name||'')}"></div><div><label class="lt-f-l">Host / IP</label><input class="lt-f-in" id="m-host" placeholder="133.9.48.110" value="${esc(sv.host||'')}"></div><div><label class="lt-f-l">Port</label><input class="lt-f-in" id="m-port" placeholder="22" value="${esc(sv.port!=null?sv.port:'')}"></div><div><label class="lt-f-l">User</label><input class="lt-f-in" id="m-user" placeholder="yue_ziran" value="${esc(sv.user||'')}"></div><div><label class="lt-f-l">Label (GPU / role)</label><input class="lt-f-in" id="m-gpu" placeholder="RTX 4090" value="${esc(sv.gpuLabel||'')}"></div><div class="lt-f-wide"><label class="lt-f-l">Folder</label><select class="lt-f-in" id="m-folder">${fopts}</select></div></div>`;}
 const head=ed?`<b style="font-family:var(--f-display);font-size:15px;color:var(--tx)">${m==='folder'?'Rename folder':'Edit server'}</b>`:`<div class="lt-seg"><span class="${m==='server'?'on':''}" data-mode="server">Server</span><span class="${m==='folder'?'on':''}" data-mode="folder">Folder</span></div>`;
 const btn=ed?'Save':('Add '+(m==='folder'?'folder':'server'));
 el.innerHTML=`<div class="lt-modal-card"><div class="lt-modal-h">${head}<span class="lt-modal-x" data-mclose="1">✕</span></div><div class="lt-modal-b">${body}</div><div class="lt-modal-f"><span class="lt-btn ghost" data-mclose="1">Cancel</span><span class="lt-btn" data-msubmit="1">${btn}</span></div></div>`;
 const fi=el.querySelector('.lt-f-in');if(fi)fi.focus();
}
async function submitAdd(){try{
 const ed=_modal.editId;
 if(_modal.mode==='folder'){const t=(($('m-fname')||{}).value||'').trim();if(!t){toast('Folder name required');return;}
  if(ed){await api('/api/folders/'+ed,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:t})});closeModal();await refreshRegistry();renderAll();toast('Folder renamed');return;}
  await api('/api/folders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:t})});closeModal();await refreshRegistry();toast('Folder “'+t+'” added');return;}
 const v=id=>(($(id)||{}).value||'').trim();const name=v('m-name');if(!name){toast('Name required');return;}
 const group=v('m-folder')||_modal.folder||'lab';
 const payload={name,kind:v('m-kind')||'ssh',host:v('m-host'),port:v('m-port'),user:v('m-user'),gpuLabel:v('m-gpu'),group};
 if(ed){const s=await api('/api/servers/'+ed,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});closeModal();await refreshRegistry();renderAll();toast('Saved “'+((s&&s.name)||name)+'”');return;}
 const s=await api('/api/servers',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
 ST.collapsed[group]=false;try{localStorage.setItem('lt-collapsed',JSON.stringify(ST.collapsed));}catch(e){}
 closeModal();await refreshRegistry();toast('Server “'+((s&&s.name)||name)+'” added');
}catch(e){toast('Save failed: '+e);}}

/* ---------------- header + tabs ---------------- */
function renderHeadTabs(){
 const head=$('lt-shead'),tabs=$('lt-subtabs');
 if(ST.view==='fleet'){head.innerHTML='';tabs.innerHTML='';return;}
 const s=byId[ST.active],d=FLEET[ST.active]||{},g=gpuSummary(d),dk=diskPrimary(d);
 let chips='';
 if(d.online===false)chips+=`<span class="lt-chip hot">offline</span>`;
 else if(g)chips+=`<span class="lt-chip ${g.avg>=70?'hot':g.idle===g.total?'ok':''}">${g.total>1?g.total+'× GPU':'GPU'} · ${gpus(d).map(x=>x.util+'%').join(' / ')}</span>`;
 else if(s.kind==='ssh'&&d.ncpu)chips+=`<span class="lt-chip">${d.ncpu} cores · load ${d.load[0]}</span>`;
 if(dk)chips+=`<span class="lt-chip">${s.kind==='nas'?'volume':'disk'} ${pct(dk.used,dk.size)}%</span>`;
 if(d.online!==false)chips+=`<span class="lt-chip ok">● live</span>`;
 const addr=s.kind==='nas'?`${s.host}:${s.port}`:s.kind==='wsl'?'wsl · Ubuntu':`${s.user}@${s.host}:${s.port}`;
 head.innerHTML=`<span class="lt-st ${statusDot(d)}" style="width:10px;height:10px"></span><span class="hnm">${esc(s.name)}</span><span class="hsub">${esc(addr)}${d.up?' · up '+d.up:''}</span><div class="chips">${chips}</div>`;
 tabs.innerHTML=tabsFor(s).map(([k,lbl,gly])=>`<div class="tab${ST.tab===k?' on':''}" data-tab="${k}"><span class="gly">${gly}</span>${lbl}</div>`).join('');
}

/* ---------------- hosts overview ---------------- */
function hostMeta(s,idx){
 const d=FLEET[s.id],g=gpuSummary(d),dk=diskPrimary(d);
 const hue=hueOf(s.id),t1=`hsl(${hue} 66% 56%)`,t2=`hsl(${(hue+36)%360} 60% 46%)`;
 const code=s.kind==='wsl'?'WS':s.kind==='nas'?'NS':(s.name.replace(/[^0-9]/g,'')||s.name.slice(0,2).toUpperCase());
 const addr=s.kind==='wsl'?(s.user||'wsl')+' · Ubuntu':s.kind==='nas'?`${s.host}:${s.port}`:`${s.user}@${s.host}:${s.port}`;
 let stat;
 if(!d)stat='connecting…';
 else if(d.online===false)stat='offline'+(d.error?' · '+d.error:'');
 else if(g)stat=`GPU ${g.avg}% · ${g.idle>0?g.idle+' idle':'all busy'}`+(dk?` · disk ${pct(dk.used,dk.size)}%`:'');
 else if(s.kind==='nas')stat=dk?`volume ${pct(dk.used,dk.size)}% · ${bytes(dk.size-dk.used)} free`:'—';
 else stat=(d.ncpu?`load ${d.load[0]} · ${d.ncpu} cores`:'idle')+(dk?` · disk ${pct(dk.used,dk.size)}%`:'');
 return {d,g,dk,code,addr,stat,t1,t2};
}
function hostCard(s,idx){const m=hostMeta(s,idx);let tags=`<span class="lt-htag">${esc(s.gpuLabel||s.kind)}</span>`;if(m.g&&m.g.idle>0)tags+=`<span class="lt-htag free">${m.g.idle} GPU FREE</span>`;
 return `<div class="lt-hcard" data-sv="${s.id}"><div class="lt-hgo">Open →</div><div class="lt-htop"><span class="lt-hicon" style="--t1:${m.t1};--t2:${m.t2}">${esc(m.code)}<span class="lt-st ${statusDot(m.d)}"></span></span><div class="lt-hmeta"><div class="lt-hname">${esc(s.name)}</div><div class="lt-haddr">${esc(m.addr)}</div></div></div><div class="lt-htags">${tags}</div><div class="lt-hstat">${esc(m.stat)}</div></div>`;}
function hostRow(s,idx){const m=hostMeta(s,idx);const tag=(m.g&&m.g.idle>0)?`<span class="lt-htag free">${m.g.idle} FREE</span>`:`<span class="lt-htag">${esc(s.gpuLabel||s.kind)}</span>`;
 return `<div class="lt-hrow" data-sv="${s.id}"><span class="lt-hicon sm" style="--t1:${m.t1};--t2:${m.t2}">${esc(m.code)}<span class="lt-st ${statusDot(m.d)}"></span></span><div class="lt-rmeta"><span class="lt-hname">${esc(s.name)}</span><span class="lt-haddr">${esc(m.addr)}</span></div><span class="lt-rstat">${esc(m.stat)}</span>${tag}<span class="lt-hgo2">Open →</span></div>`;}
function viewFleet(){
 const q=(ST.ovq||'').toLowerCase();
 const list=SERVERS.filter(s=>!q||(s.name+' '+s.host+' '+(s.gpuLabel||'')).toLowerCase().includes(q));
 const mode=ST.ovmode==='list'?'list':'grid';
 let h=`<div class="lt-ovh"><h3>Hosts</h3><span class="ct">${SERVERS.length} machines · key auth</span><div class="lt-vtog"><span class="lt-vbtn${mode==='grid'?' on':''}" data-ov="grid" title="Grid view">▦</span><span class="lt-vbtn${mode==='list'?' on':''}" data-ov="list" title="List view">≡</span></div><input class="lt-ovsearch" id="lt-ovsearch" placeholder="Search hosts…" value="${esc(ST.ovq||'')}"></div>`;
 if(!list.length)h+=`<div class="lt-empty">No hosts match “${esc(ST.ovq)}”.</div>`;
 else if(mode==='list')h+='<div class="lt-hlist">'+list.map((s,i)=>hostRow(s,i)).join('')+'</div>';
 else h+='<div class="lt-hgrid">'+list.map((s,i)=>hostCard(s,i)).join('')+'</div>';
 const v=$('lt-view');v.className='lt-view pad';v.innerHTML=h;
}

/* ---------------- explorer ---------------- */
function crumbHtml(id,path){const s=byId[id];const parts=(path||'/').split('/').filter(Boolean);let h=`<span class="seg root" data-go="/">${esc(s.name)}</span>`;let acc='';parts.forEach((p,i)=>{acc+='/'+p;h+=`<span class="sep">/</span><span class="seg${i===parts.length-1?' root':''}" data-go="${esc(acc)}">${esc(p)}</span>`;});return h;}
/* file icons: devicon for known code/config types, shapes for folder/symlink/other */
const _DEVEXT={py:'python-plain',pyw:'python-plain',ipynb:'jupyter-plain',js:'javascript-plain',mjs:'javascript-plain',cjs:'javascript-plain',ts:'typescript-plain',tsx:'react-original',jsx:'react-original',rs:'rust-original',go:'go-plain',c:'c-plain',h:'c-plain',cpp:'cplusplus-plain',cc:'cplusplus-plain',cxx:'cplusplus-plain',hpp:'cplusplus-plain',hh:'cplusplus-plain',java:'java-plain',kt:'kotlin-plain',kts:'kotlin-plain',rb:'ruby-plain',php:'php-plain',cs:'csharp-plain',swift:'swift-plain',sh:'bash-plain',bash:'bash-plain',zsh:'bash-plain',csh:'bash-plain',ps1:'powershell-plain',psm1:'powershell-plain',html:'html5-plain',htm:'html5-plain',css:'css3-plain',scss:'sass-original',sass:'sass-original',json:'json-plain',yaml:'yaml-plain',yml:'yaml-plain',md:'markdown-original',markdown:'markdown-original',tex:'latex-original',r:'r-plain',lua:'lua-plain',vim:'vim-plain',sql:'mysql-original',db:'sqlite-plain',sqlite:'sqlite-plain'};
const _DEVNAME={dockerfile:'docker-plain','docker-compose.yml':'docker-plain','docker-compose.yaml':'docker-plain','.gitignore':'git-plain','.gitconfig':'git-plain','.gitattributes':'git-plain','package.json':'nodejs-plain','.bashrc':'bash-plain','.zshrc':'bash-plain','.bash_history':'bash-plain','.vimrc':'vim-plain','.profile':'bash-plain'};
function devClass(name){const n=name.toLowerCase();if(_DEVNAME[n])return _DEVNAME[n];const i=n.lastIndexOf('.');const ext=i>0?n.slice(i+1):'';return _DEVEXT[ext]||null;}
function fileIcon(name,isdir,islink){if(isdir)return '<span class="lt-ic dir"></span>';if(islink)return '<span class="lt-ic lnk"></span>';const dev=devClass(name);return dev?`<i class="lt-di devicon-${dev} colored"></i>`:'<span class="lt-ic fil"></span>';}
async function loadDir(id,path){
 const seq=++ST.loadSeq;ST.listing={id,path:path||'',loading:true};
 if(ST.view==='server'&&ST.tab==='explorer'&&ST.active===id)renderExplorer();
 const url=path!=null?`/api/${id}/ls?path=${encodeURIComponent(path)}`:`/api/${id}/ls`;
 let r;try{r=await api(url);}catch(e){r={error:String(e),entries:[],path:path||'/'};}
 if(seq!==ST.loadSeq)return;
 ST.cwd[id]=r.path;  // authoritative path from backend (resolves $HOME)
 ST.listing={id,path:r.path,loading:false,entries:r.entries||[],error:r.error,parent:r.parent};
 if(ST.view==='server'&&ST.tab==='explorer'&&ST.active===id)renderExplorer();
}
function viewExplorer(){
 const id=ST.active,want=ST.cwd[id];
 if(!ST.listing||ST.listing.id!==id||(want!=null&&ST.listing.path!==want)){loadDir(id,want);return;}
 renderExplorer();
}
function renderExplorer(){
 const id=ST.active,s=byId[id],path=ST.cwd[id],L=ST.listing;
 const parent=(L&&L.parent)||parentOf(path);const fwd=(ST.navFwd&&ST.navFwd[id])||[];
 const backDim=(path==='/'||!path||parent===path)?' dim':'';const fwdDim=fwd.length?'':' dim';
 const top=`<div class="lt-toolbar"><span class="lt-nav${backDim}" data-act="up" title="Parent folder">←</span><span class="lt-nav${fwdDim}" data-act="fwd" title="Forward — back to where you came from">→</span><span class="lt-nav" data-act="refresh" title="Refresh">↻</span>${s.kind==='ssh'?'<span class="lt-nav" data-act="upload" title="Upload files here">⇪</span>':''}<div class="lt-crumb">${crumbHtml(id,path)}</div><input class="lt-filter" id="lt-filter" placeholder="filter…" value="${esc(ST.filter)}"><label class="lt-chk"><input type="checkbox" id="lt-hidden" ${ST.hidden?'checked':''}>HIDDEN</label></div>`;
 let body;
 if(L&&L.loading){body=`<div class="lt-ftable"><div class="lt-empty">Listing <b>${esc(s.name)}:${esc(path)}</b> …</div></div>`;}
 else if(L&&L.error){body=`<div class="lt-ftable"><div class="lt-empty"><b>Couldn’t list this folder.</b><br>${esc(L.error)}</div></div>`;}
 else{
  const ar=ST.sort.asc?'▲':'▼';
  let table=`<div class="lt-fh"><span data-sort="name">NAME ${ST.sort.key==='name'?'<span class="ar">'+ar+'</span>':''}</span><span data-sort="size" style="text-align:right">SIZE ${ST.sort.key==='size'?'<span class="ar">'+ar+'</span>':''}</span><span data-sort="mtime" style="text-align:right">MODIFIED ${ST.sort.key==='mtime'?'<span class="ar">'+ar+'</span>':''}</span></div>`;
  let items=((L&&L.entries)||[]).slice();
  if(!ST.hidden)items=items.filter(r=>!r.name.startsWith('.')&&r.name!=='#recycle');
  if(ST.filter)items=items.filter(r=>r.name.toLowerCase().includes(ST.filter.toLowerCase()));
  const k=ST.sort.key,asc=ST.sort.asc?1:-1;items.sort((a,b)=>{if(a.isdir!==b.isdir)return a.isdir?-1:1;let x,y;if(k==='name'){x=a.name.toLowerCase();y=b.name.toLowerCase();}else if(k==='size'){x=a.isdir?-1:a.size;y=b.isdir?-1:b.size;}else{x=a.mtime;y=b.mtime;}return x<y?-asc:x>y?asc:0;});
  if(!items.length)table+=`<div class="lt-empty">Empty folder${ST.filter?' (filter active)':''}.</div>`;
  items.forEach(r=>{const isHid=r.name.startsWith('.');const seld=ST.sel&&ST.sel.name===r.name?' sel':'';
   table+=`<div class="lt-fr${seld}${isHid?' hid':''}" data-name="${esc(r.name)}" data-dir="${r.isdir?1:0}"><span class="nm">${fileIcon(r.name,r.isdir,r.islink)}<span class="nmtx">${esc(r.name)}</span></span><span class="sz">${r.isdir?'—':bytes(r.size)}</span><span class="dt">${r.mtime?ago(r.mtime):''}</span></div>`;});
  body=`<div class="lt-ftable">${table}</div>${prevHtml(id)}`;
 }
 const v=$('lt-view');v.className='lt-view flexcol';v.innerHTML=top+`<div class="lt-files-body">${body}</div>`;
}
function prevHtml(id){const s=byId[id];
 if(!ST.sel)return `<aside class="lt-prev"><div class="pic">▣</div><h4>Nothing selected</h4><div class="meta">Click a file to preview.<br>Click a folder to open it.</div><div class="lt-hint">Live listing over ${s.kind==='nas'?'the Synology API':s.kind==='wsl'?'wsl.exe':'SSH / SFTP'}.</div></aside>`;
 const r=ST.sel;if(r.dir)return `<aside class="lt-prev"><div class="pic">▤</div><h4>${esc(r.name)}</h4><div class="meta">Folder · ${esc(s.name)}<br>${esc(ST.cwd[id])}/</div><span class="lt-act pri" data-act="open">Open</span><span class="lt-act" data-act="copypath">Copy path</span>${s.kind!=='nas'?'<span class="lt-act" data-act="newterm">Open terminal here</span>':''}</aside>`;
 const ext=(r.name.split('.').pop()||'').toLowerCase();const icon=({pt:'◆',pth:'◆',ckpt:'◆',yaml:'⚙',yml:'⚙',json:'⚙',log:'▦',jsonl:'▦',sh:'▶',csh:'▶',py:'⌘',bib:'❡',pdf:'▤',php:'⟨⟩',dat:'▦'})[ext]||'▢';
 return `<aside class="lt-prev"><div class="pic">${icon}</div><h4>${esc(r.name)}</h4><div class="meta">${bytes(r.size)} · ${esc(ext||'file')}<br>${r.mtime?'modified '+ago(r.mtime):''}<br>${esc(s.name)}:${esc(ST.cwd[id])}/</div><span class="lt-act pri" data-act="sendto">Send to…</span><span class="lt-act" data-act="download">Download</span><span class="lt-act" data-act="copypath">Copy path</span></aside>`;
}

/* ---------------- transfers (queue drawer + actions) ---------------- */
function xfer(){return ST.xfer||(ST.xfer={open:false,jobs:[],timer:null});}
async function xferTick(){let r;try{r=await api('/api/transfers');}catch(e){return;}const x=xfer();x.jobs=r.jobs||[];const act=x.jobs.filter(j=>j.state==='active'||j.state==='queued').length;const n=$('lt-xfer-n');if(n){n.textContent=act||'';n.classList.toggle('on',!!act);}if(x.open)renderDrawer();}
function startXfer(){const x=xfer();if(x.timer)return;x.timer=setInterval(xferTick,1500);xferTick();}
function toggleDrawer(open){const x=xfer();x.open=open!=null?open:!x.open;if(x.open)startXfer();renderDrawer();}
function renderDrawer(){const x=xfer(),el=$('lt-drawer');if(!el)return;el.hidden=!x.open;if(!x.open)return;
 const rows=x.jobs.slice().reverse().map(j=>{const p=j.total?Math.min(100,Math.round(j.done/j.total*100)):(j.state==='done'?100:0);const dir=j.kind==='upload'?'↑':j.kind==='download'?'↓':'→';const col=j.state==='error'?'var(--hot)':j.state==='done'?'var(--ok)':j.state==='canceled'?'var(--dim)':'var(--acc)';const active=j.state==='active'||j.state==='queued';
  return `<div class="lt-xrow"><div class="lt-xtop"><span class="lt-xlabel" title="${esc(j.label)}">${dir} ${esc(j.label)}</span>${active?`<span class="lt-xcancel" data-xcancel="${j.id}" title="Cancel">✕</span>`:`<span class="lt-xstate" style="color:${col}">${j.state}</span>`}</div><div class="lt-xbar"><span class="lt-xfill" style="width:${p}%;background:${col}"></span></div><div class="lt-xsub"><span>${j.total?bytes(j.done)+' / '+bytes(j.total):bytes(j.done)}</span><span>${j.state==='active'?(j.speed>0?bytes(j.speed)+'/s · ':'')+p+'%':(j.error?esc(j.error):p+'%')}</span></div></div>`;}).join('')||'<div class="lt-xempty">No transfers yet.<br>Use “Send to…”, “Download”, or “Upload”.</div>';
 el.innerHTML=`<div class="lt-xhead"><b>Transfers</b><span class="lt-grow"></span><span class="lt-xbtn" data-xfer="clear">Clear done</span><span class="lt-xbtn" data-xclose="1">✕</span></div><div class="lt-xbody">${rows}</div>`;
}
function doDownload(id,path){const a=document.createElement('a');a.href='/api/'+id+'/download?path='+encodeURIComponent(path);document.body.appendChild(a);a.click();a.remove();toast('Downloading '+(path.split('/').pop()||'file')+'…');}
function openSendTo(src){_sendto=src;let el=$('lt-sendto');if(!el){el=document.createElement('div');el.id='lt-sendto';el.className='lt-modal';(document.querySelector('.lt-window')||document.body).appendChild(el);}
 const dests=SERVERS.filter(s=>s.kind==='ssh'||s.kind==='nas');
 const opts=dests.map(s=>`<option value="${esc(s.id)}">${esc(s.name)}${s.kind==='nas'?' · NAS':''}</option>`).join('');
 const def=dests[0];
 el.innerHTML=`<div class="lt-modal-card"><div class="lt-modal-h"><b style="font-family:var(--f-display);font-size:15px;color:var(--tx)">Send “${esc(src.name)}”</b><span class="lt-modal-x" data-sclose="1">✕</span></div><div class="lt-modal-b"><div class="lt-f-grid"><div class="lt-f-wide"><label class="lt-f-l">Destination host</label><select class="lt-f-in" id="st-host">${opts}</select></div><div class="lt-f-wide"><label class="lt-f-l">Destination folder</label><input class="lt-f-in" id="st-path" value="${esc((def&&def.home)||'/')}" placeholder="/home/you"></div></div><div class="lt-hint">Copies over the lab network (server→server or →NAS), streamed with live progress in Transfers.</div></div><div class="lt-modal-f"><span class="lt-btn ghost" data-sclose="1">Cancel</span><span class="lt-btn" data-ssubmit="1">Send</span></div></div>`;
 const sel=$('st-host');if(sel)sel.onchange=()=>{const d=byId[sel.value],p=$('st-path');if(d&&p)p.value=d.home||'/';};
 const pi=$('st-path');if(pi)pi.focus();
}
function closeSendTo(){const el=$('lt-sendto');if(el)el.remove();}
async function submitSendTo(){const src=_sendto;if(!src)return;const sid=(($('st-host')||{}).value)||'';const path=(($('st-path')||{}).value||'').trim();if(!sid||!path){toast('Pick a destination folder');return;}
 try{await api('/api/transfers/copy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({src:{sid:src.sid,path:src.path,name:src.name,size:src.size||0},dst:{sid,path}})});closeSendTo();toggleDrawer(true);toast('Transfer queued');}catch(e){toast('Send failed: '+e);}}
function pickUpload(){const id=ST.active,s=byId[id];if(!s||s.kind!=='ssh'){toast('Upload supported on SSH hosts (for now)');return;}const inp=document.createElement('input');inp.type='file';inp.multiple=true;inp.onchange=()=>uploadFiles(id,ST.cwd[id]||'/',[...inp.files]);inp.click();}
async function uploadFiles(id,dir,files){const s=byId[id];if(!s||s.kind!=='ssh'){toast('Upload supported on SSH hosts (for now)');return;}if(!files||!files.length)return;toggleDrawer(true);for(const f of files){try{await fetch('/api/'+id+'/upload?path='+encodeURIComponent(dir)+'&name='+encodeURIComponent(f.name),{method:'POST',body:f});}catch(e){toast('Upload failed: '+f.name);}xferTick();}toast('Upload complete');if(ST.view==='server'&&ST.active===id&&ST.tab==='explorer')loadDir(id,ST.cwd[id]);}
document.addEventListener('dragover',e=>{if(e.target.closest&&e.target.closest('.lt-files-body')){e.preventDefault();}});
document.addEventListener('drop',e=>{const z=e.target.closest&&e.target.closest('.lt-files-body');if(z&&e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files.length){e.preventDefault();uploadFiles(ST.active,ST.cwd[ST.active]||'/',[...e.dataTransfer.files]);}});

/* ---------------- terminal (real PTY · multi-session · broadcast · search · drop-file) ---------------- */
const SESS={};              // sessionKey -> {key,host,term,fit,search,ws,wrap,connected,ro}
const _enc=new TextEncoder();
function cssvar(n){return getComputedStyle(document.querySelector('.lt-window')).getPropertyValue(n).trim()||'#000';}
function xtermTheme(){const bg=cssvar('--bg'),tx=cssvar('--tx'),acc=cssvar('--acc'),ok=cssvar('--ok'),warn=cssvar('--warn'),hot=cssvar('--hot'),cy=cssvar('--cy'),dim=cssvar('--dim'),dim2=cssvar('--dim2'),tx2=cssvar('--tx2');
 return {background:bg,foreground:tx,cursor:acc,cursorAccent:bg,selectionBackground:acc+'55',
  black:dim2,red:hot,green:ok,yellow:warn,blue:acc,magenta:acc,cyan:cy,white:tx2,
  brightBlack:dim,brightRed:hot,brightGreen:ok,brightYellow:warn,brightBlue:acc,brightMagenta:acc,brightCyan:cy,brightWhite:tx};}
function tabsOf(id){return ST.termTabs[id]||(ST.termTabs[id]=[]);}
function activeKey(id){return ST.termActive[id];}
function updateTermThemes(){Object.values(SESS).forEach(p=>{try{p.term.options.theme=xtermTheme();}catch(e){}});}
function setTermStatus(){const p=SESS[activeKey(ST.active)];const led=$('lt-term-led'),st=$('lt-term-stat-c');if(led)led.className='lt-led'+(p&&p.connected?'':' off');if(st)st.textContent=p?(p.connected?'connected':'disconnected'):'…';}
function broadcastInput(d){const b=_enc.encode(d);Object.values(SESS).forEach(p=>{if(p.ws.readyState===1)p.ws.send(b);});}
function renderTtabs(id){const el=$('lt-ttabs');if(!el)return;const tabs=tabsOf(id);let h='';tabs.forEach((k,i)=>{const on=k===activeKey(id);h+=`<span class="lt-ttab${on?' on':''}" data-sess="${k}">sh${i+1}${tabs.length>1?` <b data-close="${k}">✕</b>`:''}</span>`;});h+=`<span class="lt-ttab add" data-newsess="1" title="New shell on this host">+</span>`;el.innerHTML=h;}
function attachSession(key){const p=SESS[key];if(!p)return;const mount=$('lt-term-mount');if(mount){mount.innerHTML='';mount.appendChild(p.wrap);}ST.termActive[p.host]=key;try{p.fit.fit();}catch(e){}p.term.focus();renderTtabs(p.host);setTermStatus();}
function openSession(id){
 const mount=$('lt-term-mount');if(!mount)return;
 if(!window.Terminal||!window.FitAddon){mount.innerHTML='<div class="lt-empty"><b>Terminal needs xterm.js.</b><br>It loads from a CDN — check the internet connection.</div>';return;}
 const key=id+'#'+(++ST.sessSeq),s=byId[id];
 tabsOf(id).push(key);ST.termActive[id]=key;
 mount.innerHTML='';
 const wrap=document.createElement('div');wrap.className='lt-xterm';mount.appendChild(wrap);
 const term=new Terminal({fontFamily:"'JetBrainsMono Nerd Font','MesloLGS NF','CaskaydiaCove Nerd Font','Hack Nerd Font','JetBrains Mono','Symbols Nerd Font Mono',ui-monospace,monospace",fontSize:12.5,lineHeight:1.15,cursorBlink:true,scrollback:8000,theme:xtermTheme(),allowProposedApi:true});
 const fit=new FitAddon.FitAddon();term.loadAddon(fit);
 let search=null;if(window.SearchAddon){search=new SearchAddon.SearchAddon();term.loadAddon(search);}
 if(window.Unicode11Addon){try{term.loadAddon(new Unicode11Addon.Unicode11Addon());term.unicode.activeVersion='11';}catch(e){}}
 term.open(wrap);try{fit.fit();}catch(e){}
 if(document.fonts&&document.fonts.ready)document.fonts.ready.then(()=>{try{fit.fit();}catch(e){}});
 term.writeln('\x1b[90mConnecting to '+s.host+'…\x1b[0m');
 const proto=location.protocol==='https:'?'wss':'ws';
 const ws=new WebSocket(`${proto}://${location.host}/api/${id}/pty?cols=${term.cols}&rows=${term.rows}`);ws.binaryType='arraybuffer';
 const p={key,host:id,term,fit,search,ws,wrap,connected:false};SESS[key]=p;
 ws.onopen=()=>{p.connected=true;setTermStatus();try{ws.send(JSON.stringify({t:'r',c:term.cols,r:term.rows}));}catch(e){}};
 ws.onmessage=ev=>{if(typeof ev.data==='string')term.write(ev.data);else term.write(new Uint8Array(ev.data));};
 ws.onclose=()=>{p.connected=false;term.write('\r\n\x1b[90m[session closed — Reconnect to restart]\x1b[0m\r\n');setTermStatus();};
 ws.onerror=()=>{p.connected=false;setTermStatus();};
 term.onData(d=>{if(ST.broadcast)broadcastInput(d);else if(ws.readyState===1)ws.send(_enc.encode(d));});
 term.onResize(({cols,rows})=>{if(ws.readyState===1)ws.send(JSON.stringify({t:'r',c:cols,r:rows}));});
 term.attachCustomKeyEventHandler(ev=>{if(ev.ctrlKey&&(ev.key==='f'||ev.key==='F')){if(ev.type==='keydown')toggleFind(true);return false;}return true;});
 wrap.addEventListener('dragover',ev=>ev.preventDefault());
 wrap.addEventListener('drop',ev=>{ev.preventDefault();const f=ev.dataTransfer&&ev.dataTransfer.files[0];if(f)injectFile(p,f);});
 if(window.ResizeObserver){p.ro=new ResizeObserver(()=>{try{fit.fit();}catch(e){}});p.ro.observe(wrap);}
 renderTtabs(id);setTermStatus();term.focus();
}
function closeSession(key,noReopen){const p=SESS[key];if(!p)return;const id=p.host;try{p.ws.close();}catch(e){}try{p.ro&&p.ro.disconnect();}catch(e){}try{p.term.dispose();}catch(e){}try{p.wrap.remove();}catch(e){}delete SESS[key];const arr=tabsOf(id).filter(k=>k!==key);ST.termTabs[id]=arr;if(ST.termActive[id]===key)ST.termActive[id]=arr[arr.length-1]||null;if(noReopen)return;if(!arr.length)openSession(id);else attachSession(ST.termActive[id]);}
function injectFile(p,file){if(file.size>512*1024){toast('Too big to paste (>512 KB)');return;}const r=new FileReader();r.onload=()=>{if(p.ws.readyState===1)p.ws.send(_enc.encode(String(r.result)));toast('Pasted “'+file.name+'” into the shell');};r.readAsText(file);}
function doFind(dir){const p=SESS[activeKey(ST.active)];if(!p||!p.search)return;const q=($('lt-find-in')||{}).value||'';if(!q)return;dir<0?p.search.findPrevious(q):p.search.findNext(q);}
function toggleFind(show){const f=$('lt-find');if(!f)return;const vis=show===undefined?(f.style.display==='none'):show;f.style.display=vis?'flex':'none';if(vis){const i=$('lt-find-in');if(i)i.focus();}else{const p=SESS[activeKey(ST.active)];if(p)p.term.focus();}}
function viewTerminal(){
 const id=ST.active,s=byId[id];
 const v=$('lt-view');v.className='lt-view flexcol';
 v.innerHTML=`<div class="lt-term${ST.broadcast?' bcast':''}"><div class="lt-term-bar"><span class="lt-led off" id="lt-term-led"></span><span>${s.kind==='wsl'?'wsl.exe':'ssh'} · ${esc(s.host)}${s.kind==='ssh'?':'+s.port:''}</span><span id="lt-term-stat-c">…</span><span class="lt-ttabs" id="lt-ttabs"></span><span class="lt-grow"></span><span class="lt-tbtn${ST.broadcast?' on':''}" data-tact="broadcast" title="Mirror keystrokes to every open session">⇉ Broadcast</span><span class="lt-tbtn" data-tact="find" title="Search scrollback (Ctrl+F)">Find</span><span class="lt-tbtn" data-tact="clear">Clear</span><span class="lt-tbtn" data-tact="reconnect">Reconnect</span></div><div class="lt-find" id="lt-find" style="display:none"><input id="lt-find-in" placeholder="search scrollback — Enter / Shift+Enter" autocomplete="off"><span class="lt-tbtn" data-tact="find-prev">▴</span><span class="lt-tbtn" data-tact="find-next">▾</span><span class="lt-tbtn" data-tact="find-close">✕</span></div><div class="lt-term-mount" id="lt-term-mount"></div></div>`;
 const key=activeKey(id);
 if(key&&SESS[key])attachSession(key);else openSession(id);
}

/* ---------------- monitor (availability · trends · processes · vitals) ---------------- */
function tempColor(t){return utilColor(Math.max(0,Math.min(100,(t-30)/0.6)));}
function userColor(u){let n=0;u=u||'';for(let i=0;i<u.length;i++)n=(n*31+u.charCodeAt(i))%360;return `hsl(${n} 58% 55%)`;}
function gpuHue(ix){return `hsl(${(ix*67)%360} 70% 55%)`;}
function pushHist(id){const d=FLEET[id];if(!d||!d.gpus)return;d.gpus.forEach((g,i)=>{const k=id+':'+(g.index!=null?g.index:i);const a=ST.hist[k]||(ST.hist[k]=[]);a.push({u:g.util,m:pct(g.mu,g.mt)});if(a.length>48)a.shift();});}
function lineChart(series,danger,metric){const W=100,H=40;let g='';[0,50,100].forEach(val=>{const y=(1-val/100)*H;g+=`<line class="gl" x1="0" y1="${y}" x2="${W}" y2="${y}"></line>`;});if(danger!=null){const y=(1-danger/100)*H;g+=`<line class="dgr" x1="0" y1="${y}" x2="${W}" y2="${y}"></line>`;}
 series.forEach(s=>{const a=s.pts;if(!a.length)return;const n=a.length;const line=(n<2?`0,${((1-(a[0]||0)/100)*H).toFixed(1)} ${W},${((1-(a[0]||0)/100)*H).toFixed(1)}`:a.map((val,i)=>`${(i/(n-1)*W).toFixed(2)},${((1-val/100)*H).toFixed(2)}`).join(' '));g+=`<polygon points="${line} ${W},${H} 0,${H}" style="fill:${s.color};fill-opacity:.15"></polygon><polyline points="${line}" style="stroke:${s.color}"></polyline>`;});
 const labs=series.map(s=>{const lv=s.pts.length?s.pts[s.pts.length-1]:0,top=(1-lv/100)*100;return `<span class="lt-lc-dot" style="top:${top}%;background:${s.color}"></span><span class="lt-lc-lab" style="top:${top}%;color:${s.color}">${esc(s.label)} ${Math.round(lv)}%</span>`;}).join('');
 return `<div class="lt-chart" data-metric="${metric||''}"><div class="lt-chart-ax"><span>100</span><span>50</span><span>0</span></div><svg class="lt-lc" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${g}</svg>${labs}</div>`;
}
function viewMonitor(){
 const id=ST.active,s=byId[id],d=FLEET[id];const v=$('lt-view');v.className='lt-view pad';
 if(!d){v.innerHTML='<div class="lt-empty">Connecting…</div>';return;}
 if(d.online===false){v.innerHTML=`<div class="lt-empty"><b>${esc(s.name)} is offline.</b><br>${esc(d.error||'')}</div>`;return;}
 const gs=gpus(d),dk=disks(d),GB=mib=>mib/1024;
 const bar=(p,c,extra)=>`<span class="lt-bar"><span class="lt-fill" style="width:${Math.max(0,Math.min(100,p))}%;color:${c}"></span>${extra||''}</span>`;
 let h='<div class="lt-mon">';
 /* PANEL 1 — availability strip (free VRAM is the hero) */
 if(gs.length){
  const free=gs.filter(g=>g.util<10&&pct(g.mu,g.mt)<10).length;
  h+=`<div class="lt-mhd"><b>GPUs</b><span class="ln"></span><span class="cnt">${free}/${gs.length} free</span></div><div class="lt-avail">`;
  gs.forEach((g,i)=>{const ix=g.index!=null?g.index:i,mp=pct(g.mu,g.mt),fGB=GB(g.mt-g.mu),isFree=g.util<10&&mp<10,mc=utilColor(mp);
   h+=`<div class="lt-av${isFree?' free':''}"><div class="lt-av-top"><span class="lt-av-ix" style="color:${gpuHue(ix)}">GPU ${ix}</span><span class="lt-av-model">${esc(g.name)}</span><span class="lt-av-t" style="color:${tempColor(g.temp)}">${g.temp}°C</span></div>`+
   `<div class="lt-av-free"><b style="color:${isFree?'var(--ok)':mc}">${fGB.toFixed(1)}</b><span>GB free</span>${isFree?'<span class="lt-av-pill">FREE</span>':`<em>${g.util}% util</em>`}</div>`+
   bar(mp,mc,`<span class="lt-av-mark" style="left:${Math.max(0,Math.min(100,g.util))}%"></span>`)+
   `<div class="lt-av-sub"><span>${GB(g.mu).toFixed(1)} / ${GB(g.mt).toFixed(0)} GB</span><span>${Math.round(g.pow)}/${g.plim} W</span></div></div>`;});
  h+='</div>';
 }else if(s.kind!=='nas'){
  h+=`<div class="lt-mhd"><b>GPUs</b><span class="ln"></span></div><div class="lt-note">No GPU on this host — CPU server · ${d.ncpu||'?'} cores · load ${d.load?d.load[0]:'?'}</div>`;
 }
 /* PANEL 3 — processes */
 if(s.kind!=='nas'){
  const procs=(d.procs||[]).slice().sort((a,b)=>(b.mem||0)-(a.mem||0));
  h+=`<div class="lt-mhd"><b>Processes</b><span class="ln"></span><span class="cnt">${procs.length}</span></div><div class="lt-panel"><div class="lt-proc-h"><span>USER</span><span>PID</span><span>GPU</span><span>VRAM</span><span>TIME</span><span>COMMAND</span></div>`;
  if(procs.length)procs.forEach(p=>{h+=`<div class="lt-proc${p.user===s.user?' me':''}${ST.procOpen[p.pid]?' open':''}" data-pid="${p.pid}"><span class="lt-proc-u"><i style="color:${userColor(p.user)}"></i>${esc(p.user)}</span><span class="lt-proc-pid">${p.pid}</span><span class="lt-proc-gpu">${p.gpu}</span><span class="lt-proc-mem">${GB(p.mem).toFixed(1)} GB</span><span class="lt-proc-time">${esc(p.etime||'')}</span><span class="lt-proc-cmd" title="${esc(p.cmd||'')}">${esc(p.cmd||'')}</span></div>`+(ST.procOpen[p.pid]?`<div class="lt-proc-full">${esc(p.cmd||'')}</div>`:'');});
  else h+=`<div class="lt-proc-empty">No GPU processes${gs.length?' — GPUs idle, or other users’ jobs not visible':''}.</div>`;
  h+='</div>';
 }
 /* PANEL 4 — host vitals (bullet bars) */
 const bl=(label,val,p,c,sub)=>`<div class="lt-bl"><div class="lt-bl-top"><span>${esc(label)}</span><span>${val}</span></div>${bar(p,c)}${sub?`<div class="lt-bl-sub">${sub}</div>`:''}</div>`;
 let vit='';
 if(s.kind!=='nas'){
  const lp=d.ncpu?Math.min(100,d.load[0]/d.ncpu*100):0;
  vit+=bl('CPU load',`${d.load?d.load[0]:'—'} / ${d.ncpu||'?'}`,lp,utilColor(lp),`${Math.round(lp)}% of ${d.ncpu||'?'} cores`);
  if(d.mem){const mp=pct(d.mem.used,d.mem.total);vit+=bl('System RAM',`${bytes(d.mem.used)} / ${bytes(d.mem.total)}`,mp,'var(--cy)',mp+'% used');}
 }
 dk.forEach(x=>{const p=pct(x.used,x.size);vit+=bl(x.m,`${bytes(x.used)} / ${bytes(x.size)}`,p,utilColor(p),`${bytes(x.size-x.used)} free · ${p}%`);});
 h+=`<div class="lt-mhd"><b>Host${s.kind==='nas'?' · storage':''}</b><span class="ln"></span><span class="cnt">${s.kind==='nas'?'volume':(d.up?'up '+d.up:'')}</span></div><div class="lt-vitals">${vit||'<div class="lt-proc-empty">No vitals reported.</div>'}</div>`;
 /* PANEL — trends (history) at the bottom */
 if(gs.length){
  const mk=which=>gs.map((g,i)=>{const ix=g.index!=null?g.index:i,a=ST.hist[id+':'+ix]||[{u:g.util,m:pct(g.mu,g.mt)}];return {label:'GPU'+ix,color:gpuHue(ix),pts:a.map(x=>x[which])};});
  const us=mk('u'),ms=mk('m');ST.chart={u:{series:us,sec:2},m:{series:ms,sec:2}};
  const span=Math.max(1,...gs.map((g,i)=>{const ix=g.index!=null?g.index:i;return (ST.hist[id+':'+ix]||[]).length;}));
  const mins=Math.round(span*2/60*10)/10;
  h+=`<div class="lt-mhd"><b>Utilization</b><span class="ln"></span><span class="cnt">% · last ${span<2?'now':mins+' min'}</span></div>${lineChart(us,null,'u')}`;
  h+=`<div class="lt-mhd"><b>VRAM</b><span class="ln"></span><span class="cnt">% of total · 90% danger</span></div>${lineChart(ms,90,'m')}`;
 }
 if(gs.length)h+=`<div class="lt-alert${ST.alert?' on':''}" id="lt-alert" style="margin-top:8px"><span class="tog"></span><div><b>Alert me when a GPU here is free for 10 minutes</b><br><span>Desktop notification — grab it before someone else does.</span></div></div>`;
 h+='</div>';
 v.innerHTML=h;
}

/* ---------------- dispatch ---------------- */
function stopMon(){if(ST.monTimer){clearInterval(ST.monTimer);ST.monTimer=null;}}
function startMon(){const s=byId[ST.active];if(!s||s.kind==='nas')return;ST.monTimer=setInterval(()=>{const cur=ST.active;api('/api/'+cur+'/status').then(st=>{FLEET[cur]=st;pushHist(cur);if(ST.view==='server'&&ST.tab==='monitor'&&ST.active===cur)viewMonitor();}).catch(()=>{});},2000);}
function renderView(){
 stopMon();
 if(ST.view==='fleet'){viewFleet();return;}
 const s=byId[ST.active];const valid=tabsFor(s).map(t=>t[0]);if(!valid.includes(ST.tab))ST.tab='explorer';
 if(ST.tab==='explorer')viewExplorer();else if(ST.tab==='terminal')viewTerminal();else{viewMonitor();startMon();}
}
/* chart hover tooltip */
function ensureChartTip(){const w=document.querySelector('.lt-window')||document.body;let t=$('lt-cht-tip');if(!t){t=document.createElement('div');t.id='lt-cht-tip';w.appendChild(t);}let g=$('lt-cht-guide');if(!g){g=document.createElement('div');g.id='lt-cht-guide';w.appendChild(g);}return{t,g};}
function hideChartTip(){const t=$('lt-cht-tip'),g=$('lt-cht-guide');if(t)t.style.display='none';if(g)g.style.display='none';}
document.addEventListener('mousemove',e=>{
 const ch=e.target.closest('.lt-chart');
 if(!ch||!ST.chart){hideChartTip();return;}
 const data=ST.chart[ch.getAttribute('data-metric')];if(!data){hideChartTip();return;}
 const r=ch.getBoundingClientRect(),L=34,R=14,w=r.width-L-R,fx=(e.clientX-r.left-L)/w;
 if(fx<-0.03||fx>1.03){hideChartTip();return;}
 const ser=data.series,n=Math.max(1,...ser.map(s=>s.pts.length)),idx=Math.min(n-1,Math.max(0,Math.round(Math.min(1,Math.max(0,fx))*(n-1))));
 const px=r.left+L+(n<2?w:idx/(n-1)*w);
 const {t,g}=ensureChartTip();
 g.style.display='block';g.style.left=px+'px';g.style.top=r.top+'px';g.style.height=r.height+'px';
 const ago=(n-1-idx)*data.sec;
 t.innerHTML=`<div class="tt">${ago<=0?'now':'~'+ago+'s ago'}</div>`+ser.map(s=>{const v=s.pts[Math.min(idx,s.pts.length-1)]||0;return `<div><span style="color:${s.color}">●</span> ${esc(s.label)} <b>${Math.round(v)}%</b></div>`;}).join('');
 t.style.display='block';const tw=t.offsetWidth;let tx=px+12;if(tx+tw>window.innerWidth-8)tx=px-tw-12;t.style.left=tx+'px';t.style.top=(r.top+6)+'px';
});
function renderAll(){renderSide();renderHeadTabs();renderView();}
function openServer(id,tab){ST.view='server';ST.active=id;if(tab)ST.tab=tab;ST.sel=null;ST.filter='';ST.listing=null;const s=byId[id];if(s&&s.group){ST.collapsed[s.group]=false;}renderAll();}

/* ---------------- events ---------------- */
document.addEventListener('click',e=>{
 if(!e.target.closest('.lt-window')&&!e.target.closest('.lt-toast'))return;
 if(e.target.closest('[data-view]')){ST.view='fleet';renderAll();return;}
 if(e.target.id==='lt-modal'){closeModal();return;}
 if(e.target.id==='lt-sendto'){closeSendTo();return;}
 if(e.target.closest('[data-sclose]')){closeSendTo();return;}
 if(e.target.closest('[data-ssubmit]')){submitSendTo();return;}
 if(e.target.closest('#lt-xfer-btn')){toggleDrawer();return;}
 if(e.target.closest('[data-xclose]')){toggleDrawer(false);return;}
 {const xc=e.target.closest('[data-xcancel]');if(xc){api('/api/transfers/'+xc.getAttribute('data-xcancel')+'/cancel',{method:'POST'}).then(xferTick);return;}}
 if(e.target.closest('[data-xfer="clear"]')){api('/api/transfers/clear',{method:'POST'}).then(xferTick);return;}
 if(e.target.closest('[data-mclose]')){closeModal();return;}
 if(e.target.closest('[data-msubmit]')){submitAdd();return;}
 const mmode=e.target.closest('[data-mode]');if(mmode){_modal.mode=mmode.getAttribute('data-mode');renderModal();return;}
 /* folder/server edit + remove are via right-click — see the contextmenu listener */
 const addb=e.target.closest('[data-add]');if(addb){openAddModal(addb.getAttribute('data-add')||'server',addb.getAttribute('data-folder'));return;}
 const grp=e.target.closest('[data-grp]');if(grp){const k=grp.getAttribute('data-grp');ST.collapsed[k]=!folderCollapsed(k);try{localStorage.setItem('lt-collapsed',JSON.stringify(ST.collapsed));}catch(e){}renderSide();return;}
 const ovb=e.target.closest('[data-ov]');if(ovb){ST.ovmode=ovb.getAttribute('data-ov');try{localStorage.setItem('lt-ovmode',ST.ovmode);}catch(e){}viewFleet();return;}
 const closeb=e.target.closest('[data-close]');if(closeb){closeSession(closeb.getAttribute('data-close'));return;}
 const sesst=e.target.closest('[data-sess]');if(sesst){attachSession(sesst.getAttribute('data-sess'));return;}
 if(e.target.closest('[data-newsess]')){openSession(ST.active);return;}
 const tact=e.target.closest('[data-tact]');if(tact){const a=tact.getAttribute('data-tact'),id=ST.active,key=activeKey(id),p=SESS[key];
  if(a==='clear'){if(p)p.term.clear();}
  else if(a==='reconnect'){if(key)closeSession(key,true);openSession(id);}
  else if(a==='broadcast'){ST.broadcast=!ST.broadcast;tact.classList.toggle('on',ST.broadcast);const tw=document.querySelector('.lt-term');if(tw)tw.classList.toggle('bcast',ST.broadcast);toast(ST.broadcast?'Broadcast ON — keystrokes go to ALL open sessions':'Broadcast off');}
  else if(a==='find'){toggleFind();}
  else if(a==='find-next'){doFind(1);}
  else if(a==='find-prev'){doFind(-1);}
  else if(a==='find-close'){toggleFind(false);}
  return;}
 const card=e.target.closest('#lt-view [data-sv]');if(card){openServer(card.getAttribute('data-sv'),'explorer');return;}
 const sv=e.target.closest('.lt-side [data-sv]');if(sv){openServer(sv.getAttribute('data-sv'));return;}
 const tab=e.target.closest('[data-tab]');if(tab){ST.tab=tab.getAttribute('data-tab');ST.sel=null;renderHeadTabs();renderView();return;}
 const go=e.target.closest('[data-go]');if(go){ST.cwd[ST.active]=go.getAttribute('data-go');(ST.navFwd||(ST.navFwd={}))[ST.active]=[];ST.sel=null;ST.filter='';loadDir(ST.active,ST.cwd[ST.active]);return;}
 const sort=e.target.closest('[data-sort]');if(sort){const k=sort.getAttribute('data-sort');if(ST.sort.key===k)ST.sort.asc=!ST.sort.asc;else{ST.sort.key=k;ST.sort.asc=true;}renderExplorer();return;}
 const row=e.target.closest('.lt-fr');if(row){const name=row.getAttribute('data-name'),dir=row.getAttribute('data-dir')==='1';
  if(dir){const cur=ST.cwd[ST.active];ST.cwd[ST.active]=(cur==='/'?'':cur)+'/'+name;(ST.navFwd||(ST.navFwd={}))[ST.active]=[];ST.sel=null;ST.filter='';loadDir(ST.active,ST.cwd[ST.active]);}
  else{const r=((ST.listing&&ST.listing.entries)||[]).find(x=>x.name===name);ST.sel=r?{name:r.name,dir:false,size:r.size,mtime:r.mtime}:{name,dir:false};renderExplorer();}return;}
 const act=e.target.closest('[data-act]');if(act){const a=act.getAttribute('data-act');
  if(a==='up'){const id=ST.active,cur=ST.cwd[id]||'',L=ST.listing,par=(L&&L.id===id&&L.parent)||parentOf(cur);if(par&&par!==cur){(ST.navFwd||(ST.navFwd={}));(ST.navFwd[id]=ST.navFwd[id]||[]).push(cur);ST.sel=null;ST.filter='';loadDir(id,par);}}
  else if(a==='fwd'){const id=ST.active,f=(ST.navFwd||{})[id];if(f&&f.length){const t=f.pop();ST.sel=null;ST.filter='';loadDir(id,t);}}
  else if(a==='refresh'){loadDir(ST.active,ST.cwd[ST.active]);toast('Refreshing…');}
  else if(a==='open'&&ST.sel){const cur=ST.cwd[ST.active];ST.cwd[ST.active]=(cur==='/'?'':cur)+'/'+ST.sel.name;(ST.navFwd||(ST.navFwd={}))[ST.active]=[];ST.sel=null;loadDir(ST.active,ST.cwd[ST.active]);}
  else if(a==='newterm'){openServer(ST.active,'terminal');}
  else if(a==='copypath'&&ST.sel){toast('Copied — '+byId[ST.active].name+':'+ST.cwd[ST.active]+'/'+ST.sel.name);}
  else if(a==='download'&&ST.sel){const cur=ST.cwd[ST.active];doDownload(ST.active,(cur==='/'?'':cur)+'/'+ST.sel.name);}
  else if(a==='sendto'&&ST.sel){const cur=ST.cwd[ST.active];openSendTo({sid:ST.active,path:(cur==='/'?'':cur)+'/'+ST.sel.name,name:ST.sel.name,size:ST.sel.size||0});}
  else if(a==='upload'){pickUpload();}
  return;}
 const prow=e.target.closest('.lt-proc[data-pid]');if(prow){const pid=prow.getAttribute('data-pid');ST.procOpen[pid]=!ST.procOpen[pid];viewMonitor();return;}
 const al=e.target.closest('#lt-alert');if(al){ST.alert=!ST.alert;al.classList.toggle('on',ST.alert);toast(ST.alert?'Alert on (prototype)':'Alert off');return;}
});
document.addEventListener('input',e=>{
 if(e.target.id==='lt-filter'){ST.filter=e.target.value;renderExplorer();const n=$('lt-filter');if(n){n.focus();n.setSelectionRange(n.value.length,n.value.length);}}
 else if(e.target.id==='lt-ovsearch'){ST.ovq=e.target.value;viewFleet();const n=$('lt-ovsearch');if(n){n.focus();n.setSelectionRange(n.value.length,n.value.length);}}
});
document.addEventListener('change',e=>{
 if(e.target.id==='lt-hidden'){ST.hidden=e.target.checked;renderExplorer();}
 else if(e.target.name==='ltpal'){localStorage.setItem('lt-pal',e.target.id.replace('th-',''));updateTermThemes();}
 else if(e.target.id==='lt-day'){localStorage.setItem('lt-mode',e.target.checked?'day':'night');updateTermThemes();}
});
document.addEventListener('keydown',e=>{
 if($('lt-modal')){if(e.key==='Escape'){closeModal();return;}if(e.key==='Enter'&&e.target.classList&&e.target.classList.contains('lt-f-in')&&e.target.tagName!=='SELECT'){e.preventDefault();submitAdd();return;}}
 if(e.target.id==='lt-find-in'){if(e.key==='Enter'){e.preventDefault();doFind(e.shiftKey?-1:1);}else if(e.key==='Escape'){toggleFind(false);}}
});

/* ---------------- init + polling ---------------- */
function applyTheme(){const pal=localStorage.getItem('lt-pal')||'sol',mode=localStorage.getItem('lt-mode')||'day';const p=$('th-'+pal);if(p)p.checked=true;$('lt-day').checked=(mode!=='night');}
async function poll(){
 try{const f=await api('/api/fleet');f.servers.forEach(s=>{FLEET[s.id]=s;});
  const on=f.servers.filter(s=>s.online!==false).length;$('lt-conn').textContent=`${on}/${f.servers.length} hosts online`;
  renderSide();
  if(ST.view==='fleet'){if(document.activeElement&&document.activeElement.id==='lt-ovsearch')return;viewFleet();}
  else{renderHeadTabs();if(ST.tab==='monitor')viewMonitor();}
 }catch(e){$('lt-conn').textContent='backend unreachable';}
}
async function init(){
 applyTheme();
 try{ST.collapsed=JSON.parse(localStorage.getItem('lt-collapsed')||'{}')||{};}catch(e){}
 ST.ovmode=localStorage.getItem('lt-ovmode')||'grid';
 try{const[sv,fo]=await Promise.all([api('/api/servers'),api('/api/folders')]);SERVERS=sv;FOLDERS=fo;}catch(e){$('lt-view').innerHTML='<div class="lt-empty">Backend not reachable — is the server running?<br>'+esc(String(e))+'</div>';return;}
 byId=Object.fromEntries(SERVERS.map(s=>[s.id,s]));SIDX=Object.fromEntries(SERVERS.map((s,i)=>[s.id,i]));
 ST.active=SERVERS[0]&&SERVERS[0].id;
 renderAll();poll();setInterval(poll,5000);startXfer();
}
/* frameless window controls (Tauri global API) */
document.addEventListener('click',e=>{const wc=e.target.closest('[data-wc]');if(!wc)return;const T=window.__TAURI__;if(T&&T.window){const w=T.window.getCurrentWindow();const a=wc.getAttribute('data-wc');if(a==='min')w.minimize();else if(a==='max')w.toggleMaximize();else if(a==='close')w.close();}});
/* drag the frameless window by the titlebar (explicit startDragging — auto drag-region isn't injected for an external-URL window) */
const _wcSel='.lt-wc,.lt-theme,.lt-kbd,button,a,input,select';
document.addEventListener('mousedown',e=>{if(e.button!==0)return;const tb=e.target.closest('.lt-titlebar');if(!tb||e.target.closest(_wcSel))return;const T=window.__TAURI__;if(T&&T.window)T.window.getCurrentWindow().startDragging();});
document.addEventListener('dblclick',e=>{const tb=e.target.closest('.lt-titlebar');if(!tb||e.target.closest(_wcSel))return;const T=window.__TAURI__;if(T&&T.window)T.window.getCurrentWindow().toggleMaximize();});
init();
})();
