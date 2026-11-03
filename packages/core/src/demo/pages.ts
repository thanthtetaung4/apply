import { jobsBySource, type MockJob, type MockSource } from './jobs'

export const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const CSS = `
body{font:15px/1.5 system-ui,Segoe UI,Arial,sans-serif;margin:0;color:#1d2433;background:#f6f7f9}
main{max-width:760px;margin:24px auto;background:#fff;padding:24px 32px;border-radius:10px;border:1px solid #e3e6ec}
h1{font-size:24px;margin:0 0 4px}h2{font-size:17px;margin:22px 0 8px}
.meta{color:#5a6477;margin:0 0 12px}
.field{margin:10px 0}label{display:block;font-weight:600;margin-bottom:3px}
fieldset label{display:inline-block;font-weight:400;margin-right:16px}
fieldset{border:1px solid #e3e6ec;border-radius:6px;margin:10px 0}legend{font-weight:600;padding:0 6px}
input[type=text],input[type=email],input[type=tel],input[type=url],input[type=number],input[type=password],select,textarea{width:100%;box-sizing:border-box;padding:8px;border:1px solid #c5cbd6;border-radius:6px;font:inherit}
button,.btn{background:#1f5eff;color:#fff;border:0;border-radius:6px;padding:9px 16px;font:inherit;cursor:pointer;text-decoration:none;display:inline-block;margin:8px 8px 0 0}
button.secondary{background:#e9edf5;color:#1d2433}
.banner{position:fixed;left:0;right:0;bottom:0;background:#101828;color:#fff;padding:14px 24px;z-index:50}
.banner button{background:#fff;color:#101828}
.modal{position:fixed;inset:0;background:rgba(16,24,40,.55);display:none;align-items:center;justify-content:center;z-index:40}
.modal.open{display:flex}.modal .box{background:#fff;border-radius:10px;padding:24px;width:520px;max-height:85vh;overflow:auto}
.step-indicator{color:#5a6477;font-size:13px;margin-bottom:6px}
.error{color:#b42318;margin:6px 0}
ul.cards{list-style:none;padding:0}ul.cards li{padding:12px 0;border-bottom:1px solid #eef0f4}
`

