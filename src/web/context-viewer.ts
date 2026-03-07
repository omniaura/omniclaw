import type { WebStateProvider } from './types.js';
import { BASE_CSS, renderNav } from './shared.js';

/**
 * Render the 4-layer context viewer page.
 * Shows agent->channel hierarchy with editable CLAUDE.md files per context layer.
 * Uses Monaco editor (CDN) for editing with live markdown preview via marked.js.
 * Sidebar shows human-readable channel names derived from chat names or folder paths.
 * Selected agent/channel is persisted in the URL (?agent=<id>&channel=<jid>).
 */
export function renderContextViewer(state: WebStateProvider): string {
  const agents = Object.values(state.getAgents());
  const subs = state.getChannelSubscriptions();
  const chats = state.getChats();

  // Build JID -> human-readable name map from chat data
  const chatNameMap: Record<string, string> = {};
  for (const c of chats) {
    if (c.name) chatNameMap[c.jid] = c.name;
  }

  // Derive a display name for a channel JID
  function channelDisplayName(jid: string, channelFolder?: string): string {
    // Prefer chat name from message history
    if (chatNameMap[jid]) return chatNameMap[jid];
    // Fall back to last segment of channelFolder (e.g. "servers/omni-aura/ditto/spec" -> "#spec")
    if (channelFolder) {
      const lastSeg = channelFolder.split('/').pop();
      if (lastSeg) return '#' + lastSeg;
    }
    // Fall back to JID itself
    return jid;
  }

  // Build agent->channels map for the sidebar
  const agentData = agents.map((a) => {
    const channels: Array<{
      jid: string;
      displayName: string;
      channelFolder?: string;
      categoryFolder?: string;
    }> = [];
    for (const [jid, subList] of Object.entries(subs)) {
      const sub = subList.find((s) => s.agentId === a.id);
      if (sub) {
        channels.push({
          jid,
          displayName: channelDisplayName(jid, sub.channelFolder),
          channelFolder: sub.channelFolder,
          categoryFolder: sub.categoryFolder,
        });
      }
    }
    return {
      id: a.id,
      name: a.name,
      folder: a.folder,
      serverFolder: a.serverFolder,
      agentContextFolder: a.agentContextFolder,
      channels,
    };
  });

  // Build sidebar HTML
  const sidebarHtml = agentData
    .map(
      (a) =>
        '<div class="agent-group" data-agent-id="' +
        esc(a.id) +
        '">' +
        '<div class="agent-header" onclick="toggleAgent(this)">' +
        '<span class="chevron">&#9654;</span>' +
        '<span class="agent-name">' +
        esc(a.name) +
        '</span>' +
        '<span class="channel-count">' +
        a.channels.length +
        '</span>' +
        '</div>' +
        '<div class="channel-list">' +
        a.channels
          .map(
            (ch) =>
              '<div class="channel-item"' +
              ' data-agent-id="' +
              esc(a.id) +
              '"' +
              ' data-jid="' +
              esc(ch.jid) +
              '"' +
              ' data-folder="' +
              esc(a.folder) +
              '"' +
              ' data-server-folder="' +
              esc(a.serverFolder || '') +
              '"' +
              ' data-agent-context-folder="' +
              esc(a.agentContextFolder || '') +
              '"' +
              ' data-channel-folder="' +
              esc(ch.channelFolder || '') +
              '"' +
              ' data-category-folder="' +
              esc(ch.categoryFolder || '') +
              '"' +
              ' onclick="selectChannel(this)">' +
              '<span class="ch-name">' +
              esc(ch.displayName) +
              '</span>' +
              '<span class="ch-jid">' +
              esc(ch.jid) +
              '</span>' +
              '</div>',
          )
          .join('') +
        '</div></div>',
    )
    .join('');

  // Build the page as concatenated strings to avoid template literal escaping issues
  // with backticks in the JavaScript code (Monaco, marked.js regex, etc.)
  return buildPage(sidebarHtml);
}

