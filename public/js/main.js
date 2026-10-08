import { api, get, patch, post, put, setCsrfToken } from './api.js';
import { esc, field, publicFrame, selectField } from './components.js';
import { renderPublic } from './public-pages.js';
import { renderPortal } from './portal-pages.js';

let currentUser = null;
let renderSequence = 0;
let filterTimer;

function toast(message, kind = 'success') {
  const region = document.getElementById('toast-region');
  if (!region) return;
  const node = document.createElement('div'); node.className = `toast ${kind === 'error' ? 'error' : ''}`; node.textContent = message;
  region.append(node); setTimeout(() => node.remove(), 4200);
}
function portalFor(user) { return user?.role === 'PATIENT' ? '/patient' : user?.role === 'DOCTOR' ? '/doctor' : '/admin'; }
function safeNext(value) { return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : ''; }
function setMeta(path) {
  const isPortal = ['/patient','/doctor','/admin'].includes(path);
  const isPrivateAuth = ['/login','/register','/forgot-password','/reset-password'].includes(path);
  const metadata = {
    '/': ['SmileCare Dental Clinic | Thoughtful dental care','A calmer kind of dentistry. Explore thoughtful dental care, meet our team and request an appointment at SmileCare.'],
    '/about': ['Our Clinic | SmileCare Dental Clinic','Meet SmileCare Dental Clinic: a modern neighborhood clinic built around clear conversations and thoughtful care.'],
    '/doctors': ['Our Dentists | SmileCare Dental Clinic','Meet the SmileCare dentists, review their specializations and find a clinician for your next visit. Demo profiles are shown.'],
    '/treatments': ['Dental Treatments | SmileCare Dental Clinic','Explore dental checkups, cleaning, restorative, cosmetic and family dentistry services at SmileCare. Demo pricing is labeled.'],
    '/gallery': ['Clinic Gallery | SmileCare Dental Clinic','Preview demo images of SmileCare clinic spaces and facilities.'],
    '/faq': ['FAQs | SmileCare Dental Clinic','Helpful answers about dental appointments, visits and care at SmileCare Dental Clinic.'],
    '/contact': ['Contact Us | SmileCare Dental Clinic','Contact the SmileCare clinic team, view opening hours or send a general enquiry.'],
    '/book': ['Request an Appointment | SmileCare Dental Clinic','Request a dental appointment at SmileCare. Appointment requests are pending until confirmed by clinic staff.']
  };
  const [title,description] = metadata[path] || [isPortal ? 'Care Portal | SmileCare' : 'SmileCare Dental Clinic | Account access',isPortal ? 'Private role-based SmileCare clinic portal.' : 'Manage your SmileCare patient account.'];
  document.title = title;
  const descriptionTag = document.querySelector('meta[name="description"]'); if (descriptionTag) descriptionTag.content = description;
  const ogTitle = document.querySelector('meta[property="og:title"]'); if (ogTitle) ogTitle.content = title;
  const ogDescription = document.querySelector('meta[property="og:description"]'); if (ogDescription) ogDescription.content = description;
  const robots = document.querySelector('meta[name="robots"]') || Object.assign(document.createElement('meta'), { name: 'robots' });
  robots.content = isPortal || isPrivateAuth ? 'noindex,nofollow' : 'index,follow';
  if (!robots.parentNode) document.head.append(robots);
}
async function refreshSession() {
  const data = await get('/api/auth/session');
  currentUser = data.authenticated ? data.user : null;
  setCsrfToken(data.csrfToken || '');
}
function loading() { document.getElementById('app').innerHTML = '<main class="loading-state container"><span class="spinner" aria-hidden="true"></span>Getting things ready…</main>'; }
function errorPage() {
  return publicFrame(currentUser, `<section class="auth-page"><div class="auth-card"><span class="eyebrow">A small interruption</span><h1>We couldn’t load<br/><em>this page.</em></h1><p>Check your connection and try again. Your saved data remains in the clinic database.</p><button class="button button-dark" data-action="retry">Try again</button></div></section>`);
}
async function render() {
  const seq = ++renderSequence, path = location.pathname.replace(/\/$/, '') || '/', params = new URLSearchParams(location.search);
  setMeta(path); loading();
  try {
    if (['/patient','/doctor','/admin'].includes(path)) {
      if (!currentUser) { history.replaceState({}, '', `/login?next=${encodeURIComponent(location.pathname + location.search)}`); return render(); }
      const allowed = path === '/patient' ? currentUser.role === 'PATIENT' : path === '/doctor' ? currentUser.role === 'DOCTOR' : ['SUPER_ADMIN','ADMIN','RECEPTIONIST'].includes(currentUser.role);
      if (!allowed) { history.replaceState({}, '', portalFor(currentUser)); return render(); }
      document.getElementById('app').innerHTML = await renderPortal(currentUser, path, params);
    } else {
      if (['/login','/register'].includes(path) && currentUser) { history.replaceState({}, '', portalFor(currentUser)); return render(); }
      document.getElementById('app').innerHTML = await renderPublic(path, currentUser);
    }
    if (seq !== renderSequence) return;
    setupTablePagination();
    if (!params.has('keepScroll')) window.scrollTo(0, 0);
    document.querySelectorAll('.main-nav a').forEach(link => {
      if (link.pathname === path) link.setAttribute('aria-current','page'); else link.removeAttribute('aria-current');
    });
  } catch (error) {
    if (seq !== renderSequence) return;
    if (error.status === 401 && currentUser) {
      currentUser = null; setCsrfToken('');
      history.replaceState({}, '', `/login?next=${encodeURIComponent(location.pathname + location.search)}`); return render();
    }
    document.getElementById('app').innerHTML = errorPage();
    toast(error.message || 'We could not load that page.', 'error');
  }
}
function navigate(path) {
  if (!path.startsWith('/')) return;
  history.pushState({}, '', path); render();
}
function values(form) { return Object.fromEntries(new FormData(form).entries()); }
function statusError(error) { toast(error.message || 'We could not complete that request.', 'error'); }
function formStatus(form, message = '', kind = '') {
  const region = form.querySelector('[data-form-status]');
  if (!region) return;
  region.textContent = message;
  region.className = `form-status ${kind}`.trim();
}
function modal(content) {
  let root = document.getElementById('modal-root');
  if (!root) { root = document.createElement('div'); root.id = 'modal-root'; document.body.append(root); }
  root.innerHTML = `<div class="dialog-shell" data-action="modal-backdrop"><section class="dialog-card" role="dialog" aria-modal="true" tabindex="-1" aria-labelledby="dialog-title">${content}</section></div>`;
  root.querySelector('[role="dialog"]')?.focus();
}
function closeModal() { const root = document.getElementById('modal-root'); if (root) root.innerHTML = ''; }
const modalHead = (title, help = '') => `<div class="dialog-head"><div><h2 id="dialog-title">${esc(title)}</h2>${help ? `<p class="field-hint">${esc(help)}</p>` : ''}</div><button class="dialog-close" type="button" aria-label="Close dialog" data-action="modal-close">×</button></div>`;

