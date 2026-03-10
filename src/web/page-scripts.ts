/**
 * All page initialization scripts collected here to avoid circular deps.
 * Page renderers import allPageScripts() to pass to renderShell().
 * Script functions return JS source strings that run inside the SPA shell.
 */

import { DISCOVERY_POLL_INTERVAL } from '../config.js';

export function allPageScripts(): Record<string, string> {
  return {
    dashboard: dashboardScript(),
    conversations: conversationsScript(),
    context: contextScript(),
    ipc: ipcScript(),
    network: networkScript(),
    system: systemScript(),
  };
}

function dashboardScript(): string {
  return `
// ---- Topology Canvas (Hierarchical: Server > Category > Channel + Agents) ----
(function(){
  var canvas=document.getElementById("topo-canvas");
  var tooltip=document.getElementById("topo-tooltip");
  var dataEl=document.getElementById("topo-data");
  if(!canvas||!dataEl)return;
  var ctx=canvas.getContext("2d");
  var wrap=canvas.parentElement;
  var dpr=window.devicePixelRatio||1;
  var W,H;

  // ---- Pan & Zoom state ----
  var panX=0,panY=0,zoom=1;
  var MIN_ZOOM=0.15,MAX_ZOOM=4;

  function resize(){
    var r=wrap.getBoundingClientRect();
    W=r.width;H=r.height;
    canvas.width=W*dpr;canvas.height=H*dpr;
    canvas.style.width=W+"px";canvas.style.height=H+"px";
  }
  resize();
  var ro=new ResizeObserver(resize);ro.observe(wrap);

  // Convert screen coords to world coords
  function screenToWorld(sx,sy){return{x:(sx-panX)/zoom,y:(sy-panY)/zoom};}
  function worldToScreen(wx,wy){return{x:wx*zoom+panX,y:wy*zoom+panY};}

  var agents=JSON.parse(dataEl.textContent||"[]");
  var COLORS={
    agent:"#818cf8",server:"#fbbf24",category:"#22d3ee",channel:"#34d399",
    agentGlow:"rgba(129,140,248,.2)",serverGlow:"rgba(251,191,36,.18)",
    categoryGlow:"rgba(34,211,238,.15)",channelGlow:"rgba(52,211,153,.15)",
    edgeHierarchy:"rgba(255,255,255,.08)",edgeAgent:"rgba(129,140,248,.12)",
    edgeHierarchyActive:"rgba(255,255,255,.35)",edgeAgentActive:"rgba(129,140,248,.4)",
    text:"#cdd2dc",textDim:"#636a7e",bg:"#141821"
  };

  // ---- Build nodes & edges ----
  var nodes=[],edges=[],nodeMap={};
  var serverSet={},categorySet={},channelSet={};

  function attachAvatar(node){
    node.avatarImg=null;
    if(!node.avatarUrl)return;
    var img=new Image();
    img.crossOrigin="anonymous";
    var attempts=0;
    function load(){
      var sep=node.avatarUrl.indexOf("?")===-1?"?":"&";
      img.src=node.avatarUrl+(attempts>0?sep+"retry="+attempts:"");
    }
    img.onload=function(){node.avatarImg=img;};
    img.onerror=function(){
      if(attempts>=3)return;
      attempts++;
      setTimeout(load,1500*attempts);
    };
    load();
  }

  // 1) Collect servers
  agents.forEach(function(a){
    if(a.server){
      var sk="s:"+a.server;
      if(!serverSet[sk]){
        serverSet[sk]=true;
        var sn={id:sk,type:"server",label:a.server.split("/").pop()||a.server,
          sub:"server",detail:a.server,fullName:a.server.split("/").pop()||a.server,
          x:0,y:0,vx:0,vy:0,r:24,color:COLORS.server,glow:COLORS.serverGlow,jid:a.server,
          avatarUrl:a.serverIconUrl||null};
        attachAvatar(sn);
        nodes.push(sn);nodeMap[sk]=sn;
      } else if(a.serverIconUrl && !nodeMap[sk].avatarUrl){
        nodeMap[sk].avatarUrl=a.serverIconUrl;
        attachAvatar(nodeMap[sk]);
      }
    }
  });

  // 2) Collect categories and channels, build hierarchy edges
  agents.forEach(function(a){
    a.channels.forEach(function(ch){
      // Category node
      if(ch.category){
        var catK="cat:"+ch.category;
        if(!categorySet[catK]){
          categorySet[catK]=true;
          var catLabel=ch.category.split("/").pop()||ch.category;
          var cn={id:catK,type:"category",label:catLabel,sub:"category",detail:ch.category,fullName:catLabel,
            x:0,y:0,vx:0,vy:0,r:16,color:COLORS.category,glow:COLORS.categoryGlow,jid:ch.category};
          nodes.push(cn);nodeMap[catK]=cn;

          // Link category to its server (find server whose path is a prefix)
          if(a.server){
            var sk="s:"+a.server;
            if(nodeMap[sk]&&ch.category.indexOf(a.server)===0){
              edges.push({from:sk,to:catK,type:"hierarchy"});
            }
          }
        }
      }

      // Channel node
      var chK="ch:"+ch.jid;
      if(!channelSet[chK]){
        channelSet[chK]=true;
        var chNode={id:chK,type:"channel",label:ch.name.length>22?ch.name.slice(0,20)+"\\u2026":ch.name,
          sub:"channel",detail:ch.jid,fullName:ch.name,
          x:0,y:0,vx:0,vy:0,r:10,color:COLORS.channel,glow:COLORS.channelGlow,jid:ch.jid,
          avatarUrl:ch.iconUrl||null};
        attachAvatar(chNode);
        nodes.push(chNode);nodeMap[chK]=chNode;

        // Link channel to its category
        if(ch.category){
          edges.push({from:"cat:"+ch.category,to:chK,type:"hierarchy"});
        } else if(a.server){
          // No category — link directly to server
          edges.push({from:"s:"+a.server,to:chK,type:"hierarchy"});
        }
      } else {
        nodeMap[chK].r=Math.min(14,nodeMap[chK].r+1);
      }
    });
  });

  // 3) Agent nodes + edges to their channels
  agents.forEach(function(a){
    var ak="a:"+a.id;
    var an={id:ak,type:"agent",label:a.name,sub:a.backend,
      detail:a.runtime+(a.isAdmin?" (admin)":""),fullName:a.name,
      x:0,y:0,vx:0,vy:0,r:22,color:COLORS.agent,glow:COLORS.agentGlow,jid:a.id,
      avatarUrl:a.avatarUrl||null,avatarImg:null};
    attachAvatar(an);
    nodes.push(an);nodeMap[ak]=an;

    a.channels.forEach(function(ch){
      edges.push({from:ak,to:"ch:"+ch.jid,type:"agent"});
    });
  });

  // ---- Initial layout: hierarchical rings ----
  var centerX=W/2,centerY=H/2;
  var serverNodes=nodes.filter(function(n){return n.type==="server";});
  var catNodes=nodes.filter(function(n){return n.type==="category";});
  var chNodes=nodes.filter(function(n){return n.type==="channel";});
  var agentNodes=nodes.filter(function(n){return n.type==="agent";});

  // Servers in tight center ring
  serverNodes.forEach(function(n,i){
    var a=2*Math.PI*i/Math.max(1,serverNodes.length)-Math.PI/2;
    n.x=centerX+Math.cos(a)*60;n.y=centerY+Math.sin(a)*60;
  });
  // Categories in middle ring
  catNodes.forEach(function(n,i){
    var a=2*Math.PI*i/Math.max(1,catNodes.length)-Math.PI/4;
    n.x=centerX+Math.cos(a)*180;n.y=centerY+Math.sin(a)*180;
  });
  // Channels in outer ring
  chNodes.forEach(function(n,i){
    var a=2*Math.PI*i/Math.max(1,chNodes.length);
    n.x=centerX+Math.cos(a)*320;n.y=centerY+Math.sin(a)*320;
  });
  // Agents scattered
  agentNodes.forEach(function(n,i){
    var a=2*Math.PI*i/Math.max(1,agentNodes.length)+Math.PI/6;
    n.x=centerX+Math.cos(a)*140;n.y=centerY+Math.sin(a)*140;
  });

  // ---- Force simulation ----
  var SIM_STEPS=250,step=0;
  var HIER_LEN=70,HIER_K=0.025,AGENT_LEN=130,AGENT_K=0.003;
  var REPULSE=3500,DAMP=0.82,CENTER_PULL=0.002;
  var SAME_TYPE_REPULSE=2000;

  function simulate(){
    nodes.forEach(function(n){n.fx=0;n.fy=0;});

    // Repulsion between all nodes
    for(var i=0;i<nodes.length;i++){
      for(var j=i+1;j<nodes.length;j++){
        var a=nodes[i],b=nodes[j];
        var dx=b.x-a.x,dy=b.y-a.y;
        var d2=dx*dx+dy*dy;if(d2<1)d2=1;
        var rep=REPULSE;
        // Extra repulsion between same-type nodes for spacing
        if(a.type===b.type)rep+=SAME_TYPE_REPULSE;
        var f=rep/d2;
        var dist=Math.sqrt(d2);
        var fx=dx/dist*f,fy=dy/dist*f;
        a.fx-=fx;a.fy-=fy;b.fx+=fx;b.fy+=fy;
      }
    }

    // Spring edges
    edges.forEach(function(e){
      var a=nodeMap[e.from],b=nodeMap[e.to];if(!a||!b)return;
      var dx=b.x-a.x,dy=b.y-a.y;
      var d=Math.sqrt(dx*dx+dy*dy)||1;
      var len=e.type==="hierarchy"?HIER_LEN:AGENT_LEN;
      var k=e.type==="hierarchy"?HIER_K:AGENT_K;
      var f=(d-len)*k;
      var fx=dx/d*f,fy=dy/d*f;
      a.fx+=fx;a.fy+=fy;b.fx-=fx;b.fy-=fy;
    });

    // Gentle center gravity
    nodes.forEach(function(n){
      n.fx+=(centerX-n.x)*CENTER_PULL;
      n.fy+=(centerY-n.y)*CENTER_PULL;
    });

    // Apply forces
    nodes.forEach(function(n){
      if(n===dragNode)return;
      n.vx=(n.vx+n.fx)*DAMP;n.vy=(n.vy+n.fy)*DAMP;
      n.x+=n.vx;n.y+=n.vy;
    });
  }

  // ---- Particles ----
  var particles=[];
  function spawnParticle(){
    if(edges.length===0)return;
    var e=edges[Math.floor(Math.random()*edges.length)];
    if(e.type!=="hierarchy")return; // particles only on hierarchy edges
    var a=nodeMap[e.from],b=nodeMap[e.to];if(!a||!b)return;
    particles.push({from:a,to:b,t:0,speed:0.6+Math.random()*0.4,color:a.color});
  }

  // ---- Interaction state ----
  var hoverNode=null,dragNode=null,dragOff={x:0,y:0};
  var isPanning=false,panStart={x:0,y:0},panStartOff={x:0,y:0};
  var time=0,animFrame=null,hasFitted=false;

  function fitView(){
    if(nodes.length===0)return;
    var minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
    nodes.forEach(function(n){
      minX=Math.min(minX,n.x-n.r-30);maxX=Math.max(maxX,n.x+n.r+30);
      minY=Math.min(minY,n.y-n.r-30);maxY=Math.max(maxY,n.y+n.r+30);
    });
    var graphW=maxX-minX,graphH=maxY-minY;
    if(graphW<1||graphH<1)return;
    zoom=Math.min(W/graphW,H/graphH)*0.85;
    zoom=Math.max(MIN_ZOOM,Math.min(MAX_ZOOM,zoom));
    panX=W/2-((minX+maxX)/2)*zoom;
    panY=H/2-((minY+maxY)/2)*zoom;
  }

  // Track connected nodes for hover highlighting
  function getConnected(node){
    var set={};set[node.id]=true;
    edges.forEach(function(e){
      if(e.from===node.id)set[e.to]=true;
      if(e.to===node.id)set[e.from]=true;
    });
    return set;
  }

  function draw(){
    time+=0.016;
    if(step<SIM_STEPS){simulate();step++;}
    centerX=W/2;centerY=H/2;

    // Auto-fit after simulation settles
    if(step===SIM_STEPS&&!hasFitted){
      hasFitted=true;fitView();
    }

    // Clear with transform
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.clearRect(0,0,W,H);

    // Apply pan+zoom
    ctx.setTransform(zoom*dpr,0,0,zoom*dpr,panX*dpr,panY*dpr);

    var connSet=hoverNode?getConnected(hoverNode):null;

    // Draw edges
    edges.forEach(function(e){
      var a=nodeMap[e.from],b=nodeMap[e.to];if(!a||!b)return;
      var isActive=connSet&&(connSet[a.id]||connSet[b.id])&&(hoverNode===a||hoverNode===b);
      ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);
      if(e.type==="hierarchy"){
        ctx.strokeStyle=isActive?COLORS.edgeHierarchyActive:COLORS.edgeHierarchy;
        ctx.lineWidth=isActive?2:1.2;
        ctx.setLineDash([]);
      } else {
        ctx.strokeStyle=isActive?COLORS.edgeAgentActive:COLORS.edgeAgent;
        ctx.lineWidth=isActive?1.5:0.6;
        ctx.setLineDash([4,4]);
      }
      ctx.stroke();ctx.setLineDash([]);
    });

    // Particles
    if(Math.random()<0.12)spawnParticle();
    for(var pi=particles.length-1;pi>=0;pi--){
      var p=particles[pi];p.t+=p.speed*0.016;
      if(p.t>=1){particles.splice(pi,1);continue;}
      var px=p.from.x+(p.to.x-p.from.x)*p.t;
      var py=p.from.y+(p.to.y-p.from.y)*p.t;
      var alpha=Math.sin(p.t*Math.PI)*0.7;
      ctx.beginPath();ctx.arc(px,py,2/zoom,0,Math.PI*2);
      var c=p.color;
      if(c.charAt(0)==="#"){
        var r2=parseInt(c.slice(1,3),16),g2=parseInt(c.slice(3,5),16),b2=parseInt(c.slice(5,7),16);
        ctx.fillStyle="rgba("+r2+","+g2+","+b2+","+alpha+")";
      } else { ctx.fillStyle=c; }
      ctx.fill();
    }

    // Draw nodes (dimmed if hovering and not connected)
    nodes.forEach(function(n){
      var isHover=hoverNode===n;
      var isConn=connSet?!!connSet[n.id]:true;
      var dimmed=connSet&&!isConn;
      var pulse=isHover?1.15:1+Math.sin(time*1.8+nodes.indexOf(n)*0.5)*0.03;
      var r=n.r*pulse;
      var nodeAlpha=dimmed?0.2:1;

      ctx.globalAlpha=nodeAlpha;

      // Glow
      ctx.beginPath();ctx.arc(n.x,n.y,r+5,0,Math.PI*2);
      ctx.fillStyle=n.glow;ctx.fill();

      // Body gradient
      ctx.beginPath();ctx.arc(n.x,n.y,r,0,Math.PI*2);
      var grad=ctx.createRadialGradient(n.x-r*0.3,n.y-r*0.3,0,n.x,n.y,r);
      grad.addColorStop(0,n.color);
      grad.addColorStop(1,n.color+"99");
      ctx.fillStyle=grad;ctx.fill();

      // Border
      ctx.beginPath();ctx.arc(n.x,n.y,r,0,Math.PI*2);
      ctx.strokeStyle=isHover?"#fff":n.color;
      ctx.lineWidth=(isHover?2.5:1)/zoom;ctx.stroke();

      // Avatar image or icon/letter inside node
      if(n.avatarImg){
        ctx.save();ctx.beginPath();ctx.arc(n.x,n.y,r*0.85,0,Math.PI*2);ctx.clip();
        ctx.drawImage(n.avatarImg,n.x-r*0.85,n.y-r*0.85,r*1.7,r*1.7);
        ctx.restore();
      } else {
        ctx.font="600 "+(r*0.7)+"px 'JetBrains Mono',monospace";
        ctx.textAlign="center";ctx.textBaseline="middle";
        ctx.fillStyle="rgba(0,0,0,.35)";
        var icon=n.type==="server"?"S":n.type==="category"?"C":n.type==="agent"?"A":"#";
        ctx.fillText(icon,n.x,n.y+1);
      }

      // Label below
      var fontSize=n.type==="agent"||n.type==="server"?11:n.type==="category"?10:9;
      ctx.font=(n.type==="agent"||n.type==="server"?"600 ":"500 ")+fontSize+"px 'JetBrains Mono',monospace";
      ctx.textAlign="center";ctx.textBaseline="top";
      ctx.fillStyle=isHover?"#fff":dimmed?COLORS.textDim:COLORS.text;
      ctx.fillText(n.label,n.x,n.y+r+4);

      ctx.globalAlpha=1;
    });

    // Reset transform for UI overlays
    ctx.setTransform(dpr,0,0,dpr,0,0);

    // Zoom indicator
    if(zoom!==1){
      ctx.font="500 10px 'JetBrains Mono',monospace";
      ctx.textAlign="left";ctx.textBaseline="top";
      ctx.fillStyle=COLORS.textDim;
      ctx.fillText(Math.round(zoom*100)+"%",8,8);
    }

    animFrame=requestAnimationFrame(draw);
  }
  draw();

  // ---- Hit testing in world coords ----
  function getNode(sx,sy){
    var w=screenToWorld(sx,sy);
    for(var i=nodes.length-1;i>=0;i--){
      var n=nodes[i];var dx=w.x-n.x,dy=w.y-n.y;
      var hitR=n.r+4;
      if(dx*dx+dy*dy<hitR*hitR)return n;
    }
    return null;
  }
  function mousePos(e){var r=canvas.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top};}

  // ---- Mouse move (hover + drag + pan) ----
  canvas.addEventListener("mousemove",function(e){
    var m=mousePos(e);
    if(isPanning){
      panX=panStartOff.x+(m.x-panStart.x);
      panY=panStartOff.y+(m.y-panStart.y);
      return;
    }
    if(dragNode){
      var w=screenToWorld(m.x,m.y);
      dragNode.x=w.x+dragOff.x;dragNode.y=w.y+dragOff.y;
      dragNode.vx=0;dragNode.vy=0;
      step=Math.max(0,SIM_STEPS-40);
      return;
    }
    var n=getNode(m.x,m.y);
    hoverNode=n;
    if(n){
      canvas.style.cursor="pointer";
      tooltip.className="topo-tooltip visible";
      tooltip.innerHTML='<div><span class="tt-name">'+window.__esc(n.fullName||n.label)+'</span>'+
        '<span class="tt-type '+n.type+'">'+n.type+'</span></div>'+
        '<div class="tt-detail">'+window.__esc(n.detail||n.jid)+'</div>'+
        '<div class="tt-copy">click to copy</div>';
      tooltip.style.left=Math.min(m.x+12,W-200)+"px";
      tooltip.style.top=(m.y-10)+"px";
    }else{
      canvas.style.cursor="grab";
      tooltip.className="topo-tooltip";
    }
  });

  // ---- Mouse down: node drag or canvas pan ----
  canvas.addEventListener("mousedown",function(e){
    var m=mousePos(e);var n=getNode(m.x,m.y);
    if(n){
      var w=screenToWorld(m.x,m.y);
      dragNode=n;dragOff={x:n.x-w.x,y:n.y-w.y};
      canvas.classList.add("dragging");
    }else{
      isPanning=true;panStart={x:m.x,y:m.y};
      panStartOff={x:panX,y:panY};
      canvas.classList.add("dragging");
    }
  });
  document.addEventListener("mouseup",function(){
    if(dragNode){dragNode=null;canvas.classList.remove("dragging");}
    if(isPanning){isPanning=false;canvas.classList.remove("dragging");}
  });

  // ---- Zoom (mouse wheel) ----
  canvas.addEventListener("wheel",function(e){
    e.preventDefault();
    var m=mousePos(e);
    var oldZoom=zoom;
    var delta=e.deltaY>0?0.9:1.1;
    zoom=Math.max(MIN_ZOOM,Math.min(MAX_ZOOM,zoom*delta));
    // Zoom toward mouse position
    panX=m.x-(m.x-panX)*(zoom/oldZoom);
    panY=m.y-(m.y-panY)*(zoom/oldZoom);
  },{passive:false});

  // ---- Click to copy ----
  canvas.addEventListener("click",function(e){
    if(isPanning)return;
    var m=mousePos(e);var n=getNode(m.x,m.y);
    if(n&&n.jid){
      navigator.clipboard.writeText(n.jid).then(function(){
        window.__toast("Copied: "+n.jid);
      });
    }
  });

  // ---- Double-click to fit/reset view ----
  canvas.addEventListener("dblclick",function(e){
    if(getNode(mousePos(e).x,mousePos(e).y))return;
    // Reset to fit all nodes
    if(nodes.length===0)return;
    var minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
    nodes.forEach(function(n){
      minX=Math.min(minX,n.x-n.r-20);maxX=Math.max(maxX,n.x+n.r+20);
      minY=Math.min(minY,n.y-n.r-30);maxY=Math.max(maxY,n.y+n.r+30);
    });
    var graphW=maxX-minX,graphH=maxY-minY;
    if(graphW<1||graphH<1)return;
    zoom=Math.min(W/graphW,H/graphH)*0.9;
    zoom=Math.max(MIN_ZOOM,Math.min(MAX_ZOOM,zoom));
    panX=W/2-((minX+maxX)/2)*zoom;
    panY=H/2-((minY+maxY)/2)*zoom;
  });

  window.__cleanup=function(){ro.disconnect();if(animFrame)cancelAnimationFrame(animFrame);};
})();

// ---- Create task modal (dashboard only) ----
var modal=document.getElementById("create-task-modal");
var form=document.getElementById("create-task-form");
var errorEl=document.getElementById("ct-error");
if(modal&&form){
  modal.addEventListener("click",function(e){if(e.target===modal)modal.classList.remove("open");});
  document.getElementById("ct-cancel").addEventListener("click",function(){modal.classList.remove("open");});
  form.addEventListener("submit",function(e){
    e.preventDefault();errorEl.textContent="";
    var sb=document.getElementById("ct-submit");sb.disabled=true;
    var av=document.getElementById("ct-agent").value;
    if(!av){errorEl.textContent="Select an agent";sb.disabled=false;return;}
    var parts=av.split("|");
    var payload={group_folder:parts[0],chat_jid:parts[1],prompt:document.getElementById("ct-prompt").value,
      schedule_type:document.getElementById("ct-schedule-type").value,
      schedule_value:document.getElementById("ct-schedule-value").value,
      context_mode:document.getElementById("ct-context-mode").value};
    fetch("/api/tasks",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)})
    .then(function(r){if(!r.ok)return r.json().then(function(d){throw new Error(d.error);});return r.json();})
    .then(function(t){window.__toast("Task created: "+t.id.slice(0,12));modal.classList.remove("open");form.reset();})
    .catch(function(err){errorEl.textContent=err.message||"Failed";sb.disabled=false;});
  });
}
`;
}