function buildPage(sidebarHtml: string): string {
  const css = [
    BASE_CSS,
    'body{height:100vh;overflow:hidden;display:flex;flex-direction:column}',
    '.layout{display:flex;height:calc(100vh - 49px);overflow:hidden}',
    '.sidebar{width:280px;min-width:280px;border-right:1px solid var(--border);display:flex;flex-direction:column;overflow-y:auto}',
    '.sidebar-title{font-size:.7rem;text-transform:uppercase;letter-spacing:.05em;color:var(--text-dim);padding:.75rem 1rem .25rem;font-weight:600}',
    '.agent-group{border-bottom:1px solid var(--border)}',
    '.agent-header{display:flex;align-items:center;gap:.5rem;padding:.5rem 1rem;cursor:pointer;transition:background .15s;user-select:none}',
    '.agent-header:hover{background:var(--surface)}',
    '.agent-header .chevron{font-size:.6rem;transition:transform .2s;color:var(--text-dim)}',
    '.agent-header .chevron.open{transform:rotate(90deg)}',
    '.agent-header .agent-name{font-size:.85rem;font-weight:500}',
    '.agent-header .channel-count{margin-left:auto;font-size:.65rem;color:var(--text-dim);background:var(--border);padding:0 .35rem;border-radius:8px}',
    '.channel-list{display:none}.channel-list.open{display:block}',
    '.channel-item{padding:.35rem 1rem .35rem 2rem;font-size:.75rem;color:var(--text-dim);cursor:pointer;transition:all .15s;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;flex-direction:column;gap:0}',
    '.ch-name{font-weight:500;color:var(--text)}',
    '.ch-jid{font-size:.6rem;color:var(--text-dim);opacity:.7}',
    '.channel-item:hover{color:var(--text);background:rgba(99,102,241,.08)}',
    '.channel-item.active{color:var(--accent);background:rgba(99,102,241,.12)}',
    '.content{flex:1;display:flex;flex-direction:column;overflow:hidden}',
    '.content-header{padding:.75rem 1.5rem;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:1rem;flex-shrink:0}',
    '.content-header .title{font-size:.9rem;font-weight:600}',
    '.content-header .subtitle{font-size:.75rem;color:var(--text-dim)}',
    '.empty-state{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--text-dim)}',
    '.empty-state .icon{font-size:2rem;margin-bottom:.75rem;opacity:.5}',
    '.empty-state .label{font-size:.85rem}',
    '.empty-state .hint{font-size:.7rem;margin-top:.25rem}',
    '.layer-tabs{display:flex;gap:0;border-bottom:1px solid var(--border);flex-shrink:0;background:var(--surface)}',
    '.layer-tab{padding:.5rem 1rem;font-size:.75rem;font-weight:500;color:var(--text-dim);cursor:pointer;border-bottom:2px solid transparent;transition:all .15s;display:flex;align-items:center;gap:.35rem}',
    '.layer-tab:hover{color:var(--text)}',
    '.layer-tab.active{color:var(--accent);border-bottom-color:var(--accent)}',
    '.layer-tab .dot{width:6px;height:6px;border-radius:50%}',
    '.layer-tab .dot.exists{background:var(--green)}',
    '.layer-tab .dot.missing{background:var(--text-dim);opacity:.4}',
    '.editor-area{flex:1;display:flex;overflow:hidden;position:relative}',
    '.view-toggle{position:absolute;top:.5rem;right:.5rem;z-index:10;display:flex;gap:0;border:1px solid var(--border);border-radius:4px;overflow:hidden}',
    '.view-toggle button{padding:.25rem .5rem;font-size:.65rem;border:none;background:var(--surface);color:var(--text-dim);cursor:pointer;transition:all .15s}',
    '.view-toggle button:not(:last-child){border-right:1px solid var(--border)}',
    '.view-toggle button.active{background:var(--accent);color:#fff}',
    '.view-toggle button:hover:not(.active){color:var(--text)}',
    '.editor-pane{flex:1;display:flex;flex-direction:column;overflow:hidden}',
    '.editor-pane.hidden{display:none}',
    '#editor-container{flex:1;overflow:hidden}',
    '.preview-pane{flex:1;overflow-y:auto;padding:1.5rem;border-left:1px solid var(--border);font-size:.85rem;line-height:1.7}',
    '.preview-pane.hidden{display:none}',
    '.preview-pane h1{font-size:1.4rem;font-weight:700;margin:1rem 0 .5rem}',
    '.preview-pane h2{font-size:1.15rem;font-weight:600;margin:1rem 0 .5rem;color:var(--accent)}',
    '.preview-pane h3{font-size:1rem;font-weight:600;margin:.75rem 0 .5rem}',
    '.preview-pane p{margin-bottom:.75rem}',
    '.preview-pane ul,.preview-pane ol{margin-left:1.5rem;margin-bottom:.75rem}',
    '.preview-pane li{margin-bottom:.25rem}',
    '.preview-pane code{background:var(--border);padding:.15rem .35rem;border-radius:3px;font-family:"SF Mono","Cascadia Code",monospace;font-size:.8rem}',
    '.preview-pane pre{background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:.75rem 1rem;margin-bottom:.75rem;overflow-x:auto}',
    '.preview-pane pre code{background:none;padding:0}',
    '.preview-pane strong{font-weight:600}',
    '.preview-pane em{font-style:italic}',
    '.preview-pane a{color:var(--accent);text-decoration:none}',
    '.preview-pane a:hover{text-decoration:underline}',
    '.preview-pane hr{border:none;border-top:1px solid var(--border);margin:1rem 0}',
    '.preview-pane blockquote{border-left:3px solid var(--accent);padding-left:1rem;color:var(--text-dim);margin-bottom:.75rem}',
    '.save-bar{display:none;padding:.5rem 1rem;border-top:1px solid var(--border);background:var(--surface);flex-shrink:0;align-items:center;gap:.75rem}',
    '.save-bar.visible{display:flex}',
    '.save-bar .status{font-size:.75rem;color:var(--text-dim);flex:1}',
    '.save-bar .status.unsaved{color:var(--yellow)}',
    '.save-bar .status.saving{color:var(--accent)}',
    '.save-bar .status.saved{color:var(--green)}',
    '.save-bar .status.error{color:var(--red)}',
    '.btn{padding:.375rem .75rem;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);cursor:pointer;font-size:.75rem;font-weight:500;transition:background .15s,border-color .15s}',
    '.btn:hover{border-color:var(--accent);background:#1e2030}',
    '.btn:disabled{opacity:.5;cursor:not-allowed}',
    '.btn-primary{background:var(--accent);border-color:var(--accent);color:#fff}',
    '.btn-primary:hover{background:#4f46e5}',
    '.path-display{font-size:.65rem;color:var(--text-dim);padding:.35rem 1rem;background:var(--surface);border-bottom:1px solid var(--border);font-family:"SF Mono","Cascadia Code",monospace;flex-shrink:0}',
  ].join('\n');

  return (
    '<!DOCTYPE html>' +
    '<html lang="en"><head>' +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>OmniClaw — Context Viewer</title>' +
    '<style>' +
    css +
    '</style></head><body>' +
    renderNav('/context', { wsStatus: false }) +
    '<div class="layout">' +
    '<aside class="sidebar">' +
    '<div class="sidebar-title">Agents &amp; Channels</div>' +
    sidebarHtml +
    '</aside>' +
    '<div class="content">' +
    '<div id="empty-state" class="empty-state">' +
    '<div class="icon">&#128196;</div>' +
    '<div class="label">Select a channel to view its context layers</div>' +
    '<div class="hint">Click an agent, then choose a channel from the list</div>' +
    '</div>' +
    '<div id="editor-view" style="display:none;flex:1;flex-direction:column;overflow:hidden">' +
    '<div class="content-header"><div>' +
    '<div class="title" id="ctx-title"></div>' +
    '<div class="subtitle" id="ctx-subtitle"></div>' +
    '</div></div>' +
    '<div class="layer-tabs" id="layer-tabs">' +
    '<div class="layer-tab active" data-layer="channel" onclick="switchLayer(\'channel\')"><span class="dot" id="dot-channel"></span>Channel</div>' +
    '<div class="layer-tab" data-layer="agent" onclick="switchLayer(\'agent\')"><span class="dot" id="dot-agent"></span>Agent</div>' +
    '<div class="layer-tab" data-layer="category" onclick="switchLayer(\'category\')"><span class="dot" id="dot-category"></span>Category</div>' +
    '<div class="layer-tab" data-layer="server" onclick="switchLayer(\'server\')"><span class="dot" id="dot-server"></span>Server</div>' +
    '</div>' +
    '<div class="path-display" id="path-display"></div>' +
    '<div class="editor-area">' +
    '<div class="view-toggle">' +
    '<button class="active" data-view="split" onclick="setView(\'split\')">Split</button>' +
    '<button data-view="editor" onclick="setView(\'editor\')">Editor</button>' +
    '<button data-view="preview" onclick="setView(\'preview\')">Preview</button>' +
    '</div>' +
    '<div class="editor-pane" id="editor-pane"><div id="editor-container"></div></div>' +
    '<div class="preview-pane" id="preview-pane"></div>' +
    '</div>' +
    '<div class="save-bar" id="save-bar">' +
    '<span class="status" id="save-status">No changes</span>' +
    '<button class="btn" id="btn-revert" onclick="revertChanges()" disabled>Revert</button>' +
    '<button class="btn btn-primary" id="btn-save" onclick="saveChanges()" disabled>Save</button>' +
    '</div></div></div></div>' +
    '<script src="https://cdn.jsdelivr.net/npm/marked@15.0.7/marked.min.js"></scr' +
    'ipt>' +
    '<script src="https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs/loader.min.js"></scr' +
    'ipt>' +
    '<script>' +
    clientScript() +
    '</scr' +
    'ipt>' +
    '</body></html>'
  );
}