async function openCreatePatient() {
  modal(`${modalHead('Add patient', 'Create a patient portal account. Give the patient their sign-in details securely.')}
    <form class="stack-form" data-form="patient-create">${field('Full name','fullName')}${field('Email address','email','email')}${field('Phone number','phone','tel',{required:false})}${field('Temporary password','password','password',{min:12,hint:'At least 12 characters.'})}<button class="button button-dark">Create patient</button></form>`);
}
async function openCreateAppointment() {
  const [patients, doctors, services] = await Promise.all([get('/api/admin/patients'),get('/api/admin/doctors'),get('/api/admin/services')]);
  modal(`${modalHead('Add appointment', 'Choose an existing patient. The request is created as pending.')}
    <form class="stack-form" data-form="admin-book">${selectField('Patient','patientId',patients.filter(p=>p.active).map(p=>({value:p.id,label:`${p.fullName} · ${p.email}`})))}${selectField('Service','serviceId',services.filter(s=>s.active).map(s=>({value:s.id,label:`${s.name} · ${s.durationMinutes} min`})),{attrs:'data-booking-control'})}${selectField('Dentist','doctorId',doctors.filter(d=>d.active).map(d=>({value:d.id,label:d.fullName})),{attrs:'data-booking-control'})}${field('Date','date','date',{min:new Date(Date.now()+86400000).toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'}),attrs:'data-booking-control'})}<label class="field"><span>Available time <i>*</i></span><select name="time" data-booking-control required disabled><option value="">Choose service, dentist and date</option></select></label><div class="slot-list" data-slot-list></div><button class="button button-dark">Create pending appointment</button></form>`);
}
async function openCreateDoctor() {
  const services = await get('/api/admin/services');
  const checkboxes = services.filter(s=>s.active).map(s=>`<label class="check-field"><input type="checkbox" name="serviceIds" value="${esc(s.id)}"/><span>${esc(s.name)}</span></label>`).join('');
  modal(`${modalHead('Add doctor', 'A separate doctor portal account will be created.')}
    <form class="stack-form" data-form="doctor-create">${field('Full name','fullName')}${field('Email address','email','email')}${field('Password','password','password',{min:12})}<div class="form-row">${field('Qualification','qualification')}${field('Specialization','specialization')}</div>${field('Years of experience','experienceYears','number',{min:0,max:70,value:0})}<label class="field"><span>Short biography</span><textarea name="bio" rows="3" maxlength="1000"></textarea></label><div class="field"><span>Assigned services</span><div class="stack-form">${checkboxes}</div></div><button class="button button-dark">Create doctor account</button></form>`);
}
async function openEditDoctor(id) {
  const doctors=await get('/api/admin/doctors'), d=doctors.find(item=>item.id===id); if(!d) throw new Error('Doctor not found.');
  const serviceIds=(d.serviceIds||'').split(','); const services=await get('/api/admin/services');
  const checks=services.map(s=>`<label class="check-field"><input type="checkbox" name="serviceIds" value="${esc(s.id)}" ${serviceIds.includes(s.id)?'checked':''}/><span>${esc(s.name)}</span></label>`).join('');
  modal(`${modalHead('Edit doctor', 'Update this clinician’s public profile and service assignments.')}
    <form class="stack-form" data-form="doctor-edit" data-id="${esc(id)}">${field('Full name','fullName','text',{value:d.fullName})}${field('Email address','email','email',{required:false,value:d.email,attrs:'disabled'})}<div class="form-row">${field('Qualification','qualification','text',{value:d.qualification})}${field('Specialization','specialization','text',{value:d.specialization})}</div>${field('Years of experience','experienceYears','number',{min:0,max:70,value:d.experienceYears})}<label class="field"><span>Short biography</span><textarea name="bio" rows="3" maxlength="1000">${esc(d.bio||'')}</textarea></label><div class="field"><span>Assigned services</span><div class="stack-form">${checks}</div></div><button class="button button-dark">Save doctor details</button></form>`);
}
async function openDoctorSchedule(id) {
  const [data, doctors]=await Promise.all([get(`/api/admin/doctors/${id}/availability`),get('/api/admin/doctors')]);
  const doctor=doctors.find(d=>d.id===id), existing=new Map(data.weekly.map(row=>[row.weekday,row])), days=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const rows=days.map((day,n)=>{const item=existing.get(n), active=!!item;return `<div class="hours-editor-row"><label class="check-field"><input type="checkbox" name="enabled-${n}" ${active?'checked':''}/><span>${day}</span></label><input aria-label="${day} starts" type="time" name="start-${n}" value="${esc(item?.startTime||'09:00')}"/><input aria-label="${day} ends" type="time" name="end-${n}" value="${esc(item?.endTime||'17:00')}"/><input aria-label="${day} break starts" type="time" name="break-start-${n}" value="${esc(item?.breakStart||'13:00')}"/><input aria-label="${day} break ends" type="time" name="break-end-${n}" value="${esc(item?.breakEnd||'14:00')}"/><input aria-label="${day} slot length in minutes" type="number" name="slot-${n}" min="10" max="240" value="${item?.slotMinutes||30}"/></div>`}).join('');
  const holidays=data.unavailable.length?`<div class="holiday-list"><b>Unavailable dates</b>${data.unavailable.map(item=>`<label class="check-field"><input type="checkbox" name="removeUnavailable" value="${esc(item.id)}"/><span>${esc(item.date)}${item.reason?` — ${esc(item.reason)}`:''} <small>(check to remove)</small></span></label>`).join('')}</div>`:'<p class="field-hint">No unavailable dates are set.</p>';
  modal(`${modalHead(`Availability · ${doctor?.fullName||'Doctor'}`, 'Use the checkboxes to choose working days. Hours use 24-hour local clinic time.')}
    <form class="stack-form" data-form="doctor-hours" data-id="${esc(id)}"><div class="hours-editor"><div class="hours-editor-labels"><span>Day</span><span>Start</span><span>End</span><span>Break start</span><span>Break end</span><span>Slot (min)</span></div>${rows}</div>${holidays}<div class="form-row">${field('Add unavailable date','unavailableDate','date',{required:false,min:new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'})})}${field('Reason','unavailableReason','text',{required:false,max:200})}</div><button class="button button-dark">Save availability</button></form>`);
}
async function openCreateService() {
  modal(`${modalHead('Add service', 'New services appear in the public treatment list after creation.')}
    <form class="stack-form" data-form="service-create">${field('Service name','name')}${field('Description','description','text',{max:1500})}<div class="form-row">${field('Duration in minutes','durationMinutes','number',{min:10,max:240,value:30})}${field('Displayed price in rupees','priceRupees','number',{required:false,min:0})}</div><button class="button button-dark">Add service</button></form>`);
}
async function openCreateStaff() {
  modal(`${modalHead('Add staff member', 'Staff passwords are stored as salted hashes.')}<form class="stack-form" data-form="staff-create">${field('Email address','email','email')}${selectField('Role','role',[{value:'ADMIN',label:'Admin'},{value:'RECEPTIONIST',label:'Receptionist'}])}${field('Initial password','password','password',{min:12})}<button class="button button-dark">Create account</button></form>`);
}
async function openContentCreate(kind) {
  const forms={faq:`${field('Question','question')}${field('Answer','answer','text',{max:3000})}${field('Sort order','sort_order','number',{min:0,value:0})}`,testimonial:`${field('Patient display name','patient_name')}${field('Rating (1 to 5)','rating','number',{min:1,max:5,value:5})}${field('Review','review','text',{max:3000})}${field('Treatment category','category','text',{required:false,max:120})}`,gallery:`${field('Title','title')}${field('Image URL','image_url','url')}${field('Alt text','alt_text')}${field('Description','description','text',{required:false,max:1000})}`};
  modal(`${modalHead(`Add ${kind}`, 'Public-facing content must be demo content until real clinic material is approved.')}<form class="stack-form" data-form="content-create" data-kind="${kind}">${forms[kind]}<button class="button button-dark">Save ${kind}</button></form>`);
}
async function openPatientReschedule(id) {
  const rows=await get('/api/patient/appointments'), item=rows.find(row=>row.id===id); if(!item) throw new Error('Appointment not found.');
  modal(`${modalHead('Request a new time', 'We’ll review your new time request with the clinic.')}
    <form class="stack-form" data-form="appointment-reschedule" data-id="${esc(id)}" data-scope="patient" data-doctor="${esc(item.doctorId)}" data-service="${esc(item.serviceId)}">${field('New date','date','date',{min:new Date(Date.now()+86400000).toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'}),attrs:'data-reschedule-date'})}<label class="field"><span>Available time</span><select name="time" disabled required data-reschedule-time><option>Choose a date first</option></select></label><button class="button button-dark">Request new time</button></form>`);
}
async function openAdminReschedule(id) {
  const rows=await get('/api/admin/appointments'), item=rows.find(row=>row.id===id); if(!item) throw new Error('Appointment not found.');
  modal(`${modalHead('Reschedule appointment', 'Choose an available replacement time for this dentist and service.')}
    <form class="stack-form" data-form="appointment-reschedule" data-id="${esc(id)}" data-scope="admin" data-doctor="${esc(item.doctorId)}" data-service="${esc(item.serviceId)}">${field('New date','date','date',{min:new Date(Date.now()+86400000).toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'}),attrs:'data-reschedule-date'})}<label class="field"><span>Available time</span><select name="time" disabled required data-reschedule-time><option>Choose a date first</option></select></label><button class="button button-dark">Save new appointment time</button></form>`);
}

