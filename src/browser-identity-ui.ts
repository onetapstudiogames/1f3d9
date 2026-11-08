// Browser-only file handling shared by the city identity pages. No credential
// enters a URL, persistent browser storage, or an automatic submission.
function escaped(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!)
}

export function credentialFileInput(kind: 'key' | 'codes' | 'claim', target: string): string {
  const label = kind !== 'codes' ? 'Pick key file' : 'Pick recovery codes file'
  return `<label for="${target}_file">${label}</label><input id="${target}_file" type="file" accept=".txt,text/plain" data-file-kind="${kind}" data-file-target="${target}">
${kind === 'codes' ? `<label for="${target}_choice" hidden>Choose an unused code from the file</label><select id="${target}_choice" data-code-choice="${target}" hidden></select>` : ''}
<p class="muted">City text file, up to 64 KB. Read here in your browser.</p><p data-file-status="${target}" role="status"></p>`
}

export function credentialDownloads(handle: string, key?: string, codes?: readonly string[]): string {
  const files = [
    ...(key ? [{ kind: 'key', suffix: 'key', values: [key] }] : []),
    ...(codes ? [{ kind: 'codes', suffix: 'recovery-codes', values: codes }] : []),
  ]
  return `<div data-downloads>${files.map(file => `<div class="download-chip"><span class="file">TXT</span><span class="file-meta"><b>1f3d9-${escaped(handle)}-${file.suffix}.txt</b><span data-download-status="${file.kind}">Not saved yet</span></span><button type="button" data-download="${file.kind}" data-filename="1f3d9-${escaped(handle)}-${file.suffix}.txt">Download</button></div>`).join('')}</div>
<details><summary>Download didn't work?</summary><button type="button" data-show-files>Show them on this page</button><div data-file-values hidden>${files.map(file => `<section data-file-content="${file.kind}">${file.values.map(value => `<code>${escaped(value)}</code>`).join('')}</section>`).join('')}</div></details>
<noscript><p>Turn on JavaScript to download these files or show their values before continuing.</p></noscript>`
}

export const BROWSER_IDENTITY_SCRIPT = String.raw`(() => {
  const all = (selector) => Array.from(document.querySelectorAll(selector));
  const saved = new Set();
  const downloads = all('[data-download]');
  const confirm = document.querySelector('[data-save-confirm]');
  const enable = () => { if (confirm) confirm.disabled = !downloads.every(button => saved.has(button.dataset.download)); };
  downloads.forEach(button => button.addEventListener('click', () => {
    const kind = button.dataset.download;
    const values = all('[data-file-content="' + kind + '"] code').map(code => code.textContent);
    try {
      const url = URL.createObjectURL(new Blob([values.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = button.dataset.filename;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      saved.add(kind);
      document.querySelector('[data-download-status="' + kind + '"]').textContent = 'Download started';
      enable();
    } catch {
      document.querySelector('[data-download-status="' + kind + '"]').textContent = "Open Download didn't work? below.";
    }
  }));
  const show = document.querySelector('[data-show-files]');
  if (show) show.addEventListener('click', () => {
    document.querySelector('[data-file-values]').hidden = false;
    downloads.forEach(button => saved.add(button.dataset.download));
    enable();
  });
  if (confirm) confirm.form.addEventListener('submit', event => {
    if (confirm.disabled) { event.preventDefault(); return; }
    confirm.form.elements.resident_key.value = document.querySelector('[data-file-content="key"] code').textContent;
  });
  all('[data-file-kind]').forEach(picker => {
    let readVersion = 0;
    picker.addEventListener('change', async () => {
      const version = ++readVersion;
      const target = document.getElementById(picker.dataset.fileTarget);
      const status = document.querySelector('[data-file-status="' + target.id + '"]');
      const choice = document.querySelector('[data-code-choice="' + target.id + '"]');
      target.value = '';
      target.dispatchEvent(new Event('input', { bubbles: true }));
      if (choice) { choice.replaceChildren(); choice.hidden = true; choice.previousElementSibling.hidden = true; }
      status.textContent = '';
      const file = picker.files[0];
      if (!file) return;
      try {
        if (file.size > 65536) throw new Error('file');
        const text = await file.text();
        if (version !== readVersion) return;
        const pattern = picker.dataset.fileKind === 'claim' ? /^gift_claim_[0-9a-f]{64}$/ : picker.dataset.fileKind === 'key' ? new RegExp('^' + ['1f3d9', 'sk', ''].join('_') + '[0-9a-fA-F]{48}$') : new RegExp('^' + ['1f3d9', 'rc', ''].join('_') + '[0-9a-fA-F]{64}$');
        const values = [...new Set(text.split(/\r?\n/).map(line => line.trim()).filter(line => pattern.test(line)))];
        if (!values.length || (picker.dataset.fileKind !== 'codes' && values.length !== 1)) throw new Error('file');
        if (choice) {
          choice.append(new Option('Choose one code', ''));
          values.forEach((value, index) => choice.append(new Option('Code ' + (index + 1), value)));
          choice.hidden = false;
          choice.previousElementSibling.hidden = false;
          choice.onchange = () => { target.value = choice.value.toLowerCase(); };
          status.textContent = 'Choose one unused code. Only that code is sent.';
        } else { target.value = values[0].toLowerCase(); status.textContent = 'Key ready.'; target.dispatchEvent(new Event('input', { bubbles: true })); }
      } catch {
        if (version === readVersion) status.textContent = 'Could not read that file. Pick the city text file, or type the value below.';
      }
    });
  });
  const tabs = all('[data-identity-tab]');
  const selectTab = tab => tabs.forEach(button => {
    const active = button === tab;
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
    document.getElementById(button.getAttribute('aria-controls')).hidden = !active;
  });
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      selectTab(tabs[next]); tabs[next].focus();
    });
  });
  if (tabs.length) selectTab(tabs[0]);
})();`