function conversationsScript(): string {
  return [
    'var chatList=document.getElementById("chat-list");',
    'var convContent=document.getElementById("conv-content");',
    'var searchInput=document.getElementById("chat-search");',
    'var chatCountEl=document.getElementById("chat-count");',
    'if(!chatList)return;',
    'var currentJid=null;var messageCache={};var PAGE_SIZE=100;',
    '',
    'var params=new URLSearchParams(location.search);',
    'var initChat=params.get("chat");',
    'if(initChat){var ii=chatList.querySelector("[data-jid=\\""+CSS.escape(initChat)+"\\"]");',
    '  if(ii)setTimeout(function(){selectChat(initChat);},0);}',
    '',
    'searchInput.addEventListener("input",function(){',
    '  var q=this.value.toLowerCase();var items=chatList.querySelectorAll(".chat-item");var vis=0;',
    '  items.forEach(function(item){',
    '    var name=item.querySelector(".chat-name").textContent.toLowerCase();',
    '    var jid=item.getAttribute("data-jid").toLowerCase();',
    '    var show=name.indexOf(q)!==-1||jid.indexOf(q)!==-1;',
    '    item.style.display=show?"":"none";if(show)vis++;',
    '  });',
    '  chatCountEl.textContent=vis+" chat"+(vis!==1?"s":"");',
    '});',
    '',
    'chatList.addEventListener("click",function(e){',
    '  var item=e.target.closest(".chat-item");if(!item)return;selectChat(item.getAttribute("data-jid"));',
    '});',
    'chatList.addEventListener("keydown",function(e){',
    '  if(e.key==="Enter"){var item=e.target.closest(".chat-item");if(item)selectChat(item.getAttribute("data-jid"));}',
    '});',
    '',
    'function selectChat(jid){',
    '  if(jid===currentJid)return;currentJid=jid;',
    '  history.replaceState(null,"","/conversations?chat="+encodeURIComponent(jid));',
    '  chatList.querySelectorAll(".chat-item").forEach(function(el){',
    '    el.classList.toggle("selected",el.getAttribute("data-jid")===jid);',
    '  });',
    '  convContent.innerHTML=\'<div class="loading">Loading\\u2026</div>\';',
    '  loadMessages(jid);',
    '}',
    '',
    'function loadMessages(jid){',
    '  fetch("/api/messages/"+encodeURIComponent(jid)+"?limit="+PAGE_SIZE)',
    '  .then(function(r){if(!r.ok)throw new Error("Failed");return r.json();})',
    '  .then(function(msgs){',
    '    if(!Array.isArray(msgs))throw new Error("bad");',
    '    if(currentJid!==jid)return;messageCache[jid]=msgs;renderMessages(jid,msgs);',
    '  }).catch(function(){if(currentJid!==jid)return;convContent.innerHTML=\'<div class="loading">Failed to load</div>\';});',
    '}',
    '',
    'function renderMessages(jid,messages){',
    '  var ci=chatList.querySelector("[data-jid=\\""+CSS.escape(jid)+"\\"]");',
    '  var cn=ci?ci.querySelector(".chat-name").textContent:jid;',
    "  var h='<div class=\"message-header\"><h2>'+window.__esc(cn)+'</h2>'",
    "    +'<span class=\"jid-label\">'+window.__esc(jid)+'</span>'",
    '    +\'<span class="msg-count">\'+messages.length+\' msg\'+(messages.length!==1?"s":"")+\'</span></div>\';',
    '  var lm=messages.length>=PAGE_SIZE?\'<div class="load-more-bar"><button class="btn btn-sm" id="btn-load-more">Load older</button></div>\':"";',
    '  var m=\'<div class="messages" id="messages-container">\';',
    '  if(messages.length===0)m+=\'<div class="loading">No messages</div>\';',
    '  else for(var i=0;i<messages.length;i++){',
    '    var msg=messages[i];var isMe=msg.sender==="me"||msg.sender==="bot"||msg.is_from_me;',
    '    var rc="msg-row"+(isMe?" from-me":"");',
    '    var time=new Date(msg.timestamp).toLocaleString();',
    '    var sn=msg.sender_name||msg.sender||"Unknown";',
    '    var text=msg.content||"";var dt=text.length>2000?text.slice(0,2000)+"\\u2026 [truncated]":text;',
    '    m+=\'<div class="\'+rc+\'"><div class="msg-bubble">\'',
    "      +'<div class=\"msg-sender\">'+window.__esc(sn)+'</div>'",
    "      +'<div class=\"msg-text\">'+window.__esc(dt)+'</div>'",
    "      +'<div class=\"msg-time\">'+window.__esc(time)+'</div>'",
    "      +'</div></div>';",
    '  }',
    '  m+="</div>";',
    '  convContent.innerHTML=h+lm+m;',
    '  var container=document.getElementById("messages-container");',
    '  if(container)container.scrollTop=container.scrollHeight;',
    '  var lb=document.getElementById("btn-load-more");',
    '  if(lb)lb.addEventListener("click",function(){',
    '    lb.disabled=true;lb.textContent="Loading\\u2026";',
    '    fetch("/api/messages/"+encodeURIComponent(jid)+"?limit=500")',
    '    .then(function(r){if(!r.ok)throw new Error("fail");return r.json();})',
    '    .then(function(all){if(!Array.isArray(all))throw new Error("bad");if(currentJid!==jid)return;messageCache[jid]=all;renderMessages(jid,all);})',
    '    .catch(function(){lb.disabled=false;lb.textContent="Load older";});',
    '  });',
    '}',
  ].join('\n');
}