async function onAction(button) {
  const action=button.dataset.action, id=button.dataset.id;
  try {
    if(action==='choose-slot') { setSelectedBookingTime(button.closest('form'), button.dataset.time);return; }
    if(action==='menu') {const nav=document.querySelector('.main-nav');nav?.classList.toggle('open');button.setAttribute('aria-expanded',String(nav?.classList.contains('open')));return;}
    if(action==='sidebar') {document.getElementById('portal-sidebar')?.classList.toggle('open');return;}
    if(action==='logout') {await post('/api/auth/logout');currentUser=null;setCsrfToken('');toast('You have signed out.');navigate('/');return;}
    if(action==='retry') {await refreshSession();return render();}
    if(action==='modal-close') {closeModal();return;}
    if(action==='modal-backdrop' && button.target===button) {closeModal();return;}
    if(action==='page-prev'||action==='page-next') {
      const table=document.querySelector(`table[data-page-table="${button.dataset.pageTable}"]`), pager=document.querySelector(`[data-pagination="${button.dataset.pageTable}"]`);
      if(table&&pager)updateTablePages(table,Number(pager.dataset.page||0)+(action==='page-next'?1:-1));return;
    }
    if(action==='patient-create') return openCreatePatient();
    if(action==='appointment-create') return openCreateAppointment();
    if(action==='doctor-create') return openCreateDoctor();
    if(action==='doctor-edit') return openEditDoctor(id);
    if(action==='doctor-schedule') return openDoctorSchedule(id);
    if(action==='service-create') return openCreateService();
    if(action==='staff-create') return openCreateStaff();
    if(action==='content-create') return openContentCreate(button.dataset.kind);
    if(action==='patient-reschedule') return openPatientReschedule(id);
    if(action==='appointment-reschedule') return openAdminReschedule(id);
    if(action==='patient-cancel') {
      if(!confirm('Request cancellation of this appointment?')) return;
      await post(`/api/patient/appointments/${id}/cancel`);toast('Cancellation request recorded.');return render();
    }
    if(action==='doctor-status') {
      if(!confirm(`Mark this appointment ${button.dataset.status.toLowerCase().replace('_',' ')}?`)) return;
      await patch(`/api/doctor/appointments/${id}`,{status:button.dataset.status});toast('Appointment status updated.');return render();
    }
    if(action==='appointment-cancel') {
      if(!confirm('Cancel this appointment?')) return;
      await patch(`/api/admin/appointments/${id}`,{status:'CANCELLED'});toast('Appointment cancelled.');return render();
    }
    if(action==='appointment-status') {
      const status=button.dataset.status;
      if(['COMPLETED','NO_SHOW'].includes(status)&&!confirm(`Mark this appointment ${status.toLowerCase().replace('_',' ')}?`)) return;
      await patch(`/api/admin/appointments/${id}`,{status});toast(`Appointment ${status.toLowerCase().replace('_',' ')}.`);return render();
    }
    if(action==='patient-active') { await patch(`/api/admin/patients/${id}`,{active:button.dataset.active==='true'});toast('Patient access updated.');return render(); }
    if(action==='doctor-active') { await patch(`/api/admin/doctors/${id}`,{active:button.dataset.active==='true'});toast('Doctor account updated.');return render(); }
    if(action==='service-active') { const rows=await get('/api/admin/services'), service=rows.find(s=>s.id===id); await patch(`/api/admin/services/${id}`,{active:button.dataset.active==='true'});toast('Service updated.');return render(); }
    if(action==='staff-active') { await patch(`/api/admin/staff/${id}`,{active:button.dataset.active==='true'});toast('Staff access updated.');return render(); }
    if(action==='content-active') { await patch(`/api/admin/content/${button.dataset.kind}/${id}`,{active:button.dataset.active==='true'});toast('Website content updated.');return render(); }
  } catch(error) { statusError(error); }
}

