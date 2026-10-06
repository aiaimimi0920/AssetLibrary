import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { root, sourceFiles } from "./source-scope.mjs";

// 使用 TS 语法树 token 覆盖行，排除纯注释；SQL/YAML 当前均为单行注释。
function effectiveLines(file, text) {
  // HTML/CSS 用非空物理行作为保守上界，不能借 TS 解析器漏算新 UI。
  if (/\.(?:html|css)$/.test(file)) return text.split(/\r?\n/).filter((line) => line.trim()).length;
  if (/\.(?:sql|yaml)$/.test(file))
    return text.split(/\r?\n/).filter((line) => line.trim() && !/^\s*(?:--|#)/.test(line)).length;
  const kind = /\.jsonc?$/.test(file)
    ? ts.ScriptKind.JSON
    : file.endsWith(".ts")
      ? ts.ScriptKind.TS
      : ts.ScriptKind.JS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const lines = text.split(/\r?\n/);
  const occupied = new Set();
  function visit(node) {
    const children = node.getChildren(source);
    if (children.length) {
      for (const child of children) visit(child);
      return;
    }
    if (node.kind === ts.SyntaxKind.EndOfFileToken || node.getWidth(source) === 0) return;
    const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
    const end = source.getLineAndCharacterOfPosition(node.getEnd() - 1).line;
    for (let line = start; line <= end; line++) occupied.add(line);
  }
  visit(source);
  return [...occupied].filter((line) => lines[line]?.trim()).length;
}

let failed = false;
for (const file of await sourceFiles()) {
  const bytes = await readFile(path.join(root, file));
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    throw new Error(`UTF8_BOM: ${file}`);
  if (file.endsWith(".md") || file === "pnpm-lock.yaml" || file.startsWith(".")) continue;
  const count = effectiveLines(file, text);
  console.log(`${count.toString().padStart(4)} ${file}`);
  // 当前切片没有 501–700 行例外，达到软阈值即要求人工审查而不是默许。
  if (count > 500) failed = true;
}
if (failed) throw new Error("SOURCE_SIZE_REQUIRES_SPLIT_OR_REVIEW");
