import { APP_VERSION } from '../../version.js';

export function h1(title: string) {
  return `<h1>${title} <small style="font-size:.55em;opacity:.65;">v${APP_VERSION}</small></h1>`;
}

export function pageShell(title: string, body: string, extraHead = '') {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>${title}</title>${extraHead}<style>body{font-family:system-ui,Arial,sans-serif;background:#0f1115;color:#eee;margin:1.2rem;}table{border-collapse:collapse;width:100%;margin-top:1rem;}th,td{border:1px solid #333;padding:4px 6px;font-size:.7rem;}th{background:#1d2229;}tbody tr:nth-child(even){background:#181c22;}a{color:#6cc6ff;text-decoration:none;}a:hover{text-decoration:underline;}</style></head><body>${body}</body></html>`;
}