/** Client-side JavaScript — returned as a plain string to avoid template literal issues. */
function clientScript(): string {
  // Using regular string concatenation to avoid backtick escaping problems.
  return [
    '(function(){',
    'var currentLayer="channel",currentView="split",layerData={},editor=null,originalContent="",dirty=false,monacoReady=false;',

    // Monaco initialization
    'require.config({paths:{vs:"https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs"}});',
    'require(["vs/editor/editor.main"],function(){',
    '  monaco.editor.defineTheme("omniclaw",{base:"vs-dark",inherit:true,rules:[],colors:{',
    '    "editor.background":"#1a1d27","editor.foreground":"#e1e4ed",',
    '    "editorLineNumber.foreground":"#4a4d5a","editorLineNumber.activeForeground":"#8b8fa3",',
    '    "editor.lineHighlightBackground":"#1e2030","editor.selectionBackground":"#3a3d5a",',
    '    "editorCursor.foreground":"#6366f1"',
    '  }});',
    '  editor=monaco.editor.create(document.getElementById("editor-container"),{',
    '    value:"",language:"markdown",theme:"omniclaw",minimap:{enabled:false},',
    '    fontSize:13,lineHeight:22,wordWrap:"on",scrollBeyondLastLine:false,',
    '    renderWhitespace:"selection",padding:{top:12},automaticLayout:true,tabSize:2',
    '  });',
    '  editor.onDidChangeModelContent(function(){',
    '    if(!monacoReady)return;',
    '    var val=editor.getValue();dirty=val!==originalContent;',
    '    updateSaveBar();updatePreview(val);',
    '  });',
    '  editor.addCommand(monaco.KeyMod.CtrlCmd|monaco.KeyCode.KeyS,function(){if(dirty)saveChanges();});',
    '  monacoReady=true;',
    '});',

    // Toggle agent group
    'window.toggleAgent=function(el){',
    '  el.querySelector(".chevron").classList.toggle("open");',
    '  el.nextElementSibling.classList.toggle("open");',
    '};',

    // Select channel
    'window.selectChannel=function(el){',
    '  document.querySelectorAll(".channel-item").forEach(function(c){c.classList.remove("active");});',
    '  el.classList.add("active");',
    '  var jid=el.getAttribute("data-jid");',
    '  var agentId=el.getAttribute("data-agent-id");',
    '  var chName=el.querySelector(".ch-name");',
    '  document.getElementById("ctx-title").textContent=chName?chName.textContent:agentId;',
    '  document.getElementById("ctx-subtitle").textContent=agentId+" — "+jid;',
    '  document.getElementById("empty-state").style.display="none";',
    '  document.getElementById("editor-view").style.display="flex";',
    '  history.replaceState(null,"","/context?agent="+encodeURIComponent(agentId)+"&channel="+encodeURIComponent(jid));',
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
    '      dot.className=layerData[l]&&layerData[l].exists?"dot exists":"dot missing";',
    '    });',
    '    currentLayer="channel";',
    '    document.querySelectorAll(".layer-tab").forEach(function(t){',
    '      t.classList.toggle("active",t.getAttribute("data-layer")===currentLayer);',
    '    });',
    '    loadLayerContent(currentLayer);',
    '    document.getElementById("save-bar").classList.add("visible");',
    '  }).catch(function(err){console.error("Failed to load context layers:",err);});',
    '};',

    // Switch layer tab
    'window.switchLayer=function(layer){',
    '  if(dirty&&!confirm("You have unsaved changes. Discard them?"))return;',
    '  currentLayer=layer;',
    '  document.querySelectorAll(".layer-tab").forEach(function(t){',
    '    t.classList.toggle("active",t.getAttribute("data-layer")===layer);',
    '  });',
    '  loadLayerContent(layer);',
    '};',

    // Load layer content into editor
    'function loadLayerContent(layer){',
    '  var info=layerData[layer];',
    '  if(!info||!info.path){',
    '    document.getElementById("path-display").textContent="No path configured for this layer";',
    '    if(editor){monacoReady=false;editor.setValue("");monacoReady=true;}',
    '    originalContent="";dirty=false;updateSaveBar();updatePreview("");return;',
    '  }',
    '  document.getElementById("path-display").textContent=info.path+"/CLAUDE.md";',
    '  var content=info.content||"";',
    '  originalContent=content;',
    '  if(editor){monacoReady=false;editor.setValue(content);monacoReady=true;}',
    '  dirty=false;updateSaveBar();updatePreview(content);',
    '}',

    // View mode toggle
    'window.setView=function(view){',
    '  currentView=view;',
    '  document.querySelectorAll(".view-toggle button").forEach(function(b){',
    '    b.classList.toggle("active",b.getAttribute("data-view")===view);',
    '  });',
    '  var ep=document.getElementById("editor-pane"),pp=document.getElementById("preview-pane");',
    '  ep.classList.toggle("hidden",view==="preview");',
    '  pp.classList.toggle("hidden",view==="editor");',
    '  if(editor)editor.layout();',
    '};',

    // Markdown preview using marked.js
    'function updatePreview(content){',
    '  var el=document.getElementById("preview-pane");',
    '  if(!content){el.innerHTML="<p style=\\"color:var(--text-dim)\\">No content — this file does not exist yet.</p>";return;}',
    '  if(typeof marked!=="undefined"){',
    '    el.innerHTML=marked.parse(content);',
    '  }else{',
    '    el.textContent=content;',
    '  }',
    '}',

    // Save bar state
    'function updateSaveBar(){',
    '  var s=document.getElementById("save-status"),sb=document.getElementById("btn-save"),rb=document.getElementById("btn-revert");',
    '  if(dirty){s.textContent="Unsaved changes";s.className="status unsaved";sb.disabled=false;rb.disabled=false;}',
    '  else{s.textContent="No changes";s.className="status";sb.disabled=true;rb.disabled=true;}',
    '}',

    // Save changes
    'window.saveChanges=function(){',
    '  var info=layerData[currentLayer];if(!info||!info.path)return;',
    '  var content=editor?editor.getValue():"";',
    '  var s=document.getElementById("save-status"),sb=document.getElementById("btn-save");',
    '  s.textContent="Saving...";s.className="status saving";sb.disabled=true;',
    '  fetch("/api/context/file",{method:"PUT",headers:{"Content-Type":"application/json"},',
    '    body:JSON.stringify({path:info.path,content:content})})',
    '  .then(function(r){if(!r.ok)return r.json().then(function(d){throw new Error(d.error);});return r.json();})',
    '  .then(function(){',
    '    originalContent=content;dirty=false;info.content=content;info.exists=true;',
    '    document.getElementById("dot-"+currentLayer).className="dot exists";',
    '    s.textContent="Saved";s.className="status saved";sb.disabled=true;',
    '    document.getElementById("btn-revert").disabled=true;',
    '    setTimeout(function(){if(!dirty){s.textContent="No changes";s.className="status";}},2000);',
    '  }).catch(function(err){',
    '    s.textContent="Error: "+(err.message||"Save failed");s.className="status error";sb.disabled=false;',
    '  });',
    '};',

    // Revert changes
    'window.revertChanges=function(){',
    '  if(editor){monacoReady=false;editor.setValue(originalContent);monacoReady=true;}',
    '  dirty=false;updateSaveBar();updatePreview(originalContent);',
    '};',

    // Restore selection from URL params on load
    'var params=new URLSearchParams(location.search);',
    'var initAgent=params.get("agent"),initChannel=params.get("channel");',
    'if(initAgent&&initChannel){',
    '  var agentGroup=document.querySelector(".agent-group[data-agent-id=\\""+CSS.escape(initAgent)+"\\"]");',
    '  if(agentGroup){',
    '    agentGroup.querySelector(".chevron").classList.add("open");',
    '    agentGroup.querySelector(".channel-list").classList.add("open");',
    '    var chItem=agentGroup.querySelector(".channel-item[data-jid=\\""+CSS.escape(initChannel)+"\\"]");',
    '    if(chItem)setTimeout(function(){selectChannel(chItem);},0);',
    '  }',
    '}',

    '})();',
  ].join('\n');
}

// esc is a local alias for the shared escapeHtml
const esc = (str: string): string =>
  str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