async function handleForm(form) {
  if (form.dataset.submitting === 'true') return;
  const type=form.dataset.form, timeField=type==='book' ? form.elements.time : null;
  if (timeField && !timeField.value) {
    const message='Please select an available appointment time.';
    timeField.setCustomValidity(message);formStatus(form,message,'error');timeField.reportValidity();return;
  }
  timeField?.setCustomValidity('');
  if (!form.checkValidity()) { form.reportValidity(); return; }
  const data=values(form), submit=form.querySelector('[type="submit"],button:not([type])');
  form.dataset.submitting='true';formStatus(form, type==='book' ? 'Submitting your appointment request…' : '');
  if(submit){submit.disabled=true;submit.dataset.previous=submit.textContent;submit.textContent='Saving…';}
  try {
    if(type==='login'||type==='register') {
      const endpoint=type==='login'?'/api/auth/login':'/api/auth/register';
      const result=await post(endpoint,data);currentUser=result.user;setCsrfToken(result.csrfToken);
      const next=safeNext(data.next);toast(type==='login'?'Welcome back.':'Your patient account is ready.');navigate(next||portalFor(currentUser));return;
    }
    if(type==='forgot') {
      const result=await post('/api/auth/forgot-password',{email:data.email});
      const area=form.querySelector('[data-reset-result]');
      area.innerHTML=`<div class="notice">${esc(result.message)} ${result.developmentResetUrl?`<a href="${esc(new URL(result.developmentResetUrl).pathname+new URL(result.developmentResetUrl).search)}">Open password reset link ↗</a>`:''}</div>`;return;
    }
    if(type==='reset') { await post('/api/auth/reset-password',data);setCsrfToken('');toast('Password updated. Sign in with your new password.');navigate('/login');return; }
    if(type==='contact') { await post('/api/public/enquiries',data);toast('Your message has been sent to the clinic team.');form.reset();return; }
    if(type==='book') {
      const appointment=await post('/api/patient/appointments',data);
      formStatus(form, `Appointment ${appointment.reference} is pending clinic confirmation.`, 'success');
      toast(`Appointment ${appointment.reference} requested successfully.`);
      navigate(`/patient?section=appointments&booked=${encodeURIComponent(appointment.reference)}`);return;
    }
    if(type==='admin-book') { await post('/api/admin/appointments',data);closeModal();toast('Pending appointment created.');return render(); }
    if(type==='profile') { await patch('/api/patient/profile',data);toast('Profile updated.');return render(); }
    if(type==='change-password') { await post('/api/auth/change-password',data);toast('Password changed.');form.reset();return; }
    if(type==='patient-create') { await post('/api/admin/patients',data);closeModal();toast('Patient account created. Share sign-in details securely.');return render(); }
    if(type==='doctor-create') {
      data.serviceIds=[...form.querySelectorAll('[name="serviceIds"]:checked')].map(el=>el.value);
      await post('/api/admin/doctors',data);closeModal();toast('Doctor portal account created.');return render();
    }
    if(type==='doctor-edit') {
      data.serviceIds=[...form.querySelectorAll('[name="serviceIds"]:checked')].map(el=>el.value);delete data.email;delete data['serviceIds'];
      const body={fullName:data.fullName,qualification:data.qualification,specialization:data.specialization,experienceYears:Number(data.experienceYears),bio:data.bio,serviceIds:[...form.querySelectorAll('[name="serviceIds"]:checked')].map(el=>el.value)};
      await patch(`/api/admin/doctors/${form.dataset.id}`,body);closeModal();toast('Doctor details updated.');return render();
    }
    if(type==='doctor-hours') {
      const weekly=[];
      for(let weekday=0;weekday<7;weekday++) if(form.elements[`enabled-${weekday}`]?.checked) weekly.push({weekday,startTime:data[`start-${weekday}`],endTime:data[`end-${weekday}`],breakStart:data[`break-start-${weekday}`]||null,breakEnd:data[`break-end-${weekday}`]||null,slotMinutes:Number(data[`slot-${weekday}`])});
      const unavailable=data.unavailableDate?[{date:data.unavailableDate,reason:data.unavailableReason||''}]:[];
      const removeUnavailable=[...form.querySelectorAll('[name="removeUnavailable"]:checked')].map(el=>el.value);
      await put(`/api/admin/doctors/${form.dataset.id}/availability`,{weekly,unavailable,removeUnavailable});closeModal();toast('Doctor availability updated.');return render();
    }
    if(type==='service-create') { const body={name:data.name,description:data.description,durationMinutes:Number(data.durationMinutes),priceCents:data.priceRupees?Math.round(Number(data.priceRupees)*100):null};await post('/api/admin/services',body);closeModal();toast('Service added.');return render(); }
    if(type==='staff-create') { await post('/api/admin/staff',data);closeModal();toast('Staff account created.');return render(); }
    if(type==='content-create') {
      const kind=form.dataset.kind, payload={...data}; if(kind==='faq')payload.sort_order=Number(data.sort_order||0);if(kind==='testimonial')payload.rating=Number(data.rating);
      await post(`/api/admin/content/${kind}`,payload);closeModal();toast(`${kind[0].toUpperCase()+kind.slice(1)} saved.`);return render();
    }
    if(type==='appointment-reschedule') {
      const scope=form.dataset.scope, payload={date:data.date,time:data.time};
      if(scope==='patient') await post(`/api/patient/appointments/${form.dataset.id}/reschedule`,payload); else await patch(`/api/admin/appointments/${form.dataset.id}`,payload);
      closeModal();toast('New appointment time requested.');return render();
    }
  } catch(error) { formStatus(form, error.message || 'We could not complete that request.', 'error');statusError(error); }
  finally { delete form.dataset.submitting;if(submit&&submit.isConnected){submit.disabled=false;submit.textContent=submit.dataset.previous||'Save';} }
}

