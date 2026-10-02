/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
const FIXTURE_ID = 'REPLACE_WITH_SETUP_OWNER_ID';
const owner=await figma.getNodeByIdAsync(FIXTURE_ID);
const report=JSON.parse(owner.getPluginData('slot-root-transport'));
const safe=f=>{try{return {ok:true,value:f()};}catch(e){return {ok:false,error:String(e.message||e)};}};
const inspect=n=>Object.fromEntries(['id','type','name','width','height','characters','visible'].map(k=>[k,safe(()=>n[k])]));
for(const row of report.cases) {
 const read={};row.readback=read;
 for(const [label,id]of [['root',row.root],['originalRoot',row.originalRoot],['source',row.slot],['destination',row.destination]]){
  try {const n=await figma.getNodeByIdAsync(id);read[label]={found:!!n};if(n){read[label].fields=inspect(n);read[label].parent=safe(()=>n.parent?.id);read[label].children=safe(()=>n.children?.map(inspect));read[label].indexed=safe(()=>n.findAllWithCriteria({types:[]}).map(inspect));}}
  catch(e){read[label]={error:String(e.message||e)};}
 }
 try{read.flcm=await flcm.get({id:row.root});}catch(e){read.flcm={error:String(e.message||e)};}
}
return report;
