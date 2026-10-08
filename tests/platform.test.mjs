import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const project = resolve(fileURLToPath(new URL('..', import.meta.url)));
let processRef, baseUrl, origin, scratch;

async function freePort() {
  const socket = createServer();
  await new Promise((ok, bad) => socket.once('error', bad).listen(0, '127.0.0.1', ok));
  const port = socket.address().port;
  await new Promise((ok, bad) => socket.close(error => error ? bad(error) : ok()));
  return port;
}
async function waitReady() {
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    try { const response = await fetch(`${baseUrl}/api/health`); if (response.ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
    if (processRef.exitCode !== null) throw new Error(`test server exited early with ${processRef.exitCode}`);
  }
  throw new Error('test server did not become ready');
}
async function raw(path, { method = 'GET', body, session, originHeader = true } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (originHeader) headers.origin = origin;
  if (session?.cookie) headers.cookie = session.cookie;
  if (session?.csrf && !['GET','HEAD'].includes(method)) headers['x-csrf-token'] = session.csrf;
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => null);
  return { response, data };
}
async function signIn(email, passwordText = 'SmileCareDemo!24') {
  const result = await raw('/api/auth/login', { method: 'POST', body: { email, password: passwordText } });
  assert.equal(result.response.status, 200, JSON.stringify(result.data));
  return { cookie: result.response.headers.get('set-cookie').split(';')[0], csrf: result.data.csrfToken, user: result.data.user };
}
async function clinicDateAfter(days) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map(p => [p.type,p.value]));
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  for (let add = days; add < 85; add++) {
    const point = new Date(Date.parse(`${today}T12:00:00.000Z`) + add * 86400000);
    if (point.getUTCDay() === 2) return point.toISOString().slice(0,10);
  }
  throw new Error('No test date found');
}

before(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'smilecare-tests-'));
  const port = await freePort(); baseUrl = `http://127.0.0.1:${port}`; origin = baseUrl;
  processRef = spawn(process.execPath, [join(project, 'server/index.mjs')], {
    cwd: project,
    env: { ...process.env, NODE_ENV: 'development', PORT: String(port), APP_ORIGIN: origin,
      DATABASE_PATH: join(scratch, 'test.sqlite'), CLINIC_TIMEZONE: 'Asia/Kolkata', SEED_DEMO_DATA: 'true' },
    stdio: ['ignore','ignore','pipe']
  });
  let stderr = '';
  processRef.stderr.setEncoding('utf8'); processRef.stderr.on('data', chunk => { stderr += chunk; });
  try { await waitReady(); } catch (error) { throw new Error(`${error.message}\n${stderr}`); }
});
after(async () => {
  if (processRef && processRef.exitCode === null) {
    processRef.kill('SIGTERM');
    await new Promise(resolve => { const timer = setTimeout(resolve, 2500); processRef.once('exit', () => { clearTimeout(timer); resolve(); }); });
  }
  // scratch is a unique temporary directory created by this test setup.
  if (scratch?.startsWith(join(tmpdir(), 'smilecare-tests-'))) rmSync(scratch, { recursive: true, force: true });
});

test('patients authenticate and cannot enter clinic administration APIs', async () => {
  const patient = await signIn('patient1@smilecare.demo');
  const profile = await raw('/api/patient/profile', { session: patient });
  assert.equal(profile.response.status, 200);
  assert.equal(profile.data.fullName, 'Aditi Sharma');
  const admin = await raw('/api/admin/metrics', { session: patient });
  assert.equal(admin.response.status, 403);
  const patients = await raw('/api/admin/patients', { session: patient });
  assert.equal(patients.response.status, 403);
});

test('reception has scheduling access but not super-admin staff management', async () => {
  const reception = await signIn('reception@smilecare.demo');
  const metrics = await raw('/api/admin/metrics', { session: reception });
  assert.equal(metrics.response.status, 200);
  const staff = await raw('/api/admin/staff', { session: reception });
  assert.equal(staff.response.status, 403);
  const createService = await raw('/api/admin/services', { method: 'POST', session: reception, body: { name:'Not allowed', description:'', durationMinutes:30 } });
  assert.equal(createService.response.status, 403);
});