export const layout = (title: string, body: string, head = '') =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${CSS}</style>${head}</head><body>${body}</body></html>`

// --- boards -----------------------------------------------------------------------------

const CARD_PATH: Record<MockSource, (id: string) => string> = {
  indeed: (id) => `/indeed/viewjob?jk=${id}`,
  linkedin: (id) => `/linkedin/jobs/view/${id}`,
  glassdoor: (id) => `/glassdoor/job-listing/${id}`,
}

export const boardJobPath = (job: MockJob) => CARD_PATH[job.source](job.id)

export function boardSearch(source: MockSource): string {
  const cards = jobsBySource(source)
    .map(
      (j) =>
        `<li class="job-card"><a href="${boardJobPath(j)}">${esc(j.title)}</a><div class="meta"><span class="company">${esc(j.company)}</span> · <span class="loc">${esc(j.location)}</span></div></li>`,
    )
    .join('')
  return layout(
    `${source} jobs`,
    `<main><h1>${source} job search</h1><ul class="cards">${cards}</ul></main>`,
  )
}

export function boardView(job: MockJob, origin: string): string {
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: job.title,
    description: job.description,
    datePosted: '2026-10-30',
    hiringOrganization: { '@type': 'Organization', name: job.company },
    jobLocation: {
      '@type': 'Place',
      address: { '@type': 'PostalAddress', addressLocality: job.location, addressCountry: 'SG' },
    },
  }
  const head = `<script type="application/ld+json">${JSON.stringify(ld)}</script>`
  let applyBlock: string
  if (job.boardNative && job.source === 'linkedin') {
    applyBlock = `<button type="button" onclick="document.getElementById('ea').classList.add('open')">Easy Apply</button>${easyApplyModal(job)}`
  } else if (job.boardNative && job.source === 'indeed') {
    applyBlock = `<a class="btn" href="${job.applyPath}">Apply now</a>`
  } else {
    applyBlock = `<a class="btn apply-external" href="${origin}${job.applyPath}">Apply on company site</a>`
  }
  return layout(
    `${job.title} at ${job.company}`,
    `<main><h1>${esc(job.title)}</h1><p class="meta">${esc(job.company)} · ${esc(job.location)}</p><p>${esc(job.description)}</p>${applyBlock}</main>`,
    head,
  )
}

// --- shared form snippets ---------------------------------------------------------------

const text = (
  id: string,
  label: string,
  opts: { req?: boolean; type?: string; name?: string } = {},
) =>
  `<div class="field"><label for="${id}">${esc(label)}${opts.req ? ' *' : ''}</label><input type="${opts.type ?? 'text'}" id="${id}" name="${opts.name ?? id}"${opts.req ? ' required' : ''}></div>`

const file = (id: string, label: string, req = true) =>
  `<div class="field"><label for="${id}">${esc(label)}${req ? ' *' : ''}</label><input type="file" id="${id}" name="${id}"${req ? ' required' : ''}></div>`

const select = (id: string, label: string, options: string[], req = true) =>
  `<div class="field"><label for="${id}">${esc(label)}${req ? ' *' : ''}</label><select id="${id}" name="${id}"${req ? ' required' : ''}><option value="">Select...</option>${options.map((o) => `<option value="${esc(o.toLowerCase())}">${esc(o)}</option>`).join('')}</select></div>`

const yesNoRadio = (name: string, legend: string) =>
  `<fieldset><legend>${esc(legend)} *</legend><label><input type="radio" name="${name}" value="yes" required> Yes</label><label><input type="radio" name="${name}" value="no"> No</label></fieldset>`

const combobox = (
  id: string,
  label: string,
) => `<div class="field"><label for="${id}">${esc(label)} *</label>
<input type="text" id="${id}" name="${id}" role="combobox" aria-autocomplete="list" aria-controls="${id}-list" autocomplete="off" required>
<ul id="${id}-list" role="listbox" hidden style="list-style:none;margin:2px 0;padding:0;border:1px solid #c5cbd6;border-radius:6px;background:#fff"></ul></div>
<script>(function(){var cities=['Singapore','Kuala Lumpur','Jakarta','Bangkok'];var i=document.getElementById('${id}');var l=document.getElementById('${id}-list');
i.addEventListener('input',function(){var q=i.value.toLowerCase();l.innerHTML='';var m=cities.filter(function(c){return q&&c.toLowerCase().indexOf(q)===0});
m.forEach(function(c){var li=document.createElement('li');li.setAttribute('role','option');li.textContent=c;li.style.padding='6px 8px';li.style.cursor='pointer';
li.addEventListener('click',function(){i.value=c;l.hidden=true});l.appendChild(li)});l.hidden=m.length===0});})();</script>`

// --- Greenhouse style (single page) ------------------------------------------------------

export function greenhousePage(job: MockJob): string {
  const eeo = job.kind === 'greenhouse_eeo'
  const unknown = job.kind === 'greenhouse_unknown_question'
  const banner = eeo
    ? `<div class="banner" id="cookie"><span>We use cookies to improve your experience.</span> <button type="button" onclick="document.getElementById('cookie').remove()">Accept all cookies</button></div>`
    : ''
  const form = `<form method="post" action="${job.applyPath}/submit" enctype="multipart/form-data">
<section><h2>Apply for this job</h2>
${text('first_name', 'First Name', { req: true })}
${text('last_name', 'Last Name', { req: true })}
${text('email', 'Email', { req: true, type: 'email' })}
${text('phone', 'Phone', { type: 'tel' })}
${file('resume', 'Resume/CV')}
${combobox('location', 'Location (City)')}
${text('linkedin', 'LinkedIn Profile', { type: 'url' })}
${text('website', 'Website', { type: 'url' })}
</section>
<section><h2>Additional questions</h2>
${select('work_auth', 'Are you legally authorized to work in Singapore?', ['Yes', 'No'])}
${yesNoRadio('sponsorship', 'Will you now or in the future require visa sponsorship?')}
${text('referral', 'How did you hear about us?')}
${unknown ? `<div class="field"><label for="conflict">Describe a time you led a team through conflict *</label><textarea id="conflict" name="conflict" rows="4" required></textarea></div>` : ''}
</section>
${
  eeo
    ? `<section><h2>Voluntary self-identification</h2>
${select('gender', 'Gender', ['Male', 'Female', 'Non-binary', 'Decline to self-identify'], false)}
${select('ethnicity', 'Race/Ethnicity', ['Chinese', 'Malay', 'Indian', 'Other', 'Decline to self-identify'], false)}
</section>`
    : ''
}
<button type="submit">Submit Application</button>
</form>`
  return layout(
    `${job.title} at ${job.company}`,
    `<main><h1>${esc(job.title)}</h1><p class="meta">${esc(job.company)} · ${esc(job.location)}</p><p>${esc(job.description)}</p>${form}</main>${banner}`,
  )
}

export function captchaPage(job: MockJob): string {
  return layout(
    'Just a moment...',
    `<main><h1>Just a moment...</h1><p>Please verify you are human to continue to ${esc(job.company)} careers.</p>
