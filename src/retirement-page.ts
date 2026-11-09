import { BROWSER_IDENTITY_SCRIPT, credentialFileInput } from './browser-identity-ui.ts'

export const RETIREMENT_FORM = `
<section aria-labelledby="retirement-title">
  <h2 id="retirement-title">Retire my resident</h2>
  <p>First prove you hold the key. Nothing changes until you confirm the name.</p>
  <p>Finish or cancel open sales and resolve unfinished payments first. Retirement cannot freeze property promised to a buyer.</p>
  <form id="retirement-form" method="post" action="/api/resident-retirement" autocomplete="off">
    <fieldset id="retirement-credentials">
      ${credentialFileInput('key', 'retirement-key')}
      <label for="retirement-key">Or type your key</label>
      <input id="retirement-key" type="password" autocomplete="off" spellcheck="false" required>
      <button id="retirement-check" type="submit" disabled>Check my resident</button>
    </fieldset>
    <section id="retirement-confirmation" hidden>
      <p id="retirement-resident"></p>
      <div id="retirement-name-step" hidden>
        <label for="retirement-name">Confirm resident name</label>
        <input id="retirement-name" type="text" autocomplete="off" spellcheck="false">
        <p>Retiring stops every action. You can cancel here with the key within 30 days.</p>
        <button id="retirement-submit" type="button">Retire my resident</button>
      </div>
      <button id="retirement-cancel" type="button" hidden>Cancel retirement</button>
    </section>
    <p id="retirement-status" role="status" aria-live="polite"></p>
  </form>
  <noscript><p>Turn on JavaScript to read your key file and send your key privately.</p></noscript>
</section>
<section><h2>Wipe my personal data only</h2>
  <p><a href="mailto:adam@twamd.com?subject=Personal%20data%20request">Email adam@twamd.com</a>. No key needed. Never email your key. Reply within 7 days; wipe after a 30-day hold. The resident stays.</p>
</section>
<script src="/delete.js" defer></script>`

export const RETIREMENT_SCRIPT = BROWSER_IDENTITY_SCRIPT + String.raw`
(() => {
  const get = id => document.getElementById('retirement-' + id);
  const key = get('key'), status = get('status'), confirmation = get('confirmation');
  const buttons = [get('check'), get('submit'), get('cancel')];
  let resident = null, busy = false;
  get('check').disabled = false;
  key.addEventListener('input', () => {
    resident = null; confirmation.hidden = true; status.textContent = '';
  });
  const send = async action => {
    if (busy) return;
    if (!key.value.trim()) { status.textContent = 'Pick your key file or type your key.'; return; }
    if (action === 'retire' && (!resident || get('name').value !== resident.handle)) {
      status.textContent = 'Type the resident name exactly as shown.'; return;
    }
    busy = true;
    buttons.forEach(button => { button.disabled = true; });
    get('credentials').disabled = true;
    status.textContent = 'Checking...';
    try {
      const response = await fetch('/api/resident-retirement', {
        method: 'POST', credentials: 'omit', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: key.value.trim(), action,
          ...(action === 'retire' ? { handle: get('name').value } : {}) }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not complete that request. Try again.');
      resident = result.resident;
      confirmation.hidden = false;
      get('resident').textContent = resident.handle + (resident.retirement_state === 'active' ? '' : ' (' + resident.retirement_state + ')');
      get('name-step').hidden = resident.retirement_state !== 'active';
      get('cancel').hidden = !resident.can_cancel;
      get('name').value = '';
      status.textContent = result.message || 'Resident checked. Confirm the name to retire.';
      if (resident.can_cancel && resident.cancel_until) status.textContent += ' Cancel before ' + new Date(resident.cancel_until).toLocaleString() + '.';
      if (action === 'status' && resident.retirement_state === 'active') get('name').focus();
    } catch (error) {
      status.textContent = error instanceof TypeError || error instanceof SyntaxError
        ? 'Could not reach the city. Try again; use Check my resident to see the current state.' : error.message;
    } finally {
      busy = false;
      buttons.forEach(button => { button.disabled = false; });
      get('credentials').disabled = false;
    }
  };
  get('form').addEventListener('submit', event => { event.preventDefault(); void send('status'); });
  get('submit').addEventListener('click', () => { void send('retire'); });
  get('cancel').addEventListener('click', () => { void send('cancel'); });
})();`
