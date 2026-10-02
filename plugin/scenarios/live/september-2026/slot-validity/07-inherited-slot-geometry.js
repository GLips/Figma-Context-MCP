/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Original department shape and clone audit: see archaeology README.
const SCENARIO="07-inherited-slot-geometry";
const report = { scenario: SCENARIO, status: "setup_pending", observations: [], screenshotTargets: [] };
const page = figma.createPage(); page.name = "FLCM archaeology / " + SCENARIO + " / " + page.id;
await figma.setCurrentPageAsync(page); report.pageId = page.id;
function checkpoint(phase) { report.phase = phase; page.setPluginData("archaeology-report", JSON.stringify({ scenario: report.scenario, status: report.status, phase, pageId: page.id, screenshotTargets: report.screenshotTargets, observations: report.observations.map(o => ({ kind: o.kind, rootId: o.rootId, cloneId: o.cloneId, plainId: o.plainId, sourceId: o.sourceId, slotId: o.slotId })) })); console.log(phase); }
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
 const ph=(name,width,height)=>flcm.frame({name,width,height,fill:"#E6EAF0",layout:{mode:"column",padding:20}},[flcm.text(name)]);
 const tree=flcm.frame({name:"Department section",width:1600,height:"hug",fill:"#FFFFFF",layout:{mode:"column",gap:22,padding:{top:52,right:40,bottom:52,left:40}}},[
  flcm.frame({key:"body",name:"Body",width:"fill",height:"hug",layout:{mode:"row",gap:20}},[
   flcm.frame({key:"start",name:"Body start",width:"hug",height:"hug",layout:{mode:"column"},componentPropertyReferences:{slot:"Body start"}},[ph("Feature placeholder",330,120)]),
   flcm.frame({key:"end",name:"Body end",width:"hug",height:"hug",layout:{mode:"column"},componentPropertyReferences:{slot:"Body end"}},[ph("Product placeholder",1170,100)])
  ])
 ]);
 const built=await flcm.component(tree,{name:"Original department shape",propertyDefinitions:{"Body start":{type:"slot"},"Body end":{type:"slot"}}});
 const master=await node(built.node.id);master.y=-400;const bodyMaster=await node(built.keyed.body.id);bodyMaster.layoutWrap="WRAP";bodyMaster.counterAxisSpacing=20;
 report.setup={verified:true,masterId:master.id};
 for(const [index,kind] of ["wrap-fill","wrap-fixed","nowrap-fill"].entries()) {
  const board=figma.createFrame();board.name=kind;board.resize(1500,650);board.y=index*700;board.fills=[{type:"SOLID",color:{r:.88,g:.92,b:1}}];board.clipsContent=false;
  const art=figma.createFrame();art.name="Live artboard 393";art.resize(393,600);art.layoutMode="VERTICAL";art.primaryAxisSizingMode="FIXED";board.appendChild(art);
  const inst=master.createInstance();art.appendChild(inst);inst.layoutSizingHorizontal="FILL";inst.paddingLeft=20;inst.paddingRight=20;inst.paddingTop=36;inst.paddingBottom=36;
  const body=inst.children[0];if(kind==="nowrap-fill")body.layoutWrap="NO_WRAP";
  for(const [i,slot] of body.children.entries()){
   for(const c of [...slot.children])c.remove();
   const content=figma.createFrame();content.name=i?"Category nav":"Carousel";content.resize(353,i?100:120);content.fills=[{type:"SOLID",color:i?{r:.25,g:.4,b:1}:{r:1,g:.2,b:.3}}];slot.appendChild(content);
   content.layoutSizingHorizontal="FIXED";content.resize(353,content.height);
   if(kind!=="wrap-fixed")content.layoutSizingHorizontal="FILL";
  }
  const before=audit(inst);
  if(kind!=="nowrap-fill" && (body.width!==353 || body.children[1].width!==353)) throw new Error("Fixture must have live Body/Body end at353: "+JSON.stringify(before));
  const clone=inst.clone();const sameParent=audit(clone);board.appendChild(clone);clone.x=440;clone.y=0;const afterReparent=audit(clone);
  const detached=inst.clone();board.appendChild(detached);const plain=detached.detachInstance();plain.x=880;plain.y=0;
  report.observations.push({kind,rootId:inst.id,cloneId:clone.id,plainId:plain.id,before,sameParent,afterReparent,liveAfter:audit(inst),plain:audit(plain)});shot(kind,board);checkpoint("complete "+kind);
 }
 report.status="observations_recorded";
}catch(e){report.status=report.setup?.verified?"incomplete":"setup_failed";report.error=String(e.message||e);}
checkpoint("finished");return report;