<label><input type="checkbox" name="human"> I am not a robot</label><p class="meta">Unusual traffic detected from your network.</p></main>`,
  )
}

// --- company career sites ----------------------------------------------------------------

export function companySinglePage(job: MockJob): string {
  const form = `<form id="apply-form" method="post" action="${job.applyPath}/submit" enctype="multipart/form-data" style="display:none">
<section><h2>Your application</h2>
${text('full_name', 'Full name', { req: true })}
${text('email', 'Email address', { req: true, type: 'email' })}
${text('phone', 'Phone number', { req: true, type: 'tel' })}
${text('city', 'Current location')}
${file('cv', 'Upload your CV')}
${text('portfolio', 'Link to GitHub or portfolio', { type: 'url' })}
${text('salary', 'Expected salary (SGD per month)')}
${text('start', 'Earliest start date')}
<div class="field"><label><input type="checkbox" name="privacy" required> I agree to the privacy policy *</label></div>
</section>
<button type="submit">Send application</button>
</form>`
  return layout(
    `${job.title} | ${job.company} careers`,
    `<main><h1>${esc(job.title)}</h1><p class="meta">${esc(job.company)} · ${esc(job.location)}</p><p>${esc(job.description)}</p>
<button type="button" id="open-apply" onclick="document.getElementById('apply-form').style.display='block';this.style.display='none'">Apply now</button>${form}</main>`,
  )
}

export function companyWizardPage(job: MockJob): string {
  const form = `<form id="wiz" method="post" action="${job.applyPath}/submit" enctype="multipart/form-data">
<div class="step-indicator" id="ind">Step 1 of 2</div>
<div class="step" data-s="1"><section><h2>Your details</h2>
${text('first_name', 'First name', { req: true })}
${text('last_name', 'Last name', { req: true })}
${text('email', 'Email', { req: true, type: 'email' })}
${text('phone', 'Mobile number', { req: true, type: 'tel' })}
${file('resume', 'Resume')}
</section><button type="button" onclick="go(2)">Continue</button></div>
<div class="step" data-s="2" style="display:none"><section><h2>A few questions</h2>
${select('work_auth', 'Do you have the right to work in Singapore?', ['Yes', 'No'])}
${text('salary', 'Expected salary')}
</section><button type="button" class="secondary" onclick="go(1)">Back</button><button type="submit">Submit application</button></div>
</form>
<script>function go(n){document.querySelectorAll('#wiz .step').forEach(function(s){s.style.display=(s.dataset.s==String(n))?'block':'none'});document.getElementById('ind').textContent='Step '+n+' of 2';}</script>`
  return layout(
    `${job.title} | ${job.company}`,
    `<main><h1>${esc(job.title)}</h1><p class="meta">${esc(job.company)} · ${esc(job.location)}</p><p>${esc(job.description)}</p>${form}</main>`,
  )
}

// --- Workday style -----------------------------------------------------------------------

export function workdaySignIn(job: MockJob): string {
  return layout(
    'Sign In',
    `<main><h1>Sign In</h1><p class="meta">Sign in to apply to ${esc(job.company)}.</p>
<form method="post" action="/wd/${job.slug}/signin"><div class="field"><label for="u">Email Address</label><input type="email" id="u" name="email"></div>
<div class="field"><label for="p">Password</label><input type="password" id="p" name="password"></div><button type="submit">Sign In</button></form></main>`,
  )
}

export function workdayJob(job: MockJob): string {
  const steps = [
    `<h2>My Information</h2>
${text('wd_first', 'First Name', { req: true })}
${text('wd_last', 'Last Name', { req: true })}
${text('wd_email', 'Email', { req: true, type: 'email' })}
${text('wd_phone', 'Phone Number', { req: true, type: 'tel' })}
${file('wd_resume', 'Resume/CV')}`,
    `<h2>My Experience</h2>
${text('wd_company', 'Current Employer', { req: true })}
${text('wd_linkedin', 'LinkedIn URL', { type: 'url' })}`,
    `<h2>Application Questions</h2>
${select('wd_auth', 'Are you legally authorized to work in Singapore?', ['Yes', 'No'])}
${yesNoRadio('wd_sponsor', 'Will you require visa sponsorship?')}
${text('wd_source', 'How did you hear about us?')}`,
    `<h2>Voluntary Disclosures</h2>${select('wd_gender', 'Gender', ['Male', 'Female', 'Decline to self-identify'], false)}`,
    `<h2>Review</h2><p>Please review your application and submit.</p>`,
  ]
  const stepDivs = steps
    .map(
      (s, i) =>
        `<div class="step" data-s="${i + 1}" style="${i === 0 ? '' : 'display:none'}"><section>${s}</section>