function contextScript(): string {
  return [
    'var currentLayer="channel",currentView="split",layerData={},editor=null,originalContent="",dirty=false,monacoReady=false;',
    'var ctxSidebar=document.querySelector(".ctx-sidebar");',
    'if(!ctxSidebar)return;',
    '',
    'function loadScript(src){return new Promise(function(ok,fail){',
    '  if(document.querySelector("script[src=\\""+src+"\\"]"))return ok();',
    '  var s=document.createElement("script");s.src=src;s.onload=ok;s.onerror=fail;document.head.appendChild(s);',
    '});}',
    '',
    'Promise.all([',
    '  loadScript("https://cdn.jsdelivr.net/npm/marked@15.0.7/marked.min.js"),',
    '  loadScript("https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs/loader.min.js")',
    ']).then(function(){',
    '  if(typeof require==="undefined"||!require.config)return;',
    '  require.config({paths:{vs:"https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs"}});',
    '  require(["vs/editor/editor.main"],function(){',
    '    monaco.editor.defineTheme("omniclaw",{base:"vs-dark",inherit:true,rules:[],colors:{',
    '      "editor.background":"#141821","editor.foreground":"#cdd2dc",',
    '      "editorLineNumber.foreground":"#3a3f52","editorLineNumber.activeForeground":"#636a7e",',
    '      "editor.lineHighlightBackground":"#1c2030","editor.selectionBackground":"#2e3450",',
    '      "editorCursor.foreground":"#818cf8"',
    '    }});',
    '    var container=document.getElementById("editor-container");',
    '    if(!container)return;',
    '    editor=monaco.editor.create(container,{',
    '      value:"",language:"markdown",theme:"omniclaw",minimap:{enabled:false},',
    '      fontSize:13,lineHeight:22,wordWrap:"on",scrollBeyondLastLine:false,',
    '      renderWhitespace:"selection",padding:{top:12},automaticLayout:true,tabSize:2',
    '    });',
    '    editor.onDidChangeModelContent(function(){',
    '      if(!monacoReady)return;var val=editor.getValue();dirty=val!==originalContent;',
    '      updateSaveBar();updatePreview(val);',
    '    });',
    '    editor.addCommand(monaco.KeyMod.CtrlCmd|monaco.KeyCode.KeyS,function(){if(dirty)saveChanges();});',
    '    monacoReady=true;',
    '  });',
    '}).catch(function(e){console.error("Failed to load editor:",e);});',
    '',
    'function updateUrl(agent,channel){',
    '  var p=new URLSearchParams(location.search);',
    '  if(agent!==undefined)p.set("agent",agent);',
    '  if(channel!==undefined)p.set("channel",channel);',
    '  if(currentLayer&&currentLayer!=="channel")p.set("layer",currentLayer);else p.delete("layer");',
    '  if(currentView&&currentView!=="split")p.set("view",currentView);else p.delete("view");',
    '  history.replaceState(null,"","/context?"+p.toString());',
    '}',
    '',
    'ctxSidebar.addEventListener("click",function(e){',
    '  var ch=e.target.closest("[data-select-channel]");',
    '  if(ch)selectChannel(ch);',
    '});',
    '',
    'function selectChannel(el){',
    '  document.querySelectorAll(".channel-item").forEach(function(c){c.classList.remove("active");});',
    '  el.classList.add("active");',
    '  var jid=el.getAttribute("data-jid");',
    '  var agentId=el.getAttribute("data-agent-id");',
    '  var chName=el.querySelector(".ch-name");',
    '  document.getElementById("ctx-title").textContent=chName?chName.textContent:agentId;',
    '  document.getElementById("ctx-subtitle").textContent=agentId+" \\u2014 "+jid;',
    '  document.getElementById("ctx-empty").style.display="none";',
    '  document.getElementById("editor-view").style.display="flex";',
    '  updateUrl(agentId,jid);',
    '  var qs="agent_id="+encodeURIComponent(agentId)',
    '    +"&jid="+encodeURIComponent(jid)',
    '    +"&folder="+encodeURIComponent(el.getAttribute("data-folder"))',
    '    +"&server_folder="+encodeURIComponent(el.getAttribute("data-server-folder"))',
    '    +"&agent_context_folder="+encodeURIComponent(el.getAttribute("data-agent-context-folder"))',
    '    +"&channel_folder="+encodeURIComponent(el.getAttribute("data-channel-folder"))',
    '    +"&category_folder="+encodeURIComponent(el.getAttribute("data-category-folder"));',
    '  fetch("/api/context/layers?"+qs).then(function(r){return r.json();}).then(function(data){',
    '    layerData=data;',
    '    ["channel","agent","category","server"].forEach(function(l){',
    '      var dot=document.getElementById("dot-"+l);',
    '      if(dot)dot.className=layerData[l]&&layerData[l].exists?"dot exists":"dot missing";',
    '    });',
    '    document.querySelectorAll(".layer-tab").forEach(function(t){',
    '      t.classList.toggle("active",t.getAttribute("data-layer")===currentLayer);',
    '    });',
    '    loadLayerContent(currentLayer);',
    '    var sb=document.getElementById("save-bar");if(sb)sb.classList.add("visible");',
    '  }).catch(function(err){console.error("Failed to load context:",err);});',
    '}',
    '',
    'var layerTabs=document.getElementById("layer-tabs");',
    'if(layerTabs)layerTabs.addEventListener("click",function(e){',
    '  var tab=e.target.closest("[data-switch-layer]");if(!tab)return;',
    '  var layer=tab.getAttribute("data-layer");',
    '  currentLayer=layer;',
    '  document.querySelectorAll(".layer-tab").forEach(function(t){',
    '    t.classList.toggle("active",t.getAttribute("data-layer")===layer);',
    '  });',
    '  loadLayerContent(layer);updateUrl();',
    '});',
    '',
    'function loadLayerContent(layer){',
    '  var info=layerData[layer];',
    '  if(!info||!info.path){',
    '    var pd=document.getElementById("path-display");if(pd)pd.textContent="No path for this layer";',
    '    if(editor){monacoReady=false;editor.setValue("");monacoReady=true;}',
    '    originalContent="";dirty=false;updateSaveBar();updatePreview("");return;',
    '  }',
    '  var pd2=document.getElementById("path-display");if(pd2)pd2.textContent=info.path+"/CLAUDE.md";',
    '  var content=info.content||"";originalContent=content;',
    '  if(editor){monacoReady=false;editor.setValue(content);monacoReady=true;}',
    '  dirty=false;updateSaveBar();updatePreview(content);',
    '}',
    '',
    'var viewToggle=document.querySelector(".view-toggle");',
    'if(viewToggle)viewToggle.addEventListener("click",function(e){',
    '  var btn=e.target.closest("[data-set-view]");if(!btn)return;',
    '  var view=btn.getAttribute("data-view");currentView=view;',
    '  document.querySelectorAll(".view-toggle button").forEach(function(b){',
    '    b.classList.toggle("active",b.getAttribute("data-view")===view);',
    '  });',
    '  var ep=document.getElementById("editor-pane"),pp=document.getElementById("preview-pane");',
    '  if(ep)ep.classList.toggle("hidden",view==="preview");',
    '  if(pp)pp.classList.toggle("hidden",view==="editor");',
    '  if(editor)editor.layout();updateUrl();',
    '});',
    '',
    'function updatePreview(content){',
    '  var el=document.getElementById("preview-pane");if(!el)return;',
    '  if(!content){el.innerHTML="<p style=\\"color:var(--text-dim)\\">No content.</p>";return;}',
    '  if(typeof marked!=="undefined")el.innerHTML=marked.parse(content);',
    '  else el.textContent=content;',
    '}',
    '',
    'function updateSaveBar(){',
    '  var s=document.getElementById("save-status"),sb=document.getElementById("btn-save"),rb=document.getElementById("btn-revert");',
    '  if(!s)return;',
    '  if(dirty){s.textContent="Unsaved changes";s.className="status unsaved";if(sb)sb.disabled=false;if(rb)rb.disabled=false;}',
    '  else{s.textContent="No changes";s.className="status";if(sb)sb.disabled=true;if(rb)rb.disabled=true;}',
    '}',
    '',
    'function saveChanges(){',
    '  var info=layerData[currentLayer];if(!info||!info.path)return;',
    '  var content=editor?editor.getValue():"";',
    '  var s=document.getElementById("save-status"),sb=document.getElementById("btn-save");',
    '  if(s){s.textContent="Saving...";s.className="status saving";}if(sb)sb.disabled=true;',
    '  fetch("/api/context/file",{method:"PUT",headers:{"Content-Type":"application/json"},',
    '    body:JSON.stringify({path:info.path,content:content})})',
    '  .then(function(r){if(!r.ok)return r.json().then(function(d){throw new Error(d.error);});return r.json();})',
    '  .then(function(){',
    '    originalContent=content;dirty=false;info.content=content;info.exists=true;',
    '    var dot=document.getElementById("dot-"+currentLayer);if(dot)dot.className="dot exists";',
    '    if(s){s.textContent="Saved";s.className="status saved";}if(sb)sb.disabled=true;',
    '    var rb=document.getElementById("btn-revert");if(rb)rb.disabled=true;',
    '    setTimeout(function(){if(!dirty&&s){s.textContent="No changes";s.className="status";}},2000);',
    '  }).catch(function(err){',
    '    if(s){s.textContent="Error: "+(err.message||"Save failed");s.className="status error";}if(sb)sb.disabled=false;',
    '  });',
    '}',
    '',
    'var btnSave=document.getElementById("btn-save");if(btnSave)btnSave.addEventListener("click",saveChanges);',
    'var btnRevert=document.getElementById("btn-revert");',
    'if(btnRevert)btnRevert.addEventListener("click",function(){',
    '  if(editor){monacoReady=false;editor.setValue(originalContent);monacoReady=true;}',
    '  dirty=false;updateSaveBar();updatePreview(originalContent);',
    '});',
    '',
    'var params=new URLSearchParams(location.search);',
    'var initAgent=params.get("agent"),initChannel=params.get("channel");',
    'var initLayer=params.get("layer"),initView=params.get("view");',
    'if(initLayer&&["channel","category","server","agent"].indexOf(initLayer)!==-1)currentLayer=initLayer;',
    'if(initView&&["split","editor","preview"].indexOf(initView)!==-1){currentView=initView;',
    '  var vtBtns=document.querySelectorAll(".view-toggle button");',
    '  vtBtns.forEach(function(b){b.classList.toggle("active",b.getAttribute("data-view")===initView);});',
    '  var ep=document.getElementById("editor-pane"),pp=document.getElementById("preview-pane");',
    '  if(ep)ep.classList.toggle("hidden",initView==="preview");',
    '  if(pp)pp.classList.toggle("hidden",initView==="editor");',
    '}',
    'if(initAgent&&initChannel){',
    '  var ag=document.querySelector(".agent-group[data-agent-id=\\""+CSS.escape(initAgent)+"\\"]");',
    '  if(ag){',
    '    ag.querySelector(".chevron").classList.add("open");',
    '    ag.querySelector(".channel-list").classList.add("open");',
    '    var ci=ag.querySelector(".channel-item[data-jid=\\""+CSS.escape(initChannel)+"\\"]");',
    '    if(ci)setTimeout(function(){selectChannel(ci);},0);',
    '  }',
    '}',
    '',
    'window.__cleanup=function(){',
    '  if(editor){editor.dispose();editor=null;monacoReady=false;}',
    '};',
  ].join('\n');
}

