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
    if (!t) {
      const l = el.closest('label');
      if (l) {
        // Lever wraps the question text and the widget (with its result lists) in one label.
        const inner = l.querySelector('.application-label');
        if (inner) t = inner.textContent;
        else { const c = l.cloneNode(true); c.querySelectorAll('input,select,textarea').forEach((n) => n.remove()); t = c.textContent; }
      }
    }
    if (!t && el.getAttribute('aria-labelledby')) {
      t = el.getAttribute('aria-labelledby').split(/\s+/).map((id) => { const n = document.getElementById(id); return n ? n.textContent : ''; }).join(' ');
    }
    if (!t && el.getAttribute('aria-label')) t = el.getAttribute('aria-label');
    if (!t && el.placeholder) t = el.placeholder;
    if (!t && el.name) t = el.name;
    return norm(t);
  };
  const cleanLabel = (s) => norm(s.replace(/\(required\)/i, '').replace(/\s*[*✱]+\s*$/, ''));
  // The question a control belongs to, from the field's container. Lever puts it in
  // .application-label .text, Ashby in the field entry's label, many others in a label or legend.
  const containerLabel = (el) => {
    const c = el.closest('.application-question, [data-field-path], .ashby-application-form-field-entry, fieldset, [class*="field-entry"], [class*="question"]');
    if (!c) return '';
    const l = c.querySelector('.application-label .text, .application-label, legend, label[for], label, [class*="label"], [class*="title"]');
    return l && !l.contains(el) ? norm(l.textContent) : '';
  };
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
    // react-select hides its text input (opacity 0, near zero width) once an option is chosen.
    // The dropdown is still there, so judge it by its control box.
    if (el.getAttribute('role') === 'combobox') {
      const box = el.closest('[class*="control"]') || el.parentElement;
      return isVisible(el) || (box ? isVisible(box) : false);
    }
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
      const raw = groupLabel(first) || containerLabel(first);
      const label = cleanLabel(raw) || cleanLabel(first.name || 'choice');
      const section = sectionOf(first);
      const id = mkId('f', label, g.type + '|' + (first.name || '') + '|' + section);
      g.els.forEach((e) => e.setAttribute('data-aa', id));
      const checked = g.els.filter((e) => e.checked).map((e) => cleanLabel(rawLabel(e)));
      out.push({
        id, label, type: g.type, name: first.name || undefined,
        required: g.els.some((e) => e.required) || /[*✱]/.test(raw),
        options, value: g.type === 'radio' ? (checked[0] || '') : checked,
        section: section || undefined, disabled: g.els.every((e) => e.disabled) || undefined,
      });
      return;
    }
    const el = f.el;
    const tag = el.tagName.toLowerCase();
    let raw = rawLabel(el);
    // A label that is only the placeholder or the field name ("Type your response",
    // "cards[...][field0]") says nothing; use the question from the container instead.
    if (!raw || raw === norm(el.placeholder || '') || raw === norm(el.name || '')) {
      const cl = containerLabel(el);
      if (cl) raw = cl;
    }
    // Greenhouse labels its file inputs with the button word ("Attach"); the question
    // ("Resume/CV *") sits higher in the group. Without it the resume field is not recognised.
    const GENERIC_FILE = /^(attach|upload|upload (a )?file|choose (a )?file|browse|select (a )?file|add (a )?file|drop .*)$/i;
    if (el.type === 'file' && (!raw || GENERIC_FILE.test(raw))) {
      let t = '';
      const g = el.closest('[role=group][aria-labelledby]');
      if (g) { const n = document.getElementById(g.getAttribute('aria-labelledby')); if (n) t = norm(n.textContent); }
      for (let a = el, i = 0; !t && i < 6 && a.parentElement; i++) {
        a = a.parentElement;
        const l = a.querySelector('[id^="upload-label"], .label, .field-label, label:not([for]), legend, h3, h4');
        const lt = l && !l.contains(el) ? norm(l.textContent) : '';
        if (lt && !GENERIC_FILE.test(lt) && !/^enter manually$/i.test(lt)) t = lt;
      }
      if (!t) t = norm((el.id || el.name || '').replace(/[_-]+/g, ' '));
      if (t) raw = t;
    }
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
      required: !!el.required || el.getAttribute('aria-required') === 'true' || /[*✱]/.test(raw),
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
    } else if (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-haspopup') === 'listbox') {
      // A custom dropdown (react-select on Greenhouse, Ashby's location). The input only holds
      // what is typed; the chosen option is shown in a separate element. Report that, so a
      // typed but unselected answer reads back as empty instead of looking filled.
      field.hint = 'combobox';
      let box = el;
      let shown;
      for (let i = 0; i < 6 && box.parentElement; i++) {
        box = box.parentElement;
        if (box.querySelectorAll('[role=combobox]').length > 1) break; // reached another field
        const single = box.querySelector('[class*="single-value"], [class*="singleValue"]');
        if (single) { shown = norm(single.textContent); break; }
        const multi = box.querySelectorAll('[class*="multi-value__label"], [class*="multiValueLabel"]');
        if (multi.length) { shown = Array.from(multi).map((m) => norm(m.textContent)); break; }
      }
      field.value = shown !== undefined ? shown : (el.value || '');
    } else {
      field.value = el.value || '';
      // Lever's location: suggestions appear in a list under the input after typing.
      const cell = el.closest('.application-field, .application-question');
      if (cell && cell.querySelector('.dropdown-results')) field.hint = 'autocomplete';
    }
    out.push(field);
  });

  // Choice buttons (Ashby's Yes / No): a few aria-pressed buttons side by side for one question.
  const groupsOfButtons = new Set();
  document.querySelectorAll('button[aria-pressed], [role=button][aria-pressed]').forEach((b) => {
    if (b.parentElement && isVisible(b)) groupsOfButtons.add(b.parentElement);
  });
  groupsOfButtons.forEach((p) => {
    const btns = Array.from(p.children).filter((b) => b.matches('button[aria-pressed], [role=button][aria-pressed]') && isVisible(b));
    if (btns.length < 2 || btns.length > 6) return;
    const options = btns.map((b) => norm(b.textContent));
    if (options.some((o) => !o || o.length > 40)) return;
    const raw = containerLabel(p);
    if (!raw) return;
    const label = cleanLabel(raw);
    const section = sectionOf(p);
    const id = mkId('f', label, 'buttons|' + section);
    btns.forEach((b) => b.setAttribute('data-aa', id));
    const pressed = btns.find((b) => b.getAttribute('aria-pressed') === 'true');
    const entry = p.closest('[data-field-path], .ashby-application-form-field-entry, .application-question');
    const lab = entry ? entry.querySelector('label') : null;
    out.push({
      id, label, type: 'radio', options, value: pressed ? norm(pressed.textContent) : '',
      required: !!(lab && /required/i.test(lab.className)) || /[*✱]/.test(raw),
      hint: 'buttons', section: section || undefined,
    });
  });

  const actions = [];
  Array.from(document.querySelectorAll('button, input[type=submit], input[type=button], a[role=button], [role=button]'))
    // Buttons that answer a question (tagged above) are fields, not actions.
    .filter((el) => isVisible(el) && !el.disabled && !el.hasAttribute('data-aa'))
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
