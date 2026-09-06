// Mirrors how the Artifact host wraps published content, so local tests see the
// same document the viewer will.
import fs from 'node:fs';
const body = fs.readFileSync('preview-artifact.html', 'utf8');
const head = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>html{color-scheme:light}body{margin:0;font:14px system-ui}img{max-width:100%}[hidden]{display:none!important}</style>
</head><body>`;
fs.writeFileSync('preview-wrapped.html', head + body + '</body></html>');
console.log('wrapped ->', (head + body).length, 'bytes');