function ipcScript(): string {
  return [
    'var queueBody=document.getElementById("queue-body");',
    'if(!queueBody&&!document.getElementById("stat-processing"))return;',
    '',
    'var pollTimer=setInterval(function(){',
    '  fetch("/api/ipc/queue").then(function(r){return r.json();}).then(function(details){',
    '    var tb=document.getElementById("queue-body");if(!tb)return;',
    '    var sg=document.getElementById("stat-groups");if(sg)sg.textContent=String(details.length);',
    '    if(details.length===0){tb.innerHTML="";return;}',
    '    tb.innerHTML=details.map(function(g){',
    '      var ms=g.messageLane.idle?"idle":g.messageLane.active?"active":"off";',
    '      var ts=g.taskLane.active?"active":"off";',
    '      var ti=g.taskLane.activeTask?window.__esc(g.taskLane.activeTask.taskId)+" ("+fmtMs(g.taskLane.activeTask.runningMs)+")":"\\u2014";',
    '      return "<tr><td class=\\"folder-key\\">"+window.__esc(g.folderKey)+"</td>"',
    '        +"<td><span class=\\"lane-badge lane-"+ms+"\\">"+ms+"</span></td>"',
    '        +"<td>"+g.messageLane.pendingCount+"</td>"',
    '        +"<td><span class=\\"lane-badge lane-"+ts+"\\">"+ts+"</span></td>"',
    '        +"<td>"+g.taskLane.pendingCount+"</td>"',
    '        +"<td class=\\"task-info\\">"+ti+"</td>"',
    '        +"<td>"+(g.retryCount>0?"<span class=\\"retry-count\\">"+g.retryCount+"</span>":"\\u2014")+"</td></tr>";',
    '    }).join("");',
    '  }).catch(function(){});',
    '},5000);',
    '',
    'var eventPollTimer=setInterval(function(){',
    '  fetch("/api/ipc/events?count=50").then(function(r){return r.json();}).then(function(events){',
    '    var tb=document.getElementById("events-body");if(!tb)return;',
    '    var se=document.getElementById("stat-events");if(se)se.textContent=String(events.length);',
    '    tb.innerHTML=events.map(function(e){',
    '      var kc=(e.kind||"").indexOf("error")!==-1||(e.kind||"").indexOf("blocked")!==-1?"event-error"',
    '        :(e.kind||"").indexOf("suppressed")!==-1?"event-warn":"event-ok";',
    '      var t=new Date(e.timestamp).toLocaleTimeString("en-US",{hour12:false,hour:"2-digit",minute:"2-digit",second:"2-digit"});',
    '      return "<tr class=\\""+kc+"\\"><td class=\\"event-time\\">"+window.__esc(t)+"</td>"',
    '        +"<td><span class=\\"event-kind-badge\\">"+window.__esc(e.kind||"")+"</span></td>"',
    '        +"<td class=\\"event-source\\">"+window.__esc(e.sourceGroup||"")+"</td>"',
    '        +"<td class=\\"event-summary\\">"+window.__esc(e.summary||"")+"</td></tr>";',
    '    }).join("");',
    '  }).catch(function(){});',
    '},5000);',
    '',
    'function fmtMs(ms){if(ms<1000)return ms+"ms";if(ms<60000)return(ms/1000).toFixed(1)+"s";return(ms/60000).toFixed(1)+"m";}',
    '',
    'window.__cleanup=function(){clearInterval(pollTimer);clearInterval(eventPollTimer);};',
  ].join('\n');
}

