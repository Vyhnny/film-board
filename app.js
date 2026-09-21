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
    return (label?label+" pulled by ":"Pulled by ")+w.by+(w.at?" · "+shortDate(w.at):"");
  }
  function whoTag(id,label){
    var w=STATE.checks[id]?STATE.who[id]:null;
    if(!w||!w.by) return '<span class="who-tag" aria-hidden="true"></span>';
    var tip=(label?label+" pulled by ":"Pulled by ")+w.by+(w.at?" · "+shortDate(w.at):"");
    return '<span class="who-tag on" title="'+esc(tip)+'">'+esc(initials(w.by))+'</span>';
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
    return [].filter.call(root.querySelectorAll("input.box"),function(b){ return b.getAttribute("data-id")===id; });
  }

  function setLocal(id,on,by){
    if(on){ STATE.checks[id]=1; STATE.who[id]={by:by||lsGet("fpb_who")||"",at:new Date().toISOString()}; }
    else { delete STATE.checks[id]; delete STATE.who[id]; }
    var bs=boxesFor(id);
    if(onlyLeft){ render(); return; }
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
  try{ await loadChecks(); await loadCandidates(); render(); }
  catch(e){
    setSync("off","Not connected");
    showNotice("Could not load checkmarks. Refresh the page.");
    return;
  }
  flushQueue();

  sb.channel("checks-live")
    .on("postgres_changes",{event:"*",schema:"public",table:"checks"},function(msg){
      var row=msg.new&&msg.new.id?msg.new:null;
      if(!row) return;
      if(qGet().some(function(x){ return x.id===row.id; })) return;   /* our unsent change wins */
      applyRow(row);
      var bs=boxesFor(row.id);
      if(onlyLeft){ render(); return; }
      if(bs.length) bs.forEach(function(bx){ bx.checked=!!row.checked; refreshTag(bx); patch(bx); });
      else { updateTotals(); renderWorkload(); }
    })
    .on("postgres_changes",{event:"*",schema:"public",table:"candidates"},async function(){
      await loadCandidates(); render();
    })
    .subscribe(function(status){
      if(status==="SUBSCRIBED"){ if(!qGet().length) setSync("ok","Live"); else showQueue(); }
      else if(status==="CHANNEL_ERROR"||status==="TIMED_OUT"||status==="CLOSED") setSync("busy","Reconnecting…");
    });

  /* Catch anything missed while a laptop slept or a phone was locked. */
  document.addEventListener("visibilitychange",async function(){
    if(document.visibilityState!=="visible") return;
    flushQueue();
    try{ await loadChecks(); await loadCandidates(); render(); }catch(e){}
  });
})();
