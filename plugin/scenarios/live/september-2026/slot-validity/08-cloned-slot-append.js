/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Original main session calls 3637/3646/3655, controlled reconstruction.
const SCENARIO="08-cloned-slot-append";
// Run one case per invocation so the transport idle limit does not combine unrelated controls.
const CASE_KIND = "fresh"; // fresh | clean-clone | corrupt-clone | repaired-clone | raw-render-control
const report = { scenario: SCENARIO, status: "setup_pending", observations: [], screenshotTargets: [] };
const page = figma.createPage(); page.name = "FLCM archaeology / " + SCENARIO + " / " + page.id;
await figma.setCurrentPageAsync(page); report.pageId = page.id;
function checkpoint(phase) { report.phase = phase; page.setPluginData("archaeology-report", JSON.stringify({ scenario: report.scenario, status: report.status, phase, pageId: page.id, screenshotTargets: report.screenshotTargets, observations: report.observations.map(o => ({ kind: o.kind, rootId: o.rootId, cloneId: o.cloneId, plainId: o.plainId, sourceId: o.sourceId, slotId: o.slotId, lookup: o.lookup, append: o.append })) })); console.log(phase); }
function value(read) { try { const x = read(); return { ok: true, value: x === undefined ? null : x }; } catch(e) { return { ok: false, error: String(e.message || e) }; } }
function audit(root) {
 const rows = []; const visit = (n, path) => {
  const row = {path};
  for (const field of ["id","name","type","width","height","x","y","layoutMode","layoutWrap","layoutSizingHorizontal","layoutSizingVertical","minWidth","layoutGrow","characters","fills"]) row[field] = value(() => n[field]);
  const children = value(() => "children" in n ? [...n.children] : []); row.childCount = children.ok ? children.value.length : children; rows.push(row);
  if (children.ok) children.value.forEach((c,i) => visit(c,path+"/"+i));
 }; visit(root,"root"); return { visited: rows.length, fieldErrors: rows.reduce((sum,r) => sum+Object.values(r).filter(v=>v && v.ok===false).length,0), rows };
}
async function attempt(label, action) { checkpoint(label); const start = Date.now(); try { const result = await action(); return { label, outcome: "returned", ms: Date.now()-start, result }; } catch(e) { return { label, outcome: "threw", ms: Date.now()-start, error: String(e.message || e) }; } }
async function node(id) { const n=await figma.getNodeByIdAsync(id); if(!n) throw new Error("Fixture missing "+id); return n; }
function shot(key,n) { report.screenshotTargets.push({key,nodeId:n.id}); }
try {
 const chip=await flcm.component(flcm.frame({name:"Chip",width:80,height:30,layout:{mode:"row"}},[flcm.text("Chip")]),{name:"Fixture chip"});
 const masterResult=await flcm.component(flcm.frame({name:"Department",width:393,height:"hug",fill:"#FFFFFF",layout:{mode:"column",padding:20,gap:22}},[
  flcm.frame({key:"tabs",name:"Tabs",width:"fill",height:"hug",clip:true,layout:{mode:"row",gap:10},componentPropertyReferences:{slot:"Tabs"}},[flcm.instance(chip.node.id),flcm.instance(chip.node.id)]),
  flcm.frame({name:"Body",width:"fill",height:"hug",layout:{mode:"row",gap:20}},[
   flcm.frame({key:"start",name:"Body start",width:"hug",height:"hug",layout:{mode:"column"},componentPropertyReferences:{slot:"Body start"}},[flcm.rect({width:100,height:80,fill:"#4477EE"})])
  ])
 ]),{name:"Append fixture",propertyDefinitions:{Tabs:{type:"slot"},"Body start":{type:"slot"}}});
 const master=await node(masterResult.node.id);master.y=-400;
 const GROUPS=['Piercing Needles','Piercing Tools','Medical Supplies','Aftercare','Anodizing Machines','Suspension Hooks & Rings'];
 // Original failing tab tree and font; availability verified by independent readback.
 const tabsTree=(rootWidth)=>flcm.frame({name:'Tabs — scroll',width:rootWidth,height:'hug',clip:true,layout:{mode:'row',gap:26}},
  GROUPS.map((g,i)=>flcm.frame({name:'Tab — '+g,width:'hug',height:'hug',layout:{mode:'column',padding:'0px 0px 12px 0px'}},[
   flcm.text(g,{textStyle:{fontFamily:'Proxima Nova',fontWeight:i===0?600:400,fontSize:15,lineHeight:'18px'},fill:i===0?'#0F1B2D':'#5A6675'})])));
 report.setup={verified:true,masterId:master.id};
 for(const [index,kind] of [CASE_KIND].entries()) {
  const board=figma.createFrame();board.name=kind;board.resize(850,430);board.y=index*470;board.fills=[{type:"SOLID",color:{r:.9,g:.93,b:1}}];
  const source=master.createInstance();board.appendChild(source);source.name="Source "+kind;
  const sourceTabs=source.children[0],sourceStart=source.children[1].children[0];
  const before=audit(source);
  const move=kind==="corrupt-clone"||kind==="repaired-clone"||kind==="raw-render-control"?await attempt("poison control "+kind,()=>{sourceStart.appendChild(sourceTabs.children[0]);return audit(source);}):null;
  const target=kind==="fresh"?source:source.clone();if(target!==source){board.appendChild(target);target.x=430;}
  const cloneBefore=audit(target);
  const repair=kind==="repaired-clone"?await attempt("repair cloned stray",()=>{const start=target.children[1].children[0];start.children[1].remove();const contentClone=start.children[0].clone();page.appendChild(contentClone);contentClone.x=1800;return {cloneId:contentClone.id,after:audit(target)};}):null;
  const tabs=target.children[0];const slotId=tabs.id;
  const clear=await attempt("clear Tabs "+kind,()=>{for(const k of [...tabs.children])k.remove();return tabs.children.length;});
  report.observations.push({kind,rootId:target.id,sourceId:source.id,slotId,before,move,cloneBefore,repair,clear});const entry=report.observations[report.observations.length-1];checkpoint("cleared "+kind);
  entry.lookup=await attempt("lookup inherited SLOT "+kind,async()=>{const found=await figma.getNodeByIdAsync(slotId);return found?{id:found.id,name:found.name,type:found.type}:null;});
  entry.append=await attempt("append "+kind,async()=>{
   if(kind==="raw-render-control") {const built=await flcm.render(tabsTree(353));const row=await node(built.node.id);tabs.appendChild(row);row.layoutSizingHorizontal="FILL";return {id:row.id};}
   const built=await flcm.append(flcm.id(slotId),tabsTree("fill"));return {id:built.node.id};
  });
  entry.after=audit(target);shot(kind,board);checkpoint("complete "+kind);
 }
 report.status="observations_recorded";
}catch(e){report.status=report.setup?.verified?"incomplete":"setup_failed";report.error=String(e.message||e);}
checkpoint("finished");return report;
