/**
 * Page-side script that turns the visible form into a compact schema. It runs inside the page
 * (once per frame) and is a plain string on purpose: functions compiled by a TypeScript tool can
 * pick up helpers that do not exist in the page.
 *
 * Side effect: it tags the controls it finds with data-aa (field id) and the buttons with
 * data-aa-action so that later calls can find them again without guessing selectors.
 */
export function extractScript(framePrefix: string): string {
  return String.raw`((P) => {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
  };
  const slug = (s) => norm(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 28) || 'x';
  const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36).slice(0, 4); };
  const used = new Map();
  const mkId = (prefix, label, extra) => {
    const base = P + prefix + '_' + slug(label) + '_' + hash(label + '|' + extra);
    const n = (used.get(base) || 0) + 1;
    used.set(base, n);
    return n === 1 ? base : base + '-' + n;
  };

  document.querySelectorAll('[data-aa],[data-aa-action]').forEach((n) => { n.removeAttribute('data-aa'); n.removeAttribute('data-aa-action'); });

  const rawLabel = (el) => {
    let t = '';
    if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) t = l.textContent; }
    if (!t) { const l = el.closest('label'); if (l) { const c = l.cloneNode(true); c.querySelectorAll('input,select,textarea').forEach((n) => n.remove()); t = c.textContent; } }
    if (!t && el.getAttribute('aria-labelledby')) {
      t = el.getAttribute('aria-labelledby').split(/\s+/).map((id) => { const n = document.getElementById(id); return n ? n.textContent : ''; }).join(' ');
    }
    if (!t && el.getAttribute('aria-label')) t = el.getAttribute('aria-label');
    if (!t && el.placeholder) t = el.placeholder;
    if (!t && el.name) t = el.name;
    return norm(t);
  };
  const cleanLabel = (s) => norm(s.replace(/\(required\)/i, '').replace(/\s*\*+\s*$/, ''));
  const groupLabel = (el) => {
    const fs = el.closest('fieldset');
    if (fs) { const lg = fs.querySelector('legend'); if (lg) return norm(lg.textContent); }
    const g = el.closest('[role=radiogroup],[role=group]');
    if (g) {
      const al = g.getAttribute('aria-label'); if (al) return norm(al);
      const lb = g.getAttribute('aria-labelledby'); if (lb) { const n = document.getElementById(lb); if (n) return norm(n.textContent); }
    }
    return '';
  };
  const sectionOf = (el) => {
    const s = el.closest('section, [data-section]');
    if (!s) return '';
    const h = s.querySelector('h1,h2,h3,h4');
    return h ? norm(h.textContent) : '';
  };
  const mapType = (t) => ['text','email','tel','url','number','date','password'].includes(t) ? t : 'text';

  const controls = Array.from(document.querySelectorAll('input, select, textarea')).filter((el) => {
    const t = (el.type || '').toLowerCase();
    if (['hidden','submit','button','image','reset'].includes(t)) return false;
    if (t === 'file') return isVisible(el) || (el.parentElement ? isVisible(el.parentElement) : false);
    return isVisible(el);
  });

  const checkboxCount = new Map();
  controls.forEach((el) => { if (el.type === 'checkbox' && el.name) checkboxCount.set(el.name, (checkboxCount.get(el.name) || 0) + 1); });

  const fields = [];
  const groups = new Map();

  controls.forEach((el) => {
    const t = (el.type || '').toLowerCase();
    const isRadio = t === 'radio';
    const isMultiBox = t === 'checkbox' && el.name && checkboxCount.get(el.name) > 1;
    if (isRadio || isMultiBox) {
      const key = (isRadio ? 'r:' : 'c:') + (el.name || el.id);
      let g = groups.get(key);
      if (!g) { g = { els: [], type: isRadio ? 'radio' : 'checkbox' }; groups.set(key, g); fields.push({ group: g, first: el }); }
      g.els.push(el);
      return;
    }
    fields.push({ el });
  });

  const out = [];
  fields.forEach((f) => {
    if (f.group) {
      const g = f.group; const first = f.first;
      const options = g.els.map((e) => cleanLabel(rawLabel(e)));
      const label = cleanLabel(groupLabel(first)) || cleanLabel(first.name || 'choice');
      const section = sectionOf(first);
      const id = mkId('f', label, g.type + '|' + (first.name || '') + '|' + section);
      g.els.forEach((e) => e.setAttribute('data-aa', id));
      const checked = g.els.filter((e) => e.checked).map((e) => cleanLabel(rawLabel(e)));
      const raw = groupLabel(first);
      out.push({
        id, label, type: g.type, name: first.name || undefined,
        required: g.els.some((e) => e.required) || /\*/.test(raw),
        options, value: g.type === 'radio' ? (checked[0] || '') : checked,
        section: section || undefined, disabled: g.els.every((e) => e.disabled) || undefined,
      });
      return;
    }
    const el = f.el;
    const tag = el.tagName.toLowerCase();
    const raw = rawLabel(el);
    const label = cleanLabel(raw);
    const section = sectionOf(el);
    let type;
    if (tag === 'select') type = 'select';
    else if (tag === 'textarea') type = 'textarea';
    else if (el.type === 'file') type = 'file';
    else if (el.type === 'checkbox') type = 'checkbox';
    else type = mapType((el.type || 'text').toLowerCase());
    const id = mkId('f', label, type + '|' + (el.name || '') + '|' + section);
    el.setAttribute('data-aa', id);
    const field = {
      id, label, type, name: el.name || undefined,
      required: !!el.required || el.getAttribute('aria-required') === 'true' || /\*/.test(raw),
      section: section || undefined, disabled: el.disabled || undefined,
    };
    if (type === 'select') {
      const opts = Array.from(el.options).filter((o) => o.value !== '' && !o.disabled);
      field.options = opts.map((o) => norm(o.textContent));
      field.value = el.value !== '' && el.selectedOptions[0] ? norm(el.selectedOptions[0].textContent) : '';
    } else if (type === 'file') {
      field.value = el.files && el.files[0] ? el.files[0].name : '';
    } else if (type === 'checkbox') {
      field.value = !!el.checked;
    } else {
      field.value = el.value || '';
      if (el.getAttribute('role') === 'combobox') field.hint = 'combobox';
    }
    out.push(field);
  });

  const actions = [];
  Array.from(document.querySelectorAll('button, input[type=submit], input[type=button], a[role=button], [role=button]'))
    .filter((el) => isVisible(el) && !el.disabled)
    .forEach((el) => {
      const label = norm(el.value || el.textContent || el.getAttribute('aria-label') || '');
      if (!label || label.length > 60) return;
      const id = mkId('a', label, '');
      el.setAttribute('data-aa-action', id);
      actions.push({ id, label });
    });

  const errors = Array.from(document.querySelectorAll('[role=alert], .error, .field-error, .error-message, .errors li'))
    .filter(isVisible).map((e) => norm(e.textContent)).filter(Boolean).slice(0, 8);
  const stepEl = document.querySelector('[data-step], .step-indicator, [aria-current=step]');
  return { fields: out, actions, errors, stepText: stepEl ? norm(stepEl.textContent) : '' };
})(${JSON.stringify(framePrefix)})`
}