${i > 0 ? '<button type="button" class="secondary" onclick="go(' + i + ')">Back</button>' : ''}
${i < steps.length - 1 ? '<button type="button" onclick="go(' + (i + 2) + ')">Save and Continue</button>' : '<button type="submit">Submit</button>'}</div>`,
    )
    .join('\n')
  const form = `<form id="wiz" method="post" action="${job.applyPath}/submit" enctype="multipart/form-data" style="display:none">
<div class="step-indicator" id="ind">Step 1 of 5</div>${stepDivs}</form>
<script>
function go(n){document.querySelectorAll('#wiz .step').forEach(function(s){s.style.display=(s.dataset.s==String(n))?'block':'none'});document.getElementById('ind').textContent='Step '+n+' of 5';}
document.getElementById('wd_resume').addEventListener('change',function(){setTimeout(function(){document.getElementById('wd_first').value='PARSED';document.getElementById('wd_phone').value='0000';},40)});
</script>`
  return layout(
    `${job.title} - ${job.company}`,
    `<main><h1>${esc(job.title)}</h1><p class="meta">${esc(job.company)} · ${esc(job.location)}</p><p>${esc(job.description)}</p>
<button type="button" onclick="document.getElementById('wiz').style.display='block';this.style.display='none'">Apply</button>${form}</main>`,
  )
}

// --- LinkedIn Easy Apply modal and Indeed Apply ------------------------------------------

function easyApplyModal(job: MockJob): string {
  return `<div class="modal" id="ea" role="dialog" aria-label="Easy Apply"><div class="box">
<form id="eaf" method="post" action="${job.applyPath}/submit" enctype="multipart/form-data">
<div class="step-indicator" id="eai">Step 1 of 4</div>
<div class="step" data-s="1"><h2>Contact info</h2>${text('ea_email', 'Email address', { req: true, type: 'email' })}${text('ea_phone', 'Mobile phone number', { req: true, type: 'tel' })}<button type="button" onclick="eg(2)">Next</button></div>
<div class="step" data-s="2" style="display:none"><h2>Resume</h2>${file('ea_resume', 'Upload resume')}<button type="button" class="secondary" onclick="eg(1)">Back</button><button type="button" onclick="eg(3)">Next</button></div>
<div class="step" data-s="3" style="display:none"><h2>Additional questions</h2>${select('ea_auth', 'Are you legally authorized to work in Singapore?', ['Yes', 'No'])}${yesNoRadio('ea_sponsor', 'Will you require sponsorship?')}<button type="button" class="secondary" onclick="eg(2)">Back</button><button type="button" onclick="eg(4)">Review</button></div>
<div class="step" data-s="4" style="display:none"><h2>Review your application</h2><p>Check your details and submit.</p><button type="button" class="secondary" onclick="eg(3)">Back</button><button type="submit">Submit application</button></div>
</form></div></div>
<script>function eg(n){document.querySelectorAll('#eaf .step').forEach(function(s){s.style.display=(s.dataset.s==String(n))?'block':'none'});document.getElementById('eai').textContent='Step '+n+' of 4';}</script>`
}

export function indeedApplyPage(job: MockJob): string {
  return layout(
    `Apply to ${job.company}`,
    `<main><h1>Apply to ${esc(job.title)}</h1><p class="meta">${esc(job.company)}</p>
<form id="iaf" method="post" action="${job.applyPath}/submit" enctype="multipart/form-data">
<div class="step-indicator" id="iai">Step 1 of 3</div>
<div class="step" data-s="1"><h2>Add your contact information</h2>${text('ia_name', 'Full name', { req: true })}${text('ia_email', 'Email', { req: true, type: 'email' })}${text('ia_phone', 'Phone number', { req: true, type: 'tel' })}<button type="button" onclick="ig(2)">Continue</button></div>
<div class="step" data-s="2" style="display:none"><h2>Add a resume</h2>${file('ia_resume', 'Resume')}<button type="button" class="secondary" onclick="ig(1)">Back</button><button type="button" onclick="ig(3)">Continue</button></div>
<div class="step" data-s="3" style="display:none"><h2>Review your application</h2><p>Make sure everything looks right.</p><button type="button" class="secondary" onclick="ig(2)">Back</button><button type="submit">Submit your application</button></div>
</form>
<script>function ig(n){document.querySelectorAll('#iaf .step').forEach(function(s){s.style.display=(s.dataset.s==String(n))?'block':'none'});document.getElementById('iai').textContent='Step '+n+' of 3';}</script></main>`,
  )
}

export const thanksPage = (company: string) =>
  layout(
    'Thank you',
    `<main><h1>Thank you for applying</h1><p>Your application to ${esc(company)} has been submitted. We will be in touch.</p></main>`,
  )
