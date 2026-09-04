// Uses Android's own thermal severity as the authority. It never lowers output quality.
export class ThermalGuard extends EventTarget {
  constructor(androidBridge,{pollMs=2500}={}){super();this.bridge=androidBridge;this.pollMs=pollMs;this.timer=null;this.last=null;this.autoPaused=false;}
  read(){return this.bridge?.getThermalInfo?.()||null;}
  preflight(){
    const info=this.read();
    if(!info?.supported)return{ok:true,info,action:'continue'};
    if(Number(info.status)>=4)return{ok:false,info,action:'wait'}; // SEVERE+
    return{ok:true,info,action:Number(info.status)>=3?'reduce-concurrency':'continue'};
  }
  start({pause,resume,onState}={}){
    this.stop();
    const tick=()=>{
      const info=this.read(); if(!info)return;
      const status=Number(info.status??-1); this.last=info; onState?.(info);
      if(status>=4&&!this.autoPaused){this.autoPaused=true;pause?.();this.dispatchEvent(new CustomEvent('autopause',{detail:info}));}
      else if(status<=2&&this.autoPaused){this.autoPaused=false;resume?.();this.dispatchEvent(new CustomEvent('autoresume',{detail:info}));}
    };
    tick(); this.timer=setInterval(tick,this.pollMs);
  }
  stop(){if(this.timer)clearInterval(this.timer);this.timer=null;this.autoPaused=false;}
}
