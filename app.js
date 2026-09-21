/* Tulane Film Pull Board: live shared checkmarks via Supabase.
   Game data comes from data.json (updated weekly). Checkmarks live in the
   Supabase "checks" table and sync to every open screen in real time. */
(async function(){
  var COLS=[["tvcut","TV cut"],["tvdef","TV def"],["ez","2 EZ"]];
  var CFG=window.BOARD_CONFIG||{};

  var mount=document.getElementById("mount");
  mount.appendChild(document.getElementById("shell").content.cloneNode(true));

  var root=document.getElementById("root");
  var STATE={checks:{},who:{}};
  var DATA={weeks:[],logos:{}}, LOGOS={};
  var sb=null, onlyLeft=false, allShut=false, shut={}, openGames={};

  function lsGet(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
  function lsSet(k,v){ try{ localStorage.setItem(k,v); }catch(e){} }
  function lsDel(k){ try{ localStorage.removeItem(k); }catch(e){} }

  function esc(s){ return String(s).replace(/[&<>"']/g,function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
  /* Stable id: survives rows being added or reordered in data.json. */
  function idFor(w,g,c){ return "w"+w.week+"|"+g.date+"|"+g.opp+"|"+c; }
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

  function detailPanel(w,g){
    var where=g.ven
      ? esc(g.ven)+(g.loc?'<span class="sep">/</span>'+esc(g.loc):"")
      : "Not on file";
    var line, played=!!g.fin;
    if(played&&g.fin.cl){
      line='<span class="num">'+esc(g.fin.cl)+'</span>'
         + (g.fin.ou?'<span class="sep">/</span>O/U <span class="num">'+esc(g.fin.ou)+'</span>':"")
         + '<span class="sep">/</span><span class="stamp">closing</span>';
    } else if(g.ln){
      line='<span class="num">'+esc(g.ln.o)+'</span>'
         + (g.ln.ou?'<span class="sep">/</span>O/U <span class="num">'+esc(g.ln.ou)+'</span>':"")
         + '<span class="sep">/</span><span class="stamp">'+esc(g.ln.as||"opening")+'</span>';
    } else {
      line="None posted";
    }
    var html='<dl class="detail">'+fact("Venue",where,g.ven?"":"none");
    if(played){
      var f=g.fin;
      html+=fact("Final",
          esc(w.opp)+' <span class="num">'+f.us+'</span>'
        + '<span class="sep">/</span>'+esc(g.opp)+' <span class="num">'+f.them+'</span>'
        + (f.note?'<span class="sep">/</span><span class="stamp">'+esc(f.note)+'</span>':""));
    }
    html+=fact(played?"Closing line":"Line",line,(played?g.fin.cl:g.ln)?"":"none");
    return html+'</dl>';
  }

  function kickCell(o){
    if(o.fin){
      return '<span class="kcell final"><span class="kick">'+esc(o.fin.res)+" "
           + o.fin.us+"–"+o.fin.them+'</span>'
           + (o.tv?'<span class="net">'+esc(o.tv)+'</span>':'<span class="net">Final</span>')+'</span>';
    }
    if(!o.t&&!o.tv) return '<span class="kcell tbd"><span class="kick">TBD</span></span>';
    return '<span class="kcell"><span class="kick">'+esc(o.t||"Time TBD")+'</span>'
         + (o.tv?'<span class="net">'+esc(o.tv)+'</span>':"")+'</span>';
  }

  function rowMark(g){
    var badge=LOGOS[g.opp];
    return badge
      ? '<span class="rmark"><img src="'+badge+'" alt="" width="19" height="19"></span>'
      : '<span class="rmark"><span class="rmono">'+esc(g.mono||"")+'</span></span>';
  }

  function updateTotals(){
    var total=0, done=0, oppDone=0, gamesOpen=0, opps=0;
    DATA.weeks.forEach(function(w){
      var t=weekTotal(w), d=weekDone(w);
      total+=t; done+=d;
      if(t>0){ opps++; if(d===t) oppDone++; }
      w.games.forEach(function(g){
        if(!g.ha) return;
        if(!COLS.every(function(c){ return STATE.checks[idFor(w,g,c[0])]; })) gamesOpen++;
      });
    });
    document.getElementById("pdone").textContent=done;
    document.getElementById("ptot").textContent=total;
    var pct=total?Math.round(done/total*100):0;
    document.getElementById("pfill").style.width=pct+"%";
    document.getElementById("pbar").setAttribute("aria-valuenow",String(pct));
    document.getElementById("sCut").textContent=done;
    document.getElementById("sOpp").textContent=oppDone+" / "+opps;
    document.getElementById("sGame").textContent=gamesOpen;
  }

  function weekByNum(n){ var r=null; DATA.weeks.forEach(function(x){ if(x.week===n) r=x; }); return r; }

  /* Update just the touched row, its card and the totals, so focus and scroll survive. */
  function patch(box){
    if(onlyLeft) return render();
    var card=box.closest(".card");
    if(!card) return render();
    var w=weekByNum(Number(card.querySelector(".chead").getAttribute("data-wk")));
    if(!w) return render();
    var row=box.closest(".row");
    if(row){
      var all=[].slice.call(row.querySelectorAll(".box"));
      row.classList.toggle("rdone", all.length>0 && all.every(function(i){ return i.checked; }));
    }
    var tot=weekTotal(w), dn=weekDone(w), complete=tot>0&&dn===tot;
    var c=card.querySelector(".count"); if(c) c.textContent=dn+"/"+tot;
    var p=card.querySelector(".pill");
    if(p){
      p.className="pill "+(complete?"p-done":dn===0?"p-none":"p-part");
      p.textContent=complete?"Complete":dn===0?"Not started":(tot-dn)+" left";
    }
    card.classList.toggle("done",complete);
    var hd=card.querySelector(".chead");
    if(hd) hd.style.setProperty("--pct",(tot?Math.round(dn/tot*100):0)+"%");
    updateTotals();
  }

  function render(){
    updateTotals();
    var html="";
    DATA.weeks.forEach(function(w){
      var tot=weekTotal(w), dn=weekDone(w);
      var complete=tot>0&&dn===tot;
      if(onlyLeft&&(complete||tot===0)) return;

      var badge=LOGOS[w.opp], mono=w.mono||"";
      var mark = badge
        ? '<span class="mark"><img src="'+badge+'" alt="" width="36" height="36"></span>'
        : '<span class="mark plain" style="background:'+esc(w.c1||"#888")+';border-color:'+esc(w.c1||"#888")+';--edge:'+esc(w.c2||"#888")+'">'
          + '<span class="mono" style="font-size:'+(mono.length>3?12:mono.length>2?14.5:17)+'px">'+esc(mono)+'</span></span>';

      var siteTag = w.site==="BYE" ? '<span class="site bye">Bye</span>'
        : '<span class="site'+(w.site==="A"?" away":"")+'">'+(w.site==="A"?"Away":"Home")+'</span>';

      var pill = tot===0 ? '<span class="pill p-none">No film</span>'
        : complete ? '<span class="pill p-done">Complete</span>'
        : dn===0 ? '<span class="pill p-none">Not started</span>'
        : '<span class="pill p-part">'+(tot-dn)+' left</span>';

      var body="";
      if(tot===0){
        body='<div class="note">'+esc(w.note||"No opponent film this week.")+'</div>';
      } else {
        body='<div class="rhead"><span>Date</span><span>Opponent</span><span>Site</span><span>Kick / TV</span>'
           + COLS.map(function(c){ return "<span>"+c[1]+"</span>"; }).join("")
           + '</div>';
        w.games.forEach(function(g,gi){
          if(!g.ha){
            body+='<div class="row open"><span class="rdate">'+esc(g.date)+'</span>'
               +  '<span class="ropp">Open date</span><span></span><span></span>'
               +  '<span></span><span></span><span></span></div>';
            return;
          }
          var rdone=COLS.every(function(c){ return STATE.checks[idFor(w,g,c[0])]; });
          if(onlyLeft&&rdone) return;
          var gkey=w.week+"."+gi;
          body+='<div class="game'+(openGames[gkey]?" open":"")+'" data-g="'+gkey+'">'
             + '<div class="row'+(rdone?" rdone":"")+'">'
             + '<span class="rdate">'+esc(g.date)+'</span>'
             + '<span class="ropp"><span class="opw">'+rowMark(g)+'<span class="rname">'
             + (g.ha==="A"?"at ":"")+esc(g.opp)+'</span>'
             + '<svg class="rexp" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2 8.5 6 4.5 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
             + '</span></span>'
             + '<span class="rha '+(g.ha==="A"?"a":"h")+'">'+(g.ha==="A"?"AWAY":"HOME")+'</span>'
             + kickCell(g)
             + COLS.map(function(c){
                 var id=idFor(w,g,c[0]);
                 var on=!!STATE.checks[id];
                 return '<span class="cell"><input type="checkbox" class="box" data-id="'+esc(id)+'"'
                      + (on?" checked":"")
                      + ' aria-label="'+esc(c[1]+", "+g.date+" "+g.opp)+'">'
                      + whoTag(id,c[1])+'</span>';
               }).join("")
             + '</div>'
             + detailPanel(w,g)
             + '</div>';
        });
      }

      html+='<section class="card'+(complete?" done":"")+(shut[w.week]?" shut":"")+'">'
         + '<button class="chead" data-wk="'+w.week+'" aria-expanded="'+(shut[w.week]?"false":"true")+'"'
         + ' style="--team:'+esc(w.c1||"#888")+';--pct:'+(tot?Math.round(dn/tot*100):0)+'%">'
         + '<span class="wk">Wk '+w.week+'</span>'
         + mark
         + '<span class="who"><p class="opp">'+(w.site==="A"?"at ":"")+esc(w.opp)
         + (w.rec?' <span class="rec">('+esc(w.rec.replace("-","–"))+')</span>':"")+'</p>'
         + '<span class="when">'+esc(w.date)+' '+siteTag
         + (w.t?'<span class="kick">'+esc(w.t)+'</span>':"")
         + (w.tv?'<span class="net">'+esc(w.tv)+'</span>':"")
         + '</span></span>'
         + '<span class="cstat">'
         + (tot?'<span class="count">'+dn+"/"+tot+"</span>":"")
         + pill
         + '<svg class="caret" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 4.5 6 8.5 10 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
         + "</span></button>"
         + '<div class="cbody">'+body+"</div></section>";
    });
    if(!html) html='<p class="foot" style="margin-top:22px">Every cutup is pulled. Nothing left on the board.</p>';
    root.innerHTML=html;
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

  async function saveCheck(id,on){
    if(!lsGet("fpb_code")){
      var ok=await askLogin();
      if(!ok) return false;
    }
    setSync("busy","Saving…");
    var r=await sb.rpc("set_check",{p_code:lsGet("fpb_code"),p_id:id,p_on:on,p_who:lsGet("fpb_who")||""});
    if(r.error){
      if(/passcode/i.test(r.error.message||"")){
        lsDel("fpb_code");
        setSync("off","Sign in needed");
        showNotice("The staff passcode has changed. Tick the box again and enter the new one.");
      } else {
        setSync("off","Not saved");
        showNotice("That change did not save. Check your connection, then tick the box again.");
      }
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
  function whoTag(id,label){
    var w=STATE.checks[id]?STATE.who[id]:null;
    if(!w||!w.by) return '<span class="who-tag" aria-hidden="true"></span>';
    var tip=(label?label+" pulled by ":"Pulled by ")+w.by+(w.at?" \u00b7 "+shortDate(w.at):"");
    return '<span class="who-tag on" title="'+esc(tip)+'">'+esc(initials(w.by))+'</span>';
  }
  function refreshTag(box){
    var cell=box.parentNode; if(!cell) return;
    var old=cell.querySelector(".who-tag");
    var label=(box.getAttribute("aria-label")||"").split(",")[0];
    var tmp=document.createElement("span"); tmp.innerHTML=whoTag(box.getAttribute("data-id"),label);
    if(old) cell.replaceChild(tmp.firstChild,old); else cell.appendChild(tmp.firstChild);
  }
  function boxFor(id){
    var all=root.querySelectorAll("input.box");
    for(var i=0;i<all.length;i++) if(all[i].getAttribute("data-id")===id) return all[i];
    return null;
  }

  root.addEventListener("change",async function(e){
    var b=e.target;
    if(!b.classList||!b.classList.contains("box")) return;
    var id=b.getAttribute("data-id"), on=b.checked;
    if(on){ STATE.checks[id]=1; STATE.who[id]={by:lsGet("fpb_who")||"",at:new Date().toISOString()}; } else { delete STATE.checks[id]; delete STATE.who[id]; }
    refreshTag(b);
    patch(b);
    var ok=await saveCheck(id,on);
    if(ok&&on&&STATE.checks[id]){
      STATE.who[id]={by:lsGet("fpb_who")||"",at:new Date().toISOString()};
      var sx=boxFor(id); if(sx) refreshTag(sx);
    }
    if(!ok){
      if(on){ delete STATE.checks[id]; delete STATE.who[id]; } else STATE.checks[id]=1;
      var bx=boxFor(id); if(bx){ bx.checked=!on; refreshTag(bx); patch(bx); } else render();
    }
  });
  root.addEventListener("click",function(e){
    if(!e.target.closest) return;
    if(e.target.classList&&e.target.classList.contains("box")) return;
    var r=e.target.closest(".row");
    if(r&&!r.classList.contains("open")){
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
    var wk=h.getAttribute("data-wk");
    shut[wk]=!shut[wk];
    render();
  });

  document.getElementById("fLeft").addEventListener("click",function(){
    onlyLeft=!onlyLeft;
    this.setAttribute("aria-pressed",String(onlyLeft));
    this.textContent=onlyLeft?"Show everything":"Only what's left";
    render();
  });
  document.getElementById("fShut").addEventListener("click",function(){
    allShut=!allShut;
    DATA.weeks.forEach(function(w){ shut[w.week]=allShut; });
    this.textContent=allShut?"Expand all":"Collapse all";
    render();
  });
  document.getElementById("fPrint").addEventListener("click",function(){ window.print(); });
  document.getElementById("fExport").addEventListener("click",function(){
    var rows=[["opponent_week","game_date","game_opponent","cutup","pulled_by"]];
    Object.keys(STATE.checks).sort().forEach(function(id){
      var p=id.split("|");
      rows.push([p[0].slice(1),p[1],p[2],p[3],STATE.who[id]||""]);
    });
    var csv=rows.map(function(r){ return r.map(function(v){ return '"'+String(v).replace(/"/g,'""')+'"'; }).join(","); }).join("\r\n");
    var a=document.createElement("a");
    a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));
    a.download="film-board-checkmarks-"+new Date().toISOString().slice(0,10)+".csv";
    document.body.appendChild(a); a.click(); a.remove();
  });

  /* ---------- start ---------- */
  setSync("busy","Loading…");
  try{
    var resp=await fetch("data.json",{cache:"no-cache"});
    DATA=await resp.json(); LOGOS=DATA.logos||{};
  }catch(e){
    setSync("off","Offline");
    showNotice("Could not load the schedule. Refresh the page.");
    return;
  }
  render();

  if(!window.supabase||!CFG.url||!CFG.anonKey||/PASTE/.test(CFG.url+CFG.anonKey)){
    setSync("off","Not connected");
    showNotice("The board is not connected to its database yet. Fill in config.js.");
    return;
  }
  sb=window.supabase.createClient(CFG.url,CFG.anonKey);
  try{ await loadChecks(); render(); }
  catch(e){
    setSync("off","Not connected");
    showNotice("Could not load checkmarks. Refresh the page.");
    return;
  }

  sb.channel("checks-live")
    .on("postgres_changes",{event:"*",schema:"public",table:"checks"},function(msg){
      var row=msg.new&&msg.new.id?msg.new:null;
      if(!row) return;
      applyRow(row);
      var bx=boxFor(row.id);
      if(bx){
        bx.checked=!!row.checked;
        refreshTag(bx);
        patch(bx);
      } else if(!onlyLeft){ updateTotals(); } else render();
    })
    .subscribe(function(status){
      if(status==="SUBSCRIBED") setSync("ok","Live");
      else if(status==="CHANNEL_ERROR"||status==="TIMED_OUT"||status==="CLOSED") setSync("busy","Reconnecting…");
    });

  /* Catch anything missed while a laptop slept or a phone was locked. */
  document.addEventListener("visibilitychange",async function(){
    if(document.visibilityState!=="visible") return;
    try{ await loadChecks(); render(); }catch(e){}
  });
})();
