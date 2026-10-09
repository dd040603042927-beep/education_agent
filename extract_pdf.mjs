import fs from 'fs';
import { pathToFileURL } from 'url';
const pdfjsLib = await import(pathToFileURL('C:/Users/yongc/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/pdfjs-dist/legacy/build/pdf.mjs').href);

const input = 'D:/education-agent/动手学机器学习 (张伟楠等) .pdf';
const output = 'D:/education-agent/动手学机器学习_按章节提取.md';
const data = new Uint8Array(fs.readFileSync(input));
const pdf = await pdfjsLib.getDocument({ data, useWorkerFetch: false, isEvalSupported: false }).promise;
let out = '# 动手学机器学习（按章节小节提取）\n\n';
for (let i = 1; i <= pdf.numPages; i++) {
  const page = await pdf.getPage(i);
  const content = await page.getTextContent();
  const items = content.items.filter(x => x.str && x.str.trim());
  const rows = new Map();
  for (const item of items) {
    const y = Math.round(item.transform[5] / 1.5) * 1.5;
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y).push(item);
  }
  const lines = [...rows.entries()].sort((a,b) => b[0]-a[0]).map(([, row]) =>
    row.sort((a,b) => a.transform[4]-b.transform[4]).map(x => x.str).join(' ').replace(/ {2,}/g, ' ').trim()
  ).filter(Boolean);
  let text = lines.join('\n').trim();
  // Add Markdown hierarchy at printed chapter/section markers while leaving body text unchanged.
  if (i > 16) {
    text = text
      .replace(/^\s*(第\s*[0-9一二三四五六七八九十百]+\s*章[^\n]*)$/gm, '## $1')
      .replace(/^\s*(第\s*[0-9一二三四五六七八九十百]+\s*章[^\n]*)$/gm, '## $1')
      .replace(/^\s*([0-9]{1,2}\.[0-9]{1,2}(?:\.[0-9]{1,2})?\s+[^\n]*)$/gm, '### $1');
  }
  if (!text) continue;
  out += `\n<!-- 第 ${i} 页 -->\n\n${text}\n`;
}
fs.writeFileSync(output, out, 'utf8');
console.log(`Wrote ${output} (${pdf.numPages} pages)`);
