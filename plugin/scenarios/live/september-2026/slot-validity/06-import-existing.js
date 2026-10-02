/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Original operation: tile-grid subagent lines 53–75; see archaeology README.
const SCENARIO = "06-import-existing";
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
 const tile = await flcm.component(flcm.frame({name:"Tile",width:170.5,height:90,layout:{mode:"column",gap:8}},[
  flcm.rect({name:"Sentinel",width:40,height:30,fill:"#D000FF"}),flcm.text("SLOT SENTINEL")
 ]),{name:"Fixture tile"});
 const host = await flcm.component(flcm.frame({name:"Tile section",width:393,height:"hug",layout:{mode:"column",padding:20}},[
  flcm.frame({key:"tiles",name:"Tiles",width:"fill",height:"hug",layout:{mode:"row",gap:12},componentPropertyReferences:{slot:"Tiles"}},[flcm.instance(tile.node.id)])
 ]),{name:"Fixture section",propertyDefinitions:{Tiles:{type:"slot"}}});
 const master=await node(host.node.id); master.x=0; master.y=-400; const hole=await node(host.keyed.tiles.id); hole.layoutWrap="WRAP"; hole.counterAxisSpacing=22;
 const tileMaster=await node(tile.node.id); tileMaster.x=450;tileMaster.y=-400;
 report.setup={verified:true,masterId:master.id};
 for(const [index,kind] of ["fresh-fill","raw-move","cold-move","cold-flcm-move","flcm-move","clone-donor"].entries()) {
  checkpoint("setup "+kind);
  const board=figma.createFrame();board.name=kind;board.resize(420,420);board.x=index*460; board.fills=[{type:"SOLID",color:{r:.93,g:.95,b:1}}];
  const donor=figma.createFrame();donor.name="Original ordinary frame";board.appendChild(donor);donor.resize(353,220);donor.layoutMode="HORIZONTAL";donor.layoutWrap="WRAP";donor.itemSpacing=12;
  for(let i=0;i<2;i++){const t=tileMaster.createInstance();donor.appendChild(t);t.minWidth=160;t.layoutSizingHorizontal="FILL";}
  const source=kind==="clone-donor"?donor.clone():donor;
  const instance=master.createInstance();board.appendChild(instance);instance.y=130;
  const slot=instance.children[0];for(const c of [...slot.children])c.remove();
  const before=kind.startsWith("cold-")?{intentionallyNotRead:"No donor descendant getters before import"}:audit(source);
  let operation;
  if(kind==="fresh-fill") operation=await attempt(kind,()=>flcm.edit(flcm.id(instance.id),{overrides:{[hole.id]:{children:[flcm.instance(tile.node.id),flcm.instance(tile.node.id)]}}}));
  else operation=await attempt(kind,async()=>{for(const t of [...source.children]){if(kind.endsWith("flcm-move"))await flcm.move(flcm.id(t.id),flcm.id(slot.id));else slot.appendChild(t);}return "moved";});
  const after=audit(instance);
  const clone=instance.clone();board.appendChild(clone);clone.y=270;clone.name="Clone control";
  report.observations.push({kind,rootId:instance.id,slotId:slot.id,before,operation,after,cloneId:clone.id,cloneAudit:audit(clone)});shot(kind,board);checkpoint("complete "+kind);
 }
 report.status="observations_recorded";
} catch(e){report.status=report.setup?.verified?"incomplete":"setup_failed";report.error=String(e.message||e);}
checkpoint("finished");return report;
