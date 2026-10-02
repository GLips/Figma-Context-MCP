/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Current data-tree API. Isolated fixtures only; no page switching or cleanup.
await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
const owner = figma.createFrame(); owner.name = 'Slot root transport / ' + owner.id;
owner.resize(1800,700); owner.fills=[];
const tile = await flcm.component({type:'FRAME', name:'Transport tile',width:180,height:120,children:[
 {type:'TEXT',text:'ROOT TRANSPORT SENTINEL'}, {type:'TEXT',text:'HIDDEN SENTINEL',visible:false}
]});
const tileNode=await figma.getNodeByIdAsync(tile.id);owner.appendChild(tileNode);
const master=await flcm.component({type:'FRAME',name:'Transport host',width:300,height:250,children:[
 {type:'FRAME',width:260,height:200,componentPropertyReferences:{slot:'Body'},children:[]}
]}, {propertyDefinitions:{Body:{type:'slot'}}});
const hostMaster=await figma.getNodeByIdAsync(master.id);owner.appendChild(hostMaster);hostMaster.x=200;
const report={ownerId:owner.id,pageId:figma.currentPage.id,tile:tile.id,master:master.id,cases:[]};
for(const [index,route] of ['native-append','native-insert','flcm-append','native-group-transport'].entries()) {
 const host=hostMaster.createInstance();owner.appendChild(host);host.x=index*500;host.y=300;
 const slot=host.children[0];const content=tileNode.createInstance();owner.appendChild(content);
 const originalRoot=content.id;const beforeImport=await flcm.get({id:originalRoot});
 slot.appendChild(content);const remappedRoot=slot.children[0].id;
 const destination=figma.createFrame();owner.appendChild(destination);destination.resize(200,150);destination.x=index*500+300;destination.y=300;
 const row={route,host:host.id,slot:slot.id,root:remappedRoot,originalRoot,destination:destination.id,beforeImport};
 report.cases.push(row);owner.setPluginData('slot-root-transport',JSON.stringify(report));
 row.before=await flcm.get({id:originalRoot});
}
owner.setPluginData('slot-root-transport',JSON.stringify(report));return report;