function setSelectedBookingTime(form, time) {
  if (!form || !time) return;
  const select=form.querySelector('select[name="time"]');
  if (!select || select.disabled || ![...select.options].some(option => option.value === time)) return;
  select.value=time;
  select.setCustomValidity('');
  form.querySelectorAll('[data-slot-list] .slot-chip').forEach(chip => {
    const selected=chip.dataset.time===time;
    chip.setAttribute('aria-pressed',String(selected));
    chip.classList.toggle('selected',selected);
  });
  formStatus(form,'');
}

function clearSelectedBookingTime(form) {
  const select=form?.querySelector('select[name="time"]');
  if (select) {
    select.value='';
    select.setCustomValidity('');
  }
  form?.querySelectorAll('[data-slot-list] .slot-chip').forEach(chip => {
    chip.setAttribute('aria-pressed','false');
    chip.classList.remove('selected');
  });
}

async function updateBookingSlots(form) {
  const select=form.querySelector('select[name="time"]'), hint=form.querySelector('[data-slot-hint]'), list=form.querySelector('[data-slot-list]');
  const doctorId=form.elements.doctorId?.value, serviceId=form.elements.serviceId?.value, date=form.elements.date?.value;
  if(!select||!doctorId||!serviceId||!date){
    if(select){select.disabled=true;select.innerHTML='<option value="">Choose service, dentist and date</option>';}
    clearSelectedBookingTime(form);
    if(hint)hint.textContent='Select a service, dentist and day to see available times.';if(list)list.innerHTML='';return;
  }
  const selectedTime=select.value;
  const requestVersion=String(Number(form.dataset.slotRequestVersion||0)+1);
  form.dataset.slotRequestVersion=requestVersion;
  select.disabled=true;
  select.setAttribute('aria-busy','true');
  if(hint)hint.textContent='Checking the clinic schedule…';
  try {
    const slots=await get(`/api/availability?doctorId=${encodeURIComponent(doctorId)}&serviceId=${encodeURIComponent(serviceId)}&date=${encodeURIComponent(date)}`);
    if(form.dataset.slotRequestVersion!==requestVersion)return;
    select.innerHTML=`<option value="">Choose an available time</option>${slots.map(slot=>`<option value="${esc(slot.time)}">${esc(slot.time)}</option>`).join('')}`;
    select.disabled=!slots.length;
    select.removeAttribute('aria-busy');
    if(list)list.innerHTML=slots.slice(0,12).map(slot=>`<button type="button" class="slot-chip" data-action="choose-slot" data-time="${esc(slot.time)}" aria-pressed="${slot.time===selectedTime}">${esc(slot.time)}</button>`).join('');
    if(slots.some(slot=>slot.time===selectedTime)) setSelectedBookingTime(form,selectedTime); else clearSelectedBookingTime(form);
    if(hint)hint.textContent=slots.length?`${slots.length} available appointment times.`:'This dentist may not offer that service, or has no open time on this day. Choose another dentist, service or date.';
  } catch(error){
    if(form.dataset.slotRequestVersion!==requestVersion)return;
    select.disabled=true;select.removeAttribute('aria-busy');
    if(hint)hint.textContent=error.message;
  }
}
async function updateRescheduleSlots(form) {
  const date=form.querySelector('[data-reschedule-date]')?.value, select=form.querySelector('[data-reschedule-time]');
  if(!date||!select)return;
  select.disabled=true;select.innerHTML='<option>Loading available times…</option>';
  try { const slots=await get(`/api/availability?doctorId=${encodeURIComponent(form.dataset.doctor)}&serviceId=${encodeURIComponent(form.dataset.service)}&date=${encodeURIComponent(date)}`);select.innerHTML=`<option value="">Choose a time</option>${slots.map(s=>`<option value="${esc(s.time)}">${esc(s.time)}</option>`).join('')}`;select.disabled=!slots.length;if(!slots.length)select.innerHTML='<option value="">No times available</option>'; }
  catch(error){select.innerHTML='<option value="">Could not load times</option>';statusError(error);}
}

