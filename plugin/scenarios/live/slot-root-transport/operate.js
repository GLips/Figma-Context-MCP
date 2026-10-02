/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Substitute the exact setup fixture ID and one route in a copy; run only once.
const FIXTURE_ID = 'REPLACE_WITH_SETUP_OWNER_ID';
const ROUTE = 'native-append';
const owner=await figma.getNodeByIdAsync(FIXTURE_ID);
const report=JSON.parse(owner.getPluginData('slot-root-transport'));
const row=report.cases.find(c=>c.route===ROUTE);
if(!row || row.phase) throw Error('Missing or already attempted transport case');
const slot=await figma.getNodeByIdAsync(row.slot);
const root=ROUTE==='native-append'?await figma.getNodeByIdAsync(row.originalRoot):slot.findAllWithCriteria({types:['INSTANCE']})[0];
const dest=await figma.getNodeByIdAsync(row.destination);
row.transportId=root?.id;
if(!root || !dest || root.parent.id!==row.slot) throw Error('Fixture identity/membership changed');
row.phase='before-operation';owner.setPluginData('slot-root-transport',JSON.stringify(report));
try {
 if(ROUTE==='native-append') dest.appendChild(root);
 else if(ROUTE==='native-insert') dest.insertChild(0,root);
 else if(ROUTE==='native-group-transport') {
  const source=await figma.getNodeByIdAsync(row.slot);
  const group=figma.group([root],source);row.temporaryGroup=group.id;
  row.phase='grouped';owner.setPluginData('slot-root-transport',JSON.stringify(report));
  dest.appendChild(group);
  row.phase='group-moved';owner.setPluginData('slot-root-transport',JSON.stringify(report));
  row.ungrouped=figma.ungroup(group).map(n=>n.id);
 }
 else if(ROUTE==='flcm-append') row.result=await flcm.append({id:dest.id},{id:row.transportId});
 else throw Error('Unknown route');
 row.phase='returned';
} catch(e) {row.phase='threw';row.error=String(e.message||e);}
owner.setPluginData('slot-root-transport',JSON.stringify(report));return row;
