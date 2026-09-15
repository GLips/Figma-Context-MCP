// Rerunnable syntax migration for repository fixtures and examples. Runtime authoring has no
// compatibility dialect; this tool translates source so each example teaches plain data.
import ts from 'typescript';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const kinds = { frame: 'FRAME', text: 'TEXT', rect: 'RECTANGLE', ellipse: 'ELLIPSE', line: 'LINE', svg: 'VECTOR', path: 'VECTOR', instance: 'INSTANCE' };
const files = execFileSync('git', ['ls-files', 'plugin/src/**/*.test.ts', 'plugin/src/*.test.ts', 'plugin/harness/*', 'plugin/harness/scenarios/*.js', 'src/mcp/tools/flcm-docs/examples/*.ts'], {encoding:'utf8'}).trim().split('\n').filter(f => /\.(ts|mjs|js)$/.test(f));
for (const file of files) {
 if (!existsSync(file)) continue;
 let source = readFileSync(file, 'utf8');
 if (!source.match(/\b(frame|text|rect|ellipse|line|svg|path|instance)\(/)) continue;
 const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
 const imported = new Set();
 for (const n of ast.statements) if (ts.isImportDeclaration(n) && /\/(flcm|runtime)\.js$/.test(n.moduleSpecifier.text)) {
   for (const el of n.importClause?.namedBindings?.elements ?? []) if (kinds[el.name.text]) imported.add(el.name.text);
 }
 let needsCompile = false;
 function walk(node) {
   if (ts.isCallExpression(node)) {
     const expr = node.expression;
     const name = ts.isIdentifier(expr) && imported.has(expr.text) ? expr.text : ts.isPropertyAccessExpression(expr) && expr.expression.getText(ast) === 'flcm' && kinds[expr.name.text] ? expr.name.text : null;
     if (name) {
       const args = node.arguments.map(walk);
       const props = (arg) => arg && arg !== '{}' ? '...(' + arg + ')' : '';
       let fields = ['type: ' + JSON.stringify(kinds[name])];
       if (name === 'frame') { if (args[0]) fields.push(props(args[0])); if (args[1]) fields.push('children: ' + args[1]); }
       else if (name === 'text') {
         if (args.length > 1 || ts.isStringLiteralLike(node.arguments[0]) || ts.isArrayLiteralExpression(node.arguments[0])) { fields.push('text: ' + args[0]); if(args[1]) fields.push(props(args[1])); }
         else fields.push(props(args[0]));
       } else if (name === 'svg') { fields.push('svg: ' + args[0]); if(args[1]) fields.push(props(args[1])); }
       else if (name === 'instance') {
         const arg = node.arguments[0];
         const bag = arg && ts.isObjectLiteralExpression(arg) && arg.properties.some(p => p.name?.getText(ast) === 'componentId');
         if(bag) fields.push(props(args[0])); else { fields.push('componentId: ' + args[0]); if(args[1]) fields.push(props(args[1])); }
       } else if(args[0]) fields.push(props(args[0]));
       let result = '({ ' + fields.filter(Boolean).join(', ') + ' })';
       // Pure compiler assertions retain their subject, now at the actual compile entry.
       let p = node.parent, async = false, outerConstructor = false;
       while(p) { if(ts.isCallExpression(p) && ts.isIdentifier(p.expression) && imported.has(p.expression.text)) outerConstructor=true; if(ts.isFunctionLike(p) && p.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword)) async=true; p=p.parent; }
       if(file.endsWith('.test.ts') && !async && !outerConstructor) { needsCompile=true; result='compileTree(' + result + ', "spec")'; }
       return result;
     }
   }
   let result = source.slice(node.getStart(ast), node.end);
   const children = []; node.forEachChild(c => { children.push(c); });
   for(const child of children.reverse()) { const replacement=walk(child); result=result.slice(0,child.getStart(ast)-node.getStart(ast))+replacement+result.slice(child.end-node.getStart(ast)); }
   return result;
 }
 const edits=[];
 for(const n of ast.statements) {
  if(ts.isImportDeclaration(n) && /\/(flcm|runtime)\.js$/.test(n.moduleSpecifier.text) && n.importClause?.namedBindings?.elements) {
   const els=n.importClause.namedBindings.elements.filter(e=>!kinds[e.name.text]);
   if(els.length !== n.importClause.namedBindings.elements.length) edits.push([n.getStart(ast),n.end,els.length?'import { '+els.map(e=>e.getText(ast)).join(', ')+' } from '+n.moduleSpecifier.getText(ast)+';':'']);
  } else edits.push([n.getStart(ast),n.end,walk(n)]);
 }
 for(const [a,b,v] of edits.reverse()) source=source.slice(0,a)+v+source.slice(b);
 if(needsCompile) source='import { compileTree } from "./compile-tree.js";\n'+source;
 writeFileSync(file,source);
}