document.addEventListener('click', async event => {
  const link=event.target.closest('a[href]');
  if(link && link.origin===location.origin && !link.target && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
    event.preventDefault();navigate(link.pathname+link.search+link.hash);return;
  }
  const action=event.target.closest('[data-action]');if(action)await onAction(action);
});
document.addEventListener('submit', event => {
  const form=event.target.closest('form[data-form]');if(!form)return;event.preventDefault();handleForm(form);
});
document.addEventListener('change', async event => {
  const booking=event.target.closest('[data-booking-control]');if(booking){const form=booking.closest('form');if(form){if(booking.name==='time')setSelectedBookingTime(form,booking.value);else updateBookingSlots(form);}}
  const reschedule=event.target.closest('[data-reschedule-date]');if(reschedule){const form=reschedule.closest('form');if(form)updateRescheduleSlots(form);}
  const filter=event.target.closest('[data-filter]');
  if(filter?.dataset.filter==='appointment-doctor'||filter?.dataset.filter==='appointment-service'||filter?.dataset.filter==='appointment-status')applyAppointmentFilter();
  if(filter?.dataset.filter==='enquiry-status'){const value=filter.value;navigate(`/admin?section=enquiries${value?`&status=${encodeURIComponent(value)}`:''}`);}
  const enquiry=event.target.closest('select[data-action="enquiry-status"]');if(enquiry){try{await patch(`/api/admin/enquiries/${enquiry.dataset.id}`,{status:enquiry.value});toast('Enquiry status updated.');}catch(error){statusError(error);}}
});
document.addEventListener('input', event => {
  const input=event.target.closest('[data-filter]');if(!input)return;
  if(input.dataset.filter==='appointment-q')applyAppointmentFilter();
  if(input.dataset.filter==='patient-q'){
    clearTimeout(filterTimer);filterTimer=setTimeout(()=>navigate(`/admin?section=patients&q=${encodeURIComponent(input.value)}`),420);
  }
});
function applyAppointmentFilter(){
  updateTablePages();
}
function appointmentMatches(row) {
  if (row.dataset.rowSearch === undefined) return true;
  const q=document.querySelector('[data-filter="appointment-q"]')?.value.trim().toLowerCase()||'', doctor=document.querySelector('[data-filter="appointment-doctor"]')?.value||'', service=document.querySelector('[data-filter="appointment-service"]')?.value||'', status=document.querySelector('[data-filter="appointment-status"]')?.value||'';
  return row.dataset.rowSearch.includes(q)&&(!doctor||row.dataset.doctor===doctor)&&(!service||row.dataset.service===service)&&(!status||row.dataset.status===status);
}
function setupTablePagination() {
  document.querySelectorAll('.table-wrap table').forEach((table,index)=>{
    const rows=[...table.querySelectorAll('tbody tr')];
    if(rows.length<=8)return;
    table.dataset.pageTable=String(index);
    const controls=document.createElement('div');controls.className='table-pagination';controls.dataset.pagination=String(index);
    controls.innerHTML=`<span data-page-summary></span><div><button class="small-button" data-action="page-prev" data-page-table="${index}" aria-label="Previous page">Previous</button><button class="small-button" data-action="page-next" data-page-table="${index}" aria-label="Next page">Next</button></div>`;
    table.closest('.table-wrap').after(controls);
  });
  updateTablePages();
}
function updateTablePages(table = null, selectedPage = null) {
  const tables=table?[table]:[...document.querySelectorAll('table[data-page-table]')];
  for(const current of tables){
    const pageSize=8, rows=[...current.querySelectorAll('tbody tr')], matching=rows.filter(appointmentMatches), pager=document.querySelector(`[data-pagination="${current.dataset.pageTable}"]`);
    if(!pager){for(const row of rows)row.hidden=!appointmentMatches(row);continue;}
    let page=Number(pager.dataset.page||0);if(selectedPage!==null&&current===table)page=selectedPage;
    const pageCount=Math.max(1,Math.ceil(matching.length/pageSize));page=Math.min(Math.max(0,page),pageCount-1);pager.dataset.page=String(page);
    rows.forEach(row=>{const index=matching.indexOf(row);row.hidden=index<page*pageSize||index>=(page+1)*pageSize;});
    const start=matching.length?page*pageSize+1:0,end=Math.min((page+1)*pageSize,matching.length);
    const summary=pager.querySelector('[data-page-summary]');if(summary)summary.textContent=`Showing ${start}–${end} of ${matching.length}`;
    pager.hidden=matching.length<=pageSize;
    const previous=pager.querySelector('[data-action="page-prev"]'),next=pager.querySelector('[data-action="page-next"]');if(previous)previous.disabled=page===0;if(next)next.disabled=page>=pageCount-1;
  }
}
document.addEventListener('keydown',event=>{
  const dialog=document.querySelector('[role="dialog"]');if(!dialog)return;
  if(event.key==='Escape'){closeModal();return;}
  if(event.key!=='Tab')return;
  const focusable=[...dialog.querySelectorAll('a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])')];
  if(!focusable.length){event.preventDefault();dialog.focus();return;}
  const first=focusable[0],last=focusable.at(-1);
  if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
  else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
});
window.addEventListener('popstate',render);

try { await refreshSession(); await render(); }
catch(error) { document.getElementById('app').innerHTML=errorPage();toast(error.message||'Could not connect to the clinic application.','error'); }
