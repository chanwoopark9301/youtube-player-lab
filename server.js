import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';

const base = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(base,'public','player.html'),'utf8');
const diagnosticsHtml = readFileSync(join(base,'public','diagnostics.html'),'utf8');
const playerUrl = new URL(process.env.PUBLIC_ORIGIN || 'https://youtube-player-lab.onrender.com');
if (!['http:','https:'].includes(playerUrl.protocol)) throw new Error('PUBLIC_ORIGIN must be an HTTP(S) origin');
const playerOrigin = playerUrl.origin;
const appHtml = readFileSync(join(base,'public','hosted-player.html'),'utf8').replaceAll('__PLAYER_ORIGIN__',playerOrigin);
const RESOURCE = 'ui://youtube-player-lab/popup-status-v4.html';
const POPUP_RESOURCE = 'ui://youtube-player-lab/popup-v3.html';
const VIDEO_ONLY_RESOURCE = 'ui://youtube-player-lab/video-only-v2.html';
const PREVIOUS_RESOURCE = 'ui://youtube-player-lab/https-player-v1.html';
const LEGACY_RESOURCE = 'ui://youtube-player-lab/player.html';
const DEFAULT_VIDEO = 'M7lc1UVf-VE';
const VIDEO_ID = /^[a-zA-Z0-9_-]{11}$/;
const port = Number(process.env.PORT || 8787);
const widgetOrigin = process.env.WIDGET_ORIGIN;

function createMcpServer() {
  const server = new McpServer({name:'youtube-player-lab',version:'0.1.4'});
  for (const [index,uri] of [RESOURCE,POPUP_RESOURCE,VIDEO_ONLY_RESOURCE,PREVIOUS_RESOURCE,LEGACY_RESOURCE].entries()) registerAppResource(server,'youtube-player-lab-'+index,uri,{},async()=>({
    contents:[{uri,mimeType:RESOURCE_MIME_TYPE,text:appHtml,_meta:{
      ui:{
        prefersBorder:false,
        ...(widgetOrigin?{domain:widgetOrigin}:{}),
        csp:{
          resourceDomains:[],
          connectDomains:[],
          frameDomains:[playerOrigin]
        }
      },
      'openai/ui':{availableDisplayModes:['inline','pip','fullscreen']},
      'openai/widgetDescription':'Official YouTube player with small controls to request a pinned ChatGPT popup, popup then fullscreen, or return inline. Display modes depend on host support. Video streams directly from YouTube; no download or proxy.'
    }}]
  }));
  registerAppTool(server,'open_youtube_player',{
    title:'Open YouTube Player Lab',
    description:'Display an official YouTube player with native video controls and buttons for a pinned ChatGPT popup, popup then fullscreen, and returning inline when the host supports those modes. No downloads or proxies.',
    inputSchema:{videoId:z.string().regex(VIDEO_ID).default(DEFAULT_VIDEO)},
    annotations:{readOnlyHint:true,openWorldHint:true,destructiveHint:false},
    _meta:{ui:{resourceUri:RESOURCE}}
  },async({videoId=DEFAULT_VIDEO})=>({
    content:[{type:'text',text:'YouTube player for video '+videoId+'. Use the native controls for playback. The separate popup buttons request ChatGPT display modes; a host may reject or substitute a mode.'}],
    structuredContent:{videoId,watchUrl:'https://www.youtube.com/watch?v='+videoId}
  }));
  return server;
}

const httpServer=createServer(async(req,res)=>{
  const url=new URL(req.url||'/', 'http://'+(req.headers.host||'localhost'));
  if(req.method==='GET'&&url.pathname==='/health'){
    res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
    res.end(JSON.stringify({ok:true,service:'youtube-player-lab'}));
    return;
  }
  if(req.method==='GET'&&url.pathname==='/'){
    res.writeHead(200,{'content-type':'text/plain; charset=utf-8'});
    res.end('YouTube Player Lab: /health, /player, /diagnostics and /mcp');
    return;
  }
  if(req.method==='GET'&&['/player','/diagnostics'].includes(url.pathname)){
    res.writeHead(200,{'content-type':'text/html; charset=utf-8','referrer-policy':'strict-origin-when-cross-origin'});
    res.end(url.pathname==='/diagnostics'?diagnosticsHtml:html);
    return;
  }
  if(req.method==='OPTIONS'&&url.pathname==='/mcp'){
    res.writeHead(204,{
      'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST, GET, DELETE, OPTIONS',
      'Access-Control-Allow-Headers':'content-type,mcp-session-id,mcp-protocol-version,authorization,accept',
      'Access-Control-Expose-Headers':'Mcp-Session-Id'
    });
    res.end();
    return;
  }
  if(url.pathname==='/mcp'&&['POST','GET','DELETE'].includes(req.method||'')){
    res.setHeader('Access-Control-Allow-Origin','*');
    res.setHeader('Access-Control-Expose-Headers','Mcp-Session-Id');
    const server=createMcpServer();
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    res.on('close',()=>{transport.close();server.close();});
    try{await server.connect(transport);await transport.handleRequest(req,res);}
    catch(e){console.error('MCP error',e);if(!res.headersSent)res.writeHead(500).end('Internal server error');}
    return;
  }
  res.writeHead(404).end('Not found');
});
httpServer.listen(port,'0.0.0.0',()=>console.log('YouTube Player Lab is listening on port '+port));
