/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Read-only. Select the exact retained archaeology page before running.
const page = figma.currentPage;
const raw = page.getPluginData("archaeology-report");
if (!raw || !page.name.startsWith("FLCM archaeology / ")) throw new Error("Select the exact archaeology scenario page; no checkpoint found.");
const checkpoint = JSON.parse(raw);
function value(read) { try { const x = read(); return { ok: true, value: x === undefined ? null : x }; } catch(e) { return { ok: false, error: String(e.message || e) }; } }
function audit(root) {
 const rows = []; const visit = (n, path) => {
  const row = {path};
  for (const field of ["id","name","type","width","height","x","y","layoutMode","layoutWrap","layoutSizingHorizontal","layoutSizingVertical","minWidth","layoutGrow","characters","fills"]) row[field] = value(() => n[field]);
  const children = value(() => "children" in n ? [...n.children] : []); row.childCount = children.ok ? children.value.length : children; rows.push(row);
  if (children.ok) children.value.forEach((c,i) => visit(c,path+"/"+i));
 }; visit(root,"root"); return { visited: rows.length, fieldErrors: rows.reduce((sum,r) => sum+Object.values(r).filter(v=>v && v.ok===false).length,0), rows };
}

const ids = [...new Set(checkpoint.observations.flatMap(o => [o.rootId,o.cloneId,o.plainId,o.sourceId]).filter(Boolean))];
const readback=[];
for(const id of ids){
 try { const n=await figma.getNodeByIdAsync(id); readback.push({id,found:!!n,audit:n?audit(n):null}); }
 catch(e){readback.push({id,error:String(e.message||e)});}
}
return {pageId:page.id,scenario:checkpoint.scenario,phase:checkpoint.phase,status:checkpoint.status,readback,screenshotTargets:checkpoint.screenshotTargets};
