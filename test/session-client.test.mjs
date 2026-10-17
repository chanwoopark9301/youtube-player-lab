import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { PlayerSessions } from '../lib/player-sessions.js';

const A='M7lc1UVf-VE',B='jNQXAC9IVRw';
async function harness({sessions=new PlayerSessions(),connection=sessions.create(A),blockedPlay=false,delayedSelect=false}={}){
  let source='';try{source=readFileSync(new URL('../public/session-client.js',import.meta.url),'utf8')}catch{}
  const timers=new Map(),statuses=[];
  let nextTimer=0,actual={videoId:A,state:'paused',currentTime:0},pauses=0;
  const adapter={
    read:()=>({...actual}),
    select:videoId=>{if(!delayedSelect)actual={videoId,state:'unstarted',currentTime:0}},
    play:()=>{if(!blockedPlay)actual.state='playing'},
    pause:()=>{pauses++;actual.state='paused'},
    seek:seconds=>{actual.currentTime=seconds},
    status:value=>statuses.push(value),
  };
  async function fetchImpl(url,options){
    const parsed=new URL(url,'https://player.example.test');
    const match=/\/api\/players\/([^/]+)\/(attach|commands|report)$/.exec(parsed.pathname);
    assert.ok(match,'the client must talk only to the player control API');
    const key=options.headers['x-player-key'],data=options.body?JSON.parse(options.body):{};
    try{
      let result;
      if(match[2]==='attach')result=sessions.attach(match[1],key);
      if(match[2]==='commands')result=sessions.poll(match[1],key,parsed.searchParams.get('epoch'),Number(parsed.searchParams.get('after')));
      if(match[2]==='report'){const {epoch,...report}=data;result={accepted:sessions.report(match[1],key,epoch,report)}}
      return {ok:true,status:200,json:async()=>result};
    }catch(e){return {ok:false,status:e.status||500,json:async()=>({error:e.message})}}
  }
  const window={fetch:fetchImpl,setTimeout(callback){const id=++nextTimer;timers.set(id,callback);return id},clearTimeout:id=>timers.delete(id)};
  const context=vm.createContext({window,URL,URLSearchParams,AbortController,console});
  vm.runInContext(source,context);
  assert.equal(typeof window.createYouTubeSessionClient,'function','a client must connect the visible player to its server session');
  const client=window.createYouTubeSessionClient(connection,adapter);
  await client.ready;
  async function tick(){
    const batch=[...timers.values()];timers.clear();
    for(const callback of batch)await callback();
    for(let i=0;i<15;i++)await Promise.resolve();
  }
  return {sessions,connection,client,tick,statuses,setActual:value=>{actual={...actual,...value}},get actual(){return actual},get pauses(){return pauses}};
}

test('a selected video is observed without pretending denied autoplay is playback',async()=>{
  const r=await harness();
  const command=r.sessions.queue(r.connection.playerRef,{action:'select',videoId:B});
  await r.tick();
  const state=r.sessions.getState(r.connection.playerRef);
  assert.equal(state.observed.videoId,B);
  assert.equal(state.observed.state,'unstarted');
  assert.equal(state.ack.commandId,command.id);
  r.client.stop();
});

test('play is acknowledged only after the actual player begins playing',async()=>{
  const r=await harness({blockedPlay:true});
  const command=r.sessions.queue(r.connection.playerRef,{action:'play'});
  await r.tick();
  assert.notEqual(r.sessions.getState(r.connection.playerRef).ack?.commandId,command.id);
  r.setActual({state:'playing',currentTime:2.7});
  await r.tick();
  const state=r.sessions.getState(r.connection.playerRef);
  assert.equal(state.ack.commandId,command.id);
  assert.equal(state.observed.currentTime,2.7);
  r.client.stop();
});

test('opening a new player transfers ownership and pauses the replaced player',async()=>{
  const first=await harness();
  const second=await harness({sessions:first.sessions,connection:first.connection});
  await first.tick();
  assert.equal(first.pauses,1);
  assert.ok(first.statuses.includes('detached'));
  second.setActual({state:'playing',currentTime:7});
  await second.tick();
  assert.equal(first.sessions.getState(first.connection.playerRef).observed.currentTime,7);
  first.client.stop();second.client.stop();
});

test('pause and seek acknowledge measured player effects',async()=>{
  const r=await harness();
  r.sessions.queue(r.connection.playerRef,{action:'seek',seconds:23});
  await r.tick();
  assert.equal(r.sessions.getState(r.connection.playerRef).observed.currentTime,23);
  r.setActual({state:'playing'});
  const command=r.sessions.queue(r.connection.playerRef,{action:'pause'});
  await r.tick();
  assert.equal(r.sessions.getState(r.connection.playerRef).observed.state,'paused');
  assert.equal(r.sessions.getState(r.connection.playerRef).ack.commandId,command.id);
  r.client.stop();
});

test('commands following an asynchronous selection wait for the selected video to arrive',async()=>{
  const r=await harness({delayedSelect:true});
  r.setActual({state:'playing'});
  r.sessions.queue(r.connection.playerRef,{action:'select',videoId:B});
  const pause=r.sessions.queue(r.connection.playerRef,{action:'pause'});
  await r.tick();
  r.setActual({videoId:B,state:'playing',currentTime:0.2});
  await r.tick();
  const state=r.sessions.getState(r.connection.playerRef);
  assert.equal(state.observed.videoId,B);
  assert.equal(state.observed.state,'paused');
  assert.equal(state.ack.commandId,pause.id);
  r.client.stop();
});
