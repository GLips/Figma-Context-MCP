/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Independent read-only acceptance after the product route returned successfully.
const FIXTURE_ID = 'REPLACE_WITH_SETUP_OWNER_ID';
const owner=await figma.getNodeByIdAsync(FIXTURE_ID);
const saved=JSON.parse(owner.getPluginData('slot-root-transport'));
const row=saved.cases.find(c=>c.route==='flcm-append');
const check=(ok,message)=>{if(!ok)throw Error(message);};
check(row.phase==='returned','Product operation did not return successfully');
const root=await figma.getNodeByIdAsync(row.originalRoot),source=await figma.getNodeByIdAsync(row.slot),destination=await figma.getNodeByIdAsync(row.destination);
check(root.id===row.originalRoot&&root.parent.id===destination.id,'Root identity or parent changed');
check(root.width===180&&root.height===120,'Root dimensions changed');
check((await root.getMainComponentAsync()).id===saved.tile,'Component linkage changed');
check(source.children.length===0&&destination.children.length===1&&destination.children[0].id===root.id,'Incorrect source/destination membership');
const texts=root.findAllWithCriteria({types:['TEXT']});
check(texts.length===2&&texts[0].characters==='ROOT TRANSPORT SENTINEL'&&texts[0].visible&&texts[1].characters==='HIDDEN SENTINEL'&&!texts[1].visible,'Content or hidden state changed');
const read=await flcm.get({id:root.id});
return {passed:true,rootId:root.id,masterId:saved.tile,dimensions:[root.width,root.height],textIds:texts.map(n=>n.id),read};