test('doctor can see linked patient information but not unrelated records or admin routes', async () => {
  const patientA = await signIn('patient1@smilecare.demo'), patientB = await signIn('patient2@smilecare.demo');
  const doctor = await signIn('doctor3@smilecare.demo');
  const assigned = await raw('/api/doctor/appointments', { session: doctor });
  assert.equal(assigned.response.status, 200);
  assert.ok(assigned.data.some(row => row.patientId === patientA.user.id));
  const linked = await raw(`/api/doctor/patients/${patientA.user.id}`, { session: doctor });
  assert.equal(linked.response.status, 200);
  assert.equal(linked.data.fullName, 'Aditi Sharma');
  const unrelated = await raw(`/api/doctor/patients/${patientB.user.id}`, { session: doctor });
  assert.equal(unrelated.response.status, 404);
  const admin = await raw('/api/admin/metrics', { session: doctor });
  assert.equal(admin.response.status, 403);
});

test('booking prevents concurrent double booking and rejects invalid status transitions', async () => {
  const [patientA, patientB, superAdmin] = await Promise.all([
    signIn('patient1@smilecare.demo'), signIn('patient2@smilecare.demo'), signIn('admin@smilecare.demo')
  ]);
  const doctors = (await raw('/api/public/doctors')).data;
  const services = (await raw('/api/public/services')).data;
  const doctor = doctors.find(row => row.specialization === 'General Dentistry');
  const service = services.find(row => row.slug === 'dental-checkup');
  const date = await clinicDateAfter(3);
  const slots = await raw(`/api/availability?doctorId=${doctor.id}&serviceId=${service.id}&date=${date}`);
  assert.equal(slots.response.status, 200);
  assert.ok(slots.data.length > 1, 'selected weekday should have bookable times');
  const slot = slots.data[0];
  const requests = await Promise.all([
    raw('/api/patient/appointments', { method:'POST', session:patientA, body:{ doctorId:doctor.id, serviceId:service.id, date, time:slot.time, problem:'Routine checkup', consent:'on', submissionKey:'patient-a-booking-test-2026' } }),
    raw('/api/patient/appointments', { method:'POST', session:patientB, body:{ doctorId:doctor.id, serviceId:service.id, date, time:slot.time, problem:'Routine checkup', consent:'on', submissionKey:'patient-b-booking-test-2026' } })
  ]);
  assert.deepEqual(requests.map(item=>item.response.status).sort(), [201,409]);
  const createdIndex = requests.findIndex(item => item.response.status === 201);
  const created = requests[createdIndex].data;
  assert.equal(created.status, 'PENDING');
  assert.equal(created.problem, 'Routine checkup');
  const winningSession = createdIndex === 0 ? patientA : patientB;
  const winningKey = createdIndex === 0 ? 'patient-a-booking-test-2026' : 'patient-b-booking-test-2026';
  const retry = await raw('/api/patient/appointments', { method:'POST', session:winningSession, body:{ doctorId:doctor.id, serviceId:service.id, date, time:slot.time, problem:'Routine checkup', consent:'on', submissionKey:winningKey } });
  assert.equal(retry.response.status, 201);
  assert.equal(retry.data.id, created.id);
  const invalid = await raw(`/api/admin/appointments/${created.id}`, { method:'PATCH', session:superAdmin, body:{status:'COMPLETED'} });
  assert.equal(invalid.response.status, 409);
  const confirmed = await raw(`/api/admin/appointments/${created.id}`, { method:'PATCH', session:superAdmin, body:{status:'CONFIRMED'} });
  assert.equal(confirmed.response.status, 200);
  assert.equal(confirmed.data.status, 'CONFIRMED');
  const completed = await raw(`/api/admin/appointments/${created.id}`, { method:'PATCH', session:superAdmin, body:{status:'COMPLETED'} });
  assert.equal(completed.response.status, 200);
  const terminal = await raw(`/api/admin/appointments/${created.id}`, { method:'PATCH', session:superAdmin, body:{status:'NO_SHOW'} });
  assert.equal(terminal.response.status, 409);
});