function networkScript(): string {
  return `
var pollTimer=null;
var syncPeerId=null;
var networkClicksBound=false;

function networkAction(action,id){
  if(action==="request"){
    fetch("/api/discovery/peers/"+encodeURIComponent(id)+"/request-access",{method:"POST"})
      .then(function(r){return r.json();})
      .then(function(d){
        if(d.status==="trusted")window.__toast("Already trusted!");
        else if(d.status==="pending")window.__toast("Access requested - awaiting approval");
        else if(d.error)window.__toast("Error: "+d.error);
        refreshPeers();
      }).catch(function(e){window.__toast("Failed: "+e.message);});
    return;
  }
  if(action==="approve"){
    fetch("/api/discovery/requests/"+encodeURIComponent(id)+"/approve",{method:"POST"})
      .then(function(r){return r.json();})
      .then(function(d){
        if(d.approved)window.__toast("Peer approved!");
        else if(d.error)window.__toast("Error: "+d.error);
        refreshPeers();refreshRequests();
      }).catch(function(e){window.__toast("Failed: "+e.message);});
    return;
  }
  if(action==="reject"){
    fetch("/api/discovery/requests/"+encodeURIComponent(id)+"/reject",{method:"POST"})
      .then(function(r){return r.json();})
      .then(function(){window.__toast("Request rejected");refreshRequests();})
      .catch(function(e){window.__toast("Failed: "+e.message);});
    return;
  }
  if(action==="revoke"){
    if(!confirm("Revoke trust for this peer?"))return;
    fetch("/api/discovery/peers/"+encodeURIComponent(id),{method:"DELETE"})
      .then(function(r){return r.json();})
      .then(function(){window.__toast("Trust revoked");refreshPeers();})
      .catch(function(e){window.__toast("Failed: "+e.message);});
    return;
  }
  if(action==="browse"){browseRemoteAgents(id);return;}
  if(action==="sync"){openSyncPanel(id);return;}
  if(action==="close-sync"){closeSyncPanel();return;}
  if(action==="push"){syncFile("push",id);return;}
  if(action==="pull"){syncFile("pull",id);return;}
  if(action==="bulk-push"){bulkSync("push",id);return;}
  if(action==="bulk-pull"){bulkSync("pull",id);return;}
}
window.networkAction=networkAction;

function bindNetworkClicks(){
  if(networkClicksBound)return;
  document.addEventListener("click",function(event){
    var target=event.target instanceof Element?event.target.closest("[data-network-action]"):null;
    if(!target)return;
    event.preventDefault();
    networkAction(target.getAttribute("data-network-action"),target.getAttribute("data-network-id")||"");
  });
  networkClicksBound=true;
}

function renderPeerStatus(status){
  if(status==="discovered")return '<span class="badge">discovered</span>';
  if(status==="trusted")return '<span class="badge badge-admin">trusted</span>';
  if(status==="pending")return '<span class="badge" style="background:var(--warning);color:#000">pending</span>';
  if(status==="revoked")return '<span class="badge" style="background:var(--red);color:#fff">revoked</span>';
  return '<span class="badge">unknown</span>';
}

function renderPeerActions(peer){
  var id=window.__esc(peer.instanceId||"");
  if(peer.status==="trusted"){
    return '<button class="btn btn-sm" data-network-action="browse" data-network-id="'+id+'">Browse</button> '
      +'<button class="btn btn-sm btn-primary" data-network-action="sync" data-network-id="'+id+'">Sync</button> '
      +'<button class="btn btn-sm btn-danger" data-network-action="revoke" data-network-id="'+id+'">Revoke</button>';
  }
  if(peer.status==="pending")return '<span style="color:var(--text-muted);font-size:0.8rem">awaiting approval...</span>';
  if(peer.online)return '<button class="btn btn-sm btn-primary" data-network-action="request" data-network-id="'+id+'">Request Access</button>';
  return '<span style="color:var(--text-muted);font-size:0.8rem">offline</span>';
}

function renderPeerRows(peers){
  if(!Array.isArray(peers))return "";
  return peers.map(function(peer){
    return '<tr data-instance-id="'+window.__esc(peer.instanceId||"")+'">'
      +'<td><strong>'+window.__esc(peer.name||"")+'</strong></td>'
      +'<td><code>'+window.__esc(peer.host||"")+':'+window.__esc(String(peer.port||0))+'</code></td>'
      +'<td>'+renderPeerStatus(peer.status)+'</td>'
      +'<td>'+(peer.online?'<span style="color:var(--green)">●</span>':'<span style="color:var(--text-muted)">○</span>')+'</td>'
      +'<td>'+renderPeerActions(peer)+'</td></tr>';
  }).join("");
}

function renderPendingRequests(reqs){
  if(!Array.isArray(reqs)||reqs.length===0){
    return '<div style="padding:1.5rem;text-align:center;color:var(--text-muted);font-size:0.85rem">No pending requests</div>';
  }
  return reqs.map(function(r){
    var id=window.__esc(r.id||"");
    return '<div class="task-card" style="margin-bottom:0.75rem">'
      +'<div style="margin-bottom:0.5rem"><strong>'+window.__esc(r.fromName||"")+'</strong></div>'
      +'<div style="font-size:0.8rem;color:var(--text-muted);margin-bottom:0.5rem"><code>'+window.__esc(r.fromHost||"")+':'+window.__esc(String(r.fromPort||0))+'</code></div>'
      +'<div style="display:flex;gap:0.5rem">'
      +'<button class="btn btn-sm btn-primary" data-network-action="approve" data-network-id="'+id+'">Approve</button>'
      +'<button class="btn btn-sm btn-danger" data-network-action="reject" data-network-id="'+id+'">Reject</button>'
      +'</div></div>';
  }).join("");
}

function refreshPeers(){
  fetch("/api/discovery/peers").then(function(r){return r.json();})
    .then(function(peers){
      var online=peers.filter(function(p){return p.online;}).length;
      var trusted=peers.filter(function(p){return p.status==="trusted";}).length;
      var oe=document.getElementById("stat-peers-online");if(oe)oe.textContent=String(online);
      var te=document.getElementById("stat-peers-trusted");if(te)te.textContent=String(trusted);
      var body=document.getElementById("peers-tbody");if(body)body.innerHTML=renderPeerRows(peers);
    }).catch(function(){});
}

function refreshRequests(){
  fetch("/api/discovery/requests").then(function(r){return r.json();})
    .then(function(reqs){
      var ce=document.getElementById("pending-count");if(ce)ce.textContent=String(reqs.length);
      var el=document.getElementById("pending-requests");if(el)el.innerHTML=renderPendingRequests(reqs);
    }).catch(function(){});
}

function browseRemoteAgents(instanceId){
  var container=document.getElementById("remote-agents");if(!container)return;
  container.innerHTML='<div class="card"><div class="section-header"><h2>loading remote agents...</h2></div></div>';
  fetch("/api/discovery/peers/"+encodeURIComponent(instanceId)+"/agents")
    .then(function(r){if(!r.ok)throw new Error("Failed to fetch");return r.json();})
    .then(function(agents){
      if(!Array.isArray(agents)||agents.length===0){
        container.innerHTML='<div class="card"><div style="padding:2rem;text-align:center;color:var(--text-muted)">No agents found on remote instance</div></div>';
        return;
      }
      var rows=agents.map(function(a){
        return '<tr><td>'+window.__esc(a.id||"")+'</td>'
          +'<td>'+window.__esc(a.name||"")+'</td>'
          +'<td><span class="badge">'+window.__esc(a.backend||"")+'</span></td>'
          +'<td>'+window.__esc(a.agentRuntime||"")+'</td>'
          +'<td>'+(a.channels?a.channels.map(function(c){return window.__esc(c);}).join('<br>'):'-')+'</td></tr>';
      }).join("");
      container.innerHTML='<div class="card"><div class="section-header"><h2>remote agents ('+agents.length+')</h2></div>'
        +'<table class="data-table"><thead><tr><th>id</th><th>name</th><th>backend</th><th>runtime</th><th>channels</th></tr></thead>'
        +'<tbody>'+rows+'</tbody></table></div>';
    }).catch(function(e){
      container.innerHTML='<div class="card"><div style="padding:2rem;text-align:center;color:var(--red)">Error: '+window.__esc(e.message)+'</div></div>';
    });
}

function openSyncPanel(instanceId){
  syncPeerId=instanceId;
  var panel=document.getElementById("sync-panel");if(!panel)return;
  panel.innerHTML='<div class="card"><div class="section-header"><h2>comparing context files...</h2></div>'
    +'<div style="padding:2rem;text-align:center;color:var(--text-muted)">Scanning local and remote files...</div></div>';
  fetch("/api/discovery/peers/"+encodeURIComponent(instanceId)+"/context/compare")
    .then(function(r){if(!r.ok)throw new Error("Failed to compare");return r.json();})
    .then(function(cmp){renderSyncPanel(instanceId,cmp);})
    .catch(function(e){
      panel.innerHTML='<div class="card"><div style="padding:2rem;text-align:center;color:var(--red)">Error: '+window.__esc(e.message)+'</div></div>';
    });
}

function renderSyncPanel(instanceId,cmp){
  var panel=document.getElementById("sync-panel");if(!panel)return;
  var total=cmp.same.length+cmp.differs.length+cmp.localOnly.length+cmp.remoteOnly.length;
  var escapedInstanceId=window.__esc(instanceId||"");
  var h='<div class="card"><div class="section-header" style="display:flex;align-items:center;justify-content:space-between">'
    +'<h2>context sync ('+total+' files)</h2>'
    +'<div style="display:flex;gap:0.5rem">'
    +'<button class="btn btn-sm" data-network-action="close-sync" data-network-id="">Close</button>'
    +'<button class="btn btn-sm" data-network-action="sync" data-network-id="'+escapedInstanceId+'">Refresh</button>'
    +'</div></div>';
  h+='<div style="display:flex;gap:1rem;padding:0.75rem 1rem;background:var(--surface);border-radius:6px;margin-bottom:1rem;font-size:0.8rem">';
  h+='<span style="color:var(--green)">✓ '+cmp.same.length+' identical</span>';
  h+='<span style="color:var(--warning)">≠ '+cmp.differs.length+' differ</span>';
  h+='<span style="color:var(--blue)">← '+cmp.localOnly.length+' local only</span>';
  h+='<span style="color:var(--purple,#a78bfa)">→ '+cmp.remoteOnly.length+' remote only</span>';
  h+='</div>';
  if(total===0){
    h+='<div style="padding:2rem;text-align:center;color:var(--text-muted)">No context files found</div>';
  } else {
    h+='<table class="data-table"><thead><tr><th>path</th><th>status</th><th>local size</th><th>remote size</th><th>actions</th></tr></thead><tbody>';
    cmp.same.forEach(function(f){
      h+='<tr><td><code>'+window.__esc(f.path||"(root)")+'/CLAUDE.md</code></td>'
        +'<td><span style="color:var(--green)">identical</span></td>'
        +'<td>'+fmtBytes(f.size)+'</td><td>'+fmtBytes(f.size)+'</td>'
        +'<td><span style="color:var(--text-muted);font-size:0.8rem">in sync</span></td></tr>';
    });
    cmp.differs.forEach(function(d){
      var pathValue=window.__esc(d.local.path||"");
      var combined=escapedInstanceId+'|'+pathValue;
      h+='<tr style="background:rgba(251,191,36,0.05)"><td><code>'+window.__esc(d.local.path||"(root)")+'/CLAUDE.md</code></td>'
        +'<td><span style="color:var(--warning)">differs</span></td>'
        +'<td>'+fmtBytes(d.local.size)+'</td><td>'+fmtBytes(d.remote.size)+'</td>'
        +'<td><button class="btn btn-sm" data-network-action="push" data-network-id="'+combined+'">Push →</button> '
        +'<button class="btn btn-sm" data-network-action="pull" data-network-id="'+combined+'">← Pull</button></td></tr>';
    });
    cmp.localOnly.forEach(function(f){
      var pathValue=window.__esc(f.path||"");
      h+='<tr style="background:rgba(96,165,250,0.05)"><td><code>'+window.__esc(f.path||"(root)")+'/CLAUDE.md</code></td>'
        +'<td><span style="color:var(--blue)">local only</span></td>'
        +'<td>'+fmtBytes(f.size)+'</td><td>-</td>'
        +'<td><button class="btn btn-sm" data-network-action="push" data-network-id="'+escapedInstanceId+'|'+pathValue+'">Push →</button></td></tr>';
    });
    cmp.remoteOnly.forEach(function(f){
      var pathValue=window.__esc(f.path||"");
      h+='<tr style="background:rgba(167,139,250,0.05)"><td><code>'+window.__esc(f.path||"(root)")+'/CLAUDE.md</code></td>'
        +'<td><span style="color:var(--purple,#a78bfa)">remote only</span></td>'
        +'<td>-</td><td>'+fmtBytes(f.size)+'</td>'
        +'<td><button class="btn btn-sm" data-network-action="pull" data-network-id="'+escapedInstanceId+'|'+pathValue+'">← Pull</button></td></tr>';
    });
    h+='</tbody></table>';
    var pushable=cmp.differs.length+cmp.localOnly.length;
    var pullable=cmp.differs.length+cmp.remoteOnly.length;
    if(pushable>0||pullable>0){
      h+='<div style="display:flex;gap:0.75rem;margin-top:1rem;padding-top:1rem;border-top:1px solid var(--border)">';
      if(pushable>0)h+='<button class="btn btn-sm btn-primary" data-network-action="bulk-push" data-network-id="'+escapedInstanceId+'">Push All ('+pushable+') →</button>';
      if(pullable>0)h+='<button class="btn btn-sm" data-network-action="bulk-pull" data-network-id="'+escapedInstanceId+'">← Pull All ('+pullable+')</button>';
      h+='</div>';
    }
  }
  h+='</div>';
  panel.innerHTML=h;
}

function closeSyncPanel(){
  var panel=document.getElementById("sync-panel");if(panel)panel.innerHTML="";
  syncPeerId=null;
}

function syncFile(direction,idAndPath){
  var parts=idAndPath.split("|");
  var instanceId=parts[0],filePath=parts.slice(1).join("|");
  fetch("/api/discovery/peers/"+encodeURIComponent(instanceId)+"/context/"+direction,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({path:filePath})
  }).then(function(r){return r.json();}).then(function(d){
    if(d.ok)window.__toast((direction==="push"?"Pushed":"Pulled")+" "+filePath);
    else window.__toast("Error: "+(d.error||"unknown"));
    if(syncPeerId)openSyncPanel(syncPeerId);
  }).catch(function(e){window.__toast("Failed: "+e.message);});
}

function bulkSync(direction,instanceId){
  fetch("/api/discovery/peers/"+encodeURIComponent(instanceId)+"/context/compare")
    .then(function(r){return r.json();})
    .then(function(cmp){
      var paths=[];
      if(direction==="push"){
        cmp.differs.forEach(function(d){paths.push(d.local.path);});
        cmp.localOnly.forEach(function(f){paths.push(f.path);});
      } else {
        cmp.differs.forEach(function(d){paths.push(d.remote.path);});
        cmp.remoteOnly.forEach(function(f){paths.push(f.path);});
      }
      if(paths.length===0){window.__toast("Nothing to "+direction);return;}
      if(!confirm(direction==="push"?"Push "+paths.length+" file(s) to remote?":"Pull "+paths.length+" file(s) from remote?"))return;
      var done=0,errs=0;
      var chain=Promise.resolve();
      paths.forEach(function(p){
        chain=chain.then(function(){
          return fetch("/api/discovery/peers/"+encodeURIComponent(instanceId)+"/context/"+direction,{
            method:"POST",
            headers:{"Content-Type":"application/json"},
            body:JSON.stringify({path:p})
          }).then(function(r){return r.json();}).then(function(d){if(d.ok)done++;else errs++;}).catch(function(){errs++;});
        });
      });
      chain.then(function(){
        window.__toast(done+" file(s) synced"+(errs>0?", "+errs+" error(s)":""));
        if(syncPeerId)openSyncPanel(syncPeerId);
      });
    }).catch(function(e){window.__toast("Failed: "+e.message);});
}

function fmtBytes(b){if(b<1024)return b+" B";if(b<1048576)return(b/1024).toFixed(1)+" KB";return(b/1048576).toFixed(1)+" MB";}

bindNetworkClicks();
refreshPeers();
refreshRequests();
pollTimer=setInterval(function(){refreshPeers();refreshRequests();},${DISCOVERY_POLL_INTERVAL});
window.__cleanup=function(){if(pollTimer)clearInterval(pollTimer);};
`;
}

