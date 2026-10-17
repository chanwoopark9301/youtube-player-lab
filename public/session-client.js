(()=>{
'use strict';
// Reporting keys travel only through the UI and same-origin request headers.
window.createYouTubeSessionClient=function(connection,adapter){
  const valid=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{43}$/.test(value);
  if(!valid(connection?.playerRef)||!valid(connection?.reportKey))throw new Error('Invalid player connection');
  const path='/api/players/'+connection.playerRef;
  let stopped=false,timer=null,epoch=null,revision=1,videoId=null,after=0,ack=0,awaiting=null;
  let commands=[];
  const status=value=>adapter.status?.(value);
  function stop(){stopped=true;if(timer!==null)window.clearTimeout(timer)}
  async function request(endpoint,body){
    const controller=new AbortController();
    const timeout=window.setTimeout(()=>controller.abort(),6000);
    try{
      const response=await window.fetch(path+'/'+endpoint,{method:body===undefined?'GET':'POST',headers:{'x-player-key':connection.reportKey,...(body===undefined?{}:{'content-type':'application/json'})},cache:'no-store',credentials:'omit',signal:controller.signal,...(body===undefined?{}:{body:JSON.stringify(body)})});
      if(!response.ok)throw Object.assign(new Error('Player connection failed'),{status:response.status});
      return await response.json();
    }finally{window.clearTimeout(timeout)}
  }
  function apply(command){
    if(command.action==='select'){
      videoId=command.videoId;revision=command.revision;ack=0;adapter.select(videoId);
    }else if(command.revision===revision){
      if(command.action==='play')adapter.play();
      if(command.action==='pause')adapter.pause();
      if(command.action==='seek')adapter.seek(command.seconds);
    }else return;
    awaiting=command;
  }
  function effected(actual,command){
    if(!command||actual.videoId!==videoId)return false;
    if(command.action==='select')return true;
    if(command.action==='play')return actual.state==='playing';
    if(command.action==='pause')return ['paused','cued','ended','unstarted'].includes(actual.state);
    if(command.action==='seek')return Math.abs(actual.currentTime-command.seconds)<=2;
    return false;
  }
  async function refresh(){
    if(stopped)return;
    try{
      const result=await request('commands?'+new URLSearchParams({epoch,after}));
      if(stopped)return;
      if(result.detached){adapter.pause();stop();status('detached');return}
      const incoming=(result.commands||[]).filter(command=>command.id>after);
      if(incoming.length){
        const newestRevision=Math.max(revision,...incoming.map(command=>command.revision));
        commands=commands.filter(command=>command.revision===newestRevision);
        commands.push(...incoming.filter(command=>command.revision===newestRevision));
        after=incoming.at(-1).id;
      }
      while(commands.length){
        const command=commands[0];
        // loadVideoById is asynchronous. Apply a following pause/seek only to
        // the new video, rather than consuming it against the previous one.
        if(command.action!=='select'&&adapter.read()?.videoId!==command.videoId)break;
        apply(command);commands.shift();
        if(command.action==='select'&&adapter.read()?.videoId!==videoId)break;
      }
      const actual=adapter.read();
      if(actual?.videoId===videoId&&Number.isFinite(actual.currentTime)){
        if(effected(actual,awaiting)){ack=awaiting.id;awaiting=null}
        const report={epoch,revision,videoId,state:actual.state,currentTime:actual.currentTime,...(ack?{ackCommandId:ack}:{}),...(actual.error?{error:String(actual.error)}:{})};
        const result=await request('report',report);
        status(result.accepted?'connected':'unconfirmed');
      }
    }catch(error){
      if(stopped)return;
      status(error.status===404||error.status===410?'expired':'unconfirmed');
      if([403,404,410].includes(error.status)){stop();return}
    }
    if(!stopped)timer=window.setTimeout(refresh,1000);
  }
  const ready=(async()=>{
    try{
      const attached=await request('attach',{});
      if(stopped)return;
      epoch=attached.epoch;revision=attached.revision;videoId=attached.videoId;after=attached.afterCommandId;ack=after;
      if(adapter.read()?.videoId!==videoId)adapter.select(videoId);
      await refresh();
    }catch(error){status('unconfirmed');stop()}
  })();
  return {ready,stop};
};
})();