test('registration uses a patient-only role and development password reset is single-use', async () => {
  const registered = await raw('/api/auth/register', { method:'POST', body:{ fullName:'Demo New Patient', email:'new.patient@example.invalid', phone:'9000000999', password:'NewPatientPass!24' } });
  assert.equal(registered.response.status, 201);
  assert.equal(registered.data.user.role, 'PATIENT');
  const wrong = await raw('/api/auth/login', { method:'POST', body:{ email:'new.patient@example.invalid', password:'incorrect' } });
  assert.equal(wrong.response.status, 401);
  const request = await raw('/api/auth/forgot-password', { method:'POST', body:{ email:'new.patient@example.invalid' } });
  assert.equal(request.response.status, 200);
  assert.ok(request.data.developmentResetUrl);
  const token = new URL(request.data.developmentResetUrl).searchParams.get('token');
  const reset = await raw('/api/auth/reset-password', { method:'POST', body:{ token, password:'ChangedPatientPass!24' } });
  assert.equal(reset.response.status, 200);
  const reused = await raw('/api/auth/reset-password', { method:'POST', body:{ token, password:'AnotherPassword!24' } });
  assert.equal(reused.response.status, 400);
  const signedIn = await raw('/api/auth/login', { method:'POST', body:{ email:'new.patient@example.invalid', password:'ChangedPatientPass!24' } });
  assert.equal(signedIn.response.status, 200);
});

test('production mode refuses to start without a provisioned super admin and does not seed demo accounts', async () => {
  const productionDb = join(scratch, 'production.sqlite');
  const child = spawn(process.execPath, [join(project, 'server/index.mjs')], {
    cwd: project,
    env: { ...process.env, NODE_ENV: 'production', PORT: '0', APP_ORIGIN: 'https://clinic.example.invalid',
      DATABASE_PATH: productionDb, SEED_DEMO_DATA: 'true', INITIAL_SUPER_ADMIN_EMAIL: '', INITIAL_SUPER_ADMIN_PASSWORD: '' },
    stdio: ['ignore','ignore','pipe']
  });
  let stderr = '';
  child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
  const exit = await new Promise(resolve => child.once('exit', (code, signal) => resolve({code,signal})));
  assert.notEqual(exit.code, 0);
  assert.match(stderr, /requires INITIAL_SUPER_ADMIN_EMAIL and INITIAL_SUPER_ADMIN_PASSWORD/);
  const prod = new DatabaseSync(productionDb);
  assert.equal(prod.prepare('SELECT count(*) AS count FROM users').get().count, 0);
  prod.close();
});

test('public routes return page-specific SEO metadata, sitemap, and hardened headers', async () => {
  const pages = [
    ['/', 'SmileCare Dental Clinic | Thoughtful dental care'], ['/about', 'Our Clinic | SmileCare Dental Clinic'],
    ['/doctors', 'Our Dentists | SmileCare Dental Clinic'], ['/treatments', 'Dental Treatments | SmileCare Dental Clinic'],
    ['/gallery', 'Clinic Gallery | SmileCare Dental Clinic'], ['/faq', 'FAQs | SmileCare Dental Clinic'],
    ['/contact', 'Contact Us | SmileCare Dental Clinic']
  ];
  for (const [path, title] of pages) {
    const response = await fetch(`${baseUrl}${path}`), html = await response.text();
    assert.equal(response.status, 200, path);
    assert.ok(html.includes(`<title>${title}</title>`), `missing page title for ${path}`);
    assert.ok(html.includes('name="description"'), `missing description for ${path}`);
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.match(response.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  }
  const sitemap = await (await fetch(`${baseUrl}/sitemap.xml`)).text();
  assert.ok(sitemap.includes(`${baseUrl}/treatments`));
  const robots = await (await fetch(`${baseUrl}/robots.txt`)).text();
  assert.ok(robots.includes(`Sitemap: ${baseUrl}/sitemap.xml`));
});