function systemScript(): string {
  return [
    '(function(){',
    'function fmtUptime(s){',
    '  var d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60),sec=s%60;',
    '  var parts=[];if(d>0)parts.push(d+"d");if(h>0)parts.push(h+"h");if(m>0)parts.push(m+"m");parts.push(sec+"s");',
    '  return parts.join(" ");',
    '}',
    '',
    'var pollTimer=setInterval(function(){',
    '  fetch("/api/health").then(function(r){return r.json();}).then(function(h){',
    '    var el;',
    '    el=document.getElementById("sys-uptime");if(el)el.textContent=fmtUptime(h.uptime_seconds);',
    '    el=document.getElementById("sys-rss");if(el)el.textContent=h.memory.rss_mb+" MB";',
    '    el=document.getElementById("sys-heap-used");if(el)el.textContent=h.memory.heap_used_mb+" MB";',
    '    el=document.getElementById("sys-heap-total");if(el)el.textContent=h.memory.heap_total_mb+" MB";',
    '    el=document.getElementById("sys-sse");if(el)el.textContent=String(h.sse_clients);',
    '    el=document.getElementById("sys-agents-total");if(el)el.textContent=String(h.agents.total);',
    '    el=document.getElementById("sys-containers-active");if(el)el.textContent=h.containers.active+"/"+h.containers.max_active;',
    '    el=document.getElementById("sys-containers-idle");if(el)el.textContent=h.containers.idle+"/"+h.containers.max_idle;',
    '    el=document.getElementById("sys-tasks-active");if(el)el.textContent=String(h.tasks.active);',
    '    el=document.getElementById("sys-tasks-paused");if(el)el.textContent=String(h.tasks.paused);',
    '    el=document.getElementById("sys-tasks-completed");if(el)el.textContent=String(h.tasks.completed);',
    '    el=document.getElementById("sys-tasks-total");if(el)el.textContent=String(h.tasks.total);',
    '    el=document.getElementById("health-status");if(el)el.textContent=h.status;',
    '  }).catch(function(){});',
    '},5000);',
    '',
    'window.__cleanup=function(){clearInterval(pollTimer);};',
    '})();',
  ].join('\n');
}