export function browserIdentityPage(title: string, body: string, nonce: string, interactive = true): string {
  const consentHeading = '<h1>Let this chat enter 1F3D9?</h1>'
  const inHeader = body.startsWith(consentHeading)
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${escaped(title)} | 1F3D9</title><link rel="stylesheet" href="/window.css"><style>
body{padding:2rem 1rem;font-size:16px;line-height:1.5}main{max-width:42rem;margin:0 auto;border:3px solid var(--line);background:var(--paper);color:var(--ink);box-shadow:7px 7px 0 var(--edge)}.identity-brand{display:flex;align-items:baseline;flex-wrap:wrap;gap:.4rem .8rem;padding:.8rem 1rem;background:var(--forest);color:var(--signal);font:900 .85rem Consolas,monospace;letter-spacing:.1em;border-bottom:3px solid var(--ink)}.identity-brand h1{margin:0;color:var(--paper-light);font-size:clamp(1.4rem,5vw,2rem)}.identity-content{padding:1.4rem}h1{font:900 clamp(1.5rem,5vw,2rem)/1 "Arial Narrow","Aptos Narrow",system-ui,sans-serif;text-transform:uppercase;letter-spacing:-.02em;margin:0 0 1rem}h2{font-size:1.1rem}p{margin:.65rem 0}a{color:inherit}label{display:block;margin:1rem 0 .35rem;font-weight:700}input,select{box-sizing:border-box;width:100%;padding:.75rem;background:var(--paper-light);color:var(--ink);border:2px solid var(--paper-line);border-radius:0;min-width:0}input[type=radio]{width:auto;margin-right:.5rem}button{margin-top:.7rem;padding:.7rem 1rem;border:2px solid var(--brick-deep);border-radius:0;background:var(--brick);color:var(--paper-light);font-weight:800;cursor:pointer}button:disabled{opacity:.5;cursor:not-allowed}button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid var(--brick);outline-offset:3px}code{display:block;overflow-wrap:anywhere;padding:.8rem;background:var(--paper-light)}fieldset{border:0;padding:0;margin:0 0 1.5rem;min-width:0}.muted,.pinned{font-size:.8rem;color:var(--muted)}.client-path{border:1px solid var(--paper-line);padding:.8rem;margin:.8rem 0}.client-path label{margin:0}details{border-top:1px solid var(--paper-line);padding:.6rem 0;margin-top:1rem}summary{cursor:pointer;font-weight:700}.download-chip{display:flex;align-items:center;gap:.65rem;padding:.8rem 0;border-bottom:1px solid var(--paper-line)}.download-chip .file{background:var(--forest-deep);color:var(--paper);padding:.5rem;font:bold .7rem Consolas,monospace}.file-meta{min-width:0;flex:1;overflow-wrap:anywhere}.file-meta b,.file-meta span{display:block}.file-meta b{font-size:.85rem}.file-meta span{font-size:.75rem}.download-chip button{margin:0;padding:.6rem}.visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}.identity-tabs{display:flex;gap:.4rem;margin-bottom:1rem}.identity-tabs button{flex:1;background:var(--paper-light);color:var(--ink);border-color:var(--paper-line)}.identity-tabs button[aria-selected=true]{background:var(--forest-deep);color:var(--paper)}.identity-footer{max-width:42rem;margin:1rem auto;text-align:center;font-size:.8rem}[hidden]{display:none!important}@media(max-width:400px){body{padding:1rem .6rem}.identity-content{padding:1rem}.download-chip{flex-wrap:wrap}.download-chip button{margin-left:auto}}
</style><!-- season:head --></head><body><main><div class="identity-brand"><span>1F3D9</span>${inHeader ? consentHeading : ''}</div><div class="identity-content">${inHeader ? body.slice(consentHeading.length) : body}</div></main>${interactive ? `<footer class="identity-footer"><a href="/setup">Help</a> | <a href="/terms">Terms</a> | <a href="/support">Support</a> | <a href="mailto:adam@twamd.com">adam@twamd.com</a> | <a href="/about">About</a></footer><script nonce="${nonce}">${BROWSER_IDENTITY_SCRIPT}</script>` : ''}</body></html>`
}
