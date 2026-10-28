/* Tulane Film Pull Board: live shared checkmarks via Supabase.
   Game data comes from data.json (updated weekly). Checkmarks live in the
   Supabase "checks" table and sync to every open screen in real time. */
(async function(){
  var COLS=[["tvcut","TV cut"],["tvdef","TV def"],["ez","2 EZ"]];
  var CFG=window.BOARD_CONFIG||{};

  var mount=document.getElementById("mount");
  mount.appendChild(document.getElementById("shell").content.cloneNode(true));

  var root=document.getElementById("root");
  /* Column headers stick right under the toolbar, whatever height it wraps to. */
  function setStick(){
    var t=document.querySelector(".toolbar"); if(!t) return;
    var st=getComputedStyle(t).position==="sticky";
    document.documentElement.style.setProperty("--stick",(st?Math.ceil(t.getBoundingClientRect().height):0)+"px");
  }
  setStick(); window.addEventListener("resize",setStick);
  var STATE={checks:{},who:{}};
  var DATA={weeks:[],logos:{}}, LOGOS={};
  var sb=null, onlyLeft=false, allShut=false, shut={}, openGames={}, byGame=false;
  var CANDS=[];   /* possible postseason opponents added on the site (Supabase) */

  function lsGet(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
  function lsSet(k,v){ try{ localStorage.setItem(k,v); }catch(e){} }
  function lsDel(k){ try{ localStorage.removeItem(k); }catch(e){} }

  function esc(s){ return String(s).replace(/[&<>"']/g,function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
  /* No long dashes in notes: "A, dash, b" becomes "A. B" */
  function clean(t){ return String(t||"").replace(/\s*\u2014\s*(\w?)/g,function(m,c){ return ". "+(c?c.toUpperCase():""); }); }
  var RM=!!(window.matchMedia&&matchMedia("(prefers-reduced-motion: reduce)").matches);
  /* Numbers count up to their new value instead of jumping. */
  function setNum(id,v){
    var el=document.getElementById(id); if(!el) return;
    var from=Number(el.getAttribute("data-v")); if(isNaN(from)) from=0;
    el.setAttribute("data-v",v);
    if(RM||from===v){ el.textContent=v; return; }
    var t0=performance.now(), D=500;
    (function step(t){
      if(el.getAttribute("data-v")!==String(v)) return;
      var p=Math.min(1,(t-t0)/D), e=1-Math.pow(1-p,3);
      el.textContent=Math.round(from+(v-from)*e);
      if(p<1) requestAnimationFrame(step);
    })(t0);
  }
  function setBar(id,frac){ var el=document.getElementById(id); if(el) el.style.width=Math.round(Math.max(0,Math.min(1,frac||0))*100)+"%"; }
  /* Tulane's own result for a week, if the data has it: w.fin = {res:"W",us:35,them:10} */
  function tulResult(w){
    if(!w||!w.fin||w.fin.us==null) return "";
    var r=String(w.fin.res||(w.fin.us>w.fin.them?"W":"L")).toUpperCase();
    return '<span class="tres '+(r==="W"?"w":"l")+'"><b>'+r+'</b> '+w.fin.us+"\u2013"+w.fin.them+'</span>';
  }
  function tulRecord(){
    if(DATA.meta&&DATA.meta.tulRec) return String(DATA.meta.tulRec);
    var wn=0, ln=0, any=false;
    DATA.weeks.forEach(function(w){ if(w.fin&&w.fin.us!=null){ any=true; var r=String(w.fin.res||(w.fin.us>w.fin.them?"W":"L")).toUpperCase(); if(r==="W") wn++; else ln++; } });
    return any?wn+"-"+ln:"";
  }

  /* Stable id: survives rows being added or reordered in data.json. */
  function idFor(w,g,c){
    if(w.post){
      /* A game already on that team's regular-season card shares its checkmarks. */
      var reg=OPPWEEK[w.opp];
      if(reg&&reg.games.some(function(x){ return x.ha&&x.date===g.date&&x.opp===g.opp; }))
        return "w"+reg.week+"|"+g.date+"|"+g.opp+"|"+c;
      return "p|"+w.opp+"|"+g.date+"|"+g.opp+"|"+c;
    }
    return "w"+w.week+"|"+g.date+"|"+g.opp+"|"+c;
  }
  function filmGames(w){ return w.games.filter(function(g){ return !!g.ha; }); }
  function weekTotal(w){ return filmGames(w).length*3; }
  function weekDone(w){
    var n=0;
    w.games.forEach(function(g){
      if(!g.ha) return;
      COLS.forEach(function(c){ if(STATE.checks[idFor(w,g,c[0])]) n++; });
    });
    return n;
  }

  function setSync(kind,text){
    var d=document.getElementById("sdot"), t=document.getElementById("stext");
    d.className="dot"+(kind==="busy"?" busy":kind==="off"?" off":"");
    t.textContent=text;
  }
  function showNotice(msg){
    var n=document.getElementById("notice");
    n.textContent=msg; n.classList.remove("hide");
  }
  function hideNotice(){ document.getElementById("notice").classList.add("hide"); }

  function fact(label,value,cls){
    return '<div class="fact"><dt>'+label+'</dt><dd'+(cls?' class="'+cls+'"':"")+'>'+value+'</dd></div>';
  }

  /* ---------- conference lookups (data.json "conf": {team:[conference,"FBS"|"FCS"]}) ---------- */
  function confOf(team){ var c=DATA.conf&&DATA.conf[team]; return c?{name:c[0],lvl:c[1]||""}:null; }
  function confLabel(team){ var c=confOf(team); return c?c.name+(c.lvl==="FCS"?" (FCS)":""):""; }
  function sameConf(a,b){ var x=confOf(a), y=confOf(b); return !!(x&&y&&x.name===y.name&&x.name!=="Independent"); }

  /* Team colors for the score bug: Tulane opponents have c1/c2 in the data; everyone else
     gets a color sampled from their logo when the board loads. */
  var TEAMCOL={};
  function teamColors(team){
    var w=OPPWEEK[team]; if(w&&w.c1) return {c1:w.c1,c2:w.c2||"#999"};
    return TEAMCOL[team]||{c1:"#3a3f3c",c2:"#8a918c"};
  }
  function sampleLogo(team,src){
    return new Promise(function(done){
      var im=new Image(); var t=setTimeout(done,1500);
      im.onload=function(){
        try{
          var c=document.createElement("canvas"); c.width=c.height=24;
          var x=c.getContext("2d"); x.drawImage(im,0,0,24,24);
          var d=x.getImageData(0,0,24,24).data, bins={}, best=null;
          for(var i=0;i<d.length;i+=4){
            var r=d[i],g=d[i+1],b=d[i+2],a=d[i+3];
            if(a<200) continue;
            var mx=Math.max(r,g,b), mn=Math.min(r,g,b);
            if(mx>215&&mn>200) continue;               /* skip white */
            var k=(r>>5)+","+(g>>5)+","+(b>>5);
            var e=bins[k]||(bins[k]={n:0,r:0,g:0,b:0,sat:mx-mn});
            e.n++; e.r+=r; e.g+=g; e.b+=b;
          }
          Object.keys(bins).forEach(function(k){ var e=bins[k], sc=e.n*(1+e.sat/255); if(!best||sc>best.sc){ best=e; best.sc=sc; } });
          if(best){
            var r1=best.r/best.n, g1=best.g/best.n, b1=best.b/best.n;
            var lum=(0.299*r1+0.587*g1+0.114*b1)/255;
            if(lum>0.55){ var f=0.55/lum; r1*=f; g1*=f; b1*=f; }   /* keep white text readable */
            TEAMCOL[team]={c1:"rgb("+Math.round(r1)+","+Math.round(g1)+","+Math.round(b1)+")",c2:"rgba(255,255,255,.35)"};
          }
        }catch(e){}
        clearTimeout(t); done();
      };
      im.onerror=function(){ clearTimeout(t); done(); };
      im.src=src;
    });
  }
  function sampleAllLogos(){
    return Promise.all(Object.keys(LOGOS).map(function(t){ return OPPWEEK[t]?null:sampleLogo(t,LOGOS[t]); }));
  }
  function coverLine(note,w){
    var parts=String(note||"").split(" / "), out="";
    if(parts[0]){
      var who=parts[0].replace(/\s[+-]?\d+(\.\d+)?\s/," ").replace(/\s+covered.*$/i,"").trim();
      var push=/push/i.test(parts[0]);
      out+='<span class="tag '+(push?"neu":who===w.opp?"good":"bad")+'">'+esc(push?"Push":who+" covered")+'</span>';
    }
    if(parts.length>1) out+='<span class="tag neu">'+esc(parts.slice(1).join(" / "))+'</span>';
    return out;
  }
  var PIN='<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 11s4-3.8 4-6.5A4 4 0 0 0 2 4.5C2 7.2 6 11 6 11Z" fill="currentColor"/></svg>';

  /* The panel under a game when it is opened. */
  function tile(label,value,sub,cls){
    return '<div class="tile'+(cls?" "+cls:"")+'"><dt>'+label+'</dt><dd>'+value+(sub?'<small>'+sub+'</small>':"")+'</dd></div>';
  }
  function detailPanel(w,g){
    var html='<div class="detail">', f=g.fin;
    if(f){
      var won=String(f.res).toUpperCase()==="W";
      var a=teamColors(w.opp), b=teamColors(g.opp), la=LOGOS[w.opp], lb=LOGOS[g.opp];
      html+='<div class="bug">'
        + '<span class="t'+(won?"":" lose")+'" style="--tc:'+esc(a.c1)+';--tc2:'+esc(a.c2)+'">'+(la?'<img src="'+la+'" alt="">':"")+esc(shortName(w.opp))+'<b>'+f.us+'</b></span>'
        + '<span class="t'+(won?" lose":"")+'" style="--tc:'+esc(b.c1)+';--tc2:'+esc(b.c2)+'">'+(lb?'<img src="'+lb+'" alt="">':"")+esc(shortName(g.opp))+'<b>'+f.them+'</b></span>'
        + '<span class="fin">Final</span></div>';
      if(f.cl||f.ou) html+='<p class="line">Closed <b>'+(f.cl?esc(f.cl):"no spread")+'</b>'+(f.ou?', O/U <b>'+esc(f.ou)+'</b>':"")+'.'+coverLine(f.note,w)+'</p>';
      else html+='<p class="line muted">No closing line on file.</p>';
    } else {
      var k=kickoff(g.date,g.t);
      html+='<div class="big">'+[(k?dayName(k)+", ":"")+esc(String(g.date).replace(/\s*\(.*?\)/,"")),g.t?esc(g.t):"Time TBD",g.tv?esc(g.tv):""].filter(Boolean).join(" \u00b7 ")+'</div>';
      html+=g.ln
        ? '<p class="line">Line <b>'+esc(g.ln.o)+'</b>'+(g.ln.ou?', O/U <b>'+esc(g.ln.ou)+'</b>':"")+(g.ln.as?' <span class="muted">('+esc(g.ln.as)+')</span>':"")+'</p>'
        : '<p class="line muted">No line posted yet. It usually posts the week of the game.</p>';
    }
    if(g.ven) html+='<div class="venue">'+PIN+esc(g.ven)+(g.loc?", "+esc(g.loc):"")+'</div>';
    if(f){
      var url=(f.box||g.box)||("https://www.google.com/search?q="+encodeURIComponent(w.opp+" vs "+g.opp+" "+g.date+" "+seasonYear()+" box score espn"));
      html+='<a class="boxlink" href="'+esc(url)+'" target="_blank" rel="noopener">'+((f.box||g.box)?"ESPN box score":"Find the box score")+' \u2197</a>';
    }
    return html+'</div>';
  }

  function kickCell(o){
    if(o.fin){
      var wl=String(o.fin.res||"").toUpperCase();
      return '<span class="kcell final"><span class="kick"><b class="wl '+(wl==="W"?"w":wl==="L"?"l":"t")+'">'+esc(wl)+'</b>'
           + o.fin.us+"\u2013"+o.fin.them+'</span>'
           + '<span class="net">'+(o.tv?esc(o.tv):"Final")+'</span></span>';
    }
    if(!o.t&&!o.tv) return '<span class="kcell tbd"><span class="kick">TBD</span></span>';
    return '<span class="kcell"><span class="kick">'+esc(o.t||"Time TBD")+liveBadge(o)+'</span>'
         + (o.tv?'<span class="net">'+esc(o.tv)+'</span>':"")+'</span>';
  }
  function liveBadge(o){
    var k=kickoff(o.date,o.t); if(!k||!k.timed||o.fin) return "";
    var n=Date.now(), ms=k.at.getTime();
    return ' <span class="livebadge" data-live="'+ms+'"'+((n>=ms&&n<ms+GAME_LEN)?"":" hidden")+'>LIVE</span>';
  }
  /* Phone only: the kick/TV column is hidden, so show a compact line under the name. */
  function phoneSub(o,chip){
    var txt;
    if(o.fin) txt=o.fin.res+" "+o.fin.us+"\u2013"+o.fin.them;
    else txt=[o.t||"TBD",o.tv||""].filter(Boolean).join(" \u00b7 ");
    return '<span class="rsub">'+(chip||"")+(o.ha==="A"?"Away":"Home")+" \u00b7 "+esc(txt)+liveBadge(o)+'</span>';
  }

  function rowMark(g){
    var badge=LOGOS[g.opp];
    return badge
      ? '<span class="rmark"><img src="'+badge+'" alt="" width="19" height="19"></span>'
      : '<span class="rmark"><span class="rmono">'+esc(g.mono||"")+'</span></span>';
  }

  function updateTotals(){
    var total=0, done=0, oppDone=0, gamesOpen=0, opps=0, playedGames=0, avail=0, pulledPlayed=0;
    DATA.weeks.forEach(function(w){
      var t=weekTotal(w), d=weekDone(w);
      total+=t; done+=d;
      if(t>0){ opps++; if(d===t) oppDone++; }
      /* only games already played count: nobody can pull a game that has not happened */
      w.games.forEach(function(g){
        if(!g.ha||!played(g)) return;
        playedGames++;
        var got=COLS.filter(function(c){ return STATE.checks[idFor(w,g,c[0])]; }).length;
        avail+=COLS.length; pulledPlayed+=got;
        if(got<COLS.length) gamesOpen++;
      });
    });
    setNum("pdone",done);
    var pt=document.getElementById("ptot"); if(pt) pt.textContent=total;
    setNum("sCut",pulledPlayed); setNum("sOpp",oppDone); setNum("sGame",gamesOpen);
    var ot=document.getElementById("sOppT"); if(ot) ot.textContent=opps;
    var ct=document.getElementById("sCutT"); if(ct) ct.textContent=avail;
    setBar("bCut",avail?pulledPlayed/avail:0);
    setBar("bOpp",opps?oppDone/opps:0);
    var gt=document.getElementById("sGameT"); if(gt) gt.textContent=playedGames;
    setBar("bGame",playedGames?(playedGames-gamesOpen)/playedGames:0);
  }

  function weekByNum(n){ var r=null; DATA.weeks.forEach(function(x){ if(x.week===n) r=x; }); return r; }
  function weekByKey(k){ var r=null; allWeeks().forEach(function(x){ if(String(x.week)===String(k)) r=x; }); return r; }

  /* ---------- postseason: official (data.json) + possible opponents (added on the site) ---------- */
  function slug(t){ return String(t).toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,""); }
  function monoFor(t){
    var w=String(t).split(/\s+/).filter(Boolean);
    return (w.length>1?w.map(function(x){ return x[0]; }).join(""):String(t).slice(0,4)).toUpperCase().slice(0,4);
  }
  function postWeeks(){
    var post=(DATA.post)||{}, teams=post.teams||{}, out=[], seen={};
    var list=[];
    (post.events||[]).forEach(function(e){ list.push({team:e.opp,event:e.event,date:e.date,official:true,t:e.t,tv:e.tv,site:e.site}); });
    CANDS.forEach(function(c){ list.push({team:c.team,event:c.event,date:c.event_date,id:c.id,by:c.added_by}); });
    list.forEach(function(c){
      var key=c.event+"|"+c.team; if(seen[key]) return; seen[key]=1;
      var info=teams[c.team], reg=OPPWEEK[c.team], games, partial=false;
      if(info&&info.games) games=info.games;
      else if(reg){
        games=reg.games.slice(); partial=true;
        if(!games.some(function(x){ return x.opp==="Tulane"; }))
          games.push({date:reg.date.replace(/\s*\(.*\)/,""),opp:"Tulane",mono:"TU",ha:reg.site==="H"?"A":reg.site==="A"?"H":"H",t:reg.t,tv:reg.tv});
      } else { games=[]; partial=true; }
      out.push({
        week:"P-"+slug(c.event)+"-"+slug(c.team), post:true, official:!!c.official, candId:c.id, addedBy:c.by,
        event:c.event, opp:c.team, date:c.date||"", t:c.t, tv:c.tv, site:c.site||"N",
        rec:(info&&info.rec)||(reg&&reg.rec)||"", c1:(info&&info.c1)||(reg&&reg.c1)||"#5d6b62", c2:(info&&info.c2)||(reg&&reg.c2)||"#9aa69e",
        mono:(info&&info.mono)||monoFor(c.team), games:games, partial:partial
      });
    });
    return out;
  }
  function allWeeks(){ return DATA.weeks.concat(postWeeks()); }

  /* ---------- dates and kickoffs (all game times are Central) ---------- */
  var MON={Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
  function seasonYear(){ var b=(DATA.meta&&DATA.meta.built)||""; var y=parseInt(b.slice(0,4),10); return isNaN(y)?new Date().getFullYear():y; }
  function nthSunday(y,mo,n){ var d=new Date(Date.UTC(y,mo,1)); var first=(7-d.getUTCDay())%7+1; return first+(n-1)*7; }
  function ctOffsetHours(y,mo,d){
    /* US daylight time: 2nd Sunday of March to 1st Sunday of November */
    var start=Date.UTC(y,2,nthSunday(y,2,2)), end=Date.UTC(y,10,nthSunday(y,10,1)), t=Date.UTC(y,mo,d);
    return (t>=start&&t<end)?5:6;
  }
  function ctDate(y,mo,d,h,mi){ return new Date(Date.UTC(y,mo,d,h+ctOffsetHours(y,mo,d),mi||0)); }
  function parseDay(s){
    var m=/([A-Z][a-z]{2})\s+(\d{1,2})/.exec(String(s||"")); if(!m||MON[m[1]]===undefined) return null;
    var y=seasonYear(), mo=MON[m[1]]; if(mo<6) y+=1; /* January bowl games */
    return {y:y,mo:mo,d:parseInt(m[2],10)};
  }
  /* Returns {at:Date, timed:bool} or null. Untimed games count from noon CT that day. */
  function kickoff(dateStr,tStr){
    var p=parseDay(dateStr); if(!p) return null;
    var t=/(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(String(tStr||""));
    if(!t) return {at:ctDate(p.y,p.mo,p.d,12,0),timed:false};
    var h=parseInt(t[1],10)%12+(/pm/i.test(t[3])?12:0);
    return {at:ctDate(p.y,p.mo,p.d,h,parseInt(t[2],10)),timed:true};
  }
  var GAME_LEN=3.75*3600*1000;
  function played(g){
    if(g.fin) return true;
    var k=kickoff(g.date,g.t); return !!k&&Date.now()>k.at.getTime()+GAME_LEN;
  }
  function tulaneKick(w){ return w.site==="BYE"?null:kickoff(w.date,w.t); }
  function upcomingWeeks(){
    var now=Date.now();
    return DATA.weeks.filter(function(w){
      var k=tulaneKick(w); return k&&k.at.getTime()+GAME_LEN>now;
    });
  }
  function countdownText(k){
    if(!k) return "";
    var ms=k.at.getTime()-Date.now();
    if(ms<=0) return ms>-GAME_LEN?"Live now":"";
    var mins=Math.floor(ms/60000), d=Math.floor(mins/1440), h=Math.floor((mins%1440)/60), m=mins%60;
    if(!k.timed) return d>0?"In "+d+(d===1?" day":" days")+" \u00b7 time TBD":"Game day \u00b7 time TBD";
    if(d>0) return "Kickoff in "+d+"d "+h+"h";
    if(h>0) return "Kickoff in "+h+"h "+m+"m";
    return "Kickoff in "+m+"m";
  }
  /* Keeps countdowns and LIVE badges current without re-rendering the board. */
  function tick(){
    var now=Date.now();
    [].forEach.call(document.querySelectorAll("[data-count]"),function(el){
      var ms=Number(el.getAttribute("data-count"));
      var timed=el.getAttribute("data-timed")==="1";
      var txt=countdownText({at:new Date(ms),timed:timed});
      el.textContent=txt; el.hidden=!txt;
      el.classList.toggle("live",txt==="Live now");
    });
    [].forEach.call(document.querySelectorAll("[data-live]"),function(el){
      var ms=Number(el.getAttribute("data-live"));
      el.hidden=!(now>=ms&&now<ms+GAME_LEN);
    });
  }

  /* ---------- games that are film for two Tulane opponents ---------- */
  var OPPWEEK={};
  function indexOpponents(){
    OPPWEEK={};
    DATA.weeks.forEach(function(w){ if(w.site!=="BYE"&&w.opp) OPPWEEK[w.opp]=w; });
  }
  function alsoScouts(w,g){
    if(w.post) return null;
    var other=OPPWEEK[g.opp];
    if(!other||other.week===w.week) return null;
    var tk=tulaneKick(other), gk=kickoff(g.date,g.t);
    if(!tk||!gk) return null;
    if(tk.at.getTime()+GAME_LEN<Date.now()) return null;      /* already played Tulane */
    if(gk.at.getTime()>=tk.at.getTime()) return null;         /* game is after they play us */
    return other;
  }
  function shortName(n){
    var map={"South Florida":"USF","North Texas":"UNT","Southern Miss":"USM","Kansas State":"K-State","South Alabama":"USA"};
    return map[n]||n;
  }
  function alsoChip(w,g,cls){
    var o=alsoScouts(w,g); if(!o) return "";
    var logo=LOGOS[o.opp];
    var tip="2-for-1: this game is film for "+w.opp+" (Wk "+w.week+") and "+o.opp+" (Wk "+o.week+")";
    return '<span class="also '+(cls||"")+'" title="'+esc(tip)+'">'
      + (logo?'<img src="'+logo+'" alt="" width="14" height="14">':"")
      + '<span class="also-t">Also '+esc(shortName(o.opp))+' <b>Wk '+o.week+'</b></span>'
      + '<span class="also-m">Wk '+o.week+'</span></span>';
  }

  /* Update just the touched row, its card and the totals, so focus and scroll survive. */
  function patch(box){
    if(box.closest("#weekroot")||box.closest("#packroot")) return listPatch(box);
    if(onlyLeft) return render();
    var card=box.closest(".card");
    if(!card){
      var r0=box.closest(".row");
      if(r0){ var bx0=[].slice.call(r0.querySelectorAll(".box")); r0.classList.toggle("rdone",bx0.every(function(i){ return i.checked; })); syncAllButtons(r0); }
      updateTotals(); renderWorkload(); return;
    }
    var w=weekByKey(card.querySelector(".chead").getAttribute("data-wk"));
    if(!w) return render();
    var row=box.closest(".row");
    if(row){
      var all=[].slice.call(row.querySelectorAll(".box"));
      row.classList.toggle("rdone", all.length>0 && all.every(function(i){ return i.checked; }));
    }
    var tot=weekTotal(w), dn=weekDone(w), complete=tot>0&&dn===tot;
    var c=card.querySelector(".count");
    if(c){ c.innerHTML="<b>"+dn+"</b>/"+tot; if(!RM){ c.classList.remove("bump"); void c.offsetWidth; c.classList.add("bump"); } }
    var lv=dueLevel(w); if(lv) card.setAttribute("data-due",lv); else card.removeAttribute("data-due");
    var p=card.querySelector(".pill");
    if(p){
      p.className="pill "+(complete?"p-done":"p-part");
      p.textContent=complete?"All pulled":(tot-dn)+" left";
    }
    card.classList.toggle("done",complete);
    var hd=card.querySelector(".chead");
    if(hd) hd.style.setProperty("--pct",(tot?Math.round(dn/tot*100):0)+"%");
    updateTotals();
    renderWorkload();
    syncAllButtons(row);
  }

  function countdownSpan(w){
    var nx=upcomingWeeks()[0];
    if(!nx||nx.week!==w.week) return "";          /* only the next Tulane game */
    var k=tulaneKick(w); if(!k) return "";
    var txt=countdownText(k);
    return '<span class="count-down'+(txt==="Live now"?" live":"")+'" data-count="'+k.at.getTime()+'" data-timed="'+(k.timed?1:0)+'"'+(txt?"":" hidden")+'>'+esc(txt)+'</span>';
  }

  /* ---------- how far behind: shared by the cards, next 3, and the spotlight ---------- */
  function behind(w){
    var k=tulaneKick(w); if(!k) return null;
    var days=Math.max(0,Math.ceil((k.at.getTime()-Date.now())/86400000));
    var left=0, ready=0, future=0, cutsLeft=0;
    w.games.forEach(function(g){
      if(!g.ha) return;
      var n=COLS.filter(function(c){ return !STATE.checks[idFor(w,g,c[0])]; }).length;
      if(!n) return;
      left++; cutsLeft+=n;
      if(played(g)) ready++; else future++;
    });
    var due=dueAt(w), hrs=due?(due.getTime()-Date.now())/3600000:null;
    /* red: due within a day or late; gold: due within 4 days */
    var level=cutsLeft===0||hrs===null?"ok":hrs<=24?"hot":hrs<=96?"warm":"ok";
    var perDay=cutsLeft&&hrs>0?Math.ceil(cutsLeft/Math.max(1,hrs/24)):0;
    return {k:k,days:days,left:left,ready:ready,future:future,cutsLeft:cutsLeft,level:level,due:due,hrs:hrs,perDay:perDay};
  }
  /* Film goal: every cutup for an opponent done by Monday 8:00 AM CT of game week. */
  var DUE_HOUR=8;
  function dueAt(w){
    var p=parseDay(w.date); if(!p) return null;
    var d=new Date(Date.UTC(p.y,p.mo,p.d)); var back=(d.getUTCDay()+6)%7;   /* days since Monday */
    d.setUTCDate(d.getUTCDate()-back);
    return ctDate(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate(),DUE_HOUR,0);
  }
  function dueText(b){
    if(!b||!b.due) return "";
    var d=b.due.toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric",timeZone:"America/Chicago"});
    return d+", 8 AM";
  }
  function paceText(b){
    if(!b) return "";
    if(!b.cutsLeft) return "All pulled";
    if(b.hrs<=0) return "Past due";
    return b.perDay+" a day";
  }
  /* Colored bar on each upcoming card: green on track, gold getting close, red due now. */
  function dueLevel(w){
    if(w.post||!weekTotal(w)) return "";
    var k=tulaneKick(w); if(!k||k.at.getTime()+GAME_LEN<Date.now()) return "";
    var b=behind(w); if(!b||b.left===0) return "";
    return b.level;
  }
  function dayName(k){
    try{ return k.at.toLocaleDateString("en-US",{weekday:"short",timeZone:"America/Chicago"}); }catch(e){ return ""; }
  }
  /* ---------- header spotlight + phone quick bar: the next Tulane game ---------- */
  function renderSpot(){
    var spot=document.getElementById("spot"), quick=document.getElementById("quickGo");
    var w=upcomingWeeks()[0];
    if(!w){ if(spot) spot.hidden=true; var qq=document.getElementById("quick"); if(qq) qq.hidden=true; return; }
    var b=behind(w), k=b.k, txt=countdownText(k), badge=LOGOS[w.opp];
    var name=(w.site==="A"?"at ":w.site==="N"?"vs ":"vs ")+esc(w.opp);
    if(spot){
      spot.hidden=false; spot.setAttribute("data-jump",w.week);
      spot.style.setProperty("--team",w.c1||"#888");
      spot.innerHTML='<span class="spot-lbl">Next up \u00b7 Week '+esc(w.week)+'</span>'
        + '<span class="spot-main">'+(badge?'<img src="'+badge+'" alt="" width="34" height="34">':"")+'<b>'+name+'</b></span>'
        + '<span class="spot-when">'+[dayName(k)+" "+esc(w.date),esc(w.t||"Time TBD"),esc(w.tv||"")].filter(Boolean).join(" \u00b7 ")+'</span>'
        + '<span class="spot-count'+(txt==="Live now"?" live":"")+'" data-count="'+k.at.getTime()+'" data-timed="'+(k.timed?1:0)+'"'+(txt?"":" hidden")+'>'+esc(txt)+'</span>'
        + '<span class="spot-left">'+(b.left?b.left+(b.left===1?" game":" games")+" still to cut":"All film pulled")+'</span>';
    }
    if(quick){
      document.getElementById("quick").hidden=false;
      quick.setAttribute("data-jump",w.week);
      quick.innerHTML=(badge?'<img src="'+badge+'" alt="" width="30" height="30">':"")
        + '<span class="q-txt"><b>Next: '+name+'</b><small>'+(b.cutsLeft?b.cutsLeft+(b.cutsLeft===1?" cutup":" cutups")+" \u00b7 "+(b.hrs<=0?"past due":"due "+dueText(b)):"All pulled")+'</small></span><span class="q-go">Go</span>';
    }
  }

  function renderPace(){
    var el=document.getElementById("pace"); if(!el) return;
    var w=upcomingWeeks().filter(function(x){ return weekTotal(x)>0; })[0];
    if(!w){ el.hidden=true; return; }
    var b=behind(w); el.hidden=false;
    el.className="tot pace pace-"+(b.cutsLeft?b.level:"ok");
    el.innerHTML='<b>'+(b.cutsLeft?(b.hrs<=0?"Late":b.perDay+'<small> / day</small>'):"Done")+'</b>'
      + '<span>'+(b.cutsLeft?(b.hrs<=0?b.cutsLeft+" "+esc(shortName(w.opp))+" cutups past due":"to finish "+esc(shortName(w.opp))+" by "+dueText(b)):esc(shortName(w.opp))+" is all pulled")+'</span>';
  }

  /* ---------- next 3 opponents: how far behind are we ---------- */
  function renderWorkload(){
    renderSpot(); renderPace();
    var box=document.getElementById("ondeck"); if(!box) return;
    var next=upcomingWeeks().slice(0,3);
    if(!next.length){ box.innerHTML=""; return; }
    box.innerHTML=next.map(function(w,i){
      var b=behind(w), badge=LOGOS[w.opp], k=b.k, txt=i===0?countdownText(k):"";
      var lbl=i===0?'Next up \u00b7 <span data-count="'+k.at.getTime()+'" data-timed="'+(k.timed?1:0)+'">'+esc(txt)+'</span>':"Week "+esc(w.week);
      return '<button type="button" class="od od-'+(b.left?b.level:"ok")+'" data-jump="'+w.week+'">'
        + (badge?'<img src="'+badge+'" alt="">':"")
        + '<span><span class="lbl">'+lbl+'</span><b>'+(w.site==="A"?"at ":"")+esc(w.opp)+'</b>'
        + '<small>'+(b.cutsLeft?b.cutsLeft+(b.cutsLeft===1?" cutup":" cutups")+" \u00b7 "+(b.hrs<=0?"past due":paceText(b)):"All pulled")+'</small></span></button>';
    }).join("");
  }

  /* Easter egg: click "Bye Week" for its history. Deliberately looks like plain text. */
  var BYE_TXT="Bye Week", BYE_ALT="This used to be called an open date but got changed to Bye Week at the request of Roscoe Ludena";
  var BYE_EGG='<span class="byeegg">'+BYE_TXT+'</span>';
  document.addEventListener("click",function(e){
    var t=e.target.closest&&e.target.closest(".byeegg"); if(!t) return;
    e.stopPropagation();
    t.textContent=t.textContent===BYE_TXT?BYE_ALT:BYE_TXT;
  },true);
  var PRINT_SVG='<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 6V2.5h7V6M4.5 11.5h-2v-5h11v5h-2M4.5 9.5h7v4h-7z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  var CARET_R='<svg class="rexp" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2 8.5 6 4.5 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var CARET_D='<svg class="caret" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 4.5 6 8.5 10 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var CHECK_SVG='<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.2 5 8.6 9.5 3.6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function boxCells(w,g){
    return COLS.map(function(c){
      var id=idFor(w,g,c[0]);
      var on=!!STATE.checks[id];
      var wt=whoTip(id,c[1]);
      return '<span class="cell"><input type="checkbox" class="box" data-id="'+esc(id)+'"'
           + (on?" checked":"")+(wt?' title="'+esc(wt)+'"':"")
           + ' aria-label="'+esc(c[1]+", "+g.date+" "+g.opp)+'">'
           + whoTag(id,c[1])+'</span>';
    }).join("");
  }
  function rowIds(w,g){ return COLS.map(function(c){ return idFor(w,g,c[0]); }); }
  function allBtn(w,g){
    var ids=rowIds(w,g), done=ids.every(function(id){ return STATE.checks[id]; });
    return '<span class="cell allc"><button class="rowall'+(done?" is-done":"")+'" data-ids="'+esc(ids.join("\n"))+'"'
      + ' title="'+(done?"Clear all 3 for this game":"Mark all 3 done for this game")+'" aria-label="'+(done?"Clear all 3":"Mark all 3 done")+', '+esc(g.date+" "+g.opp)+'">'
      + CHECK_SVG+'<span>All</span></button></span>';
  }
  function detailAll(w,g){
    var ids=rowIds(w,g), done=ids.every(function(id){ return STATE.checks[id]; });
    return '<button class="btn rowall-d rowall'+(done?" is-done":"")+'" data-ids="'+esc(ids.join("\n"))+'">'+(done?"Clear all 3":"Mark all 3 done")+'</button>';
  }
  /* Keep the "All" buttons in a row in step with its boxes. */
  function syncAllButtons(row){
    var game=row&&row.closest?row.closest(".game"):null; if(!game) return;
    [].forEach.call(game.querySelectorAll(".rowall"),function(b){
      var ids=b.getAttribute("data-ids").split("\n");
      var done=ids.every(function(id){ return STATE.checks[id]; });
      b.classList.toggle("is-done",done);
      if(b.classList.contains("rowall-d")) b.textContent=done?"Clear all 3":"Mark all 3 done";
      else b.title=done?"Clear all 3 for this game":"Mark all 3 done for this game";
    });
  }

  function gameRow(w,g,gi){
    var rdone=COLS.every(function(c){ return STATE.checks[idFor(w,g,c[0])]; });
    if(onlyLeft&&rdone) return "";
    var gkey=w.week+"."+gi;
    return '<div class="game'+(openGames[gkey]?" open":"")+'" data-g="'+esc(gkey)+'">'
       + '<div class="row'+(rdone?" rdone":"")+'">'
       + '<span class="rdate">'+esc(g.date)+'</span>'
       + '<span class="ropp"><span class="opw">'+rowMark(g)+'<span class="rtext"><span class="rname">'
       + (g.ha==="A"?"at ":"")+esc(g.opp)+'</span>'
       + (!w.post&&!sameConf(w.opp,g.opp)&&confOf(g.opp)?'<span class="cf">'+esc(confOf(g.opp).name+(confOf(g.opp).lvl==="FCS"?" \u00b7 FCS":""))+'</span>':"")+'</span>'
       + alsoChip(w,g,"also-d")
       + CARET_R
       + '</span>'+phoneSub(g,alsoChip(w,g,"also-p"))+'</span>'
       + kickCell(g)
       + boxCells(w,g)
       + allBtn(w,g)
       + '</div>'
       + detailPanel(w,g).replace(/<\/div>$/,'<div class="fact-act">'+detailAll(w,g)+'</div></div>')
       + '</div>';
  }
  function headRow(w){
    var badge=w&&LOGOS[w.opp];
    return '<div class="rhead"><span class="rh-wk">'+(w&&!w.post?"Wk "+esc(w.week):"Date")+'</span>'
       + '<span class="rh-team">'+(badge?'<img src="'+badge+'" alt="">':"")+(w?esc(w.opp):"Opponent")+'</span><span>Result / Kick</span>'
       + COLS.map(function(c){ return "<span>"+c[1]+"</span>"; }).join("")
       + '<span class="allc">All</span></div>';
  }

  function cardHtml(w){
    var tot=weekTotal(w), dn=weekDone(w);
    var complete=tot>0&&dn===tot;
    if(onlyLeft&&(complete||(tot===0&&!w.post))) return "";
    /* Weeks with no film (opener, bye) are one slim line. */
    if(tot===0&&!w.post){
      var bye=w.site==="BYE";
      return '<section class="slim"><b>Week '+esc(w.week)+'</b>'
        + '<span class="slim-name">'+(bye?BYE_EGG:(w.site==="A"?"at ":"vs ")+esc(w.opp))+' \u00b7 '+esc(w.date)+'</span>'
        + tulResult(w)
        + '<em>'+esc(clean(w.note||"No opponent film."))+'</em></section>';
    }
    /* Finished weeks fold up on their own unless someone opens them. */
    var tk=w.post?null:tulaneKick(w), pastWeek=!!(tk&&tk.at.getTime()+GAME_LEN<Date.now());
    var isShut=Object.prototype.hasOwnProperty.call(shut,String(w.week))?shut[w.week]:(complete||pastWeek);
    var due=dueLevel(w);

    var badge=LOGOS[w.opp], mono=w.mono||"";
    var mark = badge
      ? '<span class="mark"><img src="'+badge+'" alt="" width="36" height="36"></span>'
      : '<span class="mark plain" style="background:'+esc(w.c1||"#888")+';border-color:'+esc(w.c1||"#888")+';--edge:'+esc(w.c2||"#888")+'">'
        + '<span class="mono" style="font-size:'+(mono.length>3?12:mono.length>2?14.5:17)+'px">'+esc(mono)+'</span></span>';

    var siteTag = w.post ? '<span class="site post">'+esc(w.official?"Confirmed":"Possible")+'</span>'
      : w.site==="BYE" ? '<span class="site bye">Bye</span>'
      : '<span class="site'+(w.site==="A"?" away":"")+'">'+(w.site==="A"?"Away":"Home")+'</span>';

    var pill = tot===0 ? '<span class="pill p-wait">'+(w.post?"Waiting on games":"No film")+'</span>'
      : complete ? '<span class="pill p-done">All pulled</span>'
      : '<span class="pill p-part">'+(tot-dn)+' left</span>';

    var body="";
    if(w.post){
      body+='<div class="postbar"><span>'+esc(w.event)+(w.official?" · confirmed opponent":" · possible opponent")
        + (w.addedBy?" · added by "+esc(w.addedBy):"")+'</span>'
        + (w.partial?'<span class="postnote">'+(w.games.length?"Games after they play Tulane are added on the next data refresh.":"Their games are added on the next data refresh.")+'</span>':"")
        + (w.candId?'<button class="btn cand-rm" data-cand="'+w.candId+'">Remove</button>':"")
        + '</div>';
    }
    if(tot===0){
      body+='<div class="note">'+esc(clean(w.note||(w.post?"No games on file yet.":"No opponent film this week.")))+'</div>';
    } else {
      body+=headRow(w);
      w.games.forEach(function(g,gi){
        if(!g.ha){
          if(onlyLeft) return;
          body+='<div class="row open"><span class="rdate">'+esc(g.date)+'</span>'
             +  '<span class="ropp">'+BYE_EGG+'</span><span></span>'
             +  '<span></span><span></span><span></span><span class="allc"></span></div>';
          return;
        }
        body+=gameRow(w,g,gi);
      });
    }

    var sub=[];
    if(w.rec) sub.push('<b>'+esc(w.rec.replace("-","\u2013"))+'</b>');
    if(w.post) sub.push(esc(w.event)+(w.official?"":" (possible)"));
    else if(confLabel(w.opp)) sub.push(esc(confLabel(w.opp)));
    var wk=tulaneKick(w);
    if(w.date) sub.push((wk&&!w.post?dayName(wk)+", ":"")+esc(String(w.date).replace(/\s*\(.*?\)/,"")));
    if(w.t) sub.push(esc(w.t)); if(w.tv) sub.push(esc(w.tv));
    var bw=!w.post&&!complete&&tot?behind(w):null;
    if(bw&&bw.due&&bw.k&&bw.k.at.getTime()+GAME_LEN>Date.now()) sub.push('<span class="duetag">Film due '+dueText(bw)+'</span>');
    return '<section class="card week'+(complete?" done":"")+(isShut?" shut":"")+(w.post?" postcard":"")+'"'+(due?' data-due="'+due+'"':"")
       + ' style="--team:'+esc(w.c1||"#555")+';--team2:'+esc(w.c2||"#999")+'">'
       + '<button class="chead wbar" data-wk="'+esc(w.week)+'" aria-expanded="'+(isShut?"false":"true")+'"'
       + ' style="--team:'+esc(w.c1||"#555")+';--team2:'+esc(w.c2||"#999")+';--pct:'+(tot?Math.round(dn/tot*100):0)+'%'
       + (badge?";--logo:url("+badge+")":"")+'">'
       + '<span class="wnum"><small>'+(w.post?"Post":"Week")+'</small>'+(w.post?"&#9733;":esc(w.week))+'</span>'
       + mark
       + '<span class="who"><span class="opp">'+(!w.post&&w.site==="A"?"at ":"")+esc(w.opp)+'</span>'
       + '<span class="when">'+sub.join(" \u00b7 ")+(w.post?"":countdownSpan(w))+tulResult(w)+'</span></span>'
       + '<span class="cstat">'
       + (tot?'<span class="count"><b>'+dn+'</b>/'+tot+'</span>':"")
       + pill
       + (tot?'<span class="wprint" role="button" tabindex="0" data-print="'+esc(w.week)+'" title="Print just this week" aria-label="Print just this week">'+PRINT_SVG+'</span>':"")
       + CARET_D
       + "</span></button>"
       + '<div class="cbody">'+body+"</div></section>";
  }

  function render(){
    updateTotals();
    renderWorkload();
    syncViewButtons();
    if(byGame){ renderByGame(); tick(); return; }
    var html="";
    DATA.weeks.forEach(function(w){ html+=cardHtml(w); });
    var pw=postWeeks(), posthtml="";
    pw.forEach(function(w){ posthtml+=cardHtml(w); });
    html+='<div class="posthead"><div><h2>Postseason</h2><p>Conference championship and bowl opponents. Add every team you might face so the staff can start on all of them.</p></div>'
      + '<button class="btn go" id="candAdd">Add possible opponents</button></div>'
      + (posthtml||(pw.length?"":'<p class="postempty">No postseason opponents yet.</p>'));
    if(!html) html='<p class="foot" style="margin-top:22px">Every cutup is pulled. Nothing left on the board.</p>';
    root.innerHTML=html;
    tick();
  }

  /* ---------- by game: each game once, with every Tulane opponent it is film for ---------- */
  var twoOnly=false;
  function renderByGame(){
    var now=Date.now(), map={}, order=[];
    allWeeks().forEach(function(w){
      if(w.site==="BYE") return;
      if(!w.post){
        var tk=tulaneKick(w); if(tk&&tk.at.getTime()+GAME_LEN<now) return;   /* opponent already played */
      }
      w.games.forEach(function(g,gi){
        if(!g.ha) return;
        var teams=[w.opp,g.opp].sort();
        var key=g.date+"|"+teams.join("|");
        if(!map[key]){ map[key]={key:key,date:g.date,g:g,w:w,home:g.ha==="H"?w.opp:g.opp,away:g.ha==="H"?g.opp:w.opp,uses:[]}; order.push(key); }
        /* one line per Tulane opponent; a postseason card for a team already on the
           regular schedule shares the same checkmarks, so it is not listed twice */
        if(!map[key].uses.some(function(u){ return u.w.opp===w.opp; }))
          map[key].uses.push({w:w,g:g,gi:gi});
      });
    });
    var items=order.map(function(k){ return map[k]; }).filter(function(it){
      if(twoOnly&&it.uses.length<2) return false;
      if(onlyLeft){
        var all=it.uses.every(function(u){ return COLS.every(function(c){ return STATE.checks[idFor(u.w,u.g,c[0])]; }); });
        if(all) return false;
      }
      return true;
    });
    items.sort(function(a,b){
      var ka=kickoff(a.date,a.g.t), kb=kickoff(b.date,b.g.t);
      return (ka?ka.at.getTime():0)-(kb?kb.at.getTime():0);
    });
    var html='<div class="bg-bar"><label class="bg-opt"><input type="checkbox" id="twoOnly"'+(twoOnly?" checked":"")+'> Only games that are film for 2+ opponents</label>'
      + '<span class="bg-count">'+items.length+' games</span></div>';
    if(!items.length) html+='<p class="postempty">Nothing to show.</p>';
    items.forEach(function(it){
      var g=it.g;
      html+='<article class="bg-item'+(it.uses.length>1?" multi":"")+'">'
        + '<div class="bg-head"><span class="rdate">'+esc(it.date)+'</span>'
        + '<span class="bg-match">'+logoMini(it.away)+esc(it.away)+' <i>at</i> '+logoMini(it.home)+esc(it.home)+'</span>'
        + (it.uses.length>1?'<span class="bg-multi">Film for '+it.uses.length+' opponents</span>':"")
        + kickCell(g)+'</div>';
      it.uses.forEach(function(u){
        var done=COLS.every(function(c){ return STATE.checks[idFor(u.w,u.g,c[0])]; });
        html+='<div class="game bg-use"><div class="row bg-row'+(done?" rdone":"")+'">'
          + '<span class="bg-for">For</span>'
          + '<button class="bg-jump" data-jump="'+esc(u.w.week)+'">'+logoMini(u.w.opp)+'<b>'+esc(u.w.opp)+'</b> <span>'+(u.w.post?esc(u.w.event):"Wk "+u.w.week)+'</span></button>'
          + boxCells(u.w,u.g)
          + allBtn(u.w,u.g)
          + '</div></div>';
      });
      html+='</article>';
    });
    root.innerHTML=html;
    var t=document.getElementById("twoOnly");
    if(t) t.addEventListener("change",function(){ twoOnly=this.checked; render(); });
  }
  function logoMini(team){
    var l=LOGOS[team];
    return l?'<img class="lm" src="'+l+'" alt="" width="16" height="16">':"";
  }
  function syncViewButtons(){
    var b=document.getElementById("fView");
    if(b){ b.setAttribute("aria-pressed",String(byGame)); b.textContent=byGame?"By opponent":"By game"; }
    var s=document.getElementById("fShut"); if(s) s.disabled=byGame;
  }

  /* ---------- sign-in (shared staff passcode) ---------- */
  var dlg=document.getElementById("login");
  var pending=null;
  function askLogin(){
    return new Promise(function(resolve){
      pending=resolve;
      document.getElementById("lErr").textContent="";
      document.getElementById("lName").value=lsGet("fpb_who")||"";
      document.getElementById("lCode").value="";
      if(dlg.showModal) dlg.showModal(); else dlg.setAttribute("open","");
      setTimeout(function(){ document.getElementById(lsGet("fpb_who")?"lCode":"lName").focus(); },30);
    });
  }
  document.getElementById("lForm").addEventListener("submit",async function(e){
    e.preventDefault();
    var name=document.getElementById("lName").value.trim();
    var code=document.getElementById("lCode").value;
    var err=document.getElementById("lErr");
    if(!name){ err.textContent="Enter your name or initials."; return; }
    if(!code){ err.textContent="Enter the staff passcode."; return; }
    err.textContent="Checking…";
    var r=await sb.rpc("check_code",{p_code:code});
    if(r.error){ err.textContent="Could not reach the board. Check your connection."; return; }
    if(!r.data){ err.textContent="That passcode is not right."; return; }
    lsSet("fpb_code",code); lsSet("fpb_who",name);
    dlg.close ? dlg.close() : dlg.removeAttribute("open");
    if(pending){ pending(true); pending=null; }
  });
  document.getElementById("lCancel").addEventListener("click",function(){
    dlg.close ? dlg.close() : dlg.removeAttribute("open");
    if(pending){ pending(false); pending=null; }
  });

  /* ---------- saving, with an offline queue ---------- */
  /* If the connection drops, changes wait on this device and send when it is back. */
  var QKEY="fpb_queue";
  function qGet(){ try{ return JSON.parse(lsGet(QKEY)||"[]"); }catch(e){ return []; } }
  function qSet(q){ lsSet(QKEY,JSON.stringify(q)); showQueue(); }
  function enqueue(id,on){
    var q=qGet().filter(function(x){ return x.id!==id; });
    q.push({id:id,on:on,who:lsGet("fpb_who")||"",at:new Date().toISOString()});
    qSet(q);
  }
  function showQueue(){
    var n=qGet().length;
    if(n){ setSync("busy",n+" waiting to sync"); }
  }
  function netError(err){
    var m=String((err&&(err.message||err.details))||"");
    return !navigator.onLine||/fetch|network|timeout|load failed|abort/i.test(m)||(err&&err.status===0);
  }
  var flushing=false;
  async function flushQueue(){
    if(flushing||!sb) return;
    var q=qGet(); if(!q.length) return;
    if(!navigator.onLine){ showQueue(); return; }
    flushing=true;
    try{
      while(q.length){
        var x=q[0];
        var r=await sb.rpc("set_check",{p_code:lsGet("fpb_code"),p_id:x.id,p_on:x.on,p_who:x.who});
        if(r.error){
          if(/passcode/i.test(r.error.message||"")){
            lsDel("fpb_code");
            showNotice("The staff passcode changed while you were offline. Tick any box and sign in again to send your "+q.length+" saved change"+(q.length===1?"":"s")+".");
          }
          break;
        }
        q.shift(); qSet(q);
      }
    } finally { flushing=false; }
    if(!qGet().length){ hideNotice(); setSync("ok","Live"); flash("Offline changes synced."); }
  }
  window.addEventListener("online",flushQueue);
  window.addEventListener("offline",function(){ setSync("off","Offline · changes will wait"); });

  /* Returns true when saved or safely queued. */
  async function saveCheck(id,on){
    if(!lsGet("fpb_code")){
      var ok=await askLogin();
      if(!ok) return false;
    }
    if(!navigator.onLine||qGet().length){ enqueue(id,on); flushQueue(); return true; }
    setSync("busy","Saving…");
    var r;
    try{ r=await sb.rpc("set_check",{p_code:lsGet("fpb_code"),p_id:id,p_on:on,p_who:lsGet("fpb_who")||""}); }
    catch(e){ r={error:e}; }
    if(r.error){
      if(/passcode/i.test(r.error.message||"")){
        lsDel("fpb_code");
        setSync("off","Sign in needed");
        showNotice("The staff passcode has changed. Tick the box again and enter the new one.");
        return false;
      }
      if(netError(r.error)){ enqueue(id,on); return true; }
      setSync("off","Not saved");
      showNotice("That change did not save. Tick the box again.");
      return false;
    }
    hideNotice(); setSync("ok","Live");
    return true;
  }

  /* ---------- live data ---------- */
  function applyRow(row){
    if(row.checked){ STATE.checks[row.id]=1; STATE.who[row.id]={by:row.updated_by||"",at:row.updated_at||null}; }
    else { delete STATE.checks[row.id]; delete STATE.who[row.id]; }
  }
  async function loadChecks(){
    var r=await sb.from("checks").select("id,checked,updated_by,updated_at");
    if(r.error) throw r.error;
    STATE.checks={}; STATE.who={};
    (r.data||[]).forEach(applyRow);
    /* changes still waiting on this device win over the server copy */
    qGet().forEach(function(x){ applyRow({id:x.id,checked:x.on,updated_by:x.who,updated_at:x.at}); });
  }
  function initials(name){
    name=String(name||"").trim();
    if(!name) return "";
    if(name.length<=3&&name.indexOf(" ")<0) return name.toUpperCase();
    var parts=name.split(/[\s.]+/).filter(Boolean);
    if(parts.length===1) return parts[0].slice(0,2).toUpperCase();
    return (parts[0][0]+parts[parts.length-1][0]).toUpperCase();
  }
  function shortDate(iso){
    if(!iso) return "";
    var d=new Date(iso); if(isNaN(d)) return "";
    return d.toLocaleDateString("en-US",{month:"short",day:"numeric"})+" "+d.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit"});
  }
  function whoTip(id,label){
    var w=STATE.checks[id]?STATE.who[id]:null;
    if(!w||!w.by) return "";
    if(isListId(id)) return "Done by "+whoName(w.by)+(w.at?" · "+shortDate(w.at):"");
    return (label?label+" pulled by ":"Pulled by ")+whoName(w.by)+(w.at?" · "+shortDate(w.at):"");
  }
  function whoTag(id,label){
    var w=STATE.checks[id]?STATE.who[id]:null;
    if(!w||!w.by) return '<span class="who-tag" aria-hidden="true"></span>';
    var tip=isListId(id)?("Done by "+whoName(w.by)+(w.at?" · "+shortDate(w.at):""))
      :((label?label+" pulled by ":"Pulled by ")+whoName(w.by)+(w.at?" · "+shortDate(w.at):""));
    return '<span class="who-tag on'+whoTagCls(w.by)+'" title="'+esc(tip)+'">'+esc(whoTagText(w.by))+'</span>';
  }
  function refreshTag(box){
    var cell=box.parentNode; if(!cell) return;
    var old=cell.querySelector(".who-tag");
    var label=(box.getAttribute("aria-label")||"").split(",")[0];
    var tmp=document.createElement("span"); tmp.innerHTML=whoTag(box.getAttribute("data-id"),label);
    if(old) cell.replaceChild(tmp.firstChild,old); else cell.appendChild(tmp.firstChild);
    var wt=whoTip(box.getAttribute("data-id"),label); if(wt) box.title=wt; else box.removeAttribute("title");
  }
  /* The same game can show twice (for example a postseason card), so update every copy. */
  function boxesFor(id){
    return [].filter.call(document.querySelectorAll("input.box"),function(b){ return b.getAttribute("data-id")===id; });
  }

  function setLocal(id,on,by){
    if(on){ STATE.checks[id]=1; STATE.who[id]={by:by||lsGet("fpb_who")||"",at:new Date().toISOString()}; }
    else { delete STATE.checks[id]; delete STATE.who[id]; }
    var bs=boxesFor(id);
    if(onlyLeft&&!isListId(id)){ render(); return; }
    if(bs.length) bs.forEach(function(bx){ bx.checked=!!on; refreshTag(bx); patch(bx); });
    else { updateTotals(); renderWorkload(); }
  }
  async function change(id,on){
    var prevBy=STATE.who[id]&&STATE.who[id].by;
    var was=!!STATE.checks[id];
    if(was===!!on) return true;
    setLocal(id,on);
    var ok=await saveCheck(id,on);
    if(ok&&on) setLocal(id,true);
    if(!ok) setLocal(id,was,prevBy);
    return ok;
  }
  /* Several boxes at once (the "All" button, undo of an "All"). Returns what actually changed. */
  async function changeMany(items){
    var done=[];
    for(var i=0;i<items.length;i++){
      var it=items[i];
      if(!!STATE.checks[it.id]===!!it.to) continue;
      if(await change(it.id,it.to)) done.push(it); else break;
    }
    return done;
  }

  /* ---------- undo / redo (this device, this visit) ---------- */
  var UNDO=[], REDO=[];   /* each entry is a list of {id,to} */
  function entryLabel(e){
    if(e.length===1) return item(e[0].id);
    return item(e[0].id).replace(/, [^,]+$/,"")+", all "+e.length;
  }
  function syncUndoButtons(){
    var u=document.getElementById("fUndo"), r=document.getElementById("fRedo");
    var mu=document.getElementById("mUndo"), mr=document.getElementById("mRedo");
    if(mu) mu.disabled=!UNDO.length; if(mr) mr.disabled=!REDO.length;
    var dock=document.getElementById("undoDock"); if(dock) dock.classList.toggle("has",!!(UNDO.length||REDO.length));
    if(u){ u.disabled=!UNDO.length; u.title=UNDO.length?"Undo: "+entryLabel(UNDO[UNDO.length-1])+" (Ctrl+Z)":"Nothing to undo"; }
    if(r){ r.disabled=!REDO.length; r.title=REDO.length?"Redo: "+entryLabel(REDO[REDO.length-1])+" (Ctrl+Y)":"Nothing to redo"; }
  }
  function remember(entry){ if(!entry.length) return; UNDO.push(entry); if(UNDO.length>100) UNDO.shift(); REDO=[]; syncUndoButtons(); }
  async function undo(){
    var e=UNDO.pop(); if(!e) return;
    syncUndoButtons();
    var back=e.slice().reverse().map(function(x){ return {id:x.id,to:!x.to}; });
    var did=await changeMany(back);
    if(did.length===back.length){ REDO.push(e); flash("Undone: "+entryLabel(e)+"."); } else UNDO.push(e);
    syncUndoButtons();
  }
  async function redo(){
    var e=REDO.pop(); if(!e) return;
    syncUndoButtons();
    var did=await changeMany(e);
    if(did.length===e.length){ UNDO.push(e); flash("Redone: "+entryLabel(e)+"."); } else REDO.push(e);
    syncUndoButtons();
  }
  function item(id){ return describe(id,true).replace(/^checked /,""); }
  function describe(id,on){
    if(isWeekId(id)){
      var q=String(id).split("|"), hit=WK_LOOK[q[2]+"|"+q[3]];
      var dp=q[1].split("-"), wd=new Date(+dp[0],+dp[1]-1,+dp[2]);
      return (on?"checked ":"unchecked ")+(hit?hit.t+" \u00b7 "+WK_DAYS[hit.d].n+", week of "+ckNice(wd):"a checklist item");
    }
    if(isPackId(id)){
      var z=String(id).split("|"), lp=PACKS[z[1]], nm="";
      var gw=(z[2]==="season")?null:weekByNum(Number(z[2].slice(1)));
      var tail=(lp?" \u00b7 "+lp.name:"")+(gw?" \u00b7 "+(gw.site==="A"?"at ":"vs ")+gw.opp:"");
      if(lp) pkAllGroups(lp).forEach(function(gr){ gr.items.forEach(function(it,ix){
        var pth=pkPath(gr,ix);
        if(ckSlug(gr.g)===z[3]&&ckSlug(pth)===z[4]) nm=pth.split(" / ").join(" \u00b7 ")+tail; }); });
      return (on?"packed ":"unpacked ")+(nm||"a packing item");
    }
    var p=String(id).split("|"), who, date, opp, col;
    if(p[0]==="p"){ who=p[1]+" (postseason)"; date=p[2]; opp=p[3]; col=p[4]; }
    else { var w=weekByNum(Number(p[0].slice(1))); who=w?w.opp:""; date=p[1]; opp=p[2]; col=p[3]; }
    var c=(COLS.filter(function(x){ return x[0]===col; })[0]||[0,col])[1];
    return (on?"checked ":"unchecked ")+(who?who+" film, ":"")+date+" "+opp+", "+c;
  }
  var flashTimer=null;
  function flash(msg){
    var t=document.getElementById("toast"); if(!t) return;
    t.textContent=msg; t.hidden=false;
    clearTimeout(flashTimer); flashTimer=setTimeout(function(){ t.hidden=true; },2600);
  }

  root.addEventListener("change",async function(e){
    var b=e.target;
    if(!b.classList||!b.classList.contains("box")) return;
    var id=b.getAttribute("data-id"), on=b.checked;
    if(await change(id,on)) remember([{id:id,to:on}]);
  });

  async function toggleAll(btn){
    var ids=btn.getAttribute("data-ids").split("\n");
    var allDone=ids.every(function(id){ return STATE.checks[id]; });
    var items=ids.map(function(id){ return {id:id,to:!allDone}; });
    var did=await changeMany(items);
    remember(did);
    if(did.length) flash((allDone?"Cleared ":"Marked done: ")+entryLabel(did)+".");
  }

  root.addEventListener("click",function(e){
    if(!e.target.closest) return;
    if(e.target.classList&&e.target.classList.contains("box")) return;
    var pr=e.target.closest(".wprint"); if(pr){ e.stopPropagation(); printWeek(pr.getAttribute("data-print")); return; }
    var ra=e.target.closest(".rowall"); if(ra){ e.stopPropagation(); toggleAll(ra); return; }
    var rm=e.target.closest(".cand-rm"); if(rm){ removeCandidate(rm.getAttribute("data-cand")); return; }
    if(e.target.closest("#candAdd")){ openCandidates(); return; }
    if(e.target.closest("[data-jump]")) return;   /* handled below */
    var r=e.target.closest(".row");
    if(r&&!r.classList.contains("open")&&!r.classList.contains("bg-row")){
      var game=r.parentNode;
      if(game&&game.classList.contains("game")){
        var k=game.getAttribute("data-g");
        openGames[k]=!openGames[k];
        game.classList.toggle("open",!!openGames[k]);
        return;
      }
    }
    var h=e.target.closest(".chead");
    if(!h) return;
    var wk=h.getAttribute("data-wk"), card=h.closest(".card"), body=card&&card.querySelector(".cbody");
    var closing=!card.classList.contains("shut");
    shut[wk]=closing;
    h.setAttribute("aria-expanded",String(!closing));
    if(RM||!body||!body.animate){ card.classList.toggle("shut",closing); return; }
    if(closing){
      body.style.overflow="hidden";
      var a=body.animate([{height:body.offsetHeight+"px",opacity:1},{height:"0px",opacity:0}],{duration:190,easing:"cubic-bezier(.4,0,.2,1)"});
      a.onfinish=function(){ card.classList.add("shut"); body.style.overflow=""; };
    } else {
      card.classList.remove("shut");
      body.style.overflow="hidden";
      var hh=body.offsetHeight;
      var b2=body.animate([{height:"0px",opacity:0},{height:hh+"px",opacity:1}],{duration:240,easing:"cubic-bezier(.2,.8,.3,1)"});
      b2.onfinish=function(){ body.style.overflow=""; };
    }
  });

  /* ---------- keyboard: arrows move between boxes, Space ticks, A = whole game ---------- */
  root.addEventListener("keydown",function(e){
    var b=e.target;
    if(!b.classList||!b.classList.contains("box")) return;
    var k=e.key;
    if(k==="a"||k==="A"){
      var row=b.closest(".row"), ra=row&&row.querySelector(".rowall");
      if(ra){ e.preventDefault(); toggleAll(ra); }
      return;
    }
    if(["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].indexOf(k)<0) return;
    var rows=[].filter.call(root.querySelectorAll(".row"),function(r){ return r.querySelector("input.box")&&r.offsetParent!==null; });
    var row=b.closest(".row"), ri=rows.indexOf(row);
    var boxes=[].slice.call(row.querySelectorAll("input.box")), ci=boxes.indexOf(b), target=null;
    if(k==="ArrowRight") target=boxes[ci+1]||(rows[ri+1]&&rows[ri+1].querySelectorAll("input.box")[0]);
    if(k==="ArrowLeft"){ var pr=rows[ri-1]; target=boxes[ci-1]||(pr&&pr.querySelectorAll("input.box")[2]); }
    if(k==="ArrowDown"&&rows[ri+1]) target=rows[ri+1].querySelectorAll("input.box")[ci];
    if(k==="ArrowUp"&&rows[ri-1]) target=rows[ri-1].querySelectorAll("input.box")[ci];
    if(target){ e.preventDefault(); target.focus(); target.scrollIntoView({block:"nearest"}); }
  });

  document.getElementById("fLeft").addEventListener("click",function(){
    onlyLeft=!onlyLeft;
    this.setAttribute("aria-pressed",String(onlyLeft));
    this.textContent=onlyLeft?"Show everything":"Only what's left";
    render();
  });
  document.getElementById("fShut").addEventListener("click",function(){
    allShut=!allShut;
    allWeeks().forEach(function(w){ shut[w.week]=allShut; });
    this.textContent=allShut?"Expand all":"Collapse all";
    render();
  });
  document.getElementById("fView").addEventListener("click",function(){
    byGame=!byGame; render(); window.scrollTo(0,0);
  });
  document.getElementById("fPrint").addEventListener("click",function(){ window.print(); });
  /* Print a single opponent's call sheet */
  function printWeek(wk){
    var h=root.querySelector('.chead[data-wk="'+wk+'"]'); if(!h) return;
    var card=h.closest(".card"), wasShut=card.classList.contains("shut");
    card.classList.remove("shut"); card.classList.add("print-this"); document.body.classList.add("print-one");
    var done=function(){
      document.body.classList.remove("print-one"); card.classList.remove("print-this");
      if(wasShut) card.classList.add("shut");
      window.removeEventListener("afterprint",done);
    };
    window.addEventListener("afterprint",done);
    window.print();
    setTimeout(function(){ if(document.body.classList.contains("print-one")&&!window.matchMedia("print").matches) done(); },1500);
  }
  root.addEventListener("keydown",function(e){
    var pr=e.target.closest&&e.target.closest(".wprint");
    if(pr&&(e.key==="Enter"||e.key===" ")){ e.preventDefault(); e.stopPropagation(); printWeek(pr.getAttribute("data-print")); }
  },true);
  document.getElementById("fExport").addEventListener("click",function(){
    var rows=[["card","game_date","game_opponent","cutup","pulled_by","pulled_at"]];
    Object.keys(STATE.checks).sort().forEach(function(id){
      var p=id.split("|"), w=STATE.who[id]||{};
      if(p[0]==="p") rows.push([p[1]+" (postseason)",p[2],p[3],p[4],w.by||"",w.at||""]);
      else { var wk=weekByNum(Number(p[0].slice(1))); rows.push([(wk?wk.opp:"")+" (Wk "+p[0].slice(1)+")",p[1],p[2],p[3],w.by||"",w.at||""]); }
    });
    var csv=rows.map(function(r){ return r.map(function(v){ return '"'+String(v).replace(/"/g,'""')+'"'; }).join(","); }).join("\r\n");
    var a=document.createElement("a");
    a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));
    a.download="film-board-checkmarks-"+new Date().toISOString().slice(0,10)+".csv";
    document.body.appendChild(a); a.click(); a.remove();
  });
  document.getElementById("fUndo").addEventListener("click",undo);
  document.getElementById("fRedo").addEventListener("click",redo);
  document.getElementById("mUndo").addEventListener("click",undo);
  document.getElementById("mRedo").addEventListener("click",redo);
  document.addEventListener("keydown",function(e){
    var tag=(e.target&&e.target.tagName)||"";
    if(tag==="INPUT"&&e.target.type!=="checkbox"||tag==="TEXTAREA") return;
    if(!(e.ctrlKey||e.metaKey)) return;
    var k=e.key.toLowerCase();
    if(k==="z"&&!e.shiftKey){ e.preventDefault(); undo(); }
    else if(k==="y"||(k==="z"&&e.shiftKey)){ e.preventDefault(); redo(); }
  });
  document.addEventListener("click",function(e){
    var j=e.target.closest&&e.target.closest("[data-jump]"); if(!j) return;
    var wk=j.getAttribute("data-jump"); shut[wk]=false; byGame=false; render();
    var h=root.querySelector('.chead[data-wk="'+wk+'"]');
    if(h) h.scrollIntoView({behavior:"smooth",block:"start"});
  });

  /* ---------- history: every change by anyone, with undo ---------- */
  var hdlg=document.getElementById("hist");
  document.getElementById("fHist").addEventListener("click",openHistory);
  document.getElementById("hClose").addEventListener("click",function(){ hdlg.close?hdlg.close():hdlg.removeAttribute("open"); });
  async function openHistory(){
    var list=document.getElementById("hList");
    list.innerHTML='<p class="h-empty">Loading…</p>';
    if(hdlg.showModal) hdlg.showModal(); else hdlg.setAttribute("open","");
    if(!sb){ list.innerHTML='<p class="h-empty">Not connected.</p>'; return; }
    var r=await sb.from("check_log").select("id,check_id,checked,who,at").order("at",{ascending:false}).limit(80);
    if(r.error){ list.innerHTML='<p class="h-empty">History needs the one-time database update (database-update.sql).</p>'; return; }
    if(!r.data.length){ list.innerHTML='<p class="h-empty">No changes yet.</p>'; return; }
    list.innerHTML=r.data.map(function(x){
      var current=!!STATE.checks[x.check_id];
      var can=current===!!x.checked;
      return '<div class="h-row"><span class="h-who" title="'+esc(x.who||"")+'">'+esc(initials(x.who)||"?")+'</span>'
        + '<span class="h-what"><b>'+(x.checked?"Checked":"Unchecked")+'</b> '+esc(item(x.check_id))
        + '<span class="h-when">'+esc((x.who||"Someone")+" · "+shortDate(x.at))+'</span></span>'
        + (can?'<button class="btn h-undo" data-id="'+esc(x.check_id)+'" data-to="'+(x.checked?0:1)+'">Undo</button>'
              :'<span class="h-gone">changed since</span>')
        + '</div>';
    }).join("");
  }
  document.getElementById("hList").addEventListener("click",async function(e){
    var b=e.target.closest&&e.target.closest(".h-undo"); if(!b) return;
    var id=b.getAttribute("data-id"), to=b.getAttribute("data-to")==="1";
    b.disabled=true; b.textContent="…";
    if(await change(id,to)){ remember([{id:id,to:to}]); openHistory(); } else { b.disabled=false; b.textContent="Undo"; }
  });

  /* ---------- possible postseason opponents ---------- */
  var cdlg=document.getElementById("cands");
  function teamOptions(){
    var names={};
    DATA.weeks.forEach(function(w){ if(w.site!=="BYE"){ names[w.opp]=1; w.games.forEach(function(g){ if(g.ha) names[g.opp]=1; }); } });
    Object.keys((DATA.post&&DATA.post.teams)||{}).forEach(function(t){ names[t]=1; });
    delete names["Tulane"];
    return Object.keys(names).sort();
  }
  function openCandidates(){
    if(!sb){ showNotice("Not connected to the database."); return; }
    document.getElementById("cErr").textContent="";
    document.getElementById("cTeams").value="";
    document.getElementById("teamList").innerHTML=teamOptions().map(function(t){ return '<option value="'+esc(t)+'">'; }).join("");
    if(cdlg.showModal) cdlg.showModal(); else cdlg.setAttribute("open","");
    setTimeout(function(){ document.getElementById("cOne").focus(); },30);
  }
  function addChip(name){
    name=String(name||"").trim(); if(!name) return;
    var box=document.getElementById("cTeams");
    var list=box.value?box.value.split("\n"):[];
    if(list.some(function(x){ return x.toLowerCase()===name.toLowerCase(); })) return;
    list.push(name); box.value=list.join("\n"); drawChips();
  }
  function drawChips(){
    var list=(document.getElementById("cTeams").value||"").split("\n").filter(Boolean);
    document.getElementById("cChips").innerHTML=list.map(function(t,i){
      return '<span class="cchip">'+logoMini(t)+esc(t)+'<button type="button" data-i="'+i+'" aria-label="Remove '+esc(t)+'">×</button></span>';
    }).join("")||'<span class="cnone">No teams added yet</span>';
  }
  document.getElementById("cAddOne").addEventListener("click",function(){
    var i=document.getElementById("cOne"); addChip(i.value); i.value=""; i.focus();
  });
  document.getElementById("cOne").addEventListener("keydown",function(e){
    if(e.key==="Enter"){ e.preventDefault(); addChip(this.value); this.value=""; }
  });
  document.getElementById("cChips").addEventListener("click",function(e){
    var b=e.target.closest&&e.target.closest("button[data-i]"); if(!b) return;
    var list=document.getElementById("cTeams").value.split("\n").filter(Boolean);
    list.splice(Number(b.getAttribute("data-i")),1);
    document.getElementById("cTeams").value=list.join("\n"); drawChips();
  });
  document.getElementById("cCancel").addEventListener("click",function(){ cdlg.close?cdlg.close():cdlg.removeAttribute("open"); });
  document.getElementById("cForm").addEventListener("submit",async function(e){
    e.preventDefault();
    var pendingOne=document.getElementById("cOne").value.trim(); if(pendingOne){ addChip(pendingOne); document.getElementById("cOne").value=""; }
    var ev=document.getElementById("cEvent").value.trim()||"Postseason";
    var date=document.getElementById("cDate").value.trim();
    var teams=(document.getElementById("cTeams").value||"").split("\n").filter(Boolean);
    var err=document.getElementById("cErr");
    if(!teams.length){ err.textContent="Add at least one team."; return; }
    if(!lsGet("fpb_code")){ var ok=await askLogin(); if(!ok) return; }
    err.textContent="Saving…";
    for(var i=0;i<teams.length;i++){
      var r=await sb.rpc("add_candidate",{p_code:lsGet("fpb_code"),p_team:teams[i],p_event:ev,p_date:date,p_who:lsGet("fpb_who")||""});
      if(r.error){
        err.textContent=/function|does not exist|schema/i.test(r.error.message||"")?"Run database-update.sql in Supabase first.":/passcode/i.test(r.error.message||"")?"Passcode changed. Sign in again.":"Could not save "+teams[i]+".";
        if(/passcode/i.test(r.error.message||"")) lsDel("fpb_code");
        return;
      }
    }
    cdlg.close?cdlg.close():cdlg.removeAttribute("open");
    await loadCandidates(); render();
    var first=postWeeks()[0]; if(first){ var h=root.querySelector(".postcard"); if(h) h.scrollIntoView({behavior:"smooth",block:"start"}); }
    flash("Added "+teams.length+" possible opponent"+(teams.length===1?"":"s")+" for "+ev+".");
  });
  async function removeCandidate(id){
    var w=postWeeks().filter(function(x){ return String(x.candId)===String(id); })[0];
    if(!confirm("Remove "+(w?w.opp+" from "+w.event:"this team")+"? Checkmarks already made are kept.")) return;
    if(!lsGet("fpb_code")){ var ok=await askLogin(); if(!ok) return; }
    var r=await sb.rpc("remove_candidate",{p_code:lsGet("fpb_code"),p_id:Number(id)});
    if(r.error){ showNotice("Could not remove that team. Try again."); return; }
    await loadCandidates(); render();
  }
  async function loadCandidates(){
    if(!sb) return;
    var r=await sb.from("candidates").select("id,team,event,event_date,added_by,added_at").order("added_at",{ascending:true});
    CANDS=r.error?[]:(r.data||[]);
  }


  /* ================================================================
     Checklists: the DO NOT FORGET THIS SHIZ sheets.
     Day lists are keyed to the calendar week, so each week starts
     empty on its own. Packing lists are keyed to a game, so each
     trip starts empty on its own. Nothing is ever cleared by hand.
     ================================================================ */
  var WK_DAYS=[{"n":"Sunday","a":"SUN","k":"sun","t":[{"t":"Shares for Upcoming Opponents","s":1},{"t":"Shares for Special Requests","s":1},{"t":"Cut our next TV Opponents last game with urgency","s":1},{"t":"Cut our TV copy to share to exchange","n":"Do this First, ODK it as well, Export Edit Files on export, Only for Home Games"},{"t":"All future opponents uploaded to Gamebrain"},{"t":"Sunday night start first O,D,K video surges to travel laptops"},{"t":"Review everything that went wrong during the last game"},{"t":"Turn in Ref Review Clips on DVSport 360"},{"t":"PFF our team's copy","n":"run update on all other teams mid to late morning"},{"t":"Upload our film to NFL","n":"Home Games only"},{"t":"Set Manage Travel Folders"},{"t":"Remove last team from Vault Notifications"},{"t":"Move Huddleboxes back to storage location"}]},{"n":"Monday","a":"MON","k":"mon","t":[{"t":"Practice"},{"t":"Push Practice to cloud"},{"t":"O,D,K video surges to travel laptops"},{"t":"Download and Import Sunday NFL Games"},{"t":"Start PFF'ing the NFL Games","s":1},{"t":"Pub Reset during Practice?"},{"t":"Download Skycasts","n":"Carries forward until they are all down"},{"t":"Copy College games to share","s":1}]},{"n":"Tuesday","a":"TUE","k":"tue","t":[{"t":"Practice"},{"t":"Push Practice to cloud"},{"t":"O,D,K video surges to travel laptops"},{"t":"Copy College games to share","s":1},{"t":"PFF Monday night Football game"},{"t":"Huddleboxes charging","n":"are they needed at {next} practice?","g":4}]},{"n":"Wednesday","a":"WED","k":"wed","t":[{"t":"Practice"},{"t":"Push Practice to cloud"},{"t":"O,D,K video surges to travel laptops"},{"t":"Initial Pack of boxes","n":"For typical Semi leaving","sem":-1,"link":"auto"},{"t":"Any Penalty Videos for refs"},{"t":"Travel List in Staff Meeting","g":3}]},{"n":"Thursday","a":"THU","k":"thu","t":[{"t":"Practice"},{"t":"O,D,K video surges to travel laptops"},{"t":"Check the students' hours","due":"2026-10-30"},{"t":"During Practice complete the Semi Load list","sem":0,"link":"semi"}]},{"n":"Friday","a":"FRI","k":"fri","t":[{"t":"Practice"},{"t":"O,D,K video surges to travel laptops"},{"t":"PFF Thursday night Football game"}]},{"n":"Saturday","a":"SAT","k":"sat","t":[{"t":"GameDay","g":0},{"t":"Cards formatted","g":0},{"t":"Sync each quarter","g":0},{"t":"PFF Our Game","g":0},{"t":"Send PFF data to Atavus Tackling dudes","g":0},{"t":"PUSH OUR GAME TO THE CLOUD","g":0}]}];
  var PACKS={"road":{"name":"Away Game","tab":"Away Game","scope":"away","sub":"Off the Away Game Pack List. Indented items live inside the one above them.","groups":[{"g":"Travel case · Blue case","items":[{"t":"XOS laptops","q":"3"},{"t":"HDMI cables","d":1,"q":"3"},{"t":"Mice","d":1,"q":"3"},{"t":"Mouse pads","d":1,"q":"3"},{"t":"Laptop power","d":1,"q":"2"},{"t":"USB-C laptop power","d":1},{"t":"Cowboy remotes","d":1,"q":"3"},{"t":"USB extender","d":1},{"t":"PowerPoint clicker","d":1},{"t":"Brandon laptop bag"},{"t":"Mousepad","d":1},{"t":"Mouse","d":1},{"t":"SSDs","d":1,"q":"4"},{"t":"AT&T WiFi hotspots","d":1,"q":"2"},{"t":"Empty SD card cases","d":1,"q":"2"},{"t":"Walkie","d":1},{"t":"USB-C laptop power","d":1},{"t":"SL Potato Bowl bag"},{"t":"Fast 5 bag: format cards","d":1,"n":"In 1080"},{"t":"Power strip / extension","d":1},{"t":"Lanyards","d":1},{"t":"UMR 20","d":1,"n":"moved here from the EZ bag, the HMR-10 is broken"},{"t":"UMR power","d":1},{"t":"UMR cards","d":1},{"t":"UMR SDI","d":1},{"t":"Power wheel","d":1},{"t":"EZ Potato Bowl bag"},{"t":"Power wheel","d":1}]},{"g":"Travel case · Green case","items":[{"t":"Speaker cables"},{"t":"Small aux cord"},{"t":"Long aux & long 1/4\" cable"},{"t":"Small set of speakers"},{"t":"Expo markers"},{"t":"Extension cords","q":"3"},{"t":"Power strips","q":"3"},{"t":"Gaffer's tape","q":"2"},{"t":"Pen & Post-it notes"},{"t":"Airline headphones"},{"t":"Cowboy remote"}]},{"g":"Travel case · Projector box","items":[{"t":"Projectors","q":"3"},{"t":"Projector power cords","q":"3"},{"t":"Projector HDMI cables","q":"3"},{"t":"USB-C to HDMI"}]},{"g":"No case / oversize","items":[{"t":"Big speaker"},{"t":"Speaker power","d":1},{"t":"Projector screens","q":"2"},{"t":"Rainrooms","q":"4"},{"t":"Motivational"}]},{"g":"Camera bag · SL sideline","items":[{"t":"Camera"},{"t":"Walkie"},{"t":"Earpiece"},{"t":"Cards","q":"7"},{"t":"Camera batteries","q":"4"},{"t":"Monitor batteries","q":"4"},{"t":"Tripod"},{"t":"Monitor"},{"t":"Rain gear"},{"t":"Black Magic box"},{"t":"HDMI cable"},{"t":"USB-C brick & cable"}]},{"g":"Camera bag · SB scoreboard","items":[{"t":"Camera"},{"t":"Walkie"},{"t":"Earpiece"},{"t":"Cards","q":"7"},{"t":"Camera batteries","q":"4"},{"t":"Monitor batteries","q":"4"},{"t":"Tripod"},{"t":"Monitor"},{"t":"Rain gear"}]},{"g":"Camera bag · EZ end zone","items":[{"t":"Camera"},{"t":"Walkie"},{"t":"Earpiece"},{"t":"Cards","q":"7"},{"t":"Camera batteries","q":"4"},{"t":"Monitor batteries","q":"4"},{"t":"Tripod"},{"t":"Monitor"},{"t":"Rain gear"},{"t":"Black Magic box"},{"t":"HDMI cable"},{"t":"USB-C brick & cable"}]},{"g":"Camera bag · EZ2 end zone 2","items":[{"t":"Camera"},{"t":"Walkie"},{"t":"Earpiece"},{"t":"Cards","q":"7"},{"t":"Camera batteries","q":"4"},{"t":"Monitor batteries","q":"4"},{"t":"Tripod"},{"t":"Monitor"},{"t":"Rain gear"}]}]},"semi":{"name":"Semi Load","tab":"Semi Load","scope":"away","sub":"Indented items live inside the one above them.","groups":[{"g":"Semi load","items":[{"t":"iPad cart"},{"t":"A/C tube","d":1},{"t":"Booth bag","d":1},{"t":"Ethernet","d":2},{"t":"USB-C power","d":2},{"t":"Adapters","d":2},{"t":"A/C power","d":1},{"t":"Extra remotes","d":1},{"t":"iPad case"},{"t":"iPad stands","q":"7","n":"two broke, one replaced. The sheet still says 8"},{"t":"A/C unit"},{"t":"Huddleboxes","q":"2","n":"Padded and strapped"},{"t":"Extension cords (longer)","d":1,"n":"Plenty"},{"t":"HDMI cables","d":1,"n":"Plenty"},{"t":"USB-C to HDMI adapters","d":1,"n":"Plenty"},{"t":"USB-C to HDMI cords","d":1,"n":"Plenty"},{"t":"USB-C power","d":1},{"t":"Long HDMIs","d":1},{"t":"USB-C converter","d":1},{"t":"Table in 1","d":1},{"t":"Elmo in 1","d":1},{"t":"Elmo cables","d":2},{"t":"Printer & case","d":1},{"t":"Ink","d":2},{"t":"Battery","d":2},{"t":"Cable","d":2}]}]},"stay":{"name":"Staycation","tab":"Staycation","scope":"home","sub":"Off the Home Game Pack List. Indented items live inside the one above them.","groups":[{"g":"Travel case · Green case","items":[{"t":"XOS laptops","q":"2"},{"t":"HDMI cables","d":1,"q":"2"},{"t":"Mice","d":1,"q":"2"},{"t":"Mouse pads","d":1,"q":"2"},{"t":"Laptop power","d":1,"q":"2"},{"t":"Cowboy remotes","d":1,"q":"2"},{"t":"USB extender","d":1},{"t":"Ross' laptop"},{"t":"HDMI cable","d":1},{"t":"Mouse","d":1},{"t":"Mouse pad","d":1},{"t":"USB-C laptop power","d":1},{"t":"Speaker cables"},{"t":"Small aux cord"},{"t":"Long aux & long 1/4\" cable"},{"t":"Small set of speakers"},{"t":"Expo markers"},{"t":"Extension cords","q":"3"},{"t":"Power strips","q":"3"},{"t":"Gaffer's tape","q":"2"},{"t":"Pen & Post-it notes"},{"t":"Cowboy remote"},{"t":"Power wheel","q":"2"}]},{"g":"Travel case · Projector box","items":[{"t":"Projectors","q":"3"},{"t":"Projector power cords","q":"3"},{"t":"Projector HDMI cables","q":"3"},{"t":"USB-C to HDMI"}]},{"g":"No case / oversize","items":[{"t":"Big speaker"},{"t":"Speaker power","d":1},{"t":"Projector screens","q":"2"},{"t":"Motivational"}]}]},"bowl":{"name":"Bowl Travel","tab":"Bowl","scope":"season","sub":"Second camera set is the sheet's right-hand column. Notes at the bottom are last year's lessons, kept verbatim.","prep":[{"g":"As soon as the matchup is announced","items":[{"t":"Add the opponent to the board as a postseason team"},{"t":"Start film downloads to coaches' laptops, staggered","n":"we overloaded a download overnight once and the server was bogged down the next morning"},{"t":"Pull the opponent's full season off the exchange"},{"t":"Cut the opponent's last game with urgency"},{"t":"Ask the bowl for the meeting room list and room sizes"},{"t":"Ask for a full size table in every meeting room","n":"so coaches have a work space, not just room for a projector and laptop"},{"t":"Get the stadium's video setup in writing","n":"press box spot, end zone access, what cabling they provide"}]},{"g":"Week of departure","items":[{"t":"Test every coach's laptop individually in travel mode","n":"a few did not go into travel mode correctly last time"},{"t":"Test every projector"},{"t":"Line up one or two rental projectors as spares","n":"the rented ones always have issues, and ours need replacing with urgency"},{"t":"Charge everything","n":"huddleboxes, iPads, batteries, walkies"},{"t":"Format all cards"},{"t":"Confirm the advance crew","n":"who goes, when they land, what each person sets. Consider sending two"},{"t":"Write the advance crew a room by room setup sheet"},{"t":"Plan how we help EQ and still get our own work done"},{"t":"Confirm hotel meeting room access times"},{"t":"Pack a working PS5 and controllers","n":"no matter what they say is in the hospitality room"}]},{"g":"Day before the truck leaves","items":[{"t":"Pack to the Bowl Travel list below"},{"t":"Label every case"},{"t":"Photograph each packed case"},{"t":"Confirm the truck's departure time and arrival window with EQ"},{"t":"Set aside the carry on","n":"laptops, drives, chargers, anything we cannot replace down there"},{"t":"Load the travel laptops with the latest O,D,K surges"},{"t":"Print the coaches iPad checklist and the room setup sheets"}]},{"g":"On arrival","items":[{"t":"Walk the stadium","n":"sideline spot, end zone spot, cable runs, power"},{"t":"Walk the meeting rooms and confirm the tables"},{"t":"Set and test every meeting room before the team arrives"},{"t":"Test the hotspots and find out what the venue provides"},{"t":"Test upload speed from the hotel and from the stadium"},{"t":"Run a full record and upload dry run"},{"t":"Find the nearest hardware store"}]}],"groups":[{"g":"SL","items":[{"t":"CAMERA"},{"t":"WALKIES"},{"t":"CARDS"},{"t":"BATTERIES"},{"t":"TRIPOD"},{"t":"BLACK MAGIC BOX"},{"t":"MONITOR & BATTERIES"},{"t":"CAMERA RAIN GEAR"}]},{"g":"SL (second set)","items":[{"t":"CAMERA"},{"t":"WALKIES"},{"t":"CARDS"},{"t":"BATTERIES"},{"t":"TRIPOD"},{"t":"BLACK MAGIC BOX"},{"t":"MONITOR & BATTERIES"},{"t":"CAMERA RAIN GEAR"}]},{"g":"EZ","items":[{"t":"CAMERA"},{"t":"WALKIES"},{"t":"CARDS"},{"t":"BATTERIES"},{"t":"TRIPOD"},{"t":"MONITOR & BATTERIES"},{"t":"CAMERA RAIN GEAR"}]},{"g":"EZ (second set)","items":[{"t":"CAMERA"},{"t":"WALKIES"},{"t":"CARDS"},{"t":"BATTERIES"},{"t":"TRIPOD"},{"t":"MONITOR & BATTERIES"},{"t":"CAMERA RAIN GEAR"}]},{"g":"MR","items":[{"t":"15 XOS LAPTOPS ?"},{"t":"3 HDMI CABLES"},{"t":"3 MICE"},{"t":"3 MOUSE PADS"},{"t":"3 LAPTOP POWERS"},{"t":"3 COWBOY REMOTES"},{"t":"3 PROJECTORS"},{"t":"PROJECTOR POWER"},{"t":"PROJECTOR HDMI'S"},{"t":"USB-C to HDMI"},{"t":"1 BIG SPEAKER"},{"t":"SPEAKER CABLES"},{"t":"SPEAKER POWER"},{"t":"SMALL AUX CORD"},{"t":"LONG AUX"},{"t":"1 SMALL OF SPEAKERS"},{"t":"EXPO MARKERS"},{"t":"3 HDMI CABLES"},{"t":"4 AT&T WIFI HOTSPOTS"},{"t":"2 MICE"},{"t":"3 EXTENSION CORDS"},{"t":"3 POWER STRIPS"},{"t":"GAFFERS TAPE"}]},{"g":"OR","items":[{"t":"Coaches IPAD"}]},{"g":"TV copy","items":[{"t":"HMR 10"},{"t":"HMR 10 CARDS - SWAP HALF"},{"t":"SDI CORD"},{"t":"HMR 10 POWER"}]},{"g":"Game time","items":[{"t":"THUNDER IPAD CHARGERS"},{"t":"COACHES IPAD CHECKLIST"},{"t":"PEN & POST IT NOTES"},{"t":"EAR PIECES FOR WALKIES"},{"t":"HMR SETUP FOR SL"},{"t":"LANYARDS"},{"t":"COACH'S BOOTH BAG"},{"t":"ETHERNET"},{"t":"USB-C POWER"},{"t":"ADAPTERS"},{"t":"POTATO BOWL BAG"},{"t":"FAST 5 BAG - format cards"},{"t":"4 SSD'S"},{"t":"POWER STRIP - EXTENSION"}]},{"g":"Charging stations","items":[{"t":"WALKIE"},{"t":"CAMERA"},{"t":"MONITOR"},{"t":"GH5"},{"t":"BATTERIES & CARDS"},{"t":"USB-B PRINTER CABLES"},{"t":"LOTS OF POWER"},{"t":"LOTS OF POWER STRIPS"},{"t":"LOTS OF TAPE"},{"t":"CARDS"},{"t":"SMALL CARDS AND ADAPTERS"}]},{"g":"Gear ideas to consider","items":[{"t":"MOTIVATIONAL"},{"t":"LAMINATOR?!"},{"t":"OLD LAPTOP"},{"t":"additional box? For Cold Gear?"}]}],"notes":["AS SOON AS BOWL TEAM IS ANNOUNCED. IN AND SETTLED. START DOWNLOADING BITS OF FILM TO ALL COACHES COMPUTERS.","WE OVERLOADED A DOWNLOAD OVERNIGHT AND THE SERVER WAS BOGGED DOWN THE NEXT MORNING","A FEW COMPUTERS DID NOT TRAVEL MODE CORRECTLY. A TEST OF EACH INDIVIDUAL COACHES LAPTOP BEFORE TRAVEL MAY HAVE CLEANED THIS UP","TAKE A WORKING PS5 AND CONTROLLERS NO MATTER WHAT THEY SAY IS INCLUDED IN THE HOSPITALITY ROOM","GIVE CLEARER INSTRUCTIONS TO ADVANCE CREW, VIDEO GA DID NOT HAVE EVERY ROOM SET BY ARRIVAL…. ITS HARD TO DO BUT MAYBE SEND 2,","AND DEVELOP A PLAN IN ADVANCE OF HOW TO HELP EQ AND HOW TO GET OUR SHIT DONE AS WELL","IN EVERY MEETING ROOM, I WANT A FULL SIZE TABLE TO ALLOW COACHES A WORK SPACE, NOT JUST ENOUGH ROOM FOR A PROJECTOR AND LAPTOP","TEST AND MAKE SURE WE HAVE EXTRA PROJECTORS ON HAND, EVEN IF WE HAVE TO RENT 1 OR 2 EXTRAS. THE RENTED PROJECTORS ALWAYS HAVE ISSUES","AND WE NEED TO REPLACE WITH URGENCY."]}};
  var PACK_ORDER=["semi","road","stay","bowl"];

  var WK_LOOK={};
  WK_DAYS.forEach(function(d,i){ d.t.forEach(function(x){ WK_LOOK[d.k+"|"+ckSlug(x.t)]={d:i,t:x.t}; }); });

  var TAB="board";
  var wkState={off:0,open:{}, todayOnly:true, focus:false};
  var pkState={};        /* list key -> week number being packed for */
  var weekroot=document.getElementById("weekroot");
  var packroot=document.getElementById("packroot");

  function ckSlug(t){ return String(t).toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,44); }
  function ckPad(n){ return (n<10?"0":"")+n; }
  function ckISO(d){ return d.getFullYear()+"-"+ckPad(d.getMonth()+1)+"-"+ckPad(d.getDate()); }
  function isWeekId(id){ return String(id).slice(0,3)==="wk|"; }
  function isPackId(id){ return String(id).slice(0,3)==="pk|"; }
  function isListId(id){ return isWeekId(id)||isPackId(id); }

  /* ---------------- shared settings ----------------
     Small bits the whole staff shares, like the day the semi loads when
     Equipment moves it off its usual slot. */
  var SETTINGS={};
  async function loadSettings(){
    if(!sb) return;
    var r=await sb.from("settings").select("k,v");
    if(r.error){ logRead("the shared settings",r.error); return; }
    SETTINGS={};
    (r.data||[]).forEach(function(x){ SETTINGS[x.k]=x.v; });
  }
  /* A realtime payload only carries the columns Postgres felt like sending.
     Taking row.v on faith wrote undefined into the cache, which read back as
     an empty list and made a list you had just added to look wiped. Only
     trust a payload that actually brought the value; otherwise go and ask. */
  function applySetting(row){
    if(!row||!row.k) return false;
    if(typeof row.v!=="string") return false;
    SETTINGS[row.k]=row.v;
    return true;
  }
  async function settingChanged(msg){
    if(!applySetting(msg&&msg.new)){ try{ await loadSettings(); }catch(e){} }
    renderCurrentList();
  }
  async function saveSetting(k,v){
    if(!sb) return "Not connected.";
    if(!lsGet("fpb_code")){ var ok=await askLogin(); if(!ok) return "Sign in to change this."; }
    var r=await sb.rpc("set_setting",{p_code:lsGet("fpb_code"),p_k:k,p_v:v||"",p_who:lsGet("fpb_who")||""});
    if(r.error){
      var m=String(r.error.message||"");
      if(/does not exist|schema|function/i.test(m)) return "Run notes-setup.sql in Supabase first.";
      if(/passcode/i.test(m)){ lsDel("fpb_code"); return "Passcode changed. Try again."; }
      return "That did not save.";
    }
    if(v) SETTINGS[k]=v; else delete SETTINGS[k];
    return "";
  }
  function semiKey(w){ return w?("semi:w"+w.week):""; }

  /* People sign in with whatever they feel like typing. This is the one
     place that decides what the rest of the site calls them, so a name is
     fixed everywhere at once: the board, the checklists, notes, the buy
     list, the worker log and the history. What was typed is left alone in
     the database; only the display changes, so fixing a name later also
     fixes every record already written under it. */
  var WHO_BUILTIN={"sh":"Bulldog"};
  function whoMap(){
    var m={}, k;
    for(k in WHO_BUILTIN) m[k]=WHO_BUILTIN[k];
    try{
      var o=JSON.parse(SETTINGS["who:alias"]||"{}");
      Object.keys(o).forEach(function(x){ m[String(x).trim().toLowerCase()]=String(o[x]); });
    }catch(e){}
    return m;
  }
  /* Names that read better whole than squeezed into two letters. The board
     tag sits inside the checkbox itself, so a full name there gets its own
     much smaller size rather than overflowing the box. */
  var WHO_FULLTAG={"bulldog":1};
  function whoTagText(s){
    var n=whoName(s);
    return WHO_FULLTAG[String(n).toLowerCase()]?n.toUpperCase():initials(n);
  }
  function whoTagCls(s){
    return WHO_FULLTAG[String(whoName(s)).toLowerCase()]?" wt-full":"";
  }
  function whoName(s){
    s=String(s==null?"":s).trim();
    if(!s) return s;
    var hit=whoMap()[s.toLowerCase()];
    return hit||s;
  }

  /* ---------------- week helpers ---------------- */
  function wkSunday(off){
    var d=new Date(); d.setHours(0,0,0,0);
    d.setDate(d.getDate()-d.getDay()+(off||0)*7);
    return d;
  }
  function wkDayDate(sun,i){ var d=new Date(sun.getTime()); d.setDate(d.getDate()+i); return d; }
  function wkId(sun,sheet,t){ return "wk|"+ckISO(sun)+"|"+WK_DAYS[sheet].k+"|"+ckSlug(t); }
  /* one place that knows whether a row came off the sheet or out of the + */
  function wkIdOf(sun,e){
    return e.item.cid?bldWeekId(sun,e.sheet,e.item.cid):wkId(sun,e.sheet,e.item.t);
  }
  /* The explainer that used to sit at the bottom of every tab, every day,
     forever. Still here when somebody new needs it, folded away when they
     do not. The browser remembers nothing, which is right: closed is the
     default and opening it is one click. */
  function howto(html,label){
    return '<details class="howto"><summary>'+(label||"How this tab works")+'</summary>'
      + '<div class="howbody">'+html+'</div></details>';
  }

  function ckNice(d){ return d.toLocaleDateString("en-US",{month:"short",day:"numeric"}); }

  /* A week date can still be a flex window the conference has not set, like
     "Nov 27/28". Take the later day: that is the Saturday. Once the schedule
     pins it to one date this does nothing. */
  function wkDate(w){
    var p=parseDay(w.date); if(!p) return null;
    var m=/[A-Z][a-z]{2}\s+\d{1,2}\s*[\/-]\s*(\d{1,2})/.exec(String(w.date||""));
    if(m) return {y:p.y,mo:p.mo,d:parseInt(m[1],10),flex:true};
    return p;
  }

  /* Every Tulane game on the calendar, regular season plus any postseason
     game that has actually been announced. A team somebody added as a
     maybe is not a game yet, so it does not drive a checklist. */
  function allGames(){
    var out=(DATA.weeks||[]).slice();
    try{
      postWeeks().forEach(function(w){ if(w.official&&w.date) out.push(w); });
    }catch(e){}
    return out;
  }
  /* The Tulane game inside this calendar week, if any. */
  function wkGame(sun){
    var end=wkDayDate(sun,6), out=null;
    allGames().forEach(function(w){
      var p=wkDate(w); if(!p) return;
      var d=new Date(p.y,p.mo,p.d);
      if(d>=sun&&d<=end) out={w:w,d:d,i:d.getDay(),bye:w.site==="BYE",post:!!w.post};
    });
    return out;
  }
  /* Is there a game in the week before or the week after this one? If not,
     the season is not running and the day lists do not apply. */
  function weekIsLive(sun,g){
    if(g) return true;
    var from=new Date(sun.getTime()); from.setDate(from.getDate()-7);
    var to=new Date(sun.getTime()); to.setDate(to.getDate()+13);
    var live=false;
    allGames().forEach(function(w){
      if(w.site==="BYE") return;
      var p=wkDate(w); if(!p) return;
      var d=new Date(p.y,p.mo,p.d);
      if(d>=from&&d<=to) live=true;
    });
    return live;
  }
  function sideWord(site){ return site==="A"?"at ":site==="N"?"vs ":"vs "; }
  function gameLabel(g){
    if(!g||g.bye) return "";
    return sideWord(g.w.site)+g.w.opp+(g.w.event?" ("+g.w.event+")":"");
  }

  /* The calendar day index the semi loads on, 0 (Sunday) to 6.
     Default is two days before kickoff, which is the Thursday of a normal
     Saturday week. Equipment can move it, and that override wins. */
  function semiDay(sun,g){
    if(!g||g.bye) return -1;
    var ov=SETTINGS[semiKey(g.w)];
    if(ov){
      var p=String(ov).split("-");
      if(p.length===3){
        var d=new Date(+p[0],+p[1]-1,+p[2]);
        var i=Math.round((d.getTime()-sun.getTime())/86400000);
        if(i>=0&&i<=6) return i;
      }
    }
    return Math.max(0,g.i-2);
  }
  function semiIsCustom(g){ return !!(g&&g.w&&SETTINGS[semiKey(g.w)]); }

  /* What lands on calendar day i.
     A task with a .g rides the kickoff: it sits that many days before
     the game, wherever the game falls. Everything else keeps its
     weekday. Returns a list of {sheet, item}. */
  function wkTasks(i,g,sun){
    var out=[], sd=sun?semiDay(sun,g):-1;
    /* Anything you typed shows up even on a quiet week. You put it there
       on purpose; the sheet's own routine is what goes dark. */
    var mine=sun?bldWeekFor(i,sun).map(function(x){
      return {sheet:i,item:{t:x.t,n:x.n,cid:x.id,every:x.every,nd:x.nd||0}}; }):[];
    if(sun&&!weekIsLive(sun,g)) return mine;
    WK_DAYS.forEach(function(D,sheet){
      D.t.forEach(function(x){
        if(x.sem!==undefined){
          /* rides the semi load day, wherever that has been set */
          if(sd>=0&&sd+x.sem===i) out.push({sheet:sheet,item:x});
          return;
        }
        if(x.g===undefined){
          /* a plain weekday task drops off on game day and after, because by
             then the week's routine is over and the game-day list has landed */
          if(sheet===i&&!(g&&!g.bye&&i>=g.i)) out.push({sheet:sheet,item:x});
          return;
        }
        if(!g||g.bye) return;                 /* no kickoff, no anchor */
        var land=g.i-x.g;
        if(land===i) out.push({sheet:sheet,item:x});
      });
    });
    return out.concat(mine);
  }
  function wkStat(sun,i,g){
    var list=wkTasks(i,g,sun), done=0;
    list.forEach(function(e){ if(STATE.checks[wkIdOf(sun,e)]) done++; });
    return {done:done,total:list.length};
  }
  /* Unfinished work from earlier in the same week. */
  function wkOverdue(sun,g,upto){
    var out=[];
    for(var i=0;i<upto;i++){
      wkTasks(i,g,sun).forEach(function(e){
        if(!STATE.checks[wkIdOf(sun,e)]) out.push({day:i,sheet:e.sheet,item:e.item});
      });
    }
    return out;
  }

  /* "due:2026-10-30" means that Friday and every second Friday after it.
     Returns the next due date on or after the given day. */
  function nextDue(anchorISO,from){
    var p=String(anchorISO).split("-"); if(p.length!==3) return null;
    var a=new Date(+p[0],+p[1]-1,+p[2]);
    var d=Math.round((from.getTime()-a.getTime())/86400000);
    var k=Math.ceil(d/14);
    var out=new Date(a.getTime()); out.setDate(out.getDate()+k*14);
    return out;
  }
  function dueNote(item,dd){
    if(!item.due) return "";
    var due=nextDue(item.due,dd); if(!due) return "";
    var days=Math.round((due.getTime()-dd.getTime())/86400000);
    if(days===0) return "Due today";
    if(days===1) return "Due tomorrow, Friday "+ckNice(due);
    return "Next due Friday "+ckNice(due)+", "+days+" days out";
  }
  function noteText(n,dayIdx){
    return String(n||"").replace("{next}",WK_DAYS[(dayIdx+1)%7].n);
  }
  /* A task can point at the list it needs. "auto" works out which pack
     list this week's game calls for: home goes to Staycation, a road or
     neutral game goes to Away Game. */
  function linkTarget(item,g){
    if(!item.link) return "";
    if(item.link!=="auto") return item.link;
    if(g&&!g.bye&&g.w.site==="H") return "stay";
    return "road";
  }
  function taskRow(id,item,dayIdx,from,dd,g){
    var on=!!STATE.checks[id];
    var note=noteText(item.n,dayIdx);
    var due=dd?dueNote(item,dd):"";
    return '<label class="trow'+(item.cid?" mineRow d"+(item.nd||0):"")
      +(on?" tdone":"")+(from!==undefined?" tlate":"")+'"'
      +(item.cid&&from===undefined?' draggable="true" data-wdrag="'+esc(item.cid)+'"':"")+'>'
      + '<input class="box" type="checkbox" data-id="'+esc(id)+'"'+(on?" checked":"")+'>'
      + '<span class="tmain"><span class="tname">'+esc(item.t)+'</span>'
      + (from!==undefined?'<span class="tfrom">from '+WK_DAYS[from].n+'</span>':"")
      + (note?'<span class="tnote">'+esc(note)+'</span>':"")
      + (due?'<span class="tdue'+(/today|tomorrow/.test(due)?" soon":"")+'">'+esc(due)+'</span>':"")+'</span>'
      + '<span class="tflags">'
      + (item.q?'<span class="tqty">&times;'+esc(item.q)+'</span>':"")
      + (function(){
          var k=linkTarget(item,g);
          if(!k||!PACKS[k]) return "";
          return '<button type="button" class="tlink" data-golist="'+esc(k)+'">Open '+esc(PACKS[k].tab)+'</button>';
        })()
      + (item.s?'<span class="stu" title="Your sheet flags this as a weekly student task">Student</span>':"")
      + (item.cid?'<span class="mine" title="'+(item.every?"Added by hand, every week":"Added by hand, this week only")+'">'
          +(item.every?"Weekly":"Added")+'</span>'
          +(from===undefined?
             '<button type="button" class="bldico" data-wout="'+esc(item.cid)+'"'+((item.nd||0)<=0?" disabled":"")+' aria-label="Move out one level">&#8592;</button>'
            +'<button type="button" class="bldico" data-win="'+esc(item.cid)+'"'+((item.nd||0)>=2?" disabled":"")+' aria-label="Nest under the row above">&#8594;</button>'
            +'<button type="button" class="bldico" data-wup="'+esc(item.cid)+'" aria-label="Move up">&#9650;</button>'
            +'<button type="button" class="bldico" data-wdn="'+esc(item.cid)+'" aria-label="Move down">&#9660;</button>':"")
          +'<button type="button" class="bldico" data-wkedit="'+esc(item.cid)+'" aria-label="Edit this">&#9998;</button>'
          +'<button type="button" class="bldico bldx" data-wkdel="'+esc(item.cid)+'" aria-label="Remove this">&times;</button>':"")
      + '</span>'
      + whoTag(id,"")
      + '</label>';
  }

  function wkCard(sun,i,g,today,overdue){
    var D=WK_DAYS[i], dd=wkDayDate(sun,i), list=wkTasks(i,g,sun);
    var isToday=dd.getTime()===today.getTime();
    var isGame=!!(g&&!g.bye&&g.i===i);
    var st={done:0,total:list.length};
    list.forEach(function(e){ if(STATE.checks[wkIdOf(sun,e)]) st.done++; });
    var left=st.total-st.done, complete=st.total>0&&left===0;
    var late=(overdue&&isToday)?overdue:[];
    var open=!!wkState.open[i];
    var cls="dcard"+(isToday?" iscur":"")+(isGame?" isgame":"")+(complete&&!late.length?" ddone":"")+(open?"":" shut");

    var tag="";
    if(isGame) tag='<span class="dtag game">Game day'+(gameLabel(g)?" &middot; "+esc(gameLabel(g)):"")+'</span>';
    else if(isToday) tag='<span class="dtag">Today</span>';

    var chip="";
    if(g&&!g.bye){
      var diff=g.i-i;
      if(diff>0) chip='<span class="dout">'+diff+' day'+(diff===1?"":"s")+' out</span>';
    }

    var body="";
    if(late.length){
      body+='<div class="pastdue"><div class="pdhead">Past due &middot; carried over from earlier this week</div>';
      late.forEach(function(e){ body+=taskRow(wkIdOf(sun,e),e.item,e.day,e.day,wkDayDate(sun,e.day),g); });
      body+='</div>';
    }
    if(!list.length){
      body+='<p class="dempty">'+(g&&g.bye?"Bye week, nothing on the sheet for this day."
        :(g?"Clear. The week ended at kickoff on "+WK_DAYS[g.i].n+"."
           :"Nothing on the sheet for this day."))+'</p>';
    } else {
      list.forEach(function(e){ body+=taskRow(wkIdOf(sun,e),e.item,i,undefined,dd,g); });
    }
    body+=bldAddForm(i)+bldPlus(i);

    return '<section class="'+cls+'" data-day="'+i+'">'
      + '<div class="dhead" role="button" tabindex="0" aria-expanded="'+(open?"true":"false")+'">'
      + '<span class="dabbr">'+D.a+'</span>'
      + '<span class="dmeta"><b>'+D.n+'</b><span class="ddate">'+ckNice(dd)+'</span></span>'
      + tag + chip
      + (late.length?'<span class="pill p-late">'+late.length+' past due</span>':"")
      + '<span class="count"><b>'+st.done+'</b>/'+st.total+'</span>'
      + '<span class="pill '+(complete?"p-done":st.total?"p-part":"p-none")+'">'+(st.total?(complete?"Done":left+" left"):"Clear")+'</span>'
      + '<span class="caret" aria-hidden="true">&#9662;</span>'
      + '</div>'
      + '<div class="dbody">'+body+'</div></section>';
  }

  function renderWeek(){
    if(!weekroot) return;
    var sun=wkSunday(wkState.off), g=wkGame(sun);
    var today=new Date(); today.setHours(0,0,0,0);
    var thisWeek=wkState.off===0;
    var overdue=thisWeek?wkOverdue(sun,g,new Date().getDay()):null;

    var done=0,total=0,clear=0;
    for(var i=0;i<7;i++){
      var s=wkStat(sun,i,g);
      done+=s.done; total+=s.total;
      if(s.total&&s.done===s.total) clear++;
    }

    var live=weekIsLive(sun,g);
    var ctx;
    if(!g) ctx='<span class="wkctx">'+(live?"No Tulane game this week":"Nothing scheduled around this week")+'</span>';
    else if(g.bye) ctx='<span class="wkctx">Bye week</span>';
    else ctx='<span class="wkctx">Game week: <b>'+esc(gameLabel(g))+'</b>, '+WK_DAYS[g.i].n+' '+ckNice(g.d)+'</span>';

    var banner="";
    if(!live){
      banner='<div class="wkquiet"><b>Quiet week.</b> No Tulane game this week, the week before or the week after, '
        +'so the day lists are off. They come back on their own once a game is within a week either side. '
        +'Bowl prep lives on the <button type="button" class="qlink" data-golist="bowl">Bowl</button> tab.</div>';
    } else if(g&&!g.bye&&g.i<6){
      banner='<div class="wkshort"><b>Short week.</b> Kickoff is '+WK_DAYS[g.i].n+'. '
        +'The count on each card is days to kickoff.'
        +'<details class="wkwhy"><summary>What moved</summary><div>'
        +'The game-day list slid onto '+WK_DAYS[g.i].n+'. The semi load and the box pack moved with it, '
        +'and the staff-meeting travel list and the huddlebox charge stayed the same number of days from kickoff. '
        +'The rest kept its weekday.</div></details></div>';
    }

    /* Focus mode: today only, no week bar, no other days. The phone lands
       here by default on the current week. */
    var todayIdx=new Date().getDay();
    var focus=wkState.focus&&thisWeek&&total>0;
    var cards="";
    if(focus){
      wkState.open[todayIdx]=true;
      cards=wkCard(sun,todayIdx,g,today,overdue);
    } else {
      for(var j=0;j<7;j++) cards+=wkCard(sun,j,g,today,overdue);
    }

    if(focus){
      weekroot.innerHTML=
        '<div class="printhead">Weekly checklist &middot; '+WK_DAYS[todayIdx].n+' '+ckNice(wkDayDate(sun,todayIdx))+'<i>v'+VER+'</i></div>'
        + '<div class="focusbar"><span class="focusnow">Today</span>'
        + (g&&!g.bye?'<span class="wkctx">'+esc(gameLabel(g))+', '+WK_DAYS[g.i].n+'</span>':'')
        + '<span class="wksp"></span>'
        + '<button class="btn" id="wkWhole">Whole week</button></div>'
        + bldUndoHtml()
        + '<div class="wkdays">'+cards+'</div>';
      return;
    }
    weekroot.innerHTML=
      '<div class="printhead">Weekly checklist &middot; week of '+ckNice(sun)
        +(g&&!g.bye?' &middot; '+esc(gameLabel(g))+', '+WK_DAYS[g.i].n:'')
        +'<i>v'+VER+'</i></div>'
      + '<div class="wkbar">'
      + '<button class="btn wkarrow" id="wkPrev" aria-label="Previous week">&#9664;</button>'
      + '<button class="btn wkarrow" id="wkNext" aria-label="Next week">&#9654;</button>'
      + '<span class="wknow">Week of '+ckNice(sun)+'</span>'
      + ctx
      + (thisWeek?"":'<button class="btn wkgo" id="wkNow">This week</button>')
      + '<span class="wksp"></span>'
      + '<span class="wkstat">'+(total?('<b>'+done+'</b>/'+total+' done<i>&middot;</i><b>'+clear+'</b>/7 days'):'Nothing due')
      + (overdue&&overdue.length?'<i>&middot;</i><b class="lateN">'+overdue.length+'</b> past due':'')+'</span>'
      + '<button class="btn" id="wkToday" aria-pressed="'+(wkState.todayOnly?"true":"false")+'">Today</button>'
      + '<button class="btn" id="wkAll">Expand</button>'
      + '<button class="btn" id="wkFocus">Today only</button>'
      + '</div>'
      + banner
      + bldUndoHtml()
      + bldCutHtml(BLD_WK)
      + '<div class="wkdays">'+cards+'</div>'
      + howto('Straight off your <b>DO NOT FORGET THIS SHIZ</b> sheet. <b>STUDENT</b> marks the items the sheet flags as a weekly student task. '
      + 'Anything left unticked from earlier in the week rides along at the top of today, under Past due, and ticking it there ticks it on its own day too. '
      + 'Boxes are keyed to the week, so every week starts empty on its own and the weeks behind you stay on the record.');
    bldReArm(weekroot);
  }

  (function(){
    var saved=lsGet("fpb_focus");
    if(saved!==null) wkState.focus=saved==="1";
    else wkState.focus=(window.matchMedia&&window.matchMedia("(max-width:720px)").matches);
  })();
  function wkDefaultOpen(){
    wkState.open={};
    if(wkState.off===0&&wkState.todayOnly){ wkState.open[new Date().getDay()]=true; return; }
    if(!wkState.todayOnly){ for(var i=0;i<7;i++) wkState.open[i]=true; }
  }

  function wkPatch(box){
    var card=box.closest(".dcard"); if(!card) return;
    var i=Number(card.getAttribute("data-day"));
    var sun=wkSunday(wkState.off), g=wkGame(sun), st=wkStat(sun,i,g);
    var left=st.total-st.done, complete=st.total>0&&left===0;
    var row=box.closest(".trow"); if(row) row.classList.toggle("tdone",box.checked);
    var c=card.querySelector(".count"); if(c) c.innerHTML="<b>"+st.done+"</b>/"+st.total;
    var p=card.querySelector(".pill:not(.p-late)");
    if(p){ p.className="pill "+(complete?"p-done":st.total?"p-part":"p-none"); p.textContent=st.total?(complete?"Done":left+" left"):"Clear"; }
    card.classList.toggle("ddone",complete&&!card.querySelector(".pastdue .trow:not(.tdone)"));
    var done=0,total=0,clear=0;
    for(var k=0;k<7;k++){ var s=wkStat(sun,k,g); done+=s.done; total+=s.total; if(s.total&&s.done===s.total) clear++; }
    var late=(wkState.off===0)?wkOverdue(sun,g,new Date().getDay()).length:0;
    var line=weekroot.querySelector(".wkstat");
    if(line) line.innerHTML="<b>"+done+"</b>/"+total+" done<i>&middot;</i><b>"+clear+"</b>/7 days"
      +(late?'<i>&middot;</i><b class="lateN">'+late+'</b> past due':"");
    var lp=weekroot.querySelector(".dcard.iscur .pill.p-late");
    if(lp){ if(late) lp.textContent=late+" past due"; else lp.remove(); }
  }

  /* ---------------- packing lists ---------------- */
  /* Home Game Setup starts empty on purpose. Everything in it is typed on
     the page, and it is keyed per game like the other per-game lists. */
  /* The sheet's own version, frozen, so Reset always has something to go
     back to however much you have changed on the page. */
  ["semi","road","stay","bowl"].forEach(function(k){
    if(!PACKS[k]) return;
    PACKS[k].gen=(PACKS[k].prep||[]).concat(PACKS[k].groups||[]);
    PACKS[k].build=true;
    PACKS[k].live=(function(kk){ return function(){ return bldPack(kk); }; })(k);
  });

  PACKS.home={name:"Home Game Setup",tab:"Home Setup",scope:"home",word:"set",
    sub:"What we set up at the stadium for a home game. Build it with the buttons below; it is yours, not off a sheet.",
    live:bldHome, build:true, gen:[], groups:[]};

  function pkGames(scope){
    if(scope==="season") return [];
    var want=scope==="home"?"H":"A";
    var out=(DATA.weeks||[]).filter(function(w){ return w.site===want; });
    /* an announced bowl or championship travels too; a neutral site is a trip */
    try{
      postWeeks().forEach(function(w){
        if(!w.official||!w.date) return;
        if((w.site==="N"?"A":w.site)===want) out.push(w);
      });
    }catch(e){}
    return out;
  }
  function pkDefault(scope){
    var gs=pkGames(scope); if(!gs.length) return null;
    var now=Date.now(), pick=null;
    gs.forEach(function(w){ if(!pick){ var k=tulaneKick(w); if(k&&k.at.getTime()+GAME_LEN>now) pick=w; } });
    return pick||gs[gs.length-1];
  }
  function pkWeek(key){
    var p=PACKS[key];
    if(p.scope==="season") return null;
    var gs=pkGames(p.scope);
    /* until you move the arrows yourself, this always lands on the next
       trip, so a tab left open all week does not stay on a played game */
    if(!pkState[key+"|touched"]){
      var d=pkDefault(p.scope);
      pkState[key]=d?d.week:null;
    }
    var out=null;
    gs.forEach(function(w){ if(w.week===pkState[key]) out=w; });
    if(!out&&gs.length){ var d2=pkDefault(p.scope); out=d2||gs[gs.length-1]; pkState[key]=out.week; }
    return out;
  }
  /* A season-wide list still starts fresh each year. */
  function pkId(key,w,gname,t){
    var scope=w?("w"+w.week):("s"+seasonYear());
    return "pk|"+key+"|"+scope+"|"+ckSlug(gname)+"|"+ckSlug(t);
  }
  function pkAllGroups(p){
    if(p.live) return p.live();                 /* a list you built yourself */
    return (p.prep||[]).concat(p.groups||[]);
  }
  /* A row you typed keeps its own id, so renaming it does not lose the tick. */
  function pkKeyOf(gr,ix){
    var it=gr.items[ix];
    if(!it.id) return pkPath(gr,ix);
    /* A "k|" prefix means the row came off the sheet: its key stays the
       path it always had, so taking a list over wipes no checkmark. A
       generated id is base36 and can never contain a pipe, so the two
       can never be mistaken for each other. */
    return it.id.slice(0,2)==="k|"?it.id.slice(2):("x"+it.id);
  }
  /* "Brandon laptop bag / Mouse", so two different bags can both hold a Mouse */
  function pkPath(gr,ix){
    var it=gr.items[ix], d=it.d||0, trail=[], look=d;
    for(var i=ix-1;i>=0&&look>0;i--){
      var pd=gr.items[i].d||0;
      if(pd<look){ trail.unshift(gr.items[i].t); look=pd; }
    }
    return trail.concat(it.t).join(" / ");
  }
  function pkStat(key,w){
    var p=PACKS[key], done=0, total=0;
    pkAllGroups(p).forEach(function(gr){ gr.items.forEach(function(it,ix){
      total++; if(STATE.checks[pkId(key,w,gr.g,pkKeyOf(gr,ix))]) done++; }); });
    return {done:done,total:total};
  }

  function renderPack(key){
    if(!packroot) return;
    var p=PACKS[key], w=pkWeek(key), st=pkStat(key,w);
    var left=st.total-st.done;
    var gs=pkGames(p.scope), idx=-1;
    gs.forEach(function(x,i){ if(w&&x.week===w.week) idx=i; });

    var who;
    if(p.scope==="season") who='<span class="wkctx">Whole season, one list</span>';
    else if(!w) who='<span class="wkctx">No '+(p.scope==="home"?"home":"road")+' games on the schedule</span>';
    else who='<span class="wknow">'+esc(sideWord(w.site||(p.scope==="home"?"H":"A"))+w.opp)+'</span>'
           + '<span class="wkctx">'+esc(w.date+(w.event?" \u00b7 "+w.event:""))+'</span>';

    var nav=p.scope==="season"?"":
        '<button class="btn wkarrow" id="pkPrev"'+(idx<=0?" disabled":"")+' aria-label="Previous game">&#9664;</button>'
      + '<button class="btn wkarrow" id="pkNext"'+(idx<0||idx>=gs.length-1?" disabled":"")+' aria-label="Next game">&#9654;</button>';

    var body="";
    /* a long list starts folded so you can see the whole shape of it */
    var foldByDefault=st.total>30;
    function groupHtml(gr,isPrep){
      var gd=0;
      gr.items.forEach(function(it,ix){ if(STATE.checks[pkId(key,w,gr.g,pkKeyOf(gr,ix))]) gd++; });
      var gleft=gr.items.length-gd, gdone=gleft===0;
      var shut=pkState[key+"|shut|"+gr.g];
      var open=shut===undefined?!foldByDefault:!shut;
      body+='<section class="dcard pkgroup'+(isPrep?" pkprep":"")+(gdone?" ddone":"")+(open?"":" shut")+'" data-grp="'+esc(gr.g)+'">'
        + '<div class="dhead" role="button" tabindex="0" aria-expanded="'+(open?"true":"false")+'">'
        + '<span class="dmeta"><b>'+esc(gr.g)+'</b></span>'
        + '<span class="count"><b>'+gd+'</b>/'+gr.items.length+'</span>'
        + '<span class="pill '+(gdone?"p-done":"p-part")+'">'+(gdone?"Done":gleft+" left")+'</span>'
        + '<span class="caret" aria-hidden="true">&#9662;</span></div><div class="dbody">';
      gr.items.forEach(function(it,ix){
        var id=pkId(key,w,gr.g,pkKeyOf(gr,ix)), on=!!STATE.checks[id];
        var d=it.d||0, nx=gr.items[ix+1];
        var head=!!(nx&&(nx.d||0)>d);
        body+='<label class="trow d'+d+(head?" thead":"")+(on?" tdone":"")+'">'
          + '<input class="box" type="checkbox" data-id="'+esc(id)+'"'+(on?" checked":"")+'>'
          + '<span class="tmain"><span class="tname">'+esc(it.t)+'</span>'
          + (it.n?'<span class="tnote">'+esc(it.n)+'</span>':"")+'</span>'
          + '<span class="tflags">'+(it.q?'<span class="tqty">&times;'+esc(it.q)+'</span>':"")+'</span>'
          + whoTag(id,"")+'</label>';
      });
      body+='</div></section>';
    }
    if(p.prep&&p.prep.length&&!bldOwned(key)){
      body+='<div class="pkhead"><b>Before the bowl</b><span>Things to do, in the order they happen. '
          + 'Drafted from last year&#39;s bowl notes, so change whatever is wrong.</span></div>';
      p.prep.forEach(function(gr){ groupHtml(gr,true); });
      body+='<div class="pkhead"><b>Equipment</b><span>What goes in the truck.</span></div>';
    }
    (p.live?p.live():p.groups).forEach(function(gr){ groupHtml(gr,(p.prep||[]).indexOf(gr)>=0); });

    var notes="";
    if(p.notes&&p.notes.length){
      notes='<section class="dcard pknotes"><div class="dhead nohit"><span class="dmeta"><b>Bowl notes</b></span></div><div class="dbody"><ul>';
      p.notes.forEach(function(n){ notes+='<li>'+esc(n)+'</li>'; });
      notes+='</ul></div></section>';
    }

    packroot.innerHTML=
      '<div class="printhead">'+esc(p.name)+(w?' &middot; '+esc(sideWord(w.site||"A")+w.opp+", "+w.date):'')
        +'<i>v'+VER+'</i></div>'
      + '<div class="wkbar">'+nav+who
      + '<span class="wksp"></span>'
      + '<span class="wkstat"><b>'+st.done+'</b>/'+st.total+' '+(p.word||(p.prep?'done':'packed'))+'</span>'
      + '<button class="btn" id="pkAll">Expand</button>'
      + '<button class="btn" id="pkShut">Collapse</button>'
      + (p.build?'<button class="btn" id="pkBuild" data-arm="takeover:'+esc(key)+'" aria-pressed="'+(hgBuild?"true":"false")+'">'
          +(hgBuild?"Done building":(pkAllGroups(p).length?"Edit this list":"Build the list"))
          +'</button>':"")
      + ((p.build&&hgBuild)
          ?'<button class="btn" id="pkHist" aria-pressed="'+(hgHist?"true":"false")+'">Earlier versions</button>':"")
      + ((p.build&&hgBuild&&p.gen.length&&bldOwned(key))
          ?'<button class="btn" id="pkReset" data-arm="reset:'+esc(key)+'">Reset to the sheet</button>':"")
      + '</div>'
      + (key==="semi"?semiBar(w):"")
      + (p.sub?'<p class="pksub">'+esc(p.sub)+'</p>':"")
      + (p.build&&!pkAllGroups(p).length&&!hgBuild
          ? '<div class="bldempty"><h2>Nothing here yet</h2>'
            + '<p>This list is yours to write. Hit <b>Build the list</b>, add a section, '
            + 'then add rows to it. Everybody sees the same list and every home game gets '
            + 'its own set of checkmarks.</p></div>' : "")
      + bldCutHtml(bldTabKey(key))
      + (p.build?bldSugHtml(key):"")
      + '<div class="wkdays">'+body+notes+'</div>'
      + (p.build?bldHistHtml(bldTabKey(key))+hgBuilderHtml():"")
      + howto(esc(p.name)+' off your travel sheet. '
      + (p.scope==="season"?'One list for the season.':'Boxes are keyed to the game above, so every trip starts empty on its own and past trips stay on the record.')
      + ' Checkmarks are shared: everyone with this link sees the same list.');
    bldReArm(packroot);
  }

  /* "Loads Wednesday, two days before kickoff" plus a day picker, because
     Equipment moves the semi and nobody should have to wait on a rebuild. */
  function semiBar(w){
    if(!w) return "";
    var gw=null;
    (DATA.weeks||[]).forEach(function(x){ if(x.week===w.week) gw=x; });
    var p=wkDate(gw||w); if(!p) return "";
    var kick=new Date(p.y,p.mo,p.d);
    var sun=new Date(kick.getTime()); sun.setDate(sun.getDate()-sun.getDay());
    var g={w:gw||w,d:kick,i:kick.getDay(),bye:false};
    var sd=semiDay(sun,g), custom=semiIsCustom(g);
    var out=0-(sd-g.i);
    var opts="";
    for(var i=0;i<7;i++){
      var dd=wkDayDate(sun,i);
      var away=g.i-i;
      opts+='<option value="'+ckISO(dd)+'"'+(i===sd?" selected":"")+'>'
        + WK_DAYS[i].n+" "+ckNice(dd)
        + (away>0?" ("+away+" day"+(away===1?"":"s")+" out)":(away===0?" (game day)":""))
        + '</option>';
    }
    return '<div class="semibar">'
      + '<span class="semilab">Semi loads</span>'
      + '<select class="semisel" id="semiDay">'+opts+'</select>'
      + (custom?'<button type="button" class="btn semireset" id="semiReset">Back to default</button>'
               :'<span class="semidef">Default: two days before kickoff</span>')
      + '<span class="semierr" id="semiErr"></span>'
      + '<span class="seminote">The box pack lands the day before, and the Week tab moves both.</span>'
      + '</div>';
  }

  function pkPatch(box){
    var card=box.closest(".pkgroup"); if(!card) return;
    var row=box.closest(".trow"); if(row) row.classList.toggle("tdone",box.checked);
    var all=card.querySelectorAll(".trow"), done=0;
    all.forEach(function(r){ if(r.querySelector(".box").checked) done++; });
    var left=all.length-done, complete=left===0;
    var c=card.querySelector(".count"); if(c) c.innerHTML="<b>"+done+"</b>/"+all.length;
    var p=card.querySelector(".pill");
    if(p){ p.className="pill "+(complete?"p-done":"p-part"); p.textContent=complete?"Done":left+" left"; }
    card.classList.toggle("ddone",complete);
    var st=pkStat(TAB,pkWeek(TAB));
    var line=packroot.querySelector(".wkstat");
    if(line) line.innerHTML="<b>"+st.done+"</b>/"+st.total+" "
      +((PACKS[TAB]&&PACKS[TAB].word)||((PACKS[TAB]&&PACKS[TAB].prep)?"done":"packed"));
  }

  function listPatch(box){
    if(box.closest("#packroot")) return pkPatch(box);
    return wkPatch(box);
  }

  /* ---------------- shared wiring ---------------- */
  function onListChange(e){
    var b=e.target;
    if(!b.classList||!b.classList.contains("box")) return;
    var id=b.getAttribute("data-id"), on=b.checked;
    change(id,on).then(function(ok){ if(ok) remember([{id:id,to:on}]); });
  }
  function onHeadClick(e){
    var h=e.target.closest&&e.target.closest(".dhead");
    if(!h||h.classList.contains("nohit")) return false;
    var card=h.parentNode;
    if(card.classList.contains("pkgroup")){
      var g=card.getAttribute("data-grp"), k=TAB+"|shut|"+g;
      pkState[k]=!card.classList.contains("shut");
      card.classList.toggle("shut",!!pkState[k]);
      h.setAttribute("aria-expanded",pkState[k]?"false":"true");
    } else {
      var i=Number(card.getAttribute("data-day"));
      wkState.open[i]=!wkState.open[i];
      card.classList.toggle("shut",!wkState.open[i]);
      h.setAttribute("aria-expanded",wkState.open[i]?"true":"false");
    }
    return true;
  }

  if(weekroot){
    weekroot.addEventListener("change",onListChange);
    weekroot.addEventListener("submit",function(e){
      if(e.target.classList&&e.target.classList.contains("bldadd")){ e.preventDefault(); bldWeekSubmit(e.target); }
    });
    weekroot.addEventListener("click",function(e){
      if(e.target.classList&&e.target.classList.contains("box")) return;
      if(!e.target.closest) return;

      /* rows you typed yourself */
      var ap=e.target.closest("[data-addday]");
      if(ap){ e.preventDefault(); e.stopPropagation();
              bldAdd=Number(ap.getAttribute("data-addday")); bldEdit="";
              wkState.open[bldAdd]=true; renderWeek();
              var f=weekroot.querySelector(".bldadd .bldt"); if(f) f.focus(); return; }
      if(e.target.closest(".bldcancel")){ e.preventDefault(); e.stopPropagation();
              bldAdd=-1; bldEdit=""; renderWeek(); return; }
      var wi=e.target.closest("[data-win]");
      if(wi){ e.preventDefault(); e.stopPropagation(); return bldWeekIndent(wi.getAttribute("data-win"),1); }
      var wo=e.target.closest("[data-wout]");
      if(wo){ e.preventDefault(); e.stopPropagation(); return bldWeekIndent(wo.getAttribute("data-wout"),-1); }
      var wu=e.target.closest("[data-wup]");
      if(wu){ e.preventDefault(); e.stopPropagation(); return bldWeekMove(wu.getAttribute("data-wup"),-1); }
      var wdn=e.target.closest("[data-wdn]");
      if(wdn){ e.preventDefault(); e.stopPropagation(); return bldWeekMove(wdn.getAttribute("data-wdn"),1); }
      var we=e.target.closest("[data-wkedit]");
      if(we){ e.preventDefault(); e.stopPropagation();
              bldEdit=we.getAttribute("data-wkedit"); bldAdd=-1;
              var hit=bldLook(bldEdit); if(hit) wkState.open[Number(hit.d)]=true;
              renderWeek();
              var f2=weekroot.querySelector(".bldadd .bldt"); if(f2) f2.focus(); return; }
      var wd=e.target.closest("[data-wkdel]");
      if(wd){
        e.preventDefault(); e.stopPropagation();
        if(bldArm(wd,"wdel:"+wd.getAttribute("data-wkdel"),"Remove it?")) return;
        bldWeekDel(wd.getAttribute("data-wkdel")); return;
      }

      var gl=e.target.closest("[data-golist]");
      if(gl){ e.preventDefault(); e.stopPropagation(); showTab(gl.getAttribute("data-golist")); return; }
      if(e.target.closest("#bldUndoBtn")) return bldDoUndo();
      if(e.target.closest("#bldUndoNo")){ bldUndo=null; renderWeek(); return; }
      var cc=e.target.closest("[data-cutclear]");
      if(cc){ if(bldArm(cc,"cut:"+cc.getAttribute("data-cutclear"),"Start it fresh?")) return;
              return bldCutClear(cc.getAttribute("data-cutclear")); }
      if(e.target.closest("#wkPrev")){ wkState.off--; wkDefaultOpen(); renderWeek(); return; }
      if(e.target.closest("#wkNext")){ wkState.off++; wkDefaultOpen(); renderWeek(); return; }
      if(e.target.closest("#wkNow")){ wkState.off=0; wkState.todayOnly=true; wkDefaultOpen(); renderWeek(); return; }
      if(e.target.closest("#wkToday")){ wkState.todayOnly=!wkState.todayOnly; wkDefaultOpen(); renderWeek(); return; }
      if(e.target.closest("#wkAll")){ wkState.todayOnly=false; wkDefaultOpen(); renderWeek(); return; }
      if(e.target.closest("#wkFocus")){ wkState.focus=true; wkState.off=0; lsSet("fpb_focus","1"); renderWeek(); return; }
      if(e.target.closest("#wkWhole")){ wkState.focus=false; lsSet("fpb_focus","0"); wkDefaultOpen(); renderWeek(); return; }
      if(e.target.closest("#ckPrint")){ window.print(); return; }
      onHeadClick(e);
    });
    var wDrag="";
    weekroot.addEventListener("dragstart",function(e){
      var row=e.target.closest&&e.target.closest("[data-wdrag]"); if(!row) return;
      wDrag=row.getAttribute("data-wdrag"); row.classList.add("bldlift");
      try{ e.dataTransfer.effectAllowed="move"; e.dataTransfer.setData("text/plain",wDrag); }catch(x){}
    });
    weekroot.addEventListener("dragend",function(){
      wDrag="";
      [].forEach.call(weekroot.querySelectorAll(".bldlift,.bldover"),function(n){
        n.classList.remove("bldlift","bldover"); });
    });
    weekroot.addEventListener("dragover",function(e){
      var row=e.target.closest&&e.target.closest("[data-wdrag]"); if(!row||!wDrag) return;
      if(row.getAttribute("data-wdrag")===wDrag) return;
      e.preventDefault();
      [].forEach.call(weekroot.querySelectorAll(".bldover"),function(n){ n.classList.remove("bldover"); });
      row.classList.add("bldover");
    });
    weekroot.addEventListener("drop",function(e){
      var row=e.target.closest&&e.target.closest("[data-wdrag]"); if(!row||!wDrag) return;
      e.preventDefault();
      var a=wDrag; wDrag="";
      bldWeekDrop(a,row.getAttribute("data-wdrag"));
    });
    weekroot.addEventListener("keydown",function(e){
      if(e.key!=="Enter"&&e.key!==" ") return;
      var h=e.target.closest&&e.target.closest(".dhead"); if(!h) return;
      e.preventDefault(); h.click();
    });
  }
  if(packroot){
    packroot.addEventListener("change",function(e){
      var sel=e.target.closest&&e.target.closest("#semiDay"); if(!sel) return;
      var gw=pkWeek("semi"); if(!gw) return;
      var err=document.getElementById("semiErr");
      if(err) err.textContent="Saving…";
      saveSetting(semiKey(gw),sel.value).then(function(bad){
        if(err) err.textContent=bad||"";
        if(!bad){ renderPack(TAB); renderWeek(); flash("Semi day set."); }
      });
    });
    packroot.addEventListener("change",onListChange);
    packroot.addEventListener("submit",function(e){
      if(e.target.getAttribute&&e.target.getAttribute("data-hgform")!==null){ e.preventDefault(); return hgItemSubmit(e.target); }
      if(e.target.getAttribute&&e.target.getAttribute("data-hggroup")!==null){ e.preventDefault(); return hgGroupSubmit(e.target); }
    });
    packroot.addEventListener("click",function(e){
      if(e.target.classList&&e.target.classList.contains("box")) return;
      if(!e.target.closest) return;
      var p=PACKS[TAB]; if(!p) return;

      /* building a list of your own */
      if(e.target.closest("#pkBuild")){
        if(!hgBuild&&p.gen&&p.gen.length&&!bldOwned(TAB)){
          var btn=e.target.closest("#pkBuild");
          if(bldArm(btn,"takeover:"+TAB,"Take this list over?")) return;
          var k=TAB;
          bldTakeOver(k).then(function(ok){
            if(!ok) return;
            hgBuild=true; hgAdd=""; hgEdit=""; renderPack(k);
            flash("This list is yours now. Reset puts the sheet version back.");
          });
          return;
        }
        hgBuild=!hgBuild; hgAdd=""; hgEdit=""; renderPack(TAB); return;
      }
      if(e.target.closest("#bldSugBtn")){ bldSugOpen=!bldSugOpen; renderPack(TAB); return; }
      var cc=e.target.closest("[data-cutclear]");
      if(cc){ if(bldArm(cc,"cut:"+cc.getAttribute("data-cutclear"),"Start it fresh?")) return;
              return bldCutClear(cc.getAttribute("data-cutclear")); }
      if(e.target.closest("#pkHist")){ hgHist=!hgHist; renderPack(TAB); return; }
      var hr=e.target.closest("[data-hrest]");
      if(hr){
        if(bldArm(hr,"hrest:"+TAB+":"+hr.getAttribute("data-hrest"),"Go back to it?")) return;
        var kk=bldTabKey(TAB), ii=Number(hr.getAttribute("data-hrest"));
        bldRestore(kk,ii).then(function(bad){
          if(bad){ flash(bad); return; }
          hgHist=false; bldUndo=null; renderPack(TAB); flash("Back to that version.");
        });
        return;
      }
      if(e.target.closest("#bldUndoBtn")) return bldDoUndo();
      if(e.target.closest("#bldUndoNo")){ bldUndo=null; renderPack(TAB); return; }
      var sa=e.target.closest("[data-sugadd]");
      if(sa) return bldSugAdd(TAB,sa.getAttribute("data-sugadd"));
      var sw=e.target.closest("[data-sugword]");
      if(sw) return bldSugWord(TAB,sw.getAttribute("data-sugword"));
      var sd=e.target.closest("[data-sugdel]");
      if(sd) return bldSugDel(TAB,sd.getAttribute("data-sugdel"));
      var ss=e.target.closest("[data-sugskip]");
      if(ss) return bldSugSkip(TAB,ss.getAttribute("data-sugskip"));
      if(e.target.closest("#pkReset")){
        var rb=e.target.closest("#pkReset");
        if(bldArm(rb,"reset:"+TAB,"Throw away your edits?")) return;
        bldResetList(TAB); return;
      }
      if(e.target.closest(".bldcancel")){ e.preventDefault(); hgAdd=""; hgEdit=""; renderPack(TAB); return; }
      var ha=e.target.closest("[data-hgadd]");
      if(ha){ hgAdd=ha.getAttribute("data-hgadd"); hgEdit=""; renderPack(TAB);
              var f=packroot.querySelector(".bldinline .bldt"); if(f) f.focus(); return; }
      var hi=e.target.closest("[data-in]");
      if(hi){ var a1=hi.getAttribute("data-in").split("\u241F"); return hgIndent(a1[0],a1[1],1); }
      var ho=e.target.closest("[data-out]");
      if(ho){ var a2=ho.getAttribute("data-out").split("\u241F"); return hgIndent(a2[0],a2[1],-1); }
      var hu=e.target.closest("[data-up]");
      if(hu){ var a=hu.getAttribute("data-up").split("\u241F"); return hgMove(a[0],a[1],-1); }
      var hdn=e.target.closest("[data-down]");
      if(hdn){ var b2=hdn.getAttribute("data-down").split("\u241F"); return hgMove(b2[0],b2[1],1); }
      var he=e.target.closest("[data-edit]");
      if(he){ hgEdit=he.getAttribute("data-edit"); hgAdd=""; renderPack(TAB);
              var f2=packroot.querySelector(".bldinline .bldt"); if(f2) f2.focus(); return; }
      var hd=e.target.closest("[data-del]");
      if(hd){
        var c=hd.getAttribute("data-del").split("\u241F");
        /* a section takes everything in it, so say how much before you nod */
        var n=c[1]?0:hgCount(c[0]);
        if(bldArm(hd,"del:"+TAB+":"+hd.getAttribute("data-del"),
                  c[1]?"Remove it?":(n?("Remove it and "+n+" row"+(n===1?"":"s")+"?"):"Remove it?"))) return;
        return hgDel(c[0],c[1]);
      }
      if(e.target.closest("#pkPrev")||e.target.closest("#pkNext")){
        var gs=pkGames(p.scope), w=pkWeek(TAB), idx=-1;
        gs.forEach(function(x,i){ if(w&&x.week===w.week) idx=i; });
        idx+=e.target.closest("#pkNext")?1:-1;
        if(idx>=0&&idx<gs.length){ pkState[TAB]=gs[idx].week; pkState[TAB+"|touched"]=true; renderPack(TAB); }
        return;
      }
      if(e.target.closest("#semiReset")){
        var gw0=pkWeek("semi");
        saveSetting(semiKey(gw0),"").then(function(bad){
          document.getElementById("semiErr") && (document.getElementById("semiErr").textContent=bad||"");
          if(!bad){ renderPack(TAB); renderWeek(); flash("Semi day back to the default."); }
        });
        return;
      }
      if(e.target.closest("#pkAll")){ pkAllGroups(p).forEach(function(gr){ pkState[TAB+"|shut|"+gr.g]=false; }); renderPack(TAB); return; }
      if(e.target.closest("#pkShut")){ pkAllGroups(p).forEach(function(gr){ pkState[TAB+"|shut|"+gr.g]=true; }); renderPack(TAB); return; }
      if(e.target.closest("#ckPrint")){ window.print(); return; }
      onHeadClick(e);
    });
    /* Drag a row onto another and it tucks underneath it. Touch screens do
       not fire these at all, which is exactly why the arrows exist too. */
    var dragFrom="";
    packroot.addEventListener("dragstart",function(e){
      var row=e.target.closest&&e.target.closest("[data-drag]"); if(!row) return;
      dragFrom=row.getAttribute("data-drag");
      row.classList.add("bldlift");
      try{ e.dataTransfer.effectAllowed="move"; e.dataTransfer.setData("text/plain",dragFrom); }catch(x){}
    });
    packroot.addEventListener("dragend",function(){
      dragFrom="";
      [].forEach.call(packroot.querySelectorAll(".bldlift,.bldover"),function(n){
        n.classList.remove("bldlift","bldover"); });
    });
    packroot.addEventListener("dragover",function(e){
      var row=e.target.closest&&e.target.closest("[data-drag]"); if(!row||!dragFrom) return;
      if(row.getAttribute("data-drag")===dragFrom) return;
      if(row.getAttribute("data-drag").split("\u241F")[0]!==dragFrom.split("\u241F")[0]) return;
      e.preventDefault();
      [].forEach.call(packroot.querySelectorAll(".bldover"),function(n){ n.classList.remove("bldover"); });
      row.classList.add("bldover");
    });
    packroot.addEventListener("drop",function(e){
      var row=e.target.closest&&e.target.closest("[data-drag]"); if(!row||!dragFrom) return;
      e.preventDefault();
      var a=dragFrom.split("\u241F"), b=row.getAttribute("data-drag").split("\u241F");
      dragFrom="";
      if(a[0]!==b[0]) return;
      hgDrop(a[0],a[1],b[1]);
    });
    packroot.addEventListener("keydown",function(e){
      if(e.key!=="Enter"&&e.key!==" ") return;
      var h=e.target.closest&&e.target.closest(".dhead"); if(!h||h.classList.contains("nohit")) return;
      e.preventDefault(); h.click();
    });
  }

  /* ---------------- tabs ---------------- */
  function showTab(which){
    TAB=which;
    var onBoard=which==="board", onWeek=which==="week", onPack=!!PACKS[which];
    var onAir=which==="air", onOffice=which==="office", onBuy=which==="buy";
    var b=document.body;
    b.classList.toggle("wk-mode",!onBoard);
    b.classList.toggle("on-week",onWeek);
    b.classList.toggle("on-pack",onPack);
    b.classList.toggle("on-air",onAir);
    b.classList.toggle("on-office",onOffice);
    b.classList.toggle("on-buy",onBuy);
    [].forEach.call(document.querySelectorAll(".tabg .btn"),function(t){
      t.setAttribute("aria-pressed",t.getAttribute("data-tab")===which?"true":"false");
    });
    var h=document.querySelector(".brand-txt h1");
    if(h){
      if(!h.getAttribute("data-board")) h.setAttribute("data-board",h.textContent);
      h.textContent=onBoard?h.getAttribute("data-board")
        :(onWeek?"Weekly Checklist":(onAir?"Trackers":(onOffice?"Office":(onBuy?"Purchase List":PACKS[which].name))));
    }
    var pm=document.querySelector(".printmeta");
    if(pm){
      if(!pm.getAttribute("data-board")) pm.setAttribute("data-board",pm.innerHTML);
      pm.innerHTML=onBoard?pm.getAttribute("data-board")
        :((onOffice||onBuy)?'Printed <span id="printDate"></span>'
                  :'Printed <span id="printDate"></span><span class="pm-sep"></span>Done by ____________');
      try{ stampPrint(); }catch(e){}
    }
    var tb=document.querySelector('.tabg .btn[data-tab="'+which+'"]');
    document.title=(tb?tb.textContent.trim()+" \u00b7 ":"")+"Football Video Ops";
    lsSet("fpb_tab",which);
    if(onWeek) renderWeek();
    if(onPack){ hgBuild=false; hgAdd=""; hgEdit=""; bldSugOpen=false; hgHist=false; bldArmClear(); renderPack(which); }
    if(onAir) renderAir();
    if(onOffice){ renderOffice(); if(officeCode()&&!OFF) officeBoot(); }
    if(onBuy) renderBuy();
    window.scrollTo({top:0,behavior:"auto"});
  }
  function renderCurrentList(){
    if(TAB==="week") renderWeek();
    else if(TAB==="air") renderAir();
    else if(TAB==="office") renderOffice();
    else if(TAB==="buy") renderBuy();
    else if(PACKS[TAB]) renderPack(TAB);
  }
  [].forEach.call(document.querySelectorAll(".tabg .btn"),function(t){
    t.addEventListener("click",function(){ showTab(t.getAttribute("data-tab")); });
  });

  /* ================================================================
     Lists you build yourself.

     Two uses, one engine. On the Week tab a quiet + at the end of each
     day adds a task, either to that day this week only or to that
     weekday from now on. On Home Game Setup the whole list is yours:
     sections and rows, made on the page, no SQL and nothing to upload.

     It all lives in the settings table the semi-load day picker
     already uses, so everybody sees the same list. Checkmarks are
     ordinary checkmarks in the checks table, keyed by the row's own
     id rather than its words, so renaming a row never loses what was
     already ticked.
     ================================================================ */
  var BLD_WK="wk:tasks", BLD_HG="hg:list";
  /* Which stored list the tab you are looking at edits. Home Game Setup was
     born on the site; the pack lists were generated off the travel sheet and
     only move into the database the first time you take one over. */
  function bldTabKey(k){ k=k||TAB; return k==="home"?BLD_HG:("pk:"+k); }
  function bldSkipKey(k){ return "pkx:"+(k||TAB); }
  function bldHistKey(k){ return "pkh:"+(k||TAB); }
  /* What a section or row was called on the sheet, whatever you renamed it
     to since. That link is the whole reason a rename does not read as a
     row being deleted and a different one appearing. */
  function bldSheetName(x,fallback){
    return (x.id&&x.id.slice(0,2)==="k|")?x.id.slice(2):fallback;
  }
  function bldOwned(k){ return bldGet(bldTabKey(k)).length>0; }

  /* The generated list, exactly as the sheet made it, kept so Reset works. */
  function bldPack(k){
    var stored=bldGet(bldTabKey(k));
    if(stored.length) return stored.map(function(gr){
      return {g:gr.g, gid:gr.id, items:bldNorm((gr.items||[]).slice()).map(function(it){
        return {t:it.t, n:it.n||"", q:it.q||"", id:it.id, d:it.d||0}; })};
    });
    return (PACKS[k]&&PACKS[k].gen)||[];
  }
  /* Taking a list over copies it in as it stands. Every row keeps the key its
     checkmarks were already filed under, so nothing that was ticked is lost. */
  function bldSeed(k){
    return ((PACKS[k]&&PACKS[k].gen)||[]).map(function(gr){
      return {id:"k|"+gr.g, g:gr.g, items:(gr.items||[]).map(function(it,ix){
        return {id:"k|"+pkPath(gr,ix), t:it.t, n:it.n||"", q:it.q||"", d:it.d||0}; })};
    });
  }

  var BLD_CUT={};
  function bldGet(key){
    var raw=SETTINGS[key];
    try{
      var v=JSON.parse(raw||"[]");
      if(Array.isArray(v)){ delete BLD_CUT[key]; return v; }
    }catch(e){}
    /* an empty list and a list we cannot read are not the same thing, and
       showing the second as the first is how work looks like it vanished */
    if(raw) BLD_CUT[key]=String(raw).length;
    return [];
  }
  function bldCut(key){ return BLD_CUT[key]||0; }
  function bldId(){
    return Math.random().toString(36).slice(2,8)+Date.now().toString(36).slice(-3);
  }

  /* Read the row back out of the database before changing it, so two people
     editing different rows at the same time do not overwrite each other. */
  /* A value stored under the old 200 character limit comes back chopped in
     the middle of a word and will not parse. Say which it is, because the
     two need completely different things from you. */
  function bldCutMsg(v){
    var n=String(v||"").length;
    if(n>=195&&n<=205){
      logProblem("a list was cut off in the database",
        "stored length "+n+", the old set_setting limit was 200. Run settings-bigger.sql.");
      return "This list was cut off by an old 200 character limit in the database. "
           + "Run settings-bigger.sql in Supabase, then type it again. Nothing was changed.";
    }
    logProblem("a list would not read back","stored length "+n);
    return "That list did not read back properly. Nothing was changed.";
  }

  async function bldReadRaw(key){
    if(!sb) return {err:"Not connected."};
    var r;
    try{ r=await sb.from("settings").select("v").eq("k",key).limit(1); }
    catch(e){ r={error:e}; }
    if(!r||r.error){ logRead("a list",r&&r.error); return {err:"read failed"}; }
    return {err:"",v:(r.data&&r.data.length)?(r.data[0].v||""):""};
  }

  async function bldSave(key,mutate){
    if(!sb) return "Not connected.";
    /* The read has to succeed. It used to fall back to whatever was in the
       local cache, which meant that if the cache was empty or stale, the
       next save wrote a short list straight over a good one and the work
       was gone for good. Better to refuse the change than to lose the list. */
    var got=await bldReadRaw(key);
    if(got.err) return "Could not reach the list to change it. Nothing was saved.";
    var cur=null;
    if(got.v){
      try{
        var fresh=JSON.parse(got.v);
        if(!Array.isArray(fresh)) return bldCutMsg(got.v);
        cur=fresh;
      }catch(e){ return bldCutMsg(got.v); }
    } else cur=[];
    SETTINGS[key]=JSON.stringify(cur);          /* the cache was wrong, fix it */
    /* Snapshot BEFORE the change. cur.slice() is a shallow copy, so a mutate
       that edits a row in place changes cur too: taken afterwards, before and
       after were identical and nothing was ever filed in the history. */
    var before=JSON.stringify(cur);
    var next=mutate(cur.slice());
    if(!Array.isArray(next)) return "Nothing was changed.";
    if(key!==BLD_WK) next.forEach(function(gr){ bldNorm(gr.items); });
    var after=JSON.stringify(next);
    var bad=await saveSetting(key,after);
    if(bad) return bad;
    /* Read it straight back. The database silently cut values to 200
       characters and the page never knew, because it kept showing what it
       had sent rather than what was stored. Everything looked right until
       the next reload, when the work was gone. If what comes back is not
       what went in, say so now, while there is still something to say. */
    var chk=await bldReadRaw(key);
    if(chk.err===""&&chk.v!==after){
      SETTINGS[key]=chk.v;
      logProblem("the database changed a list while saving it",
        "sent "+after.length+" characters, got back "+String(chk.v||"").length);
      return "The database did not store the whole list ("+after.length
           + " characters in, "+String(chk.v||"").length+" back). Run settings-bigger.sql in Supabase.";
    }
    if(before!==after) await bldKeep(key,before);
    return "";
  }

  /* The last ten versions of a list, so a bad afternoon is a click to undo
     rather than an evening of retyping. Put it back covers the click you
     just regretted; this covers the one you made on Tuesday. */
  var BLD_HIST=10;
  function bldHistFor(key){
    var hk=key===BLD_WK?"wkh:tasks":bldHistKey(key.replace(/^pk:/,"").replace(/^hg:list$/,"home"));
    return hk;
  }
  async function bldKeep(key,prevJson){
    var hk=bldHistFor(key);
    var list=bldGet(hk);
    list.unshift({at:new Date().toISOString(),by:lsGet("fpb_who")||"",v:prevJson});
    list=list.slice(0,BLD_HIST);
    /* ten copies of a ninety row list is a lot of text to keep in one row */
    while(list.length>2&&JSON.stringify(list).length>180000) list.pop();
    var json=JSON.stringify(list);
    /* write the cache before the await: two saves in quick succession used
       to each read the old value and the second wiped the first */
    SETTINGS[hk]=json;
    try{ await saveSetting(hk,json); }catch(e){}
  }
  function bldHistRows(v){
    var n=0;
    try{
      var d=JSON.parse(v);
      if(!Array.isArray(d)) return 0;
      d.forEach(function(x){ n+=Array.isArray(x.items)?x.items.length:1; });
    }catch(e){}
    return n;
  }
  async function bldRestore(key,i){
    var hk=bldHistFor(key), list=bldGet(hk);
    var pick=list[i]; if(!pick) return "That version is gone.";
    var now=SETTINGS[key]||"";
    var bad=await saveSetting(key,pick.v);
    if(bad) return bad;
    bldKeep(key,now);
    return "";
  }

  var hgHist=false;
  function bldHistHtml(key){
    if(!hgHist) return "";
    var list=bldGet(bldHistFor(key));
    var out='<div class="bldhist"><h4>Earlier versions of this list</h4>';
    if(!list.length) out+='<p class="dempty">No earlier versions yet. One gets kept every time the list changes.</p>';
    list.forEach(function(h,i){
      var n=bldHistRows(h.v);
      out+='<div class="bldhrow"><span class="bldhwhen">'+esc(shortDate(h.at))+'</span>'
        + '<span class="bldhwho">'+esc(whoName(h.by)||"someone")+'</span>'
        + '<span class="bldhn">'+n+' row'+(n===1?"":"s")+'</span>'
        + '<span class="wksp"></span>'
        + '<button type="button" class="btn" data-hrest="'+i+'" data-arm="hrest:'+esc(TAB)+':'+i+'">Go back to this</button></div>';
    });
    return out+'</div>';
  }

  function bldMove(list,i,dir){
    var j=i+dir;
    if(j<0||j>=list.length) return list;
    var t=list[i]; list[i]=list[j]; list[j]=t;
    return list;
  }

  /* ---------------- the Week tab ---------------- */
  function bldWeekSlot(x){ return x.every?("w"+x.d):(x.d+"|"+x.date); }
  function bldWeekFor(i,sun){
    var iso=sun?ckISO(wkDayDate(sun,i)):"";
    var out=bldGet(BLD_WK).filter(function(x){
      if(Number(x.d)!==i) return false;
      return x.every?true:(x.date===iso);
    });
    /* the rows showing on one day are one outline, so clamp them together */
    var prev=-1;
    out.forEach(function(x){
      var d=Math.max(0,Math.min(BLD_MAXD,Number(x.nd)||0));
      if(d>prev+1) d=prev+1;
      x.nd=d; prev=d;
    });
    return out;
  }
  /* index of a task inside the run of tasks that share its day and schedule */
  function bldWeekPeers(list,x){
    var slot=bldWeekSlot(x), out=[];
    list.forEach(function(y,i){ if(bldWeekSlot(y)===slot) out.push(i); });
    return out;
  }
  async function bldWeekMove(cid,dir){
    var bad=await bldSave(BLD_WK,function(list){
      var me=-1; list.forEach(function(x,i){ if(x.id===cid) me=i; });
      if(me<0) return list;
      var peers=bldWeekPeers(list,list[me]), at=peers.indexOf(me), to=at+dir;
      if(to<0||to>=peers.length) return list;
      var a=peers[at], bI=peers[to], t=list[a]; list[a]=list[bI]; list[bI]=t;
      return list;
    });
    if(bad){ flash(bad); return; }
    renderWeek();
  }
  async function bldWeekIndent(cid,dir){
    var bad=await bldSave(BLD_WK,function(list){
      list.forEach(function(x){
        if(x.id===cid) x.nd=Math.max(0,Math.min(BLD_MAXD,(Number(x.nd)||0)+dir));
      });
      return list;
    });
    if(bad){ flash(bad); return; }
    renderWeek();
  }
  async function bldWeekDrop(cid,onto){
    if(cid===onto) return;
    var bad=await bldSave(BLD_WK,function(list){
      var from=-1,to=-1;
      list.forEach(function(x,i){ if(x.id===cid) from=i; if(x.id===onto) to=i; });
      if(from<0||to<0) return list;
      if(bldWeekSlot(list[from])!==bldWeekSlot(list[to])) return list;
      var moved=list.splice(from,1)[0];
      if(from<to) to--;
      moved.nd=Math.min(BLD_MAXD,(Number(list[to].nd)||0)+1);
      list.splice(to+1,0,moved);
      return list;
    });
    if(bad){ flash(bad); return; }
    renderWeek(); flash("Nested.");
  }
  function bldWeekId(sun,i,cid){
    return "wk|"+ckISO(sun)+"|"+WK_DAYS[i].k+"|x"+cid;
  }
  function bldLook(cid){
    var hit=null;
    bldGet(BLD_WK).forEach(function(x){ if(x.id===cid) hit=x; });
    return hit;
  }

  var bldAdd=-1, bldEdit="";

  function bldAddForm(i){
    var ed=bldEdit?bldLook(bldEdit):null;
    if(bldAdd!==i&&!(ed&&Number(ed.d)===i)) return "";
    var day=WK_DAYS[i].n;
    return '<form class="bldadd" data-addto="'+i+'">'
      + '<input type="text" class="bldt" maxlength="200" autocomplete="off" placeholder="'
        + esc((ed?"":"Add something to ")+(ed?"":day))+'" value="'+esc(ed?ed.t:"")+'">'
      + '<input type="text" class="bldn" maxlength="300" autocomplete="off" '
        + 'placeholder="A note, if it needs one" value="'+esc(ed&&ed.n?ed.n:"")+'">'
      + '<div class="bldwhen">'
      + '<label><input type="radio" name="bldwhen" value="once"'+((!ed||!ed.every)?" checked":"")+'> Just this week</label>'
      + '<label><input type="radio" name="bldwhen" value="every"'+((ed&&ed.every)?" checked":"")+'> Every '+esc(day)+'</label>'
      + '</div>'
      + '<div class="blderr" role="alert"></div>'
      + '<div class="bldrow"><button type="button" class="btn bldcancel">Cancel</button>'
      + '<button type="submit" class="btn go">'+(ed?"Save":"Add it")+'</button></div>'
      + '</form>';
  }
  function bldPlus(i){
    if(bldAdd===i||bldEdit) return "";
    return '<button type="button" class="bldplus" data-addday="'+i+'">'
      + '<span aria-hidden="true">+</span> Add something to '+esc(WK_DAYS[i].n)+'</button>';
  }

  async function bldWeekSubmit(form){
    var i=Number(form.getAttribute("data-addto"));
    var t=form.querySelector(".bldt").value.trim();
    var n=form.querySelector(".bldn").value.trim();
    var every=form.querySelector('input[name="bldwhen"]:checked').value==="every";
    var err=form.querySelector(".blderr");
    if(!t){ err.textContent="Type what it is first."; form.querySelector(".bldt").focus(); return; }
    err.textContent="Saving…";
    var sun=wkSunday(), iso=ckISO(wkDayDate(sun,i));
    var editing=bldEdit;
    var bad=await bldSave(BLD_WK,function(list){
      if(editing){
        list.forEach(function(x){
          if(x.id===editing){ x.t=t; x.n=n; x.every=every; if(!every) x.date=iso; }
        });
        return list;
      }
      list.push({id:bldId(),t:t,n:n,d:i,nd:0,every:every,date:iso,
                 by:lsGet("fpb_who")||"",at:new Date().toISOString()});
      return list;
    });
    if(bad){ err.textContent=bad; return; }
    bldAdd=-1; bldEdit="";
    wkState.open[i]=true;
    renderWeek(); flash(editing?"Saved.":"Added.");
  }

  async function bldWeekDel(cid){
    bldStash(BLD_WK,"Task removed.");
    var bad=await bldSave(BLD_WK,function(list){
      return list.filter(function(x){ return x.id!==cid; });
    });
    if(bad){ flash(bad); return; }
    renderWeek(); flash("Removed.");
  }

  /* ---------------- Home Game Setup ---------------- */
  /* Nesting is a depth on a flat list, exactly like the pack lists off the
     travel sheet: a row sits under the nearest shallower row above it. No
     row can jump more than one level past the one above it, so the outline
     can never end up orphaned however you shuffle it. */
  var BLD_MAXD=2;
  function bldNorm(items){
    var prev=-1;
    (items||[]).forEach(function(it){
      var d=Math.max(0,Math.min(BLD_MAXD,Number(it.d)||0));
      if(d>prev+1) d=prev+1;
      it.d=d; prev=d;
    });
    return items;
  }
  function bldHome(){ return bldPack("home"); }
  var hgBuild=false, hgAdd="", hgEdit="";

  async function bldTakeOver(k){
    var seed=bldSeed(k);
    var bad=await bldSave(bldTabKey(k),function(cur){ return cur.length?cur:seed; });
    if(bad){ flash(bad); return false; }
    return true;
  }
  async function bldResetList(k){
    bldStash(bldTabKey(k),"Reset to the sheet version.");
    var bad=await saveSetting(bldTabKey(k),"");
    if(bad){ flash(bad); return; }
    hgBuild=false; hgAdd=""; hgEdit="";
    renderPack(k); flash("Back to the sheet version.");
  }

  function hgRowTools(gid,iid,i,n,d,maxd){
    var k=esc(gid)+'\u241F'+esc(iid);
    return '<span class="bldtools">'
      + '<button type="button" class="bldico" data-out="'+k+'"'+(d<=0?" disabled":"")+' aria-label="Move out one level">&#8592;</button>'
      + '<button type="button" class="bldico" data-in="'+k+'"'+(d>=maxd?" disabled":"")+' aria-label="Nest under the row above">&#8594;</button>'
      + '<button type="button" class="bldico" data-up="'+k+'"'+(i===0?" disabled":"")+' aria-label="Move up">&#9650;</button>'
      + '<button type="button" class="bldico" data-down="'+k+'"'+(i===n-1?" disabled":"")+' aria-label="Move down">&#9660;</button>'
      + '<button type="button" class="bldico" data-edit="'+k+'" aria-label="Edit">&#9998;</button>'
      + '<button type="button" class="bldico bldx" data-del="'+k+'" data-arm="del:'+esc(TAB)+':'+k+'" aria-label="Remove">&times;</button>'
      + '</span>';
  }

  async function hgIndent(gid,iid,dir){
    var touched=0;
    var bad=await bldSave(bldTabKey(),function(list){
      touched=0;
      list.forEach(function(gr){
        if(gr.id!==gid) return;
        (gr.items||[]).forEach(function(it){
          if(it.id===iid){ it.d=Math.max(0,Math.min(BLD_MAXD,(Number(it.d)||0)+dir)); touched++; }
        });
      });
      return list;
    });
    if(bad){ flash(bad); return; }
    if(!touched){ bldNoMatch("nest",gid,iid); return; }
    renderPack(TAB);
  }

  /* Drop a row on another row and it becomes a child of it. Reordering
     without changing level is what the up and down arrows are for, so a
     drop never has to guess which of the two you meant. */
  async function hgDrop(gid,iid,onto){
    if(iid===onto) return;
    var bad=await bldSave(bldTabKey(),function(list){
      list.forEach(function(gr){
        if(gr.id!==gid) return;
        var items=gr.items||[], from=-1, to=-1;
        items.forEach(function(it,i){ if(it.id===iid) from=i; if(it.id===onto) to=i; });
        if(from<0||to<0) return;
        var moved=items.splice(from,1)[0];
        if(from<to) to--;
        var parent=items[to];
        moved.d=Math.min(BLD_MAXD,(Number(parent.d)||0)+1);
        items.splice(to+1,0,moved);
        gr.items=items;
      });
      return list;
    });
    if(bad){ flash(bad); return; }
    renderPack(TAB); flash("Nested.");
  }

  function hgItemForm(gid,iid){
    var ed=null;
    if(iid) bldGet(bldTabKey()).forEach(function(gr){
      if(gr.id===gid) (gr.items||[]).forEach(function(it){ if(it.id===iid) ed=it; });
    });
    return '<form class="bldadd bldinline" data-hgform="'+esc(gid)+'\u241F'+esc(iid||"")+'">'
      + '<input type="text" class="bldt" maxlength="200" autocomplete="off" placeholder="What is the step?" value="'+esc(ed?ed.t:"")+'">'
      + '<input type="text" class="bldn" maxlength="300" autocomplete="off" placeholder="A note, if it needs one" value="'+esc(ed&&ed.n?ed.n:"")+'">'
      + '<input type="text" class="bldq" maxlength="12" autocomplete="off" placeholder="How many" value="'+esc(ed&&ed.q?ed.q:"")+'">'
      + '<div class="blderr" role="alert"></div>'
      + '<div class="bldrow"><button type="button" class="btn bldcancel">Cancel</button>'
      + '<button type="submit" class="btn go">'+(ed?"Save":"Add it")+'</button></div></form>';
  }
  function hgGroupForm(gid){
    var ed=null;
    if(gid) bldGet(bldTabKey()).forEach(function(gr){ if(gr.id===gid) ed=gr; });
    return '<form class="bldadd bldinline" data-hggroup="'+esc(gid||"")+'">'
      + '<input type="text" class="bldt" maxlength="120" autocomplete="off" '
      + 'placeholder="Name the section, like Weather or Cameras" value="'+esc(ed?ed.g:"")+'">'
      + '<div class="blderr" role="alert"></div>'
      + '<div class="bldrow"><button type="button" class="btn bldcancel">Cancel</button>'
      + '<button type="submit" class="btn go">'+(ed?"Save":"Add the section")+'</button></div></form>';
  }

  async function hgItemSubmit(form){
    var bits=form.getAttribute("data-hgform").split("\u241F");
    var gid=bits[0], iid=bits[1];
    var t=form.querySelector(".bldt").value.trim();
    var n=form.querySelector(".bldn").value.trim();
    var q=form.querySelector(".bldq").value.trim();
    var err=form.querySelector(".blderr");
    if(!t){ err.textContent="Type the step first."; form.querySelector(".bldt").focus(); return; }
    err.textContent="Saving…";
    var bad=await bldSave(bldTabKey(),function(list){
      list.forEach(function(gr){
        if(gr.id!==gid) return;
        gr.items=gr.items||[];
        if(iid) gr.items.forEach(function(it){ if(it.id===iid){ it.t=t; it.n=n; it.q=q; } });
        else gr.items.push({id:bldId(),t:t,n:n,q:q});
      });
      return list;
    });
    if(bad){ err.textContent=bad; return; }
    hgAdd=""; hgEdit=""; renderPack(TAB); flash(iid?"Saved.":"Added.");
  }

  async function hgGroupSubmit(form){
    var gid=form.getAttribute("data-hggroup");
    var t=form.querySelector(".bldt").value.trim();
    var err=form.querySelector(".blderr");
    if(!t){ err.textContent="Name it first."; form.querySelector(".bldt").focus(); return; }
    err.textContent="Saving…";
    var bad=await bldSave(bldTabKey(),function(list){
      if(gid){ list.forEach(function(gr){ if(gr.id===gid) gr.g=t; }); return list; }
      list.push({id:bldId(),g:t,items:[]});
      return list;
    });
    if(bad){ err.textContent=bad; return; }
    hgAdd=""; hgEdit=""; renderPack(TAB); flash(gid?"Saved.":"Section added.");
  }

  async function hgDel(gid,iid){
    bldStash(bldTabKey(), iid?"Row removed.":"Section removed.");
    var bad=await bldSave(bldTabKey(),function(list){
      if(!iid) return list.filter(function(gr){ return gr.id!==gid; });
      list.forEach(function(gr){
        if(gr.id===gid) gr.items=(gr.items||[]).filter(function(it){ return it.id!==iid; });
      });
      return list;
    });
    if(bad){ flash(bad); return; }
    renderPack(TAB); flash("Removed.");
  }
  async function hgMove(gid,iid,dir){
    var bad=await bldSave(bldTabKey(),function(list){
      if(!iid){
        var gi=-1; list.forEach(function(gr,i){ if(gr.id===gid) gi=i; });
        return gi<0?list:bldMove(list,gi,dir);
      }
      list.forEach(function(gr){
        if(gr.id!==gid) return;
        var ii=-1; (gr.items||[]).forEach(function(it,i){ if(it.id===iid) ii=i; });
        if(ii>=0) gr.items=bldMove(gr.items,ii,dir);
      });
      return list;
    });
    if(bad){ flash(bad); return; }
    renderPack(TAB);
  }

  /* What the Home Game Setup tab shows under the list while you are building */
  function hgCount(gid){
    var n=0;
    bldGet(bldTabKey()).forEach(function(gr){ if(gr.id===gid) n=(gr.items||[]).length; });
    return n;
  }
  function hgBuilderHtml(){
    if(!hgBuild) return "";
    var out='<div class="bldpanel">'+bldUndoHtml();
    bldGet(bldTabKey()).forEach(function(gr,gi,all){
      out+='<div class="bldgrp"><span class="bldgname">'+esc(gr.g)+'</span>'
        + '<span class="bldgn">'+((gr.items||[]).length)+' row'+((gr.items||[]).length===1?"":"s")+'</span>'
        + '<span class="wksp"></span>'
        + '<button type="button" class="bldico" data-up="'+esc(gr.id)+'\u241F"'+(gi===0?" disabled":"")+' aria-label="Move section up">&#9650;</button>'
        + '<button type="button" class="bldico" data-down="'+esc(gr.id)+'\u241F"'+(gi===all.length-1?" disabled":"")+' aria-label="Move section down">&#9660;</button>'
        + '<button type="button" class="bldico" data-edit="'+esc(gr.id)+'\u241F" aria-label="Rename section">&#9998;</button>'
        + '<button type="button" class="bldico bldx" data-del="'+esc(gr.id)+'\u241F" data-arm="del:'+esc(TAB)+':'+esc(gr.id)+'\u241F" aria-label="Remove section">&times;</button>'
        + '</div>';
      if(hgEdit===gr.id+"\u241F") out+=hgGroupForm(gr.id);
      var items=bldNorm((gr.items||[]).slice());
      items.forEach(function(it,ii){
        if(hgEdit===gr.id+"\u241F"+it.id){ out+=hgItemForm(gr.id,it.id); return; }
        var d=it.d||0, prev=ii?(items[ii-1].d||0):-1;
        var maxd=Math.min(BLD_MAXD,prev+1);
        var kid=!!(items[ii+1]&&(items[ii+1].d||0)>d);
        out+='<div class="blditem bd'+d+(kid?" bdparent":"")+'" draggable="true" '
          + 'data-drag="'+esc(gr.id)+'\u241F'+esc(it.id)+'">'
          + '<span class="bldgrip" aria-hidden="true">&#8942;&#8942;</span>'
          + '<span class="blditext">'+esc(it.t)
          + (it.q?' <i>&times;'+esc(it.q)+'</i>':"")
          + (it.n?'<em>'+esc(it.n)+'</em>':"")+'</span>'
          + hgRowTools(gr.id,it.id,ii,items.length,d,maxd)+'</div>';
      });
      if(hgAdd===gr.id) out+=hgItemForm(gr.id,"");
      else out+='<button type="button" class="bldplus bldsub" data-hgadd="'+esc(gr.id)+'">'
            + '<span aria-hidden="true">+</span> Add a row to '+esc(gr.g)+'</button>';
    });
    out+='<p class="bldhint">Drag a row onto another to tuck it underneath. '
      + 'The arrows do the same thing without a mouse: &#8594; nests it under the row above, '
      + '&#8592; pulls it back out. Up to two levels deep, the same as the pack lists.</p>';
    if(hgAdd==="__g") out+=hgGroupForm("");
    else out+='<button type="button" class="bldplus" data-hgadd="__g">'
          + '<span aria-hidden="true">+</span> Add a section</button>';
    return out+'</div>';
  }

  /* ================================================================
     What the sheet says that your list does not.

     Once you take a list over, the generated copy stops being the list
     and becomes a reference. This compares the two and offers the
     difference as suggestions: nothing is ever applied on its own.

     Rows are matched on the name they had on the sheet, not the name
     they have now, so renaming a row on the site shows up as "you call
     it X, the sheet says Y" instead of a phantom add and delete.
     ================================================================ */
  function bldSkips(k){ return bldGet(bldSkipKey(k)); }

  /* The row the button pointed at is not in the list. That is never the
     person doing something odd, it is always the page and the stored list
     disagreeing about what a row is called, which is exactly the shape of
     bug that hides for weeks because nothing errors and nothing changes. */
  function bldNoMatch(what,gid,iid){
    logProblem("could not "+what+" that row",
      "nothing in the list matched. section id "+JSON.stringify(gid)
      +", row id "+JSON.stringify(iid)+", on the "+TAB+" tab");
    flash("That did not match anything. It is in the Problems log.");
  }

  function bldDiff(k){
    var out={add:[],gone:[],changed:[],n:0};
    var gen=(PACKS[k]&&PACKS[k].gen)||[];
    if(!gen.length||!bldOwned(k)) return out;
    var mine=bldGet(bldTabKey(k)), skip=bldSkips(k);
    var seen={}, byKey={};
    mine.forEach(function(gr){
      var gname=bldSheetName(gr,gr.g);
      (gr.items||[]).forEach(function(it){
        var nm=bldSheetName(it,null);
        if(nm===null) return;                 /* a row you typed: not the sheet's business */
        byKey[gname+"\u241F"+nm]={gr:gr,it:it};
      });
    });
    gen.forEach(function(gr){
      (gr.items||[]).forEach(function(it,ix){
        var path=pkPath(gr,ix), key=gr.g+"\u241F"+path;
        seen[key]=true;
        if(skip.indexOf(key)>-1) return;
        var hit=byKey[key];
        if(!hit){ out.add.push({key:key,g:gr.g,path:path,t:it.t,n:it.n||"",q:it.q||"",d:it.d||0}); return; }
        if(hit.it.t!==it.t||(hit.it.n||"")!==(it.n||"")||(hit.it.q||"")!==(it.q||""))
          out.changed.push({key:key,g:gr.g,mine:hit.it.t,sheet:it.t,
                            mineN:hit.it.n||"",sheetN:it.n||"",
                            mineQ:hit.it.q||"",sheetQ:it.q||""});
      });
    });
    Object.keys(byKey).forEach(function(key){
      if(seen[key]||skip.indexOf(key)>-1) return;
      out.gone.push({key:key,t:byKey[key].it.t,g:byKey[key].gr.g});
    });
    out.n=out.add.length+out.gone.length+out.changed.length;
    return out;
  }

  var bldSugOpen=false;

  /* ---------------- not losing work ----------------
     Arming a button is no protection at all against a keyboard: Enter on a
     focused button fires a click, so two taps of Enter walked straight
     through "Really?" and took a section and everything in it. Three
     changes: a confirm cannot land in the same breath as the arming, the
     button says how much it is about to take, and anything destructive can
     be put back. */
  /* The armed state used to live on the button. Anything that redrew the
     bar, a realtime echo from the other computer, a background refresh,
     built a fresh button with no memory of being armed, so the second press
     armed it again and it looked like the button simply did not work. It
     lives here now, keyed by what it is about to do, and the look is put
     back on after every render. */
  var ARM={key:"",at:0,label:""};
  function armPaint(btn,label){
    if(!btn||btn.getAttribute("data-armed")==="1") return;
    btn.setAttribute("data-was",btn.innerHTML);
    btn.setAttribute("data-armed","1");
    btn.innerHTML=esc(label);
    btn.classList.add("bldsure");
  }
  function bldArmClear(){ ARM={key:"",at:0,label:""}; }
  function bldArm(btn,key,label){
    var now=Date.now();
    if(ARM.key===key&&now-ARM.at<15000){
      if(now-ARM.at<500) return true;        /* same breath, not a decision */
      bldArmClear();
      return false;                          /* go ahead */
    }
    ARM={key:key,at:now,label:label};
    armPaint(btn,label);
    return true;
  }
  /* called at the end of a render so an armed button still looks armed */
  function bldReArm(root){
    if(!ARM.key||!root) return;
    if(Date.now()-ARM.at>15000){ bldArmClear(); return; }
    var el=null;
    try{ el=root.querySelector('[data-arm="'+String(ARM.key).replace(/["\\]/g,"\\$&")+'"]'); }catch(e){}
    if(el) armPaint(el,ARM.label);
  }

  var bldUndo=null;
  function bldStash(key,what){ bldUndo={key:key,prev:SETTINGS[key]||"",what:what,tab:TAB}; }
  function bldUndoHtml(){
    if(!bldUndo||bldUndo.tab!==TAB) return "";
    return '<div class="bldundo"><span>'+esc(bldUndo.what)+'</span>'
      + '<button type="button" class="btn" id="bldUndoBtn">Put it back</button>'
      + '<button type="button" class="btn" id="bldUndoNo">Dismiss</button></div>';
  }
  async function bldDoUndo(){
    if(!bldUndo) return;
    var u=bldUndo; bldUndo=null;
    var bad=await saveSetting(u.key,u.prev);
    if(bad){ flash(bad); bldUndo=u; return; }
    renderCurrentList(); flash("Put back.");
  }

  function bldSugHtml(k){
    var d=bldDiff(k);
    if(!d.n) return "";
    var bits=[];
    if(d.add.length)     bits.push(d.add.length+" not on this list");
    if(d.changed.length) bits.push(d.changed.length+" worded differently");
    if(d.gone.length)    bits.push(d.gone.length+" no longer on the sheet");
    var head='<button type="button" class="bldsug'+(bldSugOpen?" open":"")+'" id="bldSugBtn">'
      + '<span class="bldsugn">'+d.n+'</span>'
      + '<span>Your sheet and this list differ: '+esc(bits.join(", "))+'</span>'
      + '<span class="caret" aria-hidden="true">&#9662;</span></button>';
    if(!bldSugOpen) return head;

    var body='<div class="bldsugbox">';
    d.add.forEach(function(x){
      body+='<div class="bldsugrow"><span class="bldsugwhat"><b>'+esc(x.t)+'</b>'
        + (x.q?' <i>&times;'+esc(x.q)+'</i>':"")
        + '<em>on the sheet under '+esc(x.g)+(x.n?", "+esc(x.n):"")+'</em></span>'
        + '<button type="button" class="btn" data-sugadd="'+esc(x.key)+'">Add it</button>'
        + '<button type="button" class="btn" data-sugskip="'+esc(x.key)+'">Not needed</button></div>';
    });
    d.changed.forEach(function(x){
      body+='<div class="bldsugrow"><span class="bldsugwhat"><b>'+esc(x.mine)+'</b>'
        + '<em>the sheet says &ldquo;'+esc(x.sheet)+'&rdquo;'+(x.sheetN?", "+esc(x.sheetN):"")+'</em></span>'
        + '<button type="button" class="btn" data-sugword="'+esc(x.key)+'">Use the sheet&#39;s</button>'
        + '<button type="button" class="btn" data-sugskip="'+esc(x.key)+'">Keep mine</button></div>';
    });
    d.gone.forEach(function(x){
      body+='<div class="bldsugrow"><span class="bldsugwhat"><b>'+esc(x.t)+'</b>'
        + '<em>was under '+esc(x.g)+' on the sheet, it is not there any more</em></span>'
        + '<button type="button" class="btn" data-sugdel="'+esc(x.key)+'">Remove it</button>'
        + '<button type="button" class="btn" data-sugskip="'+esc(x.key)+'">Keep it</button></div>';
    });
    body+='<p class="bldhint">This compares your list against the sheet copy baked into the site. '
      + 'That copy only changes when a new travel sheet gets built in, so this is not watching anything: '
      + 'it is here to catch what a rebuild would otherwise have buried. Nothing is applied unless you '
      + 'press a button.</p></div>';
    return head+body;
  }

  async function bldSugSkip(k,key){
    var bad=await bldSave(bldSkipKey(k),function(list){
      if(list.indexOf(key)<0) list.push(key);
      return list;
    });
    if(bad){ flash(bad); return; }
    renderPack(k);
  }
  function bldSugFind(k,key){
    var hit=null;
    ((PACKS[k]&&PACKS[k].gen)||[]).forEach(function(gr){
      (gr.items||[]).forEach(function(it,ix){
        if(gr.g+"\u241F"+pkPath(gr,ix)===key) hit={gr:gr,it:it,ix:ix,path:pkPath(gr,ix)};
      });
    });
    return hit;
  }
  async function bldSugAdd(k,key){
    var src=bldSugFind(k,key); if(!src){ flash("That row is not on the sheet any more."); return; }
    var bad=await bldSave(bldTabKey(k),function(list){
      var into=null;
      list.forEach(function(gr){ if(bldSheetName(gr,gr.g)===src.gr.g) into=gr; });
      if(!into){ into={id:"k|"+src.gr.g,g:src.gr.g,items:[]}; list.push(into); }
      into.items=into.items||[];
      into.items.push({id:"k|"+src.path,t:src.it.t,n:src.it.n||"",q:src.it.q||"",d:src.it.d||0});
      return list;
    });
    if(bad){ flash(bad); return; }
    renderPack(k); flash("Added from the sheet.");
  }
  async function bldSugWord(k,key){
    var src=bldSugFind(k,key); if(!src) return;
    var bad=await bldSave(bldTabKey(k),function(list){
      list.forEach(function(gr){
        if(bldSheetName(gr,gr.g)!==src.gr.g) return;
        (gr.items||[]).forEach(function(it){
          if(bldSheetName(it,null)===src.path){ it.t=src.it.t; it.n=src.it.n||""; it.q=src.it.q||""; }
        });
      });
      return list;
    });
    if(bad){ flash(bad); return; }
    renderPack(k); flash("Reworded to match the sheet.");
  }
  async function bldSugDel(k,key){
    bldStash(bldTabKey(k),"Row removed.");
    var bits=key.split("\u241F");
    var bad=await bldSave(bldTabKey(k),function(list){
      list.forEach(function(gr){
        if(bldSheetName(gr,gr.g)!==bits[0]) return;
        gr.items=(gr.items||[]).filter(function(it){ return bldSheetName(it,null)!==bits[1]; });
      });
      return list;
    });
    if(bad){ flash(bad); return; }
    renderPack(k); flash("Removed.");
  }

  /* A list the database handed back in pieces. Saying "empty" would be a
     lie, and it is the lie that made work look like it had vanished. */
  function bldCutHtml(key){
    var n=bldCut(key);
    if(!n) return "";
    var old=(n>=195&&n<=205);
    return '<div class="bldcut"><b>This list could not be read back.</b>'
      + '<p>'+(old
          ? 'It was cut off at '+n+' characters by an old limit in the database. '
            + 'Run <b>settings-bigger.sql</b> in Supabase and that stops happening. '
            + 'What was cut cannot be recovered, so it has to be typed again. Sorry.'
          : 'What came back from the database was '+n+' characters that did not make sense. '
            + 'Nothing has been changed or deleted. Send me the Problems log from the gear.')
      + '</p>'
      + '<button type="button" class="btn" data-cutclear="'+esc(key)+'">Start this list fresh</button>'
      + '</div>';
  }
  async function bldCutClear(key){
    var bad=await saveSetting(key,"");
    if(bad){ flash(bad); return; }
    delete BLD_CUT[key];
    renderCurrentList(); flash("Cleared. Start again when you are ready.");
  }

  /* ================================================================
     Trackers: an index of the Airtable bases, tables and views, so the
     site is the front door and Airtable stays the app. The list comes
     from trackers.json, which a GitHub Action rebuilds from Airtable's
     metadata API. That API returns the shape of a base and none of its
     records, so nothing anybody typed into Airtable passes through here.
     ================================================================ */
  var airroot=document.getElementById("airroot");
  var TRK=null, trkState={};

  async function loadTrackers(){
    try{
      var r=await fetch("trackers.json?t="+Date.now(),{cache:"no-cache"});
      if(!r.ok) throw 0;
      TRK=await r.json();
    }catch(e){ TRK=null; }
  }
  function trkLink(baseId,tableId,viewId){
    return "https://airtable.com/"+baseId+"/"+tableId+(viewId?"/"+viewId:"");
  }
  function trkWhen(iso){
    if(!iso) return "";
    var d=new Date(iso); if(isNaN(d)) return "";
    return d.toLocaleDateString("en-US",{month:"short",day:"numeric"})
      +" "+d.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit"});
  }

  function renderAir(){
    if(!airroot) return;
    if(!TRK||!TRK.bases||!TRK.bases.length){
      airroot.innerHTML=
        '<div class="airsetup">'
        + '<h2>Not connected to Airtable yet</h2>'
        + '<p>This tab lists every table in your Airtable bases and links straight to them, '
        + 'so you land in the real Airtable with editing and AI rather than a read-only copy. '
        + 'The list rebuilds itself whenever you add or rename a table.</p>'
        + '<ol>'
        + '<li>In Airtable: your avatar, <b>Builder hub</b>, <b>Personal access tokens</b>, <b>Create token</b>.</li>'
        + '<li>Give it one scope only: <code>schema.bases:read</code>. Add the bases you want listed.</li>'
        + '<li>Copy the token. You only get to see it once.</li>'
        + '<li>In GitHub: <b>Vyhnny/film-board</b>, Settings, Secrets and variables, Actions, '
        + '<b>New repository secret</b>, named <code>AIRTABLE_TOKEN</code>.</li>'
        + '<li>Actions tab, <b>Refresh Airtable tracker links</b>, <b>Run workflow</b>.</li>'
        + '</ol>'
        + '<p class="airnote">That scope reads the shape of a base and none of its contents. It can see that '
        + 'a table called Student Stuff exists. It cannot read a row out of it.</p>'
        + '</div>';
      return;
    }
    var tabs=0, views=0;
    TRK.bases.forEach(function(b){ tabs+=b.tables.length;
      b.tables.forEach(function(t){ views+=(t.views||[]).length; }); });

    var body="";
    TRK.bases.forEach(function(b){
      body+='<div class="pkhead"><b>'+esc(b.name)+'</b>'
          + '<span>'+b.tables.length+' table'+(b.tables.length===1?"":"s")
          + ' &middot; <a class="trklink" href="'+esc(trkLink(b.id,""))+'" target="_blank" rel="noopener noreferrer">open the base</a></span></div>';
      if(!b.tables.length){ body+='<p class="dempty">No tables in this base.</p>'; return; }
      b.tables.forEach(function(t){
        var vs=t.views||[], k=b.id+"|"+t.id, open=!!trkState[k];
        body+='<section class="dcard pkgroup trkcard'+(open?"":" shut")+'" data-trk="'+esc(k)+'">'
          + '<div class="dhead" role="button" tabindex="0" aria-expanded="'+(open?"true":"false")+'">'
          + '<span class="dmeta"><b>'+esc(t.name)+'</b>'
          + (t.desc?'<span class="ddate">'+esc(t.desc)+'</span>':"")+'</span>'
          + '<span class="trkn">'+vs.length+' view'+(vs.length===1?"":"s")
          + (t.fields?' &middot; '+t.fields+' field'+(t.fields===1?"":"s"):"")+'</span>'
          + '<a class="btn trkgo" href="'+esc(trkLink(b.id,t.id,vs.length?vs[0].id:""))+'" '
          + 'target="_blank" rel="noopener noreferrer">Open</a>'
          + '<span class="caret" aria-hidden="true">&#9662;</span></div>'
          + '<div class="dbody">';
        if(!vs.length) body+='<p class="dempty">No views.</p>';
        vs.forEach(function(v){
          body+='<a class="trow trkrow" href="'+esc(trkLink(b.id,t.id,v.id))+'" target="_blank" rel="noopener noreferrer">'
            + '<span class="trkdot" aria-hidden="true"></span>'
            + '<span class="tmain"><span class="tname">'+esc(v.name)+'</span></span>'
            + '<span class="tflags">'+(v.type?'<span class="tqty">'+esc(v.type)+'</span>':"")+'</span>'
            + '<span class="trkarrow" aria-hidden="true">&#8599;</span></a>';
        });
        body+='</div></section>';
      });
    });

    airroot.innerHTML=
      '<div class="airbar">'
      + '<span class="wknow">Trackers</span>'
      + '<span class="wkctx">'+TRK.bases.length+' base'+(TRK.bases.length===1?"":"s")
      + ' &middot; '+tabs+' table'+(tabs===1?"":"s")+' &middot; '+views+' view'+(views===1?"":"s")+'</span>'
      + '<span class="wksp"></span>'
      + '<span class="trkwhen">'+(TRK.built?"Listed "+esc(trkWhen(TRK.built)):"")+'</span>'
      + '<button class="btn" id="trkAll">Expand</button>'
      + '<button class="btn" id="trkShut">Collapse</button>'
      + '</div>'
      + '<div class="wkdays">'+body+'</div>'
      + howto('Every link opens Airtable itself, so editing, search and Airtable’s AI all work '
      + 'and its own permissions still apply. This page only knows the names of your tables and views, never what is in them. '
      + 'Add or rename a table in Airtable and it shows up here on the next refresh.');
  }

  if(airroot){
    airroot.addEventListener("click",function(e){
      if(!e.target.closest) return;
      if(e.target.closest("a")) return;                 /* let links be links */
      if(e.target.closest("#trkAll")||e.target.closest("#trkShut")){
        var on=!!e.target.closest("#trkAll");
        (TRK&&TRK.bases||[]).forEach(function(b){ b.tables.forEach(function(t){ trkState[b.id+"|"+t.id]=on; }); });
        renderAir(); return;
      }
      var h=e.target.closest(".trkcard .dhead"); if(!h) return;
      var card=h.parentNode, k=card.getAttribute("data-trk");
      trkState[k]=!trkState[k];
      card.classList.toggle("shut",!trkState[k]);
      h.setAttribute("aria-expanded",trkState[k]?"true":"false");
    });
    airroot.addEventListener("keydown",function(e){
      if(e.key!=="Enter"&&e.key!==" ") return;
      var h=e.target.closest&&e.target.closest(".trkcard .dhead"); if(!h) return;
      e.preventDefault(); h.click();
    });
  }

  /* ================================================================
     Notes. Right-click (or long-press) any checkbox on any tab to
     leave a note on it. The note stores a label saying what it was
     attached to, so the Copy all dump reads on its own.
     ================================================================ */
  var NOTES=[];
  var noteDlg=document.getElementById("noteDlg");
  var allDlg=document.getElementById("allNotes");
  var noteRef="", noteLabel="";
  var noteQ="", noteShowDone=false;
  var GENREF="general", GENLABEL="General note";

  /* A half-typed note is kept as a draft on this device until you either
     click Add note or clear the box. Closing the window does not lose it. */
  var DKEY="fpb_ndraft";
  function drafts(){ try{ return JSON.parse(lsGet(DKEY)||"{}"); }catch(e){ return {}; } }
  function draftFor(ref){ return drafts()[ref]||""; }
  function setDraft(ref,txt){
    var d=drafts();
    if(txt&&txt.trim()) d[ref]=txt; else delete d[ref];
    try{ lsSet(DKEY,JSON.stringify(d)); }catch(e){}
  }

  function notesFor(ref){ return NOTES.filter(function(n){ return n.ref===ref; }); }
  function openNoteCount(ref){ return notesFor(ref).filter(function(n){ return !n.done; }).length; }
  function openNoteTotal(){ return NOTES.filter(function(n){ return !n.done; }).length; }

  async function loadNotes(){
    if(!sb) return;
    var r=await sb.from("notes").select("id,ref,label,body,who,done,created_at")
                  .order("created_at",{ascending:false}).limit(2000);
    if(r.error) logRead("the notes",r.error);
    NOTES=r.error?[]:(r.data||[]);
    NOTES_OK=!r.error;
  }
  var NOTES_OK=false;

  function applyNoteRow(msg){
    var row=msg.new&&msg.new.id?msg.new:(msg.old||null); if(!row) return;
    NOTES=NOTES.filter(function(n){ return n.id!==row.id; });
    if(msg.eventType!=="DELETE"&&msg.new&&msg.new.id) NOTES.unshift(msg.new);
    paintNoteMarks(); syncGearBadge();
    if(allDlg&&allDlg.open) drawAllNotes();
    if(noteDlg&&noteDlg.open) drawNoteList();
  }

  /* what the note is hanging on, in words, worked out once when it is written */
  function labelForId(id){
    try{
      var t=describe(id,true).replace(/^(checked|packed)\s+/,"");
      if(!isWeekId(id)&&!isPackId(id)) t="Film board \u00b7 "+t;
      return t;
    }catch(e){ return id; }
  }

  /* ---------- the little bubble on a row, and the ring on a board cell ---------- */
  function paintNoteMarks(){
    [].forEach.call(document.querySelectorAll("input.box"),function(b){
      var id=b.getAttribute("data-id"), n=openNoteCount(id), tot=notesFor(id).length;
      var row=b.closest(".trow");
      if(row){
        var dot=row.querySelector(".nbub");
        if(!dot){
          dot=document.createElement("button");
          dot.type="button"; dot.className="nbub";
          var fl=row.querySelector(".tflags"); (fl||row).insertBefore(dot,fl?fl.firstChild:null);
        }
        dot.setAttribute("data-note",id);
        var dr=!!draftFor(id);
        dot.classList.toggle("has",tot>0||dr);
        dot.classList.toggle("open",n>0);
        dot.classList.toggle("draft",dr&&!tot);
        dot.textContent=tot?String(tot):"";
        dot.title=tot?(tot+" note"+(tot===1?"":"s")+" on this"+(dr?", plus an unsent draft":""))
                     :(dr?"You have an unsent draft here":"Add a note");
        dot.setAttribute("aria-label",dot.title);
      }
      var cell=b.closest(".cell");
      if(cell) cell.classList.toggle("hasnote",tot>0);
    });
  }

  /* ---------- the one-item note dialog ---------- */
  function drawNoteList(){
    var box=document.getElementById("nList");
    var list=notesFor(noteRef);
    if(!list.length){ box.innerHTML='<p class="n-empty">No notes on this yet.</p>'; return; }
    box.innerHTML=list.map(function(n){
      return '<div class="n-row'+(n.done?" ndone":"")+'">'
        + '<span class="n-main"><span class="n-body">'+esc(n.body)+'</span>'
        + '<span class="n-meta">'+esc(whoName(n.who)||"Someone")+' &middot; '+esc(shortDate(n.created_at))
        + (n.done?' &middot; <b>handled</b>':"")+'</span></span>'
        + '<button type="button" class="btn n-del" data-note-del="'+n.id+'" aria-label="Delete note">Delete</button>'
        + '</div>';
    }).join("");
  }
  function openNote(id){
    if(!noteDlg) return;
    noteRef=id; noteLabel=labelForId(id);
    document.getElementById("nOn").textContent=noteLabel;
    document.getElementById("nErr").textContent=NOTES_OK?"":"Notes need the one-time database setup (notes-setup.sql).";
    document.getElementById("nBody").value=draftFor(id);
    drawNoteList();
    if(noteDlg.showModal) noteDlg.showModal(); else noteDlg.setAttribute("open","");
    setTimeout(function(){ document.getElementById("nBody").focus(); },30);
  }
  function closeNote(){ noteDlg.close?noteDlg.close():noteDlg.removeAttribute("open"); }
  function stashDraft(){
    if(!noteRef) return;
    var t=document.getElementById("nBody");
    setDraft(noteRef,t?t.value:"");
    paintNoteMarks();
  }

  async function noteRpc(fn,args){
    if(!sb) return "Not connected.";
    if(!lsGet("fpb_code")){ var ok=await askLogin(); if(!ok) return "Sign in to leave notes."; }
    args.p_code=lsGet("fpb_code");
    var r=await sb.rpc(fn,args);
    if(r.error){
      var m=String(r.error.message||"");
      if(/does not exist|schema|function/i.test(m)) return "Run notes-setup.sql in Supabase first.";
      if(/passcode/i.test(m)){ lsDel("fpb_code"); return "Passcode changed. Try again."; }
      return "That did not save. Try again.";
    }
    return "";
  }

  if(noteDlg){
    document.getElementById("nForm").addEventListener("submit",async function(e){
      e.preventDefault();
      var body=document.getElementById("nBody").value.trim();
      var err=document.getElementById("nErr");
      if(!body){ err.textContent="Type the note first."; return; }
      err.textContent="Saving…";
      var bad=await noteRpc("add_note",{p_ref:noteRef,p_label:noteLabel,p_body:body,p_who:lsGet("fpb_who")||""});
      if(bad){ err.textContent=bad; return; }
      err.textContent=""; document.getElementById("nBody").value="";
      setDraft(noteRef,"");
      await loadNotes(); drawNoteList(); paintNoteMarks(); syncGearBadge();
      flash("Note saved.");
    });
    document.getElementById("nCancel").addEventListener("click",closeNote);
    /* a click on the dark area outside the box targets the dialog itself */
    noteDlg.addEventListener("click",function(e){ if(e.target===noteDlg) closeNote(); });
    /* covers the Close button, the backdrop and the Escape key */
    noteDlg.addEventListener("close",stashDraft);
    window.addEventListener("beforeunload",stashDraft);
    document.getElementById("nList").addEventListener("click",async function(e){
      var d=e.target.closest&&e.target.closest("[data-note-del]");
      if(d){
        var bad=await noteRpc("del_note",{p_id:Number(d.getAttribute("data-note-del"))});
        if(bad){ document.getElementById("nErr").textContent=bad; return; }
        await loadNotes(); drawNoteList(); paintNoteMarks(); syncGearBadge();
      }
    });
  }

  /* ---------- every note, with copy and save ---------- */
  function shownNotes(){
    var q=noteQ.trim().toLowerCase();
    return NOTES.filter(function(n){
      if(!noteShowDone&&n.done) return false;
      if(!q) return true;
      return (n.label+" "+n.body+" "+(n.who||"")).toLowerCase().indexOf(q)>=0;
    });
  }
  function noteLines(){
    var out=["Tulane Football Video  -  Notes  (Football Video Ops v"+VER+")",
             "Copied "+new Date().toLocaleString("en-US",{weekday:"short",month:"short",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit"}),
             ""];
    var list=shownNotes();
    if(noteQ.trim()) out.splice(2,0,'Filtered on "'+noteQ.trim()+'"'+(noteShowDone?"":", handled ones hidden"));
    else if(!noteShowDone) out.splice(2,0,"Handled notes hidden");
    if(!list.length) out.push("(none)");
    list.forEach(function(n){
      out.push((n.done?"[x] ":"[ ] ")+(n.label||GENLABEL));
      out.push("    "+n.body.replace(/\n/g,"\n    "));
      out.push("    "+(whoName(n.who)||"Someone")+", "+shortDate(n.created_at));
      out.push("");
    });
    return out.join("\n");
  }
  function drawAllNotes(){
    var box=document.getElementById("nAll");
    if(!NOTES_OK){ box.innerHTML='<p class="h-empty">Notes need the one-time database setup. Run notes-setup.sql in Supabase.</p>'; return; }
    var list=shownNotes(), hid=NOTES.length-list.length;
    var head=document.getElementById("nCount");
    if(head) head.textContent=list.length+" shown"+(hid?", "+hid+" hidden":"");
    var cp=document.getElementById("nCopy");
    if(cp&&cp.textContent.indexOf("Copied")<0) cp.textContent="Copy "+list.length;
    if(!NOTES.length){ box.innerHTML='<p class="h-empty">No notes yet. Right-click any checkbox to leave one there, or use the box above for anything that is not about one checkbox.</p>'; return; }
    if(!list.length){ box.innerHTML='<p class="h-empty">Nothing matches. Clear the filter, or tick Show handled.</p>'; return; }
    box.innerHTML=list.map(function(n){
      return '<div class="h-row n-all'+(n.done?" ndone":"")+'">'
        + '<input type="checkbox" class="nchk" data-note-id="'+n.id+'"'+(n.done?" checked":"")+' aria-label="Mark handled">'
        + '<span class="h-what"><b>'+esc(n.label||GENLABEL)+'</b>'
        + '<span class="n-body">'+esc(n.body)+'</span>'
        + '<span class="h-when">'+esc((whoName(n.who)||"Someone")+" · "+shortDate(n.created_at))+'</span></span>'
        + '<button type="button" class="btn n-del" data-note-del="'+n.id+'">Delete</button></div>';
    }).join("");
  }
  async function openAllNotes(){
    if(!allDlg) return;
    if(allDlg.showModal) allDlg.showModal(); else allDlg.setAttribute("open","");
    document.getElementById("nAll").innerHTML='<p class="h-empty">Loading…</p>';
    var g=document.getElementById("nGen");
    if(g){ g.value=draftFor(GENREF); document.getElementById("nGenErr").textContent=""; }
    await loadNotes(); drawAllNotes(); paintNoteMarks(); syncGearBadge();
  }
  if(allDlg){
    /* a note that is not about any one checkbox: it hangs on nothing and
       shows up in the same list, the dump and the gear count */
    var genForm=document.getElementById("nGenForm");
    if(genForm) genForm.addEventListener("submit",async function(e){
      e.preventDefault();
      var box=document.getElementById("nGen"), err=document.getElementById("nGenErr");
      var body=box.value.trim();
      if(!body){ err.textContent="Type the note first."; box.focus(); return; }
      err.textContent="Saving…";
      var bad=await noteRpc("add_note",{p_ref:GENREF,p_label:GENLABEL,p_body:body,p_who:lsGet("fpb_who")||""});
      if(bad){ err.textContent=bad; return; }
      err.textContent=""; box.value=""; setDraft(GENREF,"");
      await loadNotes(); drawAllNotes(); syncGearBadge();
      flash("Note saved.");
    });
    if(genForm) document.getElementById("nGen").addEventListener("input",function(e){
      setDraft(GENREF,e.target.value);
      document.getElementById("nGenErr").textContent="";
    });
    document.getElementById("nClose").addEventListener("click",function(){ allDlg.close?allDlg.close():allDlg.removeAttribute("open"); });
    document.getElementById("nFind").addEventListener("input",function(e){ noteQ=e.target.value; drawAllNotes(); });
    document.getElementById("nDone").addEventListener("change",function(e){ noteShowDone=e.target.checked; drawAllNotes(); });
    document.getElementById("nCopy").addEventListener("click",function(){
      var txt=noteLines(), btn=document.getElementById("nCopy");
      function ok(){ btn.textContent="Copied"; setTimeout(function(){ btn.textContent="Copy all"; },1600); }
      if(navigator.clipboard&&navigator.clipboard.writeText){
        navigator.clipboard.writeText(txt).then(ok,function(){ fallbackCopy(txt,ok); });
      } else fallbackCopy(txt,ok);
    });
    function fallbackCopy(txt,ok){
      var ta=document.getElementById("nFallback");
      ta.value=txt; ta.hidden=false; ta.focus(); ta.select();
      try{ document.execCommand("copy"); ok(); }catch(e){}
    }
    document.getElementById("nSave").addEventListener("click",function(){
      var blob=new Blob([noteLines()],{type:"text/plain"});
      var a=document.createElement("a");
      a.href=URL.createObjectURL(blob);
      a.download="football-video-ops-notes-"+ckISO(new Date())+".txt";
      document.body.appendChild(a); a.click();
      setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); },500);
    });
    document.getElementById("nAll").addEventListener("click",async function(e){
      var d=e.target.closest&&e.target.closest("[data-note-del]"); if(!d) return;
      var bad=await noteRpc("del_note",{p_id:Number(d.getAttribute("data-note-del"))});
      if(bad){ flash(bad); return; }
      await loadNotes(); drawAllNotes(); paintNoteMarks(); syncGearBadge();
    });
    document.getElementById("nAll").addEventListener("change",async function(e){
      var c=e.target.closest&&e.target.closest("[data-note-id]"); if(!c) return;
      var bad=await noteRpc("set_note_done",{p_id:Number(c.getAttribute("data-note-id")),p_on:c.checked});
      if(bad){ flash(bad); c.checked=!c.checked; return; }
      await loadNotes(); drawAllNotes(); paintNoteMarks(); syncGearBadge();
    });
  }

  /* ---------- notes on the printed page ----------
     Built only while printing, then torn down, so the screen stays light. */
  function printNotesOn(){
    printNotesOff();                 /* beforeprint can fire twice */
    [].forEach.call(document.querySelectorAll("#weekroot .trow, #packroot .trow"),function(row){
      /* a past-due row is the same task shown twice, so only the day it
         belongs to carries the note on paper */
      if(row.classList.contains("tlate")) return;
      var b=row.querySelector("input.box"); if(!b) return;
      var list=notesFor(b.getAttribute("data-id")).filter(function(n){ return !n.done; });
      if(!list.length) return;
      var d=document.createElement("span");
      d.className="pnotes";
      d.innerHTML=list.map(function(n){
        return '<span class="pnote">'+esc(n.body)+' <i>'+esc(n.who||"")+'</i></span>';
      }).join("");
      var main=row.querySelector(".tmain")||row;
      main.appendChild(d);
    });
  }
  function printNotesOff(){
    [].forEach.call(document.querySelectorAll(".pnotes"),function(e){ e.remove(); });
  }
  window.addEventListener("beforeprint",printNotesOn);
  window.addEventListener("afterprint",printNotesOff);

  /* ---------- right-click anywhere, long-press on a touchscreen ---------- */
  function boxUnder(el){
    if(!el||!el.closest) return null;
    var b=el.closest("input.box"); if(b) return b;
    var host=el.closest(".trow, .cell"); if(!host) return null;
    return host.querySelector("input.box");
  }
  document.addEventListener("contextmenu",function(e){
    if(e.target.closest&&e.target.closest(".nbub")) return;
    var b=boxUnder(e.target); if(!b) return;
    var id=b.getAttribute("data-id"); if(!id) return;
    e.preventDefault();
    openNote(id);
  });
  document.addEventListener("click",function(e){
    var d=e.target.closest&&e.target.closest(".nbub"); if(!d) return;
    e.preventDefault(); e.stopPropagation();
    openNote(d.getAttribute("data-note"));
  },true);
  var pressTimer=null, pressBox=null;
  function cancelPress(){ if(pressTimer) clearTimeout(pressTimer); pressTimer=null; pressBox=null; }
  document.addEventListener("touchstart",function(e){
    var b=boxUnder(e.target); if(!b) return;
    pressBox=b;
    pressTimer=setTimeout(function(){
      pressTimer=null;
      var id=pressBox&&pressBox.getAttribute("data-id");
      if(id){ if(navigator.vibrate) try{ navigator.vibrate(12); }catch(x){} openNote(id); }
    },520);
  },{passive:true});
  ["touchend","touchmove","touchcancel","scroll"].forEach(function(ev){
    document.addEventListener(ev,cancelPress,{passive:true});
  });

  /* The board's own view controls sat next to the tabs and read like more
     tabs. They are actions, so they belong on the right with the gear. */
  (function(){
    var vg=document.querySelector('.tools .tgroup.bdonly[aria-label="View"]');
    var tr=document.querySelector('.tools .tright');
    if(!vg||!tr) return;
    vg.classList.add("viewg");
    tr.insertBefore(vg,tr.firstChild);
    var sep=document.createElement("span");
    sep.className="tsep bdonly"; sep.setAttribute("aria-hidden","true");
    tr.insertBefore(sep,vg.nextSibling);
    var old=document.querySelector('.tleft .tsep.bdonly');
    if(old) old.remove();
  })();

  /* ---------- version and database check ----------
     The number is MAJOR.MINOR: MAJOR goes up when a .sql file has to be
     run in Supabase, MINOR when only index.html and app.js change. The
     check below is what actually matters: it asks the database what it
     has rather than trusting the number. */
  var VER="6.0";
  var DBNEED=[{t:"checks",sql:"setup.sql"},
              {t:"check_log",sql:"database-update.sql"},
              {t:"candidates",sql:"database-update.sql"},
              {t:"notes",sql:"notes-setup.sql"},
              {t:"settings",sql:"notes-setup.sql"},
              {t:"buy",sql:"buy-setup.sql"}];
  /* the Office tables are deliberately unreadable, so a select on them
     always fails and tells us nothing. The Office tab reports itself. */
  var DBMISS=[];
  async function checkDb(){
    DBMISS=[];
    if(!sb) return;
    for(var i=0;i<DBNEED.length;i++){
      var need=DBNEED[i], bad=false;
      try{
        var r=await sb.from(need.t).select("*",{head:true,count:"exact"}).limit(1);
        bad=!!r.error;
      }catch(e){ bad=true; }
      if(bad&&DBMISS.indexOf(need.sql)<0) DBMISS.push(need.sql);
    }
  }
  function drawVersion(){
    var el=document.getElementById("gVer"); if(!el) return;
    el.innerHTML='<b>Football Video Ops v'+VER+'</b>'
      + (DBMISS.length
          ? '<span class="dbbad">Database needs '+esc(DBMISS.join(", "))+'</span>'
          : '<span class="dbok">Database up to date</span>');
  }

  /* ---------- the gear ---------- */
  var gMenu=document.getElementById("gMenu"), gBtn=document.getElementById("fGear");
  function syncGearBadge(){
    var n=openNoteTotal();
    var pn=(typeof probCount==="function")?probCount():0;
    if(gBtn) gBtn.classList.toggle("hasnote",n>0||pn>0);
    var lab=document.getElementById("gNoteN");
    if(lab) lab.textContent=n?String(n):"";
    var pl=document.getElementById("gProbN");
    if(pl){ pl.textContent=pn?String(pn):""; pl.classList.toggle("bad",pn>0); }
  }
  function closeGear(){ if(gMenu){ gMenu.hidden=true; gBtn.setAttribute("aria-expanded","false"); } }
  if(gBtn){
    gBtn.addEventListener("click",function(e){
      e.stopPropagation();
      var open=gMenu.hidden;
      gMenu.hidden=!open; gBtn.setAttribute("aria-expanded",open?"true":"false");
      if(open){
        var u=document.getElementById("fUndo"), r=document.getElementById("fRedo");
        gMenu.querySelector('[data-g="undo"]').disabled=!u||u.disabled;
        gMenu.querySelector('[data-g="redo"]').disabled=!r||r.disabled;
        var who=lsGet("fpb_who");
        gMenu.querySelector('[data-g="who"]').textContent=who?("Signed in as "+whoName(who)):"Sign in";
        gMenu.querySelector('[data-g="theme"]').textContent=
          (document.documentElement.getAttribute("data-theme")==="dark")?"Light mode":"Dark mode";
        syncGearBadge();
        drawVersion();
      }
    });
    document.addEventListener("click",function(e){
      if(gMenu.hidden) return;
      if(e.target.closest&&(e.target.closest("#gMenu")||e.target.closest("#fGear"))) return;
      closeGear();
    });
    gMenu.addEventListener("click",function(e){
      var b=e.target.closest&&e.target.closest("[data-g]"); if(!b||b.disabled) return;
      var g=b.getAttribute("data-g");
      closeGear();
      if(g==="notes") return openAllNotes();
      if(g==="find") return openFind();
      if(g==="prob") return openProblems();
      if(g==="print") return window.print();
      if(g==="who") return askLogin();
      if(g==="theme"){
        var dark=document.documentElement.getAttribute("data-theme")==="dark";
        document.documentElement.setAttribute("data-theme",dark?"light":"dark");
        lsSet("fpb_theme",dark?"light":"dark");
        return;
      }
      var hit={hist:"fHist",export:"fExport",undo:"fUndo",redo:"fRedo"}[g];
      var el=hit&&document.getElementById(hit);
      if(el) el.click();
    });
  }
  (function(){ var t=lsGet("fpb_theme"); if(t) document.documentElement.setAttribute("data-theme",t); })();

  /* ================================================================
     The Office: the part of the site that is not public.
     Its tables have row level security on and no read policy at all,
     so the key in this page cannot see a row of them. Everything here
     goes through office_read / set_assign, which check a SECOND code,
     the office code, that students do not get.
     ================================================================ */
  var officeroot=document.getElementById("officeroot");
  var OFF=null;                       /* {crew, assign, log} once unlocked */
  var OKEY="fvo_office";              /* the office code, on this device */
  var oSub="depth";
  var oBusy=false;

  function officeCode(){ return lsGet(OKEY)||""; }
  function isUnlocked(){ return !!officeCode()&&!!OFF; }

  async function officeRpc(fn,args){
    if(!sb) return {err:"Not connected."};
    args=args||{}; args.p_code=officeCode();
    var r;
    try{ r=await sb.rpc(fn,args); }catch(e){ r={error:e}; }
    if(r.error){
      var m=String(r.error.message||"");
      if(/does not exist|schema|function/i.test(m)) return {err:"Run office-setup.sql in Supabase first."};
      if(/office code/i.test(m)){ lsDel(OKEY); OFF=null; return {err:"That office code is not right."}; }
      return {err:"That did not go through. Try again."};
    }
    return {data:r.data};
  }

  async function officeLoad(){
    var r=await officeRpc("office_read",{});
    if(r.err){ OFF=null; return r.err; }
    var d=r.data||{};
    OFF={crew:d.crew||[],assign:d.assign||[],log:d.log||[]};
    return "";
  }

  function lockOffice(){
    lsDel(OKEY); OFF=null;
    document.body.classList.remove("of-prep","of-depth");
    if(TAB==="office") renderOffice();
    syncLockItem();
    flash("Office locked.");
  }

  /* ---------------- the away trips, off the real schedule ---------------- */
  function oGames(){
    var out=[];
    (DATA.weeks||[]).forEach(function(w){ if(w.site==="A") out.push(w); });
    try{ postWeeks().forEach(function(w){
      if(w.official&&w.date&&(w.site==="A"||w.site==="N")) out.push(w); }); }catch(e){}
    return out.filter(function(w){
      var p=wkDate(w); if(!p) return false;
      var d=new Date(p.y,p.mo,p.d); d.setHours(23,59,59);
      return d.getTime()>Date.now()-86400000*2;        /* drop trips already gone */
    });
  }
  function oGameKey(w){ return O_KEY[w.opp]||ckSlug(w.opp); }

  /* ---------------- how available a person is for one trip ---------------- */
  var O_SLOTS=[["SL","SL"],["EZ","EZ"],["EZ2","EZ2"],["BOOTH","Booth"],["IPADS","iPads"]];
  var O_ORDER=["req","flex","unranked","nosheet"];
  function oNeed(slot){ return slot==="SL"?"SL":(slot==="EZ"||slot==="EZ2")?"EZ":""; }
  function oList(v){ return Array.isArray(v)?v:[]; }
  function oObj(v){ return (v&&typeof v==="object"&&!Array.isArray(v))?v:{}; }

  function oStatus(p,key){
    if(p.grp==="out") return {t:"out",label:p.out_note||"Not traveling"};
    if(oList(p.cant).indexOf(key)>-1) return {t:"cant",label:"Can't go"};
    if(!p.on_sheet) return {t:"nosheet",label:"No preference sheet"};
    if(p.flex) return {t:"flex",label:"Flexible, any trip"};
    var r=oObj(p.ranks)[key];
    if(r) return {t:"req",label:"Asked for this trip, ranked "+r,rank:r};
    return {t:"unranked",label:"Did not rank this trip"};
  }
  function oFree(t){ return O_ORDER.indexOf(t)>-1; }

  function oBench(key,slot,takenIds){
    var need=oNeed(slot);
    return OFF.crew.filter(function(p){
      if(takenIds.indexOf(p.id)>-1) return false;
      if(!oFree(oStatus(p,key).t)) return false;
      if(!oShowUntagged&&need&&oList(p.tags).indexOf(need)<0) return false;
      return true;
    }).sort(function(x,y){
      if(need){
        var tx=oList(x.tags).indexOf(need)>-1?0:1, ty=oList(y.tags).indexOf(need)>-1?0:1;
        if(tx!==ty) return tx-ty;
      }
      var sx=oStatus(x,key), sy=oStatus(y,key);
      var ox=O_ORDER.indexOf(sx.t), oy=O_ORDER.indexOf(sy.t);
      if(ox!==oy) return ox-oy;
      if(sx.rank&&sy.rank&&sx.rank!==sy.rank) return sx.rank-sy.rank;
      return (x.sort||0)-(y.sort||0);
    });
  }
  var oShowUntagged=false;
  var oView="";

  function oAssigned(key){
    var m={};
    OFF.assign.forEach(function(a){ if(a.game_key===key&&a.person_id) m[a.slot]=a.person_id; });
    return m;
  }
  function oById(id){
    var hit=null; OFF.crew.forEach(function(p){ if(p.id===id) hit=p; }); return hit;
  }
  function oTagChips(p){
    var nice={SL:"SL",EZ:"EZ",POLE:"Pole",GROUND:"Ground",EDITOR:"Editor",BUBBLE:"Bubble"};
    return oList(p.tags).filter(function(t){ return nice[t]; })
      .map(function(t){ return '<span class="tqty">'+esc(nice[t])+'</span>'; }).join("");
  }

  /* opponent to the key the depth chart uses */
  var O_KEY={"Duke":"duke","Kansas State":"kstate","Army":"army",
             "Charlotte":"charlotte","Rice":"rice","South Florida":"usf"};

  /* ---------------- locked state ---------------- */
  function drawLocked(msg){
    officeroot.innerHTML=
      '<div class="oflock"><div class="ofbox">'
      + '<svg class="oficon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" '
      + 'stroke-width="1.7" stroke-linecap="round"><rect x="4" y="10.5" width="16" height="11" rx="2"/>'
      + '<path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>'
      + '<h2>Office only</h2>'
      + '<p>Travel assignments and worker notes sit behind a second code. The staff passcode '
      + 'does not open this, and the key that runs the rest of the site cannot read these tables at all, '
      + 'so a link to this page gets nobody anywhere.</p>'
      + '<form id="ofForm" autocomplete="off">'
      + '<label for="ofCode">Office code</label>'
      + '<input type="password" id="ofCode" autocomplete="off" autocapitalize="off" spellcheck="false">'
      + '<div class="err ofErr" id="ofErr" role="alert">'+esc(msg||"")+'</div>'
      + '<button type="submit" class="btn go">Unlock</button>'
      + '</form>'
      + '<p class="ofsmall">This computer stays unlocked until you choose <b>Lock the office</b> in the gear menu.</p>'
      + '</div></div>';
    var f=document.getElementById("ofForm");
    if(f) f.addEventListener("submit",async function(e){
      e.preventDefault();
      var el=document.getElementById("ofCode"), er=document.getElementById("ofErr");
      var code=el.value; if(!code){ er.textContent="Enter the office code."; return; }
      er.textContent="Checking…";
      lsSet(OKEY,code);
      var bad=await officeLoad();
      if(bad){ drawLocked(bad); return; }
      flash("Office unlocked."); syncLockItem(); renderOffice();
    });
    setTimeout(function(){ var c=document.getElementById("ofCode"); if(c) c.focus(); },30);
  }

  /* ---------------- the trip picker ---------------- */
  function ofTripBar(games,key){
    var out='<div class="oftrips">';
    games.forEach(function(w){
      var k=oGameKey(w), p=wkDate(w);
      out+='<button type="button" class="btn oftrip" data-trip="'+esc(k)+'" aria-pressed="'
        + (k===key?"true":"false")+'"><b>'+esc(w.opp)+'</b><span>'
        + esc(p?ckNice(new Date(p.y,p.mo,p.d)):String(w.date||""))+'</span></button>';
    });
    return out+'</div>';
  }

  /* ---------------- one slot ---------------- */
  function ofSlotCard(key,slot,label,taken){
    var who=taken[slot]?oById(taken[slot]):null;
    var need=oNeed(slot);
    /* nobody already on this trip shows up as a pick, including whoever is in this spot */
    var others=[]; O_SLOTS.forEach(function(s){ if(taken[s[0]]) others.push(taken[s[0]]); });
    var bench=oBench(key,slot,others);
    var open=!who;
    var sub=need?("Wants the "+need+" tag"):(slot==="BOOTH"?"Up in the booth":"Hands out the iPads");

    var head='<div class="dhead ofhead" role="button" tabindex="0" aria-expanded="'+(open?"true":"false")+'">'
      + '<span class="ofslotname"><b>'+esc(label)+'</b><span class="ofsub">'+esc(sub)+'</span></span>'
      + '<span class="ofwho'+(who?"":" ofopen")+'">'+(who?esc(who.name):"Open")+'</span>'
      + (who?'<button type="button" class="btn ofclear" data-clear="'+esc(slot)+'">Clear</button>':"")
      + '<span class="caret" aria-hidden="true">&#9662;</span></div>';

    var body='<div class="dbody">';
    if(who){
      var st=oStatus(who,key);
      body+='<div class="ofnow"><b>'+esc(who.full_name||who.name)+'</b>'
          + '<span class="ofwhy">'+esc(st.label)+'</span>'+oTagChips(who)+'</div>';
    }
    if(!bench.length){
      body+='<p class="dempty">Nobody left who is free for this trip'
          + (need&&!oShowUntagged?' and carries the '+esc(need)+' tag. Turn on "everyone" below to see the rest.':'.')+'</p>';
    }
    bench.forEach(function(p,i){
      var st=oStatus(p,key), last=oObj(p.past)[key];
      body+='<button type="button" class="ofrow" data-pick="'+esc(slot)+'|'+esc(p.id)+'">'
        + '<span class="ofname">'+esc(p.name)+(i===0&&!who?'<span class="ofsug">suggested</span>':"")+'</span>'
        + '<span class="ofwhy">'+esc(st.label)+(last?" · had "+esc(last)+" here last time":"")+'</span>'
        + '<span class="oftags">'+oTagChips(p)+'</span></button>';
    });
    body+='</div>';
    return '<section class="dcard ofslot'+(open?"":" shut")+'" data-slot="'+esc(slot)+'">'+head+body+'</section>';
  }

  /* ---------------- the depth chart ---------------- */
  function drawDepth(){
    var games=oGames();
    if(!games.length) return '<p class="dempty">No away trips left on the schedule.</p>';
    if(!oView||!games.some(function(w){ return oGameKey(w)===oView; })) oView=oGameKey(games[0]);
    var w=null; games.forEach(function(g){ if(oGameKey(g)===oView) w=g; });
    var key=oView, taken=oAssigned(key);

    var filled=0; O_SLOTS.forEach(function(s){ if(taken[s[0]]) filled++; });
    var ids=[]; O_SLOTS.forEach(function(s){ if(taken[s[0]]) ids.push(taken[s[0]]); });

    /* people who asked for this trip and are not on it */
    var asked=OFF.crew.filter(function(p){
      if(ids.indexOf(p.id)>-1) return false;
      var st=oStatus(p,key); return st.t==="req";
    }).sort(function(a,b){ return (oObj(a.ranks)[key]||9)-(oObj(b.ranks)[key]||9); });
    var out=OFF.crew.filter(function(p){ return oStatus(p,key).t==="cant"; });

    var cards=""; O_SLOTS.forEach(function(s){ cards+=ofSlotCard(key,s[0],s[1],taken); });

    /* What goes on paper: the trip, the five spots, who has each one.
       Built on screen but only ever shown by the print stylesheet, so the
       page you post on the wall is not a screenshot of a web page. */
    var gp=w?wkDate(w):null;
    var roster='<div class="ofroster"><h2>'+esc(w?("at "+w.opp):key)+'</h2>'
      + '<p class="ofrwhen">'+esc(gp?new Date(gp.y,gp.mo,gp.d).toLocaleDateString("en-US",
          {weekday:"long",month:"long",day:"numeric"}):String(w?w.date:""))+'</p>'
      + '<table class="ofrtab"><tbody>'
      + O_SLOTS.map(function(s){
          var who=taken[s[0]]?oById(taken[s[0]]):null;
          return '<tr><th scope="row">'+esc(s[1])+'</th><td>'
            + (who?esc(who.full_name||who.name):'<span class="ofropen">open</span>')+'</td></tr>'; }).join("")
      + '</tbody></table>'
      + (filled<O_SLOTS.length
          ? '<p class="ofrnote">'+(O_SLOTS.length-filled)+' spot'
            + ((O_SLOTS.length-filled)===1?" is":"s are")+' still open.</p>' : "")
      + '</div>';

    return roster
      + ofTripBar(games,key)
      + '<div class="ofstat"><span><b>'+filled+'</b> of '+O_SLOTS.length+' spots filled</span>'
      + '<span class="wksp"></span>'
      + '<label class="ofall"><input type="checkbox" id="ofAll"'+(oShowUntagged?" checked":"")
      + '> Show everyone, tagged or not</label>'
      + '<button type="button" class="btn" id="ofFill">Fill the empty spots</button></div>'
      + '<div class="wkdays">'+cards+'</div>'
      + (asked.length?'<div class="ofaside"><b>Asked for '+esc(w?w.opp:key)+' and not on it yet</b><p>'
          + asked.map(function(p){ return esc(p.name)+" ("+(oObj(p.ranks)[key]||"?")+")"; }).join(", ")
          + '</p></div>':"")
      + (out.length?'<div class="ofaside"><b>Said they cannot make this one</b><p>'
          + out.map(function(p){ return esc(p.name); }).join(", ")+'</p></div>':"")
      + howto('Suggested picks read the preference sheets: who asked for this trip and how high they '
      + 'ranked it, who is flexible, who carries the tag the spot wants, and who already covered it on an earlier trip. '
      + 'It is a starting point, not a decision. Nothing here is readable without the office code.','How the suggestions work');
  }

  /* ---------------- the frame ---------------- */
  function renderOffice(){
    if(!officeroot) return;
    if(!officeCode()||!OFF){ drawLocked(""); return; }
    var body=oSub==="log"?drawLog():drawDepth();
    document.body.classList.toggle("of-prep",oSub==="log"&&oLogView==="prep"&&!!oLogWho);
    document.body.classList.toggle("of-depth",oSub!=="log");
    officeroot.innerHTML=
      '<div class="airbar ofbar">'
      + '<span class="wknow">Office</span>'
      + '<span class="wkctx">'+(oSub==="log"
          ? ((OFF.log||[]).length+" entr"+((OFF.log||[]).length===1?"y":"ies")+" logged")
          : (OFF.crew.length+" on the crew list"))+'</span>'
      + '<span class="wksp"></span>'
      + '<div class="tgroup ofsubs" role="group" aria-label="Office section">'
      + '<button type="button" class="btn" data-sub="depth" aria-pressed="'+(oSub==="depth"?"true":"false")+'">Travel Crew</button>'
      + '<button type="button" class="btn" data-sub="log" aria-pressed="'+(oSub==="log"?"true":"false")+'">Worker Log</button>'
      + '</div>'
      + '<button type="button" class="btn" id="ofLock">Lock</button>'
      + '</div>'
      + '<div class="ofbody">'+body+'</div>';
  }

  /* ================================================================
     The worker log. Attendance and conduct, one entry at a time, so a
     conversation later can start from what actually happened and when
     rather than from memory.
     ================================================================ */
  /* The five we started with. They are only a starting point: the list is
     edited from the log's own toolbar and kept in the shared settings, so
     everybody sees the same categories. An entry already written keeps the
     words it was written with even if you later drop that category, which
     is why entries store the text and not an id. */
  var O_CATS_DEFAULT=[["Late","con"],["No Call/No Show","con"],
                      ["Unwilling to Follow Direction","con"],
                      ["Positive Note","pro"],["Other","neutral"]];
  var O_CATKEY="wlog:cats";
  function oCats(){
    var raw=SETTINGS[O_CATKEY];
    if(raw){
      try{
        var list=JSON.parse(raw);
        if(Array.isArray(list)&&list.length){
          var out=[];
          list.forEach(function(x){
            var n=String((x&&x.n)||"").trim();
            if(n) out.push([n,(x&&x.k==="pro")?"pro":((x&&x.k==="con")?"con":"neutral")]);
          });
          if(out.length) return out;
        }
      }catch(e){}
    }
    return O_CATS_DEFAULT.slice();
  }
  /* categories on file, plus any an older entry still refers to */
  function oCatsSeen(){
    var out=oCats(), have={};
    out.forEach(function(c){ have[c[0]]=true; });
    (OFF&&OFF.log||[]).forEach(function(e){
      if(e.category&&!have[e.category]){ have[e.category]=true; out.push([e.category,"neutral"]); }
    });
    return out;
  }
  function oCatKind(c){ var k="neutral"; oCatsSeen().forEach(function(x){ if(x[0]===c) k=x[1]; }); return k; }
  function oCatUsed(name){
    var n=0; (OFF&&OFF.log||[]).forEach(function(e){ if(e.category===name) n++; });
    return n;
  }
  var O_VIEWS=[["list","By date"],["person","By person"],["prep","One on one"]];
  var oLogView="list", oLogCat="", oLogWho="", oLogForm=false, oLogEdit=0;
  var oCatEdit=false, oCatDraft=null;

  function oPerson(id){ var p=oById(id); return p?(p.full_name||p.name):(id||"Nobody named"); }
  function oShortName(id){ var p=oById(id); return p?p.name:(id||"—"); }
  function oDay(iso){
    if(!iso) return "";
    var b=String(iso).slice(0,10).split("-");
    if(b.length!==3) return String(iso);
    var d=new Date(+b[0],+b[1]-1,+b[2]);
    return d.toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"});
  }
  function oLogList(){
    return (OFF.log||[]).filter(function(e){
      if(oLogCat&&e.category!==oLogCat) return false;
      if(oLogView==="prep"&&oLogWho&&e.person_id!==oLogWho) return false;
      return true;
    });
  }

  /* who can have an entry logged against them: everyone still on the crew */
  function oLogPeople(){
    return OFF.crew.slice().sort(function(a,b){ return (a.sort||0)-(b.sort||0); });
  }

  function oLogFormHtml(){
    var ed=oLogEdit?(OFF.log||[]).filter(function(e){ return e.id===oLogEdit; })[0]:null;
    if(!oLogForm&&!ed) return "";
    var who=lsGet("fpb_who")||"";
    return '<form class="oflogform" id="ofLogForm">'
      + '<h3>'+(ed?"Edit this entry":"New entry")+'</h3>'
      + '<div class="offgrid">'
      + '<label class="offf">Date<input type="date" id="lgAt" value="'
        + esc(ed?String(ed.at).slice(0,10):ckISO(new Date()))+'"'+(ed?" disabled":"")+'></label>'
      + '<label class="offf">Student worker<select id="lgWho"'+(ed?" disabled":"")+'>'
        + '<option value="">Pick someone…</option>'
        + oLogPeople().map(function(p){
            return '<option value="'+esc(p.id)+'"'+((ed&&ed.person_id===p.id)?" selected":"")
                 + '>'+esc(p.full_name||p.name)+'</option>'; }).join("")
      + '</select></label>'
      + '<label class="offf">Category<select id="lgCat"'+(ed?" disabled":"")+'>'
        + '<option value="">Pick a category…</option>'
        + oCats().map(function(c){
            return '<option'+((ed&&ed.category===c[0])?" selected":"")+'>'+esc(c[0])+'</option>'; }).join("")
      + '</select></label>'
      + '<label class="offf">Expected in<input type="time" id="lgExp" value="'+esc(ed?ed.expected:"")+'"'+(ed?" disabled":"")+'></label>'
      + '<label class="offf">Actually in<input type="time" id="lgAct" value="'+esc(ed?ed.actual:"")+'"'+(ed?" disabled":"")+'></label>'
      + '<label class="offf offcheck"><input type="checkbox" id="lgMsg"'+((ed&&ed.messaged)?" checked":"")+(ed?" disabled":"")+'> Let us know ahead of time</label>'
      + '</div>'
      + '<label class="offf offwide">What happened<textarea id="lgWhat" rows="3" maxlength="4000" '
        + 'placeholder="Just the facts: what, what time, who else was there">'+esc(ed?ed.what:"")+'</textarea></label>'
      + '<label class="offf offwide">Follow-up or outcome<textarea id="lgOut" rows="2" maxlength="4000" '
        + 'placeholder="What you did about it, or what you agreed on. Can be filled in later.">'+esc(ed?ed.outcome:"")+'</textarea></label>'
      + '<label class="offf offwide">Written up by<input type="text" id="lgBy" maxlength="60" value="'
        + esc(ed?ed.logged_by:who)+'"'+(ed?" disabled":"")+'></label>'
      + '<div class="err ofErr" id="lgErr" role="alert"></div>'
      + '<div class="offrow"><button type="button" class="btn" id="lgCancel">Cancel</button>'
      + '<button type="submit" class="btn go">'+(ed?"Save changes":"Save entry")+'</button></div>'
      + '</form>';
  }

  var O_KINDS=[["con","Counts against"],["pro","Counts for"],["neutral","Neither"]];
  function oCatFormHtml(){
    if(!oCatEdit) return "";
    if(!oCatDraft) oCatDraft=oCats().map(function(c){ return {n:c[0],k:c[1]}; });
    return '<form class="oflogform ofcatform" id="ofCatForm">'
      + '<h3>What you can log</h3>'
      + '<p class="ofcathint">These are the choices in the category dropdown. Net on the By person '
      + 'page is whatever counts for someone minus whatever counts against. Neither does neither, it '
      + 'still gets counted in the total. Entries already written keep the words they were written '
      + 'with, so dropping one here never rewrites history.</p>'
      + '<div class="ofcatlist">'
      + oCatDraft.map(function(c,i){
          var used=oCatUsed(c.n);
          return '<div class="ofcatrow">'
            + '<input type="text" class="ofcatname" maxlength="60" value="'+esc(c.n)+'" '
            + 'data-ci="'+i+'" aria-label="Category name">'
            + '<select class="ofcatkind" data-ci="'+i+'" aria-label="How it counts">'
            + O_KINDS.map(function(k){
                return '<option value="'+k[0]+'"'+(c.k===k[0]?" selected":"")+'>'+esc(k[1])+'</option>'; }).join("")
            + '</select>'
            + '<span class="ofcatused">'+(used?used+" logged":"")+'</span>'
            + '<button type="button" class="btn ofclear" data-catdel="'+i+'">Remove</button>'
            + '</div>'; }).join("")
      + '</div>'
      + '<div class="ofcatadd"><button type="button" class="btn" id="ofCatAdd">Add a category</button>'
      + '<button type="button" class="btn" id="ofCatReset">Back to the original five</button></div>'
      + '<div class="err ofErr" id="ofCatErr" role="alert"></div>'
      + '<div class="offrow"><button type="button" class="btn" id="ofCatCancel">Cancel</button>'
      + '<button type="submit" class="btn go">Save the list</button></div></form>';
  }

  /* read the boxes back before any re-render, so typing is never lost */
  function oCatRead(){
    if(!oCatDraft) return;
    [].forEach.call(officeroot.querySelectorAll(".ofcatname"),function(el){
      var i=Number(el.getAttribute("data-ci")); if(oCatDraft[i]) oCatDraft[i].n=el.value;
    });
    [].forEach.call(officeroot.querySelectorAll(".ofcatkind"),function(el){
      var i=Number(el.getAttribute("data-ci")); if(oCatDraft[i]) oCatDraft[i].k=el.value;
    });
  }

  async function oCatSave(){
    oCatRead();
    var err=document.getElementById("ofCatErr");
    var list=oCatDraft.filter(function(c){ return String(c.n||"").trim(); })
                      .map(function(c){ return {n:String(c.n).trim(),k:c.k}; });
    if(!list.length){ err.textContent="Keep at least one category."; return; }
    var seen={};
    for(var i=0;i<list.length;i++){
      var key=list[i].n.toLowerCase();
      if(seen[key]){ err.textContent='"'+list[i].n+'" is in there twice.'; return; }
      seen[key]=true;
    }
    err.textContent="Saving\u2026";
    var bad=await saveSetting(O_CATKEY,JSON.stringify(list));
    if(bad){ err.textContent=bad; return; }
    oCatEdit=false; oCatDraft=null;
    if(oLogCat&&!list.some(function(c){ return c.n===oLogCat; })) oLogCat="";
    renderOffice(); flash("Categories saved.");
  }

  function oEntryHtml(e,showWho){
    var k=oCatKind(e.category);
    var times="";
    if(e.expected||e.actual) times=(e.expected||"?")+" → "+(e.actual||"?");
    return '<section class="dcard oflog ofk-'+k+'">'
      + '<div class="dhead nohit oflogh">'
      + '<span class="ofdate">'+esc(oDay(e.at))+'</span>'
      + (showWho?'<span class="ofperson">'+esc(oShortName(e.person_id))+'</span>':"")
      + '<span class="ofcat ofc-'+k+'">'+esc(e.category)+'</span>'
      + (times?'<span class="oftimes">'+esc(times)+'</span>':"")
      + (e.messaged?'<span class="ofmsg">let us know</span>':"")
      + '<span class="wksp"></span>'
      + '<button type="button" class="btn ofclear" data-logedit="'+e.id+'">Edit</button>'
      + '<button type="button" class="btn ofclear" data-logdel="'+e.id+'">Delete</button>'
      + '</div>'
      + '<div class="dbody oflogb">'
      + '<p class="ofwhat">'+esc(e.what||"(nothing written down)")+'</p>'
      + (e.outcome?'<p class="ofout"><b>Follow-up</b> '+esc(e.outcome)+'</p>':"")
      + '<p class="ofby">'+esc(whoName(e.logged_by)||"Someone")+'</p>'
      + '</div></section>';
  }

  function oTallies(){
    var m={};
    (OFF.log||[]).forEach(function(e){
      var k=e.person_id||"";
      if(!m[k]) m[k]={id:k,n:0,pro:0,con:0,cats:{}};
      m[k].n++;
      m[k].cats[e.category]=(m[k].cats[e.category]||0)+1;
      var kind=oCatKind(e.category);
      if(kind==="pro") m[k].pro++; else if(kind==="con") m[k].con++;
    });
    return Object.keys(m).map(function(k){ return m[k]; })
      .sort(function(a,b){ return (a.pro-a.con)-(b.pro-b.con)||b.n-a.n; });
  }

  function drawLog(){
    var tools='<div class="oflogtools">'
      + '<div class="tgroup ofsubs" role="group" aria-label="Log view">'
      + O_VIEWS.map(function(v){
            return '<button type="button" class="btn" data-logview="'+v[0]+'" aria-pressed="'
                 + (oLogView===v[0]?"true":"false")+'">'+v[1]+'</button>'; }).join("")
      + '</div><span class="wksp"></span>'
      + (oLogView==="list"
          ? '<label class="offilter">Category<select id="ofCat"><option value="">All categories</option>'
            + oCats().map(function(c){ return '<option'+(oLogCat===c[0]?" selected":"")+'>'+esc(c[0])+'</option>'; }).join("")
            + '</select></label>'
            + '<button type="button" class="btn" id="ofCsv">Download CSV</button>'
          : "")
      + (oLogView==="prep"
          ? '<label class="offilter">Who<select id="ofWho"><option value="">Pick someone…</option>'
            + oLogPeople().map(function(p){ return '<option value="'+esc(p.id)+'"'+(oLogWho===p.id?" selected":"")
                + '>'+esc(p.full_name||p.name)+'</option>'; }).join("")
            + '</select></label>'
            + (oLogWho?'<button type="button" class="btn" id="ofPrint">Print</button>':"")
          : "")
      + (!oLogForm&&!oLogEdit&&!oCatEdit
          ? '<button type="button" class="btn" id="ofCats">Categories</button>'
            + '<button type="button" class="btn ofnew" id="ofAdd">Add an entry</button>' : "")
      + '</div>'+oCatFormHtml()+oLogFormHtml();

    if(oLogView==="person"){
      var t=oTallies(), CATS=oCatsSeen();
      if(!t.length) return tools+'<p class="dempty">Nothing logged yet.</p>';
      return tools
        + '<div class="oftally"><table><thead><tr><th>Who</th>'
        + CATS.map(function(c){ return '<th>'+esc(c[0])+'</th>'; }).join("")
        + '<th>Entries</th><th>Net</th></tr></thead><tbody>'
        + t.map(function(r){
            var net=r.pro-r.con;
            return '<tr><th scope="row"><button type="button" class="oflink" data-prep="'+esc(r.id)+'">'
              + esc(oPerson(r.id))+'</button></th>'
              + CATS.map(function(c){ return '<td>'+(r.cats[c[0]]||"")+'</td>'; }).join("")
              + '<td>'+r.n+'</td>'
              + '<td class="ofnet '+(net>0?"ofpos":(net<0?"ofneg":""))+'">'+(net>0?"+":"")+net+'</td></tr>'; }).join("")
        + '</tbody></table></div>'
        + howto('Net is positive notes minus the three that are not. Anything logged as Other '
        + 'counts in the total and nowhere else. A row only exists once somebody has an entry, so a blank '
        + 'name on this page means a clean season, not a missing one. Click a name to pull up their entries.','How Net is counted');
    }

    if(oLogView==="prep"&&!oLogWho)
      return tools+'<p class="dempty">Pick someone above and this becomes their page: every entry in order, ready to print.</p>';

    var list=oLogList();
    var head="";
    if(oLogView==="prep"){
      var tl=oTallies().filter(function(r){ return r.id===oLogWho; })[0];
      head='<div class="ofprephead"><h2>'+esc(oPerson(oLogWho))+'</h2>'
        + '<p>'+(tl?(tl.n+" entr"+(tl.n===1?"y":"ies")+", "+tl.pro+" positive, "+tl.con+" not")
                  :"Nothing logged")+' · printed '+esc(oDay(ckISO(new Date())))+'</p></div>';
    }
    return tools
      + '<div class="ofnoprint"><h2>Nothing to print from this view</h2>'
      + '<p>The worker log only goes to paper one person at a time. Switch to '
      + '<b>One on one</b>, pick who it is about, and print that.</p></div>'
      + head
      + (list.length
          ? '<div class="wkdays">'+list.map(function(e){ return oEntryHtml(e,oLogView!=="prep"); }).join("")+'</div>'
          : '<p class="dempty">'+(oLogCat?"Nothing in that category.":"Nothing logged yet.")+'</p>')
      + (oLogView==="prep"
          ? '<p class="foot ckfoot ofprepfoot">Working notes, not a personnel file. If any of this turns into a '
            + 'formal record it belongs in whatever system Tulane sanctions for it.</p>' : "");
  }

  function oCsv(){
    var rows=[["Date","Who","Category","Expected","Actual","Let us know","What happened","Follow-up","Written up by"]];
    oLogList().forEach(function(e){
      rows.push([String(e.at).slice(0,10),oPerson(e.person_id),e.category,e.expected,e.actual,
                 e.messaged?"yes":"no",e.what,e.outcome,e.logged_by]);
    });
    return rows.map(function(r){
      return r.map(function(c){ return '"'+String(c==null?"":c).replace(/"/g,'""')+'"'; }).join(",");
    }).join("\r\n");
  }

  /* ---------------- clicks ---------------- */
  async function ofAssign(slot,person){
    if(oBusy) return;
    oBusy=true;
    var r=await officeRpc("set_assign",{p_game:oView,p_slot:slot,p_person:person||null,p_who:lsGet("fpb_who")||""});
    oBusy=false;
    if(r.err){ flash(r.err); if(!OFF) renderOffice(); return; }
    var hit=false;
    OFF.assign.forEach(function(a){
      if(a.game_key===oView&&a.slot===slot){ a.person_id=person||null; hit=true; }
    });
    if(!hit&&person) OFF.assign.push({game_key:oView,slot:slot,person_id:person});
    renderOffice();
  }

  async function ofLogSave(){
    var err=document.getElementById("lgErr");
    if(oLogEdit){
      var r2=await officeRpc("edit_log",{p_id:oLogEdit,
        p_what:document.getElementById("lgWhat").value.trim(),
        p_outcome:document.getElementById("lgOut").value.trim()});
      if(r2.err){ err.textContent=r2.err; return; }
      var id=oLogEdit;
      (OFF.log||[]).forEach(function(x){ if(x.id===id){
        x.what=document.getElementById("lgWhat").value.trim();
        x.outcome=document.getElementById("lgOut").value.trim(); } });
      oLogEdit=0; renderOffice(); flash("Entry updated."); return;
    }
    var who=document.getElementById("lgWho").value;
    var cat=document.getElementById("lgCat").value;
    var what=document.getElementById("lgWhat").value.trim();
    if(!who){ err.textContent="Pick who this is about."; return; }
    if(!cat){ err.textContent="Pick a category."; return; }
    if(!what){ err.textContent="Write down what happened."; return; }
    var row={at:document.getElementById("lgAt").value||ckISO(new Date()),
             person_id:who,category:cat,
             expected:document.getElementById("lgExp").value,
             actual:document.getElementById("lgAct").value,
             messaged:document.getElementById("lgMsg").checked,
             what:what,
             outcome:document.getElementById("lgOut").value.trim(),
             logged_by:document.getElementById("lgBy").value.trim()};
    err.textContent="Saving…";
    var r=await officeRpc("add_log",{p_at:row.at,p_person:row.person_id,p_category:row.category,
      p_expected:row.expected,p_actual:row.actual,p_messaged:row.messaged,
      p_what:row.what,p_by:row.logged_by,p_outcome:row.outcome});
    if(r.err){ err.textContent=r.err; return; }
    row.id=r.data||Date.now();
    OFF.log=[row].concat(OFF.log||[]);
    OFF.log.sort(function(a,b){ return String(b.at).localeCompare(String(a.at))||b.id-a.id; });
    oLogForm=false; renderOffice(); flash("Entry saved.");
  }

  if(officeroot){
    officeroot.addEventListener("submit",function(e){
      if(e.target.id==="ofLogForm"){ e.preventDefault(); return ofLogSave(); }
      if(e.target.id==="ofCatForm"){ e.preventDefault(); return oCatSave(); }
    });
    officeroot.addEventListener("click",async function(e){
      if(!e.target.closest) return;
      if(e.target.closest("#ofLock")) return lockOffice();

      /* ---- the worker log ---- */
      var lv=e.target.closest("[data-logview]");
      if(lv){ oLogView=lv.getAttribute("data-logview"); oLogForm=false; oLogEdit=0;
              oCatEdit=false; oCatDraft=null; renderOffice(); return; }
      if(e.target.closest("#ofAdd")){ oLogForm=true; oLogEdit=0; oCatEdit=false; renderOffice(); return; }
      if(e.target.closest("#ofCats")){ oCatEdit=true; oCatDraft=null; oLogForm=false; oLogEdit=0; renderOffice(); return; }
      if(e.target.closest("#ofCatCancel")){ oCatEdit=false; oCatDraft=null; renderOffice(); return; }
      if(e.target.closest("#ofCatAdd")){
        oCatRead(); oCatDraft.push({n:"",k:"con"}); renderOffice();
        var boxes=officeroot.querySelectorAll(".ofcatname");
        if(boxes.length) boxes[boxes.length-1].focus();
        return;
      }
      if(e.target.closest("#ofCatReset")){
        oCatDraft=O_CATS_DEFAULT.map(function(c){ return {n:c[0],k:c[1]}; });
        renderOffice(); return;
      }
      var cd=e.target.closest("[data-catdel]");
      if(cd){
        oCatRead();
        oCatDraft.splice(Number(cd.getAttribute("data-catdel")),1);
        renderOffice(); return;
      }
      if(e.target.closest("#lgCancel")){ oLogForm=false; oLogEdit=0; renderOffice(); return; }
      if(e.target.closest("#ofPrint")) return window.print();
      if(e.target.closest("#ofCsv")){
        var blob=new Blob([oCsv()],{type:"text/csv"});
        var a=document.createElement("a");
        a.href=URL.createObjectURL(blob);
        a.download="worker-log-"+ckISO(new Date())+".csv";
        document.body.appendChild(a); a.click();
        setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); },500);
        return;
      }
      var pr=e.target.closest("[data-prep]");
      if(pr){ oLogWho=pr.getAttribute("data-prep"); oLogView="prep"; renderOffice(); return; }
      var le=e.target.closest("[data-logedit]");
      if(le){ oLogEdit=Number(le.getAttribute("data-logedit")); oLogForm=false; renderOffice(); return; }
      var ld=e.target.closest("[data-logdel]");
      if(ld){
        var id=Number(ld.getAttribute("data-logdel"));
        if(ld.getAttribute("data-sure")!=="1"){
          ld.setAttribute("data-sure","1"); ld.textContent="Really delete?";
          setTimeout(function(){ if(ld.isConnected){ ld.removeAttribute("data-sure"); ld.textContent="Delete"; } },4000);
          return;
        }
        var rd=await officeRpc("del_log",{p_id:id});
        if(rd.err){ flash(rd.err); return; }
        OFF.log=(OFF.log||[]).filter(function(x){ return x.id!==id; });
        renderOffice(); flash("Entry deleted."); return;
      }
      var sb2=e.target.closest("[data-sub]");
      if(sb2){ oSub=sb2.getAttribute("data-sub"); renderOffice(); return; }
      var tp=e.target.closest("[data-trip]");
      if(tp){ oView=tp.getAttribute("data-trip"); renderOffice(); return; }
      var cl=e.target.closest("[data-clear]");
      if(cl){ e.stopPropagation(); return ofAssign(cl.getAttribute("data-clear"),""); }
      var pk=e.target.closest("[data-pick]");
      if(pk){ var bits=pk.getAttribute("data-pick").split("|"); return ofAssign(bits[0],bits[1]); }
      if(e.target.closest("#ofFill")){
        if(oBusy) return;
        var taken=oAssigned(oView), ids=[];
        O_SLOTS.forEach(function(s){ if(taken[s[0]]) ids.push(taken[s[0]]); });
        for(var i=0;i<O_SLOTS.length;i++){
          var s=O_SLOTS[i][0]; if(taken[s]) continue;
          var b=oBench(oView,s,ids); if(!b.length) continue;
          ids.push(b[0].id);
          await ofAssign(s,b[0].id);
        }
        return;
      }
      var h=e.target.closest(".ofslot .dhead"); if(!h) return;
      var card=h.parentNode, shut=!card.classList.contains("shut");
      card.classList.toggle("shut",shut);
      h.setAttribute("aria-expanded",shut?"false":"true");
    });
    officeroot.addEventListener("change",function(e){
      if(e.target.id==="ofAll"){ oShowUntagged=e.target.checked; renderOffice(); return; }
      if(e.target.id==="ofCat"){ oLogCat=e.target.value; renderOffice(); return; }
      if(e.target.id==="ofWho"){ oLogWho=e.target.value; renderOffice(); return; }
    });
    officeroot.addEventListener("keydown",function(e){
      if(e.key!=="Enter"&&e.key!==" ") return;
      var h=e.target.closest&&e.target.closest(".ofslot .dhead"); if(!h) return;
      e.preventDefault(); h.click();
    });
  }

  /* ---------------- the gear's Lock item ---------------- */
  function syncLockItem(){
    var b=gMenu&&gMenu.querySelector('[data-g="lock"]');
    if(b) b.hidden=!officeCode();
  }
  if(gMenu) gMenu.addEventListener("click",function(e){
    var b=e.target.closest&&e.target.closest('[data-g="lock"]');
    if(b) lockOffice();
  });

  async function officeBoot(){
    if(!officeCode()) return;
    await officeLoad();
    syncLockItem();
    if(TAB==="office") renderOffice();
  }

  /* ================================================================
     The purchase list. Type what we are talking about buying, cross it
     off when it is bought with what it actually cost, or drop it when
     we decide we do not need it. Four vendor prices sit on each line:
     Amazon and B&H can be refreshed by the scheduled job, CDW and
     MediaRight are the quotes you were given, typed in with the date.
     ================================================================ */
  var buyroot=document.getElementById("buyroot");
  var BUY=[], BUY_OK=false;
  var buyFilter="open", buyOpen={}, buyForm=false, buyEdit=0, buyMark=0, buyPrice="";

  var VENDORS=[["amazon","Amazon",true],["bh","B&H",true],
               ["cdw","CDW",false],["mediaright","MediaRight",false]];
  function vName(k){ var n=k; VENDORS.forEach(function(v){ if(v[0]===k) n=v[1]; }); return n; }
  function vAuto(k){ var a=false; VENDORS.forEach(function(v){ if(v[0]===k) a=v[2]; }); return a; }

  async function loadBuy(){
    if(!sb) return;
    var r=await sb.from("buy")
      .select("id,what,qty,note,status,prices,bought_at,spent,vendor,po,added_by,added_at,sort")
      .order("added_at",{ascending:false}).limit(1000);
    if(r.error) logRead("the purchase list",r.error);
    BUY=r.error?[]:(r.data||[]);
    BUY_OK=!r.error;
  }
  function applyBuyRow(msg){
    var row=msg.new&&msg.new.id?msg.new:(msg.old||null); if(!row) return;
    BUY=BUY.filter(function(x){ return x.id!==row.id; });
    if(msg.eventType!=="DELETE"&&msg.new&&msg.new.id) BUY.unshift(msg.new);
    BUY.sort(function(a,b){ return String(b.added_at).localeCompare(String(a.added_at)); });
    if(TAB==="buy") renderBuy();
  }

  async function buyRpc(fn,args){
    if(!sb) return {err:"Not connected."};
    if(!lsGet("fpb_code")){ var ok=await askLogin(); if(!ok) return {err:"Sign in to change the list."}; }
    args=args||{}; args.p_code=lsGet("fpb_code");
    var r;
    try{ r=await sb.rpc(fn,args); }catch(e){ r={error:e}; }
    if(r.error){
      var m=String(r.error.message||"");
      if(/does not exist|schema|function/i.test(m)) return {err:"Run buy-setup.sql in Supabase first."};
      if(/passcode/i.test(m)){ lsDel("fpb_code"); return {err:"Passcode changed. Try again."}; }
      return {err:"That did not save. Try again."};
    }
    return {data:r.data};
  }

  /* ---------------- money ---------------- */
  function money(n){
    if(n===null||n===undefined||n==="") return "";
    var v=Number(n); if(isNaN(v)) return "";
    return "$"+v.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
  }
  function priceOf(b,k){
    var p=(b.prices||{})[k];
    if(!p||p.price===null||p.price===undefined||p.price==="") return null;
    var v=Number(p.price); return isNaN(v)?null:v;
  }
  function bestVendor(b){
    var best=null;
    VENDORS.forEach(function(v){
      var n=priceOf(b,v[0]);
      if(n===null) return;
      if(!best||n<best.n) best={k:v[0],n:n};
    });
    return best;
  }
  function buyTotals(){
    var open=0, spent=0, planned=0, bought=0;
    BUY.forEach(function(b){
      if(b.status==="bought"){ bought++; if(b.spent!==null) spent+=Number(b.spent)||0; return; }
      if(b.status!=="open") return;
      open++;
      var best=bestVendor(b);
      if(best) planned+=best.n*(b.qty||1);
    });
    return {open:open,bought:bought,spent:spent,planned:planned};
  }

  /* ---------------- one vendor's chip ---------------- */
  function vChip(b,k){
    var p=(b.prices||{})[k]||{}, n=priceOf(b,k);
    var best=bestVendor(b);
    var isBest=best&&best.k===k&&n!==null;
    var when=p.at?("as of "+p.at.slice(5).split("-").join("/")):"";
    var src=p.src==="auto"?"refreshed":(p.src==="quote"?"quoted":"");
    var open=buyPrice===(b.id+"|"+k);
    var head='<button type="button" class="vchip'+(isBest?" vbest":"")+(n===null?" vnone":"")
      + '" data-price="'+b.id+"|"+k+'">'
      + '<span class="vname">'+esc(vName(k))+'</span>'
      + '<span class="vamt">'+(n===null?"&mdash;":esc(money(n)))+'</span>'
      + '<span class="vwhen">'+esc([when,src].filter(Boolean).join(" · "))+'</span>'
      + (p.ref?'<span class="vref">'+esc(p.ref)+'</span>':"")
      + '</button>';
    if(!open) return head
      + (p.url?'<a class="vlink" href="'+esc(p.url)+'" target="_blank" rel="noopener noreferrer" '
             + 'aria-label="Open '+esc(vName(k))+'">&#8599;</a>':"");
    return head
      + '<form class="vform" data-pform="'+b.id+"|"+k+'">'
      + '<label>Price<input type="number" step="0.01" min="0" class="vp" value="'+esc(n===null?"":n)+'" autocomplete="off"></label>'
      + (vAuto(k)
          ? '<label>Product link<input type="url" class="vu" value="'+esc(p.url||"")+'" placeholder="https://…" autocomplete="off"></label>'
          : '<label>Quote number or who quoted it<input type="text" class="vr" maxlength="200" value="'
            + esc(p.ref||"")+'" autocomplete="off"></label>')
      + '<div class="vrow"><button type="button" class="btn vclear">Clear</button>'
      + '<button type="button" class="btn" data-pcancel="1">Cancel</button>'
      + '<button type="submit" class="btn go">Save</button></div>'
      + '<p class="vhint">'+(vAuto(k)
          ? "Paste the product page and the scheduled job keeps this one current on its own."
          : "They do not publish prices, so this is whatever you were quoted. The date is stamped for you.")
        + '</p></form>';
  }

  /* ---------------- one line ---------------- */
  function buyCard(b){
    var open=!!buyOpen[b.id], done=b.status==="bought", dropped=b.status==="dropped";
    var best=bestVendor(b);
    var head='<div class="dhead buyhead" role="button" tabindex="0" aria-expanded="'+(open?"true":"false")+'">'
      + '<input type="checkbox" class="buybox" data-got="'+b.id+'"'+(done?" checked":"")
      + ' aria-label="'+(done?"Put back on the list":"Mark as bought")+'">'
      + '<span class="buywhat"><span class="buytop"><b>'+esc(b.what)+'</b>'
      + (b.qty>1?'<span class="buyqty">×'+b.qty+'</span>':"")+'</span>'
      + (b.note?'<span class="buynote">'+esc(b.note)+'</span>':"")+'</span>'
      + '<span class="wksp"></span>'
      + (done
          ? '<span class="buyspent">'+esc(money(b.spent))+(b.vendor?' <i>'+esc(b.vendor)+'</i>':"")+'</span>'
          : (best?'<span class="buybest">'+esc(money(best.n))+' <i>'+esc(vName(best.k))+'</i></span>'
                 :'<button type="button" class="btn buyaddp" data-addprice="'+b.id+'">Add a price</button>'))
      + (dropped?'<span class="buydrop">dropped</span>':"")
      + '<span class="caret" aria-hidden="true">&#9662;</span></div>';

    var body='<div class="dbody buybody">';
    if(buyMark===b.id){
      body+='<form class="buygot" data-gotform="'+b.id+'">'
        + '<h4>What did it come to?</h4>'
        + '<div class="offgrid">'
        + '<label class="offf">What we spent<input type="number" step="0.01" min="0" class="gSpent" value="'
          + esc(b.spent===null||b.spent===undefined?(best?best.n*(b.qty||1):""):b.spent)+'"></label>'
        + '<label class="offf">Bought from<input type="text" class="gVendor" maxlength="60" value="'
          + esc(b.vendor||(best?vName(best.k):""))+'"></label>'
        + '<label class="offf">Date<input type="date" class="gAt" value="'
          + esc(b.bought_at?String(b.bought_at).slice(0,10):ckISO(new Date()))+'"></label>'
        + '<label class="offf">PO or order number<input type="text" class="gPo" maxlength="60" value="'+esc(b.po||"")+'"></label>'
        + '</div>'
        + '<div class="offrow"><button type="button" class="btn" data-gotcancel="1">Cancel</button>'
        + '<button type="submit" class="btn go">Cross it off</button></div></form>';
    } else if(done){
      body+='<p class="buydone"><b>Bought</b> '+esc(b.bought_at?String(b.bought_at).slice(0,10):"")
        + (b.vendor?' from '+esc(b.vendor):"")+(b.spent!==null?' for '+esc(money(b.spent)):"")
        + (b.po?' · '+esc(b.po):"")
        + ' <button type="button" class="btn ofclear" data-mark="'+b.id+'">Fix this</button></p>';
    }
    body+='<div class="vgrid">'+VENDORS.map(function(v){
        return '<div class="vcell'+(buyPrice===(b.id+"|"+v[0])?" vopen":"")+'">'+vChip(b,v[0])+'</div>'; }).join("")+'</div>';
    body+='<div class="buyfoot"><span>'+esc(whoName(b.added_by)||"Someone")+' added this'
      + (b.added_at?" "+esc(shortDate(b.added_at)):"")+'</span><span class="wksp"></span>'
      + '<button type="button" class="btn ofclear" data-buyedit="'+b.id+'">Edit</button>'
      + '<button type="button" class="btn ofclear" data-buydrop="'+b.id+'">'
      + (dropped?"Put back":"No longer needed")+'</button>'
      + '<button type="button" class="btn ofclear" data-buydel="'+b.id+'">Delete</button></div>';
    body+='</div>';
    return '<section class="dcard buyline'+(open?"":" shut")+(done?" buydoneline":"")
      + (dropped?" buydropline":"")+'" data-buy="'+b.id+'">'+head+body+'</section>';
  }

  function buyFormHtml(){
    var ed=buyEdit?BUY.filter(function(b){ return b.id===buyEdit; })[0]:null;
    if(!buyForm&&!ed) return "";
    return '<form class="oflogform buyform" id="buyForm">'
      + '<h3>'+(ed?"Edit this line":"What are we thinking about buying?")+'</h3>'
      + '<div class="offgrid buygrid">'
      + '<label class="offf offwide">The thing<input type="text" id="byWhat" maxlength="300" value="'
        + esc(ed?ed.what:"")+'" placeholder="Sony FX3, 128GB CFexpress card, a longer SDI run" autocomplete="off"></label>'
      + '<label class="offf">How many<input type="number" id="byQty" min="1" step="1" value="'+(ed?ed.qty:1)+'"></label>'
      + '</div>'
      + '<label class="offf offwide">Anything worth noting<textarea id="byNote" rows="2" maxlength="2000" '
        + 'placeholder="Why we want it, what it replaces, which bag it lives in">'+esc(ed?ed.note:"")+'</textarea></label>'
      + '<div class="err ofErr" id="byErr" role="alert"></div>'
      + '<div class="offrow"><button type="button" class="btn" id="byCancel">Cancel</button>'
      + '<button type="submit" class="btn go">'+(ed?"Save changes":"Add it")+'</button></div></form>';
  }

  function renderBuy(){
    if(!buyroot) return;
    if(!BUY_OK){
      buyroot.innerHTML='<div class="airsetup"><h2>One thing to run first</h2>'
        + '<p>The purchase list needs its table. Open <b>buy-setup.sql</b>, paste the whole file into '
        + 'Supabase, SQL Editor, New query, and Run it. Nothing in that file needs editing.</p>'
        + '<p class="airnote">Writing to this list uses the staff passcode you already have.</p></div>';
      return;
    }
    var t=buyTotals();
    var list=BUY.filter(function(b){
      if(buyFilter==="all") return true;
      if(buyFilter==="open") return b.status==="open";
      if(buyFilter==="bought") return b.status==="bought";
      return b.status==="dropped";
    });
    var FILT=[["open","Still want"],["bought","Bought"],["dropped","Dropped"],["all","Everything"]];
    buyroot.innerHTML=
      '<div class="airbar ofbar">'
      + '<span class="wknow">Purchase List</span>'
      + '<span class="wkctx"><b>'+t.open+'</b> still want'
      + (t.planned?' · about '+esc(money(t.planned))+' at the best price we have':"")
      + (t.spent?' · '+esc(money(t.spent))+' spent on '+t.bought+' so far':"")+'</span>'
      + '<span class="wksp"></span>'
      + '<div class="tgroup ofsubs" role="group" aria-label="Show">'
      + FILT.map(function(f){
          return '<button type="button" class="btn" data-buyfilter="'+f[0]+'" aria-pressed="'
               + (buyFilter===f[0]?"true":"false")+'">'+f[1]+'</button>'; }).join("")
      + '</div>'
      + (buyForm||buyEdit?"":'<button type="button" class="btn ofnew" id="byAdd">Add an item</button>')
      + '</div>'
      + '<div class="ofbody">'
      + buyFormHtml()
      + (list.length
          ? '<div class="wkdays">'+list.map(buyCard).join("")+'</div>'
          : '<p class="dempty">'+(BUY.length?"Nothing in here.":"Nothing on the list yet. Add the first thing you are thinking about.")+'</p>')
      + howto('Amazon and B&amp;H prices refresh on their own if you paste the product link. '
      + 'CDW and MediaRight do not publish prices, so those are whatever you were quoted, with the date stamped on '
      + 'so you can see when a number went stale. The best price we know about is the one on the line.','How the prices work')
      + '</div>';
  }

  /* ---------------- saving ---------------- */
  async function buySave(){
    var err=document.getElementById("byErr");
    var what=document.getElementById("byWhat").value.trim();
    var qty=Math.max(1,parseInt(document.getElementById("byQty").value,10)||1);
    var note=document.getElementById("byNote").value.trim();
    if(!what){ err.textContent="Type what it is first."; return; }
    err.textContent="Saving…";
    if(buyEdit){
      var r2=await buyRpc("edit_buy",{p_id:buyEdit,p_what:what,p_qty:qty,p_note:note});
      if(r2.err){ err.textContent=r2.err; return; }
      BUY.forEach(function(b){ if(b.id===buyEdit){ b.what=what; b.qty=qty; b.note=note; } });
      buyEdit=0; renderBuy(); flash("Saved."); return;
    }
    var r=await buyRpc("add_buy",{p_what:what,p_qty:qty,p_note:note,p_who:lsGet("fpb_who")||""});
    if(r.err){ err.textContent=r.err; return; }
    BUY.unshift({id:r.data||Date.now(),what:what,qty:qty,note:note,status:"open",prices:{},
                 bought_at:null,spent:null,vendor:"",po:"",
                 added_by:lsGet("fpb_who")||"",added_at:new Date().toISOString(),sort:0});
    buyForm=false; renderBuy(); flash("Added.");
  }

  async function buyGot(id,form){
    var b=BUY.filter(function(x){ return x.id===id; })[0]; if(!b) return;
    var spent=form.querySelector(".gSpent").value;
    var vendor=form.querySelector(".gVendor").value.trim();
    var at=form.querySelector(".gAt").value||ckISO(new Date());
    var po=form.querySelector(".gPo").value.trim();
    var r=await buyRpc("set_buy_status",{p_id:id,p_status:"bought",
      p_spent:spent===""?null:Number(spent),p_vendor:vendor,p_at:at,p_po:po});
    if(r.err){ flash(r.err); return; }
    b.status="bought"; b.spent=spent===""?null:Number(spent);
    b.vendor=vendor; b.bought_at=at; b.po=po;
    buyMark=0; renderBuy(); flash("Crossed off.");
  }

  async function buyStatus(id,status){
    var b=BUY.filter(function(x){ return x.id===id; })[0]; if(!b) return;
    var r=await buyRpc("set_buy_status",{p_id:id,p_status:status});
    if(r.err){ flash(r.err); return; }
    b.status=status;
    if(status!=="bought"){ b.spent=null; b.vendor=""; b.po=""; b.bought_at=null; }
    renderBuy();
  }

  async function buySavePrice(id,vend,form){
    var b=BUY.filter(function(x){ return x.id===id; })[0]; if(!b) return;
    var pIn=form.querySelector(".vp"), uIn=form.querySelector(".vu"), rIn=form.querySelector(".vr");
    var price=pIn&&pIn.value!==""?Number(pIn.value):null;
    var url=uIn?uIn.value.trim():"";
    var ref=rIn?rIn.value.trim():"";
    var r=await buyRpc("set_buy_price",{p_id:id,p_vendor:vend,p_price:price,p_url:url,
      p_ref:ref,p_src:vAuto(vend)?"hand":"quote"});
    if(r.err){ flash(r.err); return; }
    b.prices=b.prices||{};
    if(price===null&&!url&&!ref) delete b.prices[vend];
    else b.prices[vend]={price:price,url:url,ref:ref,src:vAuto(vend)?"hand":"quote",at:ckISO(new Date())};
    buyPrice=""; renderBuy();
  }

  if(buyroot){
    buyroot.addEventListener("submit",function(e){
      if(e.target.id==="buyForm"){ e.preventDefault(); return buySave(); }
      var g=e.target.getAttribute("data-gotform");
      if(g){ e.preventDefault(); return buyGot(Number(g),e.target); }
      var pf=e.target.getAttribute("data-pform");
      if(pf){ e.preventDefault(); var bits=pf.split("|"); return buySavePrice(Number(bits[0]),bits[1],e.target); }
    });
    buyroot.addEventListener("change",async function(e){
      var g=e.target.closest&&e.target.closest("[data-got]"); if(!g) return;
      var id=Number(g.getAttribute("data-got"));
      if(g.checked){ buyMark=id; buyOpen[id]=true; renderBuy(); }
      else { await buyStatus(id,"open"); }
    });
    buyroot.addEventListener("click",async function(e){
      if(!e.target.closest) return;
      if(e.target.closest(".buybox")) return;                 /* the change handler owns it */
      if(e.target.closest("a")) return;
      var f=e.target.closest("[data-buyfilter]");
      if(f){ buyFilter=f.getAttribute("data-buyfilter"); renderBuy(); return; }
      if(e.target.closest("#byAdd")){ buyForm=true; buyEdit=0; renderBuy(); return; }
      if(e.target.closest("#byCancel")){ buyForm=false; buyEdit=0; renderBuy(); return; }
      var be=e.target.closest("[data-buyedit]");
      if(be){ buyEdit=Number(be.getAttribute("data-buyedit")); buyForm=false; renderBuy(); return; }
      var mk=e.target.closest("[data-mark]");
      if(mk){ buyMark=Number(mk.getAttribute("data-mark")); renderBuy(); return; }
      if(e.target.closest("[data-gotcancel]")){
        var card=e.target.closest(".buyline"), cid=Number(card.getAttribute("data-buy"));
        var cur=BUY.filter(function(x){ return x.id===cid; })[0];
        buyMark=0; renderBuy();
        if(cur&&cur.status!=="bought"){ var cb=buyroot.querySelector('[data-got="'+cid+'"]'); if(cb) cb.checked=false; }
        return;
      }
      var dp=e.target.closest("[data-buydrop]");
      if(dp){
        var did=Number(dp.getAttribute("data-buydrop"));
        var cur2=BUY.filter(function(x){ return x.id===did; })[0];
        return buyStatus(did,cur2&&cur2.status==="dropped"?"open":"dropped");
      }
      var dl=e.target.closest("[data-buydel]");
      if(dl){
        var id2=Number(dl.getAttribute("data-buydel"));
        if(dl.getAttribute("data-sure")!=="1"){
          dl.setAttribute("data-sure","1"); dl.textContent="Really delete?";
          setTimeout(function(){ if(dl.isConnected){ dl.removeAttribute("data-sure"); dl.textContent="Delete"; } },4000);
          return;
        }
        var rr=await buyRpc("del_buy",{p_id:id2});
        if(rr.err){ flash(rr.err); return; }
        BUY=BUY.filter(function(x){ return x.id!==id2; });
        renderBuy(); flash("Deleted."); return;
      }
      var ap=e.target.closest("[data-addprice]");
      if(ap){
        var aid=Number(ap.getAttribute("data-addprice"));
        buyOpen[aid]=true; buyPrice=aid+"|amazon"; renderBuy();
        var fld=buyroot.querySelector('.vform[data-pform="'+aid+'|amazon"] .vp');
        if(fld) fld.focus();
        return;
      }
      if(e.target.closest("[data-pcancel]")){ buyPrice=""; renderBuy(); return; }
      if(e.target.closest(".vclear")){
        var pform=e.target.closest(".vform"), pb=pform.getAttribute("data-pform").split("|");
        var p1=pform.querySelector(".vp"); if(p1) p1.value="";
        var u1=pform.querySelector(".vu"); if(u1) u1.value="";
        var r1=pform.querySelector(".vr"); if(r1) r1.value="";
        return buySavePrice(Number(pb[0]),pb[1],pform);
      }
      var pc=e.target.closest("[data-price]");
      if(pc){
        var key=pc.getAttribute("data-price");
        buyPrice=(buyPrice===key)?"":key;
        var cid2=Number(key.split("|")[0]); buyOpen[cid2]=true;
        renderBuy(); return;
      }
      var h=e.target.closest(".buyline .dhead"); if(!h) return;
      var c2=h.parentNode, bid=Number(c2.getAttribute("data-buy"));
      buyOpen[bid]=!buyOpen[bid];
      c2.classList.toggle("shut",!buyOpen[bid]);
      h.setAttribute("aria-expanded",buyOpen[bid]?"true":"false");
    });
    buyroot.addEventListener("keydown",function(e){
      if(e.key!=="Enter"&&e.key!==" ") return;
      if(e.target.classList&&e.target.classList.contains("buybox")) return;
      var h=e.target.closest&&e.target.closest(".buyline .dhead"); if(!h) return;
      e.preventDefault(); h.click();
    });
  }

  /* ================================================================
     Problems, and finding things.

     A log of every click would have caught one of the three bugs that
     cost real work this week. What it would not have caught is the two
     that mattered, because neither started with a click: one was a
     message arriving from the server, the other was a read that failed
     quietly inside an ordinary-looking save.

     So this logs what FAILS. Every call to the database goes through
     one wrapper, so a failure anywhere gets written down whether or not
     the code that made the call bothered to check.
     ================================================================ */
  var PKEY="fvo_problems", PMAX=50;
  var PROB=[];
  try{ PROB=JSON.parse(lsGet(PKEY)||"[]"); if(!Array.isArray(PROB)) PROB=[]; }catch(e){ PROB=[]; }

  function probSave(){
    try{ lsSet(PKEY,JSON.stringify(PROB.slice(0,PMAX))); }catch(e){}
  }
  function logProblem(what,detail){
    var last=PROB[0];
    /* the same thing failing in a loop should read as one line with a count */
    if(last&&last.what===what&&last.detail===detail&&Date.now()-last.t<60000){
      last.n=(last.n||1)+1; last.at=new Date().toISOString(); probSave(); syncGearBadge(); return;
    }
    PROB.unshift({what:String(what).slice(0,120),detail:String(detail||"").slice(0,400),
                  at:new Date().toISOString(),t:Date.now(),n:1,
                  tab:TAB,who:lsGet("fpb_who")||"",ver:VER});
    PROB=PROB.slice(0,PMAX);
    probSave();
    try{ syncGearBadge(); }catch(e){}
  }
  function probCount(){ return PROB.length; }

  window.addEventListener("error",function(e){
    logProblem("the page hit an error",(e&&e.message||"")+" ("+((e&&e.filename||"").split("/").pop())+":"+(e&&e.lineno)+")");
  });
  window.addEventListener("unhandledrejection",function(e){
    var r=e&&e.reason;
    logProblem("something failed in the background",(r&&r.message)||String(r||""));
  });

  /* One wrapper over the database handle, put on as soon as it exists.
     Nothing has to remember to report a failure: they all come through here. */
  function watchDb(){
    if(!sb||sb.__watched) return;
    sb.__watched=true;
    var rpc=sb.rpc.bind(sb), from=sb.from.bind(sb);
    sb.rpc=function(n,a){
      var p;
      try{ p=rpc(n,a); }catch(e){ logProblem("could not send "+n,String(e&&e.message||e)); throw e; }
      return Promise.resolve(p).then(function(r){
        if(r&&r.error) logProblem(n+" was refused",r.error.message||String(r.error));
        return r;
      },function(e){ logProblem(n+" never came back",String(e&&e.message||e)); throw e; });
    };
    /* Reads are reported by the code that makes them, through logRead below.
       Wrapping sb.from cannot work: .select() and .eq() each hand back a new
       builder, so a wrapper put on the first one is gone by the time the
       query actually runs. */
  }

  function logRead(what,err){
    if(!err) return false;
    logProblem("could not read "+what,(err&&err.message)||String(err));
    return true;
  }

  function probLines(){
    var out=["Tulane Football Video  -  Problems  (Football Video Ops v"+VER+")",
             "Copied "+new Date().toLocaleString("en-US",{weekday:"short",month:"short",day:"numeric",
               year:"numeric",hour:"numeric",minute:"2-digit"}),""];
    if(!PROB.length) out.push("(nothing has gone wrong on this computer)");
    PROB.forEach(function(p){
      out.push(shortDate(p.at)+"  "+p.what+(p.n>1?"  (x"+p.n+")":""));
      if(p.detail) out.push("    "+p.detail);
      out.push("    on the "+(p.tab||"?")+" tab"+(p.who?", "+whoName(p.who):"")+", v"+(p.ver||"?"));
      out.push("");
    });
    return out.join("\n");
  }

  function drawProblems(){
    var box=document.getElementById("pbList"); if(!box) return;
    var c=document.getElementById("pbCount");
    if(c) c.textContent=PROB.length?(PROB.length+" on this computer"):"";
    if(!PROB.length){
      box.innerHTML='<p class="h-empty">Nothing has gone wrong on this computer. '
        + 'If something does, it lands here with what it was doing at the time.</p>';
      return;
    }
    box.innerHTML=PROB.map(function(p){
      return '<div class="h-row pbrow"><span class="h-what"><b>'+esc(p.what)
        + (p.n>1?' <i class="pbn">&times;'+p.n+'</i>':"")+'</b>'
        + (p.detail?'<span class="pbdetail">'+esc(p.detail)+'</span>':"")
        + '<span class="h-when">'+esc(shortDate(p.at)+" \u00b7 "+(p.tab||"?")+" tab"
            +(p.who?" \u00b7 "+whoName(p.who):"")+" \u00b7 v"+(p.ver||"?"))+'</span></span></div>';
    }).join("");
  }
  function openProblems(){
    var d=document.getElementById("probDlg"); if(!d) return;
    drawProblems();
    if(d.showModal) d.showModal(); else d.setAttribute("open","");
  }

  /* ================================================================
     Find anything. Three hundred odd rows across ten tabs is past what
     anybody keeps in their head.
     ================================================================ */
  var findQ="", findHit=null;

  function findAll(q){
    q=String(q||"").trim().toLowerCase();
    var out=[];
    if(q.length<2) return out;
    function hit(where,tab,what,sub,go){
      out.push({where:where,tab:tab,what:what,sub:sub||"",go:go});
    }
    /* the week, sheet rows and your own */
    var sun=wkSunday();
    WK_DAYS.forEach(function(D,i){
      D.t.forEach(function(x){
        if((x.t+" "+(x.n||"")).toLowerCase().indexOf(q)<0) return;
        hit("Week",  "week", x.t, D.n+(x.n?" \u00b7 "+x.n:""), {tab:"week",day:i});
      });
    });
    bldGet(BLD_WK).forEach(function(x){
      if((x.t+" "+(x.n||"")).toLowerCase().indexOf(q)<0) return;
      hit("Week","week",x.t,WK_DAYS[Number(x.d)].n+" \u00b7 added"+(x.every?", every week":""),
          {tab:"week",day:Number(x.d)});
    });
    /* every pack list, as it stands now */
    Object.keys(PACKS).forEach(function(k){
      var p=PACKS[k];
      pkAllGroups(p).forEach(function(gr){
        (gr.items||[]).forEach(function(it){
          if((it.t+" "+(it.n||"")).toLowerCase().indexOf(q)<0) return;
          hit(p.tab,k,it.t,gr.g+(it.q?" \u00b7 \u00d7"+it.q:"")+(it.n?" \u00b7 "+it.n:""),
              {tab:k,grp:gr.g});
        });
      });
    });
    /* the purchase list */
    (typeof BUY!=="undefined"?BUY:[]).forEach(function(b){
      if((b.what+" "+(b.note||"")).toLowerCase().indexOf(q)<0) return;
      hit("Buy List","buy",b.what,
          (b.status==="bought"?"bought":(b.status==="dropped"?"dropped":"still want"))
          +(b.note?" \u00b7 "+b.note:""),{tab:"buy",buy:b.id});
    });
    /* notes */
    (typeof NOTES!=="undefined"?NOTES:[]).forEach(function(n){
      if((n.body+" "+(n.label||"")).toLowerCase().indexOf(q)<0) return;
      hit("Notes","", n.body.slice(0,80), (n.label||"General note")+" \u00b7 "+(n.who||""),{notes:true});
    });
    return out.slice(0,60);
  }

  function drawFind(){
    var box=document.getElementById("fdList"); if(!box) return;
    var list=findAll(findQ);
    var c=document.getElementById("fdCount");
    if(findQ.trim().length<2){
      if(c) c.textContent="";
      box.innerHTML='<p class="h-empty">Type two letters or more. This looks through every day list, '
        + 'every pack list, the purchase list and your notes at once.</p>';
      return;
    }
    if(c) c.textContent=list.length?(list.length+(list.length===60?"+":"")+" found"):"";
    if(!list.length){ box.innerHTML='<p class="h-empty">Nothing matches that.</p>'; return; }
    box.innerHTML=list.map(function(r,i){
      return '<button type="button" class="h-row fdrow" data-find="'+i+'">'
        + '<span class="fdwhere">'+esc(r.where)+'</span>'
        + '<span class="h-what"><b>'+esc(r.what)+'</b>'
        + (r.sub?'<span class="h-when">'+esc(r.sub)+'</span>':"")+'</span>'
        + '<span class="fdgo" aria-hidden="true">&#8599;</span></button>';
    }).join("");
    findHit=list;
  }
  function openFind(){
    var d=document.getElementById("findDlg"); if(!d) return;
    findQ="";
    var inp=document.getElementById("fdQ"); if(inp) inp.value="";
    drawFind();
    if(d.showModal) d.showModal(); else d.setAttribute("open","");
    setTimeout(function(){ if(inp) inp.focus(); },40);
  }
  function closeFind(){
    var d=document.getElementById("findDlg");
    if(d) d.close?d.close():d.removeAttribute("open");
  }
  function gotoHit(r){
    closeFind();
    if(!r) return;
    if(r.go&&r.go.notes){ openAllNotes(); return; }
    var g=r.go||{};
    if(g.tab==="week"){
      wkState.off=0; wkState.todayOnly=false; wkState.focus=false;
      wkState.open[g.day]=true;
      showTab("week");
      setTimeout(function(){ flashRow('#weekroot .dcard[data-day="'+g.day+'"]'); },80);
      return;
    }
    if(g.tab==="buy"){ showTab("buy"); setTimeout(function(){
      flashRow('#buyroot .buyline[data-buy="'+g.buy+'"]'); },80); return; }
    if(PACKS[g.tab]){
      pkState[g.tab+"|shut|"+g.grp]=false;
      showTab(g.tab);
      setTimeout(function(){ flashRow('#packroot .pkgroup[data-grp="'+cssq(g.grp)+'"]'); },80);
      return;
    }
  }
  function cssq(s){ return String(s).replace(/["\\]/g,"\\$&"); }
  function flashRow(sel){
    var el=null;
    try{ el=document.querySelector(sel); }catch(e){}
    if(!el) return;
    el.scrollIntoView({block:"center",behavior:"smooth"});
    el.classList.add("fdflash");
    setTimeout(function(){ el.classList.remove("fdflash"); },2200);
  }

  /* ---------------- wiring ---------------- */
  (function(){
    var pd=document.getElementById("probDlg");
    if(pd){
      document.getElementById("pbClose").addEventListener("click",function(){
        pd.close?pd.close():pd.removeAttribute("open"); });
      document.getElementById("pbClear").addEventListener("click",function(){
        PROB=[]; probSave(); drawProblems(); syncGearBadge(); });
      document.getElementById("pbCopy").addEventListener("click",function(){
        var txt=probLines(), btn=document.getElementById("pbCopy");
        function ok(){ btn.textContent="Copied"; setTimeout(function(){ btn.textContent="Copy all"; },1600); }
        if(navigator.clipboard&&navigator.clipboard.writeText)
          navigator.clipboard.writeText(txt).then(ok,function(){ fb2(txt,ok); });
        else fb2(txt,ok);
      });
      function fb2(txt,ok){
        var ta=document.getElementById("pbFallback");
        ta.value=txt; ta.hidden=false; ta.focus(); ta.select();
        try{ document.execCommand("copy"); ok(); }catch(e){}
      }
    }
    var fd=document.getElementById("findDlg");
    if(fd){
      document.getElementById("fdClose").addEventListener("click",closeFind);
      document.getElementById("fdQ").addEventListener("input",function(e){
        findQ=e.target.value; drawFind(); });
      document.getElementById("fdList").addEventListener("click",function(e){
        var r=e.target.closest&&e.target.closest("[data-find]"); if(!r) return;
        gotoHit(findHit&&findHit[Number(r.getAttribute("data-find"))]);
      });
      fd.addEventListener("click",function(e){ if(e.target===fd) closeFind(); });
    }
    var fb=document.getElementById("fFind");
    if(fb) fb.addEventListener("click",function(e){ e.stopPropagation(); openFind(); });
    /* "/" anywhere that is not a text box opens it, the way search always has */
    document.addEventListener("keydown",function(e){
      if(e.key!=="/"||e.ctrlKey||e.metaKey||e.altKey) return;
      var t=e.target&&e.target.tagName;
      if(t==="INPUT"||t==="TEXTAREA"||t==="SELECT") return;
      if(document.querySelector("dialog[open]")) return;
      e.preventDefault(); openFind();
    });
  })();

  /* ---------- start ---------- */
  setSync("busy","Loading…");
  try{
    var resp=await fetch("data.json",{cache:"no-cache"});
    DATA=await resp.json(); LOGOS=DATA.logos||{};
    indexOpponents();
    try{ await sampleAllLogos(); }catch(e){}
  }catch(e){
    setSync("off","Offline");
    showNotice("Could not load the schedule. Refresh the page.");
    return;
  }
  var rec=tulRecord(), rc=document.getElementById("tulRec");
  if(rc&&rec){ rc.textContent="Tulane "+rec.replace("-","\u2013"); rc.hidden=false; }
  function stampPrint(){ var pd=document.getElementById("printDate"); if(pd) pd.textContent=new Date().toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric",year:"numeric"}); }
  stampPrint(); window.addEventListener("beforeprint",stampPrint);
  var qt=document.getElementById("quickTop"); if(qt) qt.addEventListener("click",function(){ window.scrollTo({top:0,behavior:RM?"auto":"smooth"}); });
  wkDefaultOpen();
  var savedTab=lsGet("fpb_tab")||"board";
  showTab((savedTab!=="board"&&(savedTab==="week"||savedTab==="air"||savedTab==="office"||savedTab==="buy"||PACKS[savedTab]))?savedTab:"board");
  render();
  syncUndoButtons();
  setInterval(tick,30000);
  setInterval(function(){ renderWorkload(); },300000);
  setInterval(flushQueue,20000);

  if(!window.supabase||!CFG.url||!CFG.anonKey||/PASTE/.test(CFG.url+CFG.anonKey)){
    setSync("off","Not connected");
    showNotice("The board is not connected to its database yet. Fill in config.js.");
    return;
  }
  sb=window.supabase.createClient(CFG.url,CFG.anonKey);
  try{ await loadChecks(); await loadCandidates(); render(); renderCurrentList(); }
  catch(e){
    setSync("off","Not connected");
    showNotice("Could not load checkmarks. Refresh the page.");
    return;
  }
  try{ await loadTrackers(); }catch(e){}
  try{ await loadNotes(); }catch(e){}
  try{ await loadSettings(); renderCurrentList(); }catch(e){}
  try{ await checkDb(); }catch(e){}
  try{ await officeBoot(); }catch(e){}
  watchDb();
  try{ await loadBuy(); renderBuy(); }catch(e){}
  paintNoteMarks(); syncGearBadge();
  flushQueue();

  sb.channel("checks-live")
    .on("postgres_changes",{event:"*",schema:"public",table:"checks"},function(msg){
      var row=msg.new&&msg.new.id?msg.new:null;
      if(!row) return;
      if(qGet().some(function(x){ return x.id===row.id; })) return;   /* our unsent change wins */
      applyRow(row);
      var bs=boxesFor(row.id);
      if(onlyLeft&&!isListId(row.id)){ render(); return; }
      if(bs.length) bs.forEach(function(bx){ bx.checked=!!row.checked; refreshTag(bx); patch(bx); });
      else { updateTotals(); renderWorkload(); }
    })
    .on("postgres_changes",{event:"*",schema:"public",table:"candidates"},async function(){
      await loadCandidates(); render();
    })
    .on("postgres_changes",{event:"*",schema:"public",table:"notes"},function(msg){ applyNoteRow(msg); })
    .on("postgres_changes",{event:"*",schema:"public",table:"settings"},function(msg){ settingChanged(msg); })
    .on("postgres_changes",{event:"*",schema:"public",table:"buy"},function(msg){ applyBuyRow(msg); })
    .subscribe(function(status){
      if(status==="SUBSCRIBED"){ if(!qGet().length) setSync("ok","Live"); else showQueue(); }
      else if(status==="CHANNEL_ERROR"||status==="TIMED_OUT"||status==="CLOSED") setSync("busy","Reconnecting…");
    });

  /* Catch anything missed while a laptop slept or a phone was locked. */
  document.addEventListener("visibilitychange",async function(){
    if(document.visibilityState!=="visible") return;
    flushQueue();
    try{ await loadChecks(); await loadCandidates(); await loadNotes(); await loadSettings(); await loadBuy(); render(); renderCurrentList(); paintNoteMarks(); syncGearBadge(); }catch(e){}
  });
})();
