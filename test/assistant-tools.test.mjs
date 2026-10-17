import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../server.js';

const A='M7lc1UVf-VE', B='jNQXAC9IVRw';
const cues=Array.from({length:205},(_,i)=>({start:i*2,duration:2,text:'caption '+i}));
async function app(t,overrides={}) {
  const server=createHttpServer({
    search:async query=>({query,source:'youtube-public-search',sourceUrl:'https://www.youtube.com/results',videos:[{videoId:A,title:'Player demonstration',channel:'Google for Developers',watchUrl:'https://www.youtube.com/watch?v='+A}]}),
    transcript:async videoId=>({videoId,language:'en',generated:false,source:'youtube-public-captions',sourceUrl:'https://www.youtube.com/watch?v='+videoId,cues}),
    ...overrides,
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const origin='http://127.0.0.1:'+server.address().port;
  let id=0;
  async function rpc(method,params={}) {
    const r=await fetch(origin+'/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params})});
    const body=await r.json();
    assert.equal(body.error,undefined,JSON.stringify(body.error));
    return body.result;
  }
  const call=(name,args={})=>rpc('tools/call',{name,arguments:args});
  const api=async(ref,key,path,body)=>{
    const r=await fetch(origin+'/api/players/'+ref+'/'+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','x-player-key':key},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:r.status,body:await r.json()};
  };
  return {rpc,call,api,origin};
}

test('search returns verified source records for the conversation model to recommend',async t=>{
  const a=await app(t);
  const names=(await a.rpc('tools/list')).tools.map(x=>x.name);
  for(const name of ['search_youtube_videos','get_youtube_transcript','control_youtube_player','get_youtube_player_state'])assert.ok(names.includes(name),name);
  const r=await a.call('search_youtube_videos',{query:'YouTube iframe API'});
  assert.equal(r.structuredContent.videos[0].videoId,A);
  assert.equal(r.structuredContent.source,'youtube-public-search');
});

test('browser reporting keys stay UI-only and control requests require real browser observations',async t=>{
  const a=await app(t);
  const opened=await a.call('open_youtube_player',{videoId:A});
  const {playerRef}=opened.structuredContent;
  const {reportKey}=opened._meta.playerConnection;
  assert.ok(playerRef&&reportKey);
  assert.ok(!JSON.stringify({content:opened.content,structuredContent:opened.structuredContent}).includes(reportKey));
  assert.equal(new URL(opened.structuredContent.popoutUrl).hash,'');
  const initial=(await a.call('get_youtube_player_state',{playerRef})).structuredContent;
  assert.equal(initial.observed,null);
  assert.equal((await a.api(playerRef,'wrong','attach',{})).status,403);
  const attached=await a.api(playerRef,reportKey,'attach',{});
  assert.equal(attached.status,200);
  const {epoch,revision}=attached.body;
  assert.equal((await a.api(playerRef,reportKey,'report',{epoch,videoId:A,revision,state:'playing',currentTime:4})).status,200);
  const state=(await a.call('get_youtube_player_state',{playerRef})).structuredContent;
  assert.equal(state.observed.videoId,A);
  assert.equal(state.observed.state,'playing');
  const request=await a.call('control_youtube_player',{playerRef,action:'select',videoId:B});
  assert.equal(request.structuredContent.confirmed,false);
  const stale=await a.api(playerRef,reportKey,'report',{epoch,videoId:A,revision,state:'playing',currentTime:9});
  assert.equal(stale.body.accepted,false);
});

test('caption pages expose partial coverage and stay bound to an explicit video',async t=>{
  const a=await app(t);
  const first=(await a.call('get_youtube_transcript',{videoId:A})).structuredContent;
  assert.equal(first.videoId,A);
  assert.equal(first.cues.length,150);
  assert.equal(first.totalCues,205);
  assert.equal(first.nextCursor,150);
  assert.equal(first.complete,false);
  const second=(await a.call('get_youtube_transcript',{videoId:A,cursor:150})).structuredContent;
  assert.equal(second.cues.length,55);
  assert.equal(second.cues[0].text,'caption 150');
  assert.equal(second.nextCursor,null);
  assert.equal(second.complete,false,'a final page alone is not the whole transcript');
});

test('a late caption response cannot be returned as the current video after a switch',async t=>{
  let finish,started;
  const entered=new Promise(resolve=>{started=resolve});
  const a=await app(t,{transcript:videoId=>{started();return new Promise(resolve=>{finish=()=>resolve({videoId,language:'en',generated:false,source:'youtube-public-captions',sourceUrl:'https://www.youtube.com/watch?v='+videoId,cues})})}});
  const opened=await a.call('open_youtube_player',{videoId:A});
  const {playerRef}=opened.structuredContent, {reportKey}=opened._meta.playerConnection;
  const attached=(await a.api(playerRef,reportKey,'attach',{})).body;
  await a.api(playerRef,reportKey,'report',{epoch:attached.epoch,revision:attached.revision,videoId:A,state:'playing',currentTime:3});
  const reading=a.call('get_youtube_transcript',{videoId:A,playerRef});
  await entered;
  await a.call('control_youtube_player',{playerRef,action:'select',videoId:B});
  finish();
  const result=await reading;
  assert.equal(result.isError,true);
  assert.equal(result.structuredContent.code,'video_changed');
  assert.equal(result.structuredContent.cues,undefined);
});

test('blocked transcript requests return a failure instead of video-description evidence',async t=>{
  const a=await app(t,{transcript:async()=>{throw Object.assign(new Error('Public captions request was blocked'),{code:'blocked',stage:'player'})}});
  const r=await a.call('get_youtube_transcript',{videoId:A});
  assert.equal(r.isError,true);
  assert.equal(r.structuredContent.code,'blocked');
  assert.equal(r.structuredContent.stage,'player');
  assert.equal(r.structuredContent.cues,undefined);
});

test('a long individual caption is paged without dropping text or exceeding the response bound',async t=>{
  const original='x'.repeat(20001);
  const a=await app(t,{transcript:async videoId=>({videoId,language:'en',source:'youtube-public-captions',cues:[{start:12,duration:20,text:original}]})});
  let cursor=0,joined='';
  do{
    const data=(await a.call('get_youtube_transcript',{videoId:A,cursor})).structuredContent;
    const page=data.cues.map(cue=>cue.text).join('');
    assert.ok(page.length<=18000);
    joined+=page;cursor=data.nextCursor;
  }while(cursor!==null);
  assert.equal(joined,original);
});
