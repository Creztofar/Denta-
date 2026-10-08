import { randomBytes } from 'node:crypto';
import { db, emitEvent, hashPassword, nowIso, sha256, uuid, verifyPassword } from './db.mjs';
import { ACTIVE_STATUSES, appointmentSelect, assertTransition, clinicDate, clinicDayBounds, createAppointment, getAvailability, inTransaction, slotIsAvailable } from './appointments.mjs';
import { audit, clearSessionCookie, createSession, fail, getSession, json, readJson, requireCsrf, requireRole, requireUser, verifyMutationOrigin } from './security.mjs';
import { date, email, enumValue, integer, password, phone, string, time } from './validation.mjs';

const STAFF = ['SUPER_ADMIN', 'ADMIN', 'RECEPTIONIST'];
const ADMIN = ['SUPER_ADMIN', 'ADMIN'];
const ALL_APPOINTMENT_STATUSES = ['PENDING', 'CONFIRMED', 'RESCHEDULED', 'CANCELLED', 'COMPLETED', 'NO_SHOW'];
const authAttempts = new Map();
const set = (sql, ...args) => db.prepare(sql).run(...args);
const one = (sql, ...args) => db.prepare(sql).get(...args);
const many = (sql, ...args) => db.prepare(sql).all(...args);
const publicUser = session => ({ id: session.id, email: session.email, role: session.role, fullName: session.full_name, phone: session.phone || '' });
const contentTables = {
  faq: { table: 'faqs', fields: ['question', 'answer', 'sort_order'], required: ['question', 'answer'] },
  testimonial: { table: 'testimonials', fields: ['patient_name', 'rating', 'review', 'category'], required: ['patient_name', 'rating', 'review'] },
  gallery: { table: 'gallery_items', fields: ['title', 'description', 'image_url', 'alt_text'], required: ['title', 'image_url', 'alt_text'] }
};

function throttle(req, key, limit = 15, windowMs = 10 * 60 * 1000) {
  const ip = req.socket.remoteAddress || 'unknown', now = Date.now(), mapKey = `${ip}:${key}`;
  const prior = authAttempts.get(mapKey) || { since: now, count: 0 };
  if (now - prior.since > windowMs) { prior.since = now; prior.count = 0; }
  prior.count++;
  authAttempts.set(mapKey, prior);
  if (prior.count > limit) throw fail(429, 'RATE_LIMITED', 'Too many requests. Wait a few minutes and try again.');
}
function recordStatus(actorId, appointment, nextStatus, newSlot = null) {
  assertTransition(appointment.status, nextStatus);
  if (newSlot) {
    set(`UPDATE appointments SET starts_at=?,ends_at=?,status='RESCHEDULED',updated_at=? WHERE id=?`, newSlot.startsAt, newSlot.endsAt, nowIso(), appointment.id);
    set('INSERT INTO audit_logs(id,actor_user_id,action,resource_type,resource_id,created_at) VALUES (?,?,?,?,?,?)', uuid(), actorId, 'appointment.rescheduled', 'appointment', appointment.id, nowIso());
    emitEvent('appointment.rescheduled', appointment.id, { previousStart: appointment.starts_at, startsAt: newSlot.startsAt });
    return;
  }
  set('UPDATE appointments SET status=?,updated_at=? WHERE id=?', nextStatus, nowIso(), appointment.id);
  set('INSERT INTO audit_logs(id,actor_user_id,action,resource_type,resource_id,created_at) VALUES (?,?,?,?,?,?)', uuid(), actorId, `appointment.${nextStatus.toLowerCase()}`, 'appointment', appointment.id, nowIso());
  emitEvent(`appointment.${nextStatus.toLowerCase()}`, appointment.id, { appointmentId: appointment.id, status: nextStatus });
}
function getAppointment(id) { return one(appointmentSelect + ' WHERE a.id=?', id); }
function setSessionResponse(req, res, userId) {
  const session = createSession(userId, res);
  const who = one(`SELECT u.id,u.email,u.role,COALESCE(p.full_name,d.full_name,'') AS full_name,p.phone
    FROM users u LEFT JOIN patients p ON p.user_id=u.id LEFT JOIN doctors d ON d.user_id=u.id WHERE u.id=?`, userId);
  return { authenticated: true, user: publicUser(who), csrfToken: session.csrfToken, expiresAt: session.expiresAt };
}
function patientOnly(session) { return requireRole(session, ['PATIENT']); }
function submissionKey(value) {
  const key = string(value, 'Submission key', { min: 16, max: 100 });
  if (!/^[A-Za-z0-9_-]+$/.test(key)) throw fail(400, 'VALIDATION_ERROR', 'The appointment submission could not be verified. Refresh the page and try again.');
  return key;
}
function contentRow(kind, body, id = null) {
  const config = contentTables[kind];
  if (!config) throw fail(404, 'NOT_FOUND', 'That content type was not found.');
  const values = {};
  for (const key of config.fields) {
    if (key === 'rating' || key === 'sort_order') {
      if (body[key] !== undefined) values[key] = integer(body[key], key, { min: 0, max: key === 'rating' ? 5 : 10000 });
    } else if (body[key] !== undefined) values[key] = string(body[key], key, { max: key === 'answer' || key === 'review' || key === 'description' ? 3000 : 500 });
  }
  if (!id) for (const required of config.required) if (values[required] === undefined || values[required] === '') throw fail(400, 'VALIDATION_ERROR', `${required} is required.`);
  if (kind === 'testimonial' && values.rating !== undefined && values.rating < 1) throw fail(400, 'VALIDATION_ERROR', 'Rating must be from 1 to 5.');
  return { config, values };
}

export async function handleApi(req, res, url) {
  const path = url.pathname;
  const method = req.method || 'GET';
  const publicAuthRoute = ['/api/auth/login', '/api/auth/register', '/api/auth/forgot-password', '/api/auth/reset-password'].includes(path);
  let session = getSession(req);
  if (method !== 'GET') {
    verifyMutationOrigin(req);
    if (!publicAuthRoute) requireCsrf(req, session);
  }
  const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? await readJson(req) : {};

  if (method === 'GET' && path === '/api/health') return json(res, 200, { status: 'ok', time: nowIso() });
  if (method === 'GET' && path === '/api/auth/session') {
    if (!session) return json(res, 200, { authenticated: false });
    return json(res, 200, { authenticated: true, user: publicUser(session), csrfToken: session.csrf_token, expiresAt: session.expires_at });
  }
  if (method === 'POST' && path === '/api/auth/register') {
    throttle(req, 'register', 6);
    const fullName = string(body.fullName, 'Name', { max: 120 }), userEmail = email(body.email), userPassword = password(body.password);
    const phoneNumber = phone(body.phone || '', { optional: true });
    if (one('SELECT id FROM users WHERE email=?', userEmail)) throw fail(409, 'EMAIL_IN_USE', 'An account with that email already exists.');
    const id = uuid(), stamp = nowIso(), hash = await hashPassword(userPassword);
    inTransaction(() => {
      set('INSERT INTO users(id,email,password_hash,role,active,created_at,updated_at) VALUES (?,?,?,\'PATIENT\',1,?,?)', id, userEmail, hash, stamp, stamp);
      set('INSERT INTO patients(user_id,full_name,phone,created_at) VALUES (?,?,?,?)', id, fullName, phoneNumber, stamp);
      audit(id, 'patient.registered', 'patient', id);
    });
    session = setSessionResponse(req, res, id);
    return json(res, 201, session);
  }
  if (method === 'POST' && path === '/api/auth/login') {
    throttle(req, 'login', 12);
    const userEmail = email(body.email), userPassword = typeof body.password === 'string' ? body.password : '';
    const account = one('SELECT id,email,password_hash,role,active FROM users WHERE email=?', userEmail);
    const valid = await verifyPassword(userPassword, account?.password_hash || '');
    if (!account || !valid || account.active !== 1) throw fail(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    session = setSessionResponse(req, res, account.id);
    return json(res, 200, session);
  }
  if (method === 'POST' && path === '/api/auth/logout') {
    if (session) set('DELETE FROM sessions WHERE token_hash=?', session.token_hash);
    clearSessionCookie(res);
    return json(res, 200, { authenticated: false });
  }
  if (method === 'POST' && path === '/api/auth/forgot-password') {
    throttle(req, 'forgot-password', 5);
    const userEmail = email(body.email);
    const account = one('SELECT id FROM users WHERE email=? AND active=1', userEmail);
    if (process.env.NODE_ENV === 'production') {
      // A real delivery channel is intentionally not configured in this project.
      return json(res, 503, { error: { code: 'RESET_DELIVERY_UNAVAILABLE', message: 'Password reset email is not configured. Contact the clinic to reset your account.' } });
    }
    if (!account) return json(res, 200, { message: 'If that account exists, a reset link is ready.' });
    const token = randomBytes(32).toString('base64url'), expires = new Date(Date.now() + Number(process.env.RESET_TOKEN_TTL_MINUTES || 30) * 60000).toISOString();
    set('DELETE FROM password_reset_tokens WHERE user_id=? AND used_at IS NULL', account.id);
    set('INSERT INTO password_reset_tokens(token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)', sha256(token), account.id, expires, nowIso());
    const resetUrl = new URL('/reset-password', process.env.APP_ORIGIN || `http://${req.headers.host || 'localhost:3000'}`);
    resetUrl.searchParams.set('token', token);
    return json(res, 200, { message: 'Reset link created for this local development build.', developmentResetUrl: resetUrl.toString(), expiresAt: expires });
  }
  if (method === 'POST' && path === '/api/auth/reset-password') {
    throttle(req, 'reset-password', 8);
    const token = string(body.token, 'Reset token', { max: 200 }), newPassword = password(body.password);
    const reset = one('SELECT token_hash,user_id,expires_at,used_at FROM password_reset_tokens WHERE token_hash=?', sha256(token));
    if (!reset || reset.used_at || reset.expires_at <= nowIso()) throw fail(400, 'RESET_TOKEN_INVALID', 'This reset link is invalid or expired. Request a new one.');
    const hash = await hashPassword(newPassword), stamp = nowIso();
    inTransaction(() => {
      set('UPDATE users SET password_hash=?,updated_at=? WHERE id=?', hash, stamp, reset.user_id);
      set('UPDATE password_reset_tokens SET used_at=? WHERE token_hash=?', stamp, reset.token_hash);
      set('DELETE FROM sessions WHERE user_id=?', reset.user_id);
      audit(reset.user_id, 'auth.password_reset', 'user', reset.user_id);
    });
    clearSessionCookie(res);
    return json(res, 200, { message: 'Password updated. Sign in with your new password.' });
  }
  if (method === 'POST' && path === '/api/auth/change-password') {
    requireUser(session);
    const current = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    const next = password(body.newPassword);
    const user = one('SELECT password_hash FROM users WHERE id=?', session.id);
    if (!await verifyPassword(current, user.password_hash)) throw fail(400, 'CURRENT_PASSWORD_INVALID', 'Current password is incorrect.');
    const hash = await hashPassword(next);
    inTransaction(() => {
      set('UPDATE users SET password_hash=?,updated_at=? WHERE id=?', hash, nowIso(), session.id);
      set('DELETE FROM sessions WHERE user_id=? AND token_hash<>?', session.id, session.token_hash);
      audit(session.id, 'auth.password_changed', 'user', session.id);
    });
    return json(res, 200, { message: 'Password changed.' });
  }

  if (method === 'GET' && path === '/api/public/services') return json(res, 200, many('SELECT id,name,slug,description,duration_minutes AS durationMinutes,price_cents AS priceCents FROM services WHERE active=1 ORDER BY name'));
  if (method === 'GET' && path === '/api/public/doctors') return json(res, 200, many(`SELECT d.user_id AS id,d.full_name AS fullName,d.qualification,d.specialization,d.experience_years AS experienceYears,d.bio,d.photo_url AS photoUrl,
    (SELECT group_concat(DISTINCT da.weekday) FROM doctor_availability da WHERE da.doctor_id=d.user_id) AS availableDays,
    (SELECT group_concat(DISTINCT ds.service_id) FROM doctor_services ds WHERE ds.doctor_id=d.user_id) AS serviceIds
    FROM doctors d JOIN users u ON u.id=d.user_id WHERE d.active=1 AND u.active=1 ORDER BY d.full_name`));
  if (method === 'GET' && path === '/api/public/testimonials') return json(res, 200, many('SELECT id,patient_name AS patientName,rating,review,category FROM testimonials WHERE active=1 ORDER BY rowid DESC'));
  if (method === 'GET' && path === '/api/public/gallery') return json(res, 200, many('SELECT id,title,description,image_url AS imageUrl,alt_text AS altText FROM gallery_items WHERE active=1 ORDER BY rowid DESC'));
  if (method === 'GET' && path === '/api/public/faqs') return json(res, 200, many('SELECT id,question,answer FROM faqs WHERE active=1 ORDER BY sort_order,rowid'));
  if (method === 'POST' && path === '/api/public/enquiries') {
    throttle(req, 'enquiry', 8);
    const name = string(body.name, 'Name', { max: 120 }), contactEmail = email(body.email), phoneNumber = phone(body.phone || '', { optional: true });
    const subject = string(body.subject || 'General enquiry', 'Subject', { max: 160 }), message = string(body.message, 'Message', { max: 3000 });
    const id = uuid(), stamp = nowIso();
    set('INSERT INTO enquiries(id,name,email,phone,subject,message,status,created_at,updated_at) VALUES (?,?,?,?,?,?,\'NEW\',?,?)', id, name, contactEmail, phoneNumber, subject, message, stamp, stamp);
    emitEvent('enquiry.created', id, { enquiryId: id });
    return json(res, 201, { id, message: 'Your enquiry has been received. The clinic team will follow up.' });
  }
  if (method === 'GET' && path === '/api/availability') {
    const doctorId = string(url.searchParams.get('doctorId'), 'Doctor', { max: 60 }), serviceId = string(url.searchParams.get('serviceId'), 'Service', { max: 60 });
    const requestedDate = date(url.searchParams.get('date'));
    const today = clinicDate();
    if (requestedDate < today || requestedDate > new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10)) return json(res, 200, []);
    return json(res, 200, getAvailability(doctorId, serviceId, requestedDate));
  }

  if (method === 'GET' && path === '/api/patient/profile') {
    const user = patientOnly(session);
    return json(res, 200, one(`SELECT u.email,p.full_name AS fullName,p.phone,p.date_of_birth AS dateOfBirth
      FROM users u JOIN patients p ON p.user_id=u.id WHERE u.id=?`, user.id));
  }
  if (method === 'PATCH' && path === '/api/patient/profile') {
    const user = patientOnly(session);
    const name = string(body.fullName, 'Name', { max: 120 }), phoneNumber = phone(body.phone || '', { optional: true });
    const dob = body.dateOfBirth ? date(body.dateOfBirth, 'Date of birth') : null;
    set('UPDATE patients SET full_name=?,phone=?,date_of_birth=? WHERE user_id=?', name, phoneNumber, dob, user.id);
    set('UPDATE users SET updated_at=? WHERE id=?', nowIso(), user.id);
    audit(user.id, 'patient.profile_updated', 'patient', user.id);
    return json(res, 200, one('SELECT full_name AS fullName,phone,date_of_birth AS dateOfBirth FROM patients WHERE user_id=?', user.id));
  }
  if (method === 'GET' && path === '/api/patient/appointments') {
    const user = patientOnly(session);
    const scope = url.searchParams.get('scope');
    const where = scope === 'upcoming' ? `AND a.starts_at>=? AND a.status IN ('PENDING','CONFIRMED','RESCHEDULED')` : '';
    const args = scope === 'upcoming' ? [user.id, nowIso()] : [user.id];
    return json(res, 200, many(appointmentSelect + ` WHERE a.patient_id=? ${where} ORDER BY a.starts_at DESC`, ...args));
  }
  if (method === 'POST' && path === '/api/patient/appointments') {
    throttle(req, 'appointment', 10);
    const user = patientOnly(session);
    const doctorId = string(body.doctorId, 'Doctor', { max: 60 }), serviceId = string(body.serviceId, 'Service', { max: 60 });
    const requestedDate = date(body.date), requestedTime = time(body.time);
    if (body.consent !== 'on' && body.consent !== true) throw fail(400, 'CONSENT_REQUIRED', 'Please confirm that the clinic may contact you about this request.');
    const profile = one('SELECT p.full_name,u.email,p.phone FROM patients p JOIN users u ON u.id=p.user_id WHERE p.user_id=?', user.id);
    if (!profile?.full_name || !profile?.email || !phone(profile.phone || '', { optional: true })) {
      throw fail(400, 'CONTACT_DETAILS_REQUIRED', 'Add a valid phone number to your profile before requesting an appointment.');
    }
    const appointment = createAppointment({
      patientId: user.id, doctorId, serviceId, date: requestedDate, time: requestedTime,
      problem: string(body.problem || '', 'Appointment note', { max: 2000, optional: true }), submissionKey: submissionKey(body.submissionKey)
    });
    return json(res, 201, appointment);
  }
  const patientAction = path.match(/^\/api\/patient\/appointments\/([0-9a-f-]+)\/(cancel|reschedule)$/i);
  if (method === 'POST' && patientAction) {
    const user = patientOnly(session), appointment = one('SELECT * FROM appointments WHERE id=? AND patient_id=?', patientAction[1], user.id);
    if (!appointment) throw fail(404, 'NOT_FOUND', 'Appointment not found.');
    if (patientAction[2] === 'cancel') {
      assertTransition(appointment.status, 'CANCELLED');
      recordStatus(user.id, appointment, 'CANCELLED');
      return json(res, 200, getAppointment(appointment.id));
    }
    const requestedDate = date(body.date), requestedTime = time(body.time);
    assertTransition(appointment.status, 'RESCHEDULED');
    const slot = slotIsAvailable({ doctorId: appointment.doctor_id, serviceId: appointment.service_id, date: requestedDate, time: requestedTime, excludeAppointmentId: appointment.id });
    if (!slot) throw fail(409, 'SLOT_UNAVAILABLE', 'That time is no longer available. Choose another slot.');
    recordStatus(user.id, appointment, 'RESCHEDULED', slot);
    return json(res, 200, getAppointment(appointment.id));
  }

  if (method === 'GET' && path === '/api/doctor/appointments') {
    const doctor = requireRole(session, ['DOCTOR']);
    const start = url.searchParams.get('from'), end = url.searchParams.get('to');
    const parts = ['a.doctor_id=?']; const args = [doctor.id];
    if (start) { parts.push('a.starts_at>=?'); args.push(clinicDayBounds(date(start)).start); }
    if (end) { parts.push('a.starts_at<?'); args.push(clinicDayBounds(date(end)).end); }
    return json(res, 200, many(appointmentSelect + ` WHERE ${parts.join(' AND ')} ORDER BY a.starts_at`, ...args));
  }
  if (method === 'GET' && path === '/api/doctor/availability') {
    const doctor = requireRole(session, ['DOCTOR']);
    return json(res, 200, many('SELECT id,weekday,start_time AS startTime,end_time AS endTime,break_start AS breakStart,break_end AS breakEnd,slot_minutes AS slotMinutes FROM doctor_availability WHERE doctor_id=? ORDER BY weekday', doctor.id));
  }
  const doctorPatient = path.match(/^\/api\/doctor\/patients\/([0-9a-f-]+)$/i);
  if (method === 'GET' && doctorPatient) {
    const doctor = requireRole(session, ['DOCTOR']), patientId = doctorPatient[1];
    if (!one('SELECT 1 FROM appointments WHERE doctor_id=? AND patient_id=? LIMIT 1', doctor.id, patientId)) throw fail(404, 'NOT_FOUND', 'Patient not found.');
    const patient = one('SELECT full_name AS fullName,phone FROM patients WHERE user_id=?', patientId);
    if (!patient) throw fail(404, 'NOT_FOUND', 'Patient not found.');
    const appointments = many(appointmentSelect + ' WHERE a.doctor_id=? AND a.patient_id=? ORDER BY a.starts_at DESC', doctor.id, patientId);
    return json(res, 200, { ...patient, appointments });
  }
  const doctorAppointment = path.match(/^\/api\/doctor\/appointments\/([0-9a-f-]+)$/i);
  if (method === 'PATCH' && doctorAppointment) {
    const doctor = requireRole(session, ['DOCTOR']), appointment = one('SELECT * FROM appointments WHERE id=? AND doctor_id=?', doctorAppointment[1], doctor.id);
    if (!appointment) throw fail(404, 'NOT_FOUND', 'Appointment not found.');
    const status = enumValue(body.status, ['COMPLETED', 'NO_SHOW'], 'Status');
    recordStatus(doctor.id, appointment, status);
    return json(res, 200, getAppointment(appointment.id));
  }

  if (method === 'GET' && path === '/api/admin/metrics') {
    requireRole(session, STAFF);
    const today = clinicDate(), bounds = clinicDayBounds(today);
    const count = (sql, ...args) => one(sql, ...args).count;
    return json(res, 200, {
      patients: count("SELECT count(*) AS count FROM patients p JOIN users u ON u.id=p.user_id WHERE u.active=1"),
      doctors: count("SELECT count(*) AS count FROM doctors d JOIN users u ON u.id=d.user_id WHERE d.active=1 AND u.active=1"),
      today: count('SELECT count(*) AS count FROM appointments WHERE starts_at>=? AND starts_at<?', bounds.start, bounds.end),
      pending: count("SELECT count(*) AS count FROM appointments WHERE status='PENDING'"),
      confirmed: count("SELECT count(*) AS count FROM appointments WHERE status='CONFIRMED'"),
      completed: count("SELECT count(*) AS count FROM appointments WHERE status='COMPLETED'"),
      cancelled: count("SELECT count(*) AS count FROM appointments WHERE status='CANCELLED'"),
      noShow: count("SELECT count(*) AS count FROM appointments WHERE status='NO_SHOW'"),
      enquiries: count("SELECT count(*) AS count FROM enquiries WHERE status='NEW'")
    });
  }
  if (method === 'GET' && path === '/api/admin/appointments') {
    requireRole(session, STAFF);
    const filters = [], args = [];
    for (const [key, column] of [['doctorId', 'a.doctor_id'], ['serviceId', 'a.service_id'], ['status', 'a.status']]) {
      const value = url.searchParams.get(key); if (value) { filters.push(`${column}=?`); args.push(value); }
    }
    const from = url.searchParams.get('from'), to = url.searchParams.get('to'), search = url.searchParams.get('q');
    if (from) { filters.push('a.starts_at>=?'); args.push(clinicDayBounds(date(from)).start); }
    if (to) { filters.push('a.starts_at<?'); args.push(clinicDayBounds(date(to)).end); }
    if (search) { filters.push('(p.full_name LIKE ? OR a.reference LIKE ?)'); args.push(`%${search.slice(0, 80)}%`, `%${search.slice(0, 80)}%`); }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    return json(res, 200, many(appointmentSelect + ` ${where} ORDER BY a.starts_at DESC LIMIT 300`, ...args));
  }
  if (method === 'POST' && path === '/api/admin/appointments') {
    const staff = requireRole(session, STAFF);
    const patientId = string(body.patientId, 'Patient', { max: 60 }), doctorId = string(body.doctorId, 'Doctor', { max: 60 });
    const serviceId = string(body.serviceId, 'Service', { max: 60 });
    const appointment = createAppointment({ patientId, doctorId, serviceId, date: date(body.date), time: time(body.time), actorId: staff.id });
    return json(res, 201, appointment);
  }
  const adminAppointment = path.match(/^\/api\/admin\/appointments\/([0-9a-f-]+)$/i);
  if (method === 'PATCH' && adminAppointment) {
    const staff = requireRole(session, STAFF), appointment = one('SELECT * FROM appointments WHERE id=?', adminAppointment[1]);
    if (!appointment) throw fail(404, 'NOT_FOUND', 'Appointment not found.');
    if (body.date || body.time) {
      const requestedDate = date(body.date), requestedTime = time(body.time);
      assertTransition(appointment.status, 'RESCHEDULED');
      const slot = slotIsAvailable({ doctorId: appointment.doctor_id, serviceId: appointment.service_id, date: requestedDate, time: requestedTime, excludeAppointmentId: appointment.id });
      if (!slot) throw fail(409, 'SLOT_UNAVAILABLE', 'That time is no longer available. Choose another slot.');
      recordStatus(staff.id, appointment, 'RESCHEDULED', slot);
    } else {
      const status = enumValue(body.status, ALL_APPOINTMENT_STATUSES, 'Status');
      recordStatus(staff.id, appointment, status);
    }
    return json(res, 200, getAppointment(appointment.id));
  }
  if (method === 'GET' && path === '/api/admin/patients') {
    requireRole(session, STAFF);
    const q = (url.searchParams.get('q') || '').slice(0, 80), active = url.searchParams.get('active');
    const filters = [], args = [];
    if (q) { filters.push('(p.full_name LIKE ? OR u.email LIKE ? OR p.phone LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    if (active === 'true' || active === 'false') { filters.push('u.active=?'); args.push(active === 'true' ? 1 : 0); }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    return json(res, 200, many(`SELECT u.id,u.email,u.active,p.full_name AS fullName,p.phone,p.date_of_birth AS dateOfBirth,p.created_at AS createdAt
      FROM patients p JOIN users u ON u.id=p.user_id ${where} ORDER BY p.created_at DESC LIMIT 300`, ...args));
  }
  if (method === 'POST' && path === '/api/admin/patients') {
    const staff = requireRole(session, STAFF), name = string(body.fullName, 'Name', { max: 120 }), userEmail = email(body.email);
    const phoneNumber = phone(body.phone || '', { optional: true }), pass = password(body.password);
    if (one('SELECT id FROM users WHERE email=?', userEmail)) throw fail(409, 'EMAIL_IN_USE', 'An account with that email already exists.');
    const id = uuid(), stamp = nowIso(), hash = await hashPassword(pass);
    inTransaction(() => {
      set('INSERT INTO users(id,email,password_hash,role,active,created_at,updated_at) VALUES (?,?,?,\'PATIENT\',1,?,?)', id, userEmail, hash, stamp, stamp);
      set('INSERT INTO patients(user_id,full_name,phone,created_at) VALUES (?,?,?,?)', id, name, phoneNumber, stamp);
      audit(staff.id, 'patient.created_by_staff', 'patient', id);
    });
    return json(res, 201, { id, email: userEmail, fullName: name });
  }
  const patientActive = path.match(/^\/api\/admin\/patients\/([0-9a-f-]+)$/i);
  if (method === 'PATCH' && patientActive) {
    const admin = requireRole(session, ADMIN), patientId = patientActive[1];
    const active = body.active;
    if (typeof active !== 'boolean' || !one('SELECT id FROM users WHERE id=? AND role=\'PATIENT\'', patientId)) throw fail(400, 'VALIDATION_ERROR', 'Patient status is invalid.');
    set('UPDATE users SET active=?,updated_at=? WHERE id=?', active ? 1 : 0, nowIso(), patientId);
    if (!active) set('DELETE FROM sessions WHERE user_id=?', patientId);
    audit(admin.id, active ? 'patient.activated' : 'patient.deactivated', 'patient', patientId);
    return json(res, 200, { id: patientId, active });
  }

  if (method === 'GET' && path === '/api/admin/doctors') {
    requireRole(session, STAFF);
    return json(res, 200, many(`SELECT d.user_id AS id,u.email,u.active,d.full_name AS fullName,d.qualification,d.specialization,
      d.experience_years AS experienceYears,d.bio,d.photo_url AS photoUrl,
      (SELECT group_concat(service_id,',') FROM doctor_services WHERE doctor_id=d.user_id) AS serviceIds
      FROM doctors d JOIN users u ON u.id=d.user_id ORDER BY d.full_name`));
  }
  if (method === 'POST' && path === '/api/admin/doctors') {
    const admin = requireRole(session, ADMIN), userEmail = email(body.email), pass = password(body.password);
    const fullName = string(body.fullName, 'Name', { max: 120 }), qualification = string(body.qualification, 'Qualification', { max: 120 });
    const specialization = string(body.specialization, 'Specialization', { max: 120 }), bio = string(body.bio || '', 'Biography', { max: 1000, optional: true });
    const experience = integer(body.experienceYears, 'Experience', { max: 70 });
    if (one('SELECT id FROM users WHERE email=?', userEmail)) throw fail(409, 'EMAIL_IN_USE', 'An account with that email already exists.');
    const id = uuid(), stamp = nowIso(), hash = await hashPassword(pass), serviceIds = Array.isArray(body.serviceIds) ? body.serviceIds : [];
    inTransaction(() => {
      set('INSERT INTO users(id,email,password_hash,role,active,created_at,updated_at) VALUES (?,?,?,\'DOCTOR\',1,?,?)', id, userEmail, hash, stamp, stamp);
      set('INSERT INTO doctors(user_id,full_name,qualification,specialization,experience_years,bio) VALUES (?,?,?,?,?,?)', id, fullName, qualification, specialization, experience, bio);
      for (const serviceId of serviceIds) if (one('SELECT id FROM services WHERE id=?', serviceId)) set('INSERT OR IGNORE INTO doctor_services(doctor_id,service_id) VALUES (?,?)', id, serviceId);
      for (let weekday = 1; weekday <= 5; weekday++) set('INSERT INTO doctor_availability(id,doctor_id,weekday,start_time,end_time,break_start,break_end,slot_minutes) VALUES (?,?,?,\'09:00\',\'17:00\',\'13:00\',\'14:00\',30)', uuid(), id, weekday);
      audit(admin.id, 'doctor.created', 'doctor', id);
    });
    return json(res, 201, { id, email: userEmail, fullName });
  }
  const doctorAdmin = path.match(/^\/api\/admin\/doctors\/([0-9a-f-]+)$/i);
  if (method === 'PATCH' && doctorAdmin) {
    const admin = requireRole(session, ADMIN), id = doctorAdmin[1], doctor = one('SELECT * FROM doctors WHERE user_id=?', id);
    if (!doctor) throw fail(404, 'NOT_FOUND', 'Doctor not found.');
    if (body.active !== undefined) {
      if (typeof body.active !== 'boolean') throw fail(400, 'VALIDATION_ERROR', 'Active must be true or false.');
      set('UPDATE doctors SET active=? WHERE user_id=?', body.active ? 1 : 0, id);
      set('UPDATE users SET active=?,updated_at=? WHERE id=?', body.active ? 1 : 0, nowIso(), id);
      if (!body.active) set('DELETE FROM sessions WHERE user_id=?', id);
    }
    const fields = { fullName: ['full_name', 120], qualification: ['qualification', 120], specialization: ['specialization', 120], bio: ['bio', 1000] };
    for (const [key, [column, max]] of Object.entries(fields)) if (body[key] !== undefined) set(`UPDATE doctors SET ${column}=? WHERE user_id=?`, string(body[key], key, { max }), id);
    if (body.experienceYears !== undefined) set('UPDATE doctors SET experience_years=? WHERE user_id=?', integer(body.experienceYears, 'Experience', { max: 70 }), id);
    if (Array.isArray(body.serviceIds)) {
      inTransaction(() => {
        set('DELETE FROM doctor_services WHERE doctor_id=?', id);
        for (const serviceId of body.serviceIds) {
          if (!one('SELECT id FROM services WHERE id=?', serviceId)) throw fail(400, 'VALIDATION_ERROR', 'A selected service does not exist.');
          set('INSERT INTO doctor_services(doctor_id,service_id) VALUES (?,?)', id, serviceId);
        }
      });
    }
    audit(admin.id, 'doctor.updated', 'doctor', id);
    return json(res, 200, { id, updated: true });
  }
  const doctorAvailability = path.match(/^\/api\/admin\/doctors\/([0-9a-f-]+)\/availability$/i);
  if (doctorAvailability && method === 'GET') {
    requireRole(session, STAFF);
    const id = doctorAvailability[1];
    return json(res, 200, {
      weekly: many('SELECT id,weekday,start_time AS startTime,end_time AS endTime,break_start AS breakStart,break_end AS breakEnd,slot_minutes AS slotMinutes FROM doctor_availability WHERE doctor_id=? ORDER BY weekday', id),
      unavailable: many('SELECT id,date,reason FROM doctor_unavailability WHERE doctor_id=? ORDER BY date DESC LIMIT 90', id)
    });
  }
  if (doctorAvailability && method === 'PUT') {
    const admin = requireRole(session, ADMIN), id = doctorAvailability[1], rows = body.weekly;
    if (!one('SELECT user_id FROM doctors WHERE user_id=?', id) || !Array.isArray(rows) || rows.length > 7) throw fail(400, 'VALIDATION_ERROR', 'Weekly availability is invalid.');
    const seen = new Set();
    const normalized = rows.map(item => {
      const weekday = integer(item.weekday, 'Weekday', { max: 6 });
      if (seen.has(weekday)) throw fail(400, 'VALIDATION_ERROR', 'A weekday may appear only once.'); seen.add(weekday);
      const startTime = time(item.startTime, 'Start time'), endTime = time(item.endTime, 'End time');
      const breakStart = item.breakStart ? time(item.breakStart, 'Break start') : null, breakEnd = item.breakEnd ? time(item.breakEnd, 'Break end') : null;
      const slotMinutes = integer(item.slotMinutes, 'Slot length', { min: 10, max: 240 });
      if (startTime >= endTime || (breakStart && (!breakEnd || breakStart >= breakEnd || breakStart < startTime || breakEnd > endTime))) throw fail(400, 'VALIDATION_ERROR', 'Availability hours or break are inconsistent.');
      return { weekday, startTime, endTime, breakStart, breakEnd, slotMinutes };
    });
    inTransaction(() => {
      set('DELETE FROM doctor_availability WHERE doctor_id=?', id);
      for (const row of normalized) set('INSERT INTO doctor_availability(id,doctor_id,weekday,start_time,end_time,break_start,break_end,slot_minutes) VALUES (?,?,?,?,?,?,?,?)', uuid(), id, row.weekday, row.startTime, row.endTime, row.breakStart, row.breakEnd, row.slotMinutes);
      for (const unavailableId of (Array.isArray(body.removeUnavailable) ? body.removeUnavailable : [])) set('DELETE FROM doctor_unavailability WHERE id=? AND doctor_id=?', string(unavailableId, 'Unavailable date', { max: 60 }), id);
      for (const item of (Array.isArray(body.unavailable) ? body.unavailable : [])) {
        const day = date(item.date), reason = string(item.reason || '', 'Reason', { max: 200, optional: true });
        set('INSERT INTO doctor_unavailability(id,doctor_id,date,reason) VALUES (?,?,?,?) ON CONFLICT(doctor_id,date) DO UPDATE SET reason=excluded.reason', uuid(), id, day, reason);
      }
      audit(admin.id, 'doctor.availability_updated', 'doctor', id);
    });
    return json(res, 200, { updated: true });
  }

  if (method === 'GET' && path === '/api/admin/services') { requireRole(session, STAFF); return json(res, 200, many('SELECT id,name,slug,description,duration_minutes AS durationMinutes,price_cents AS priceCents,active FROM services ORDER BY name')); }
  if (method === 'POST' && path === '/api/admin/services') {
    const admin = requireRole(session, ADMIN), name = string(body.name, 'Name', { max: 100 }), slug = string(body.slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), 'Slug', { max: 120 });
    const description = string(body.description, 'Description', { max: 1500 }), duration = integer(body.durationMinutes, 'Duration', { min: 10, max: 240 });
    const priceCents = body.priceCents === null || body.priceCents === '' || body.priceCents === undefined ? null : integer(body.priceCents, 'Price', { max: 100000000 });
    const id = uuid();
    set('INSERT INTO services(id,name,slug,description,duration_minutes,price_cents,active,created_at) VALUES (?,?,?,?,?,?,1,?)', id, name, slug, description, duration, priceCents, nowIso());
    audit(admin.id, 'service.created', 'service', id); return json(res, 201, { id });
  }
  const serviceAdmin = path.match(/^\/api\/admin\/services\/([0-9a-f-]+)$/i);
  if (method === 'PATCH' && serviceAdmin) {
    const admin = requireRole(session, ADMIN), id = serviceAdmin[1], service = one('SELECT * FROM services WHERE id=?', id);
    if (!service) throw fail(404, 'NOT_FOUND', 'Service not found.');
    for (const [key, col, max] of [['name', 'name', 100], ['slug', 'slug', 120], ['description', 'description', 1500]]) if (body[key] !== undefined) set(`UPDATE services SET ${col}=? WHERE id=?`, string(body[key], key, { max }), id);
    if (body.durationMinutes !== undefined) set('UPDATE services SET duration_minutes=? WHERE id=?', integer(body.durationMinutes, 'Duration', { min: 10, max: 240 }), id);
    if (body.priceCents !== undefined) set('UPDATE services SET price_cents=? WHERE id=?', body.priceCents === null ? null : integer(body.priceCents, 'Price'), id);
    if (body.active !== undefined) { if (typeof body.active !== 'boolean') throw fail(400, 'VALIDATION_ERROR', 'Active must be true or false.'); set('UPDATE services SET active=? WHERE id=?', body.active ? 1 : 0, id); }
    audit(admin.id, 'service.updated', 'service', id); return json(res, 200, { id, updated: true });
  }

  if (method === 'GET' && path === '/api/admin/enquiries') {
    requireRole(session, STAFF); const q = (url.searchParams.get('q') || '').slice(0, 80), status = url.searchParams.get('status');
    const filters = [], args = []; if (q) { filters.push('(name LIKE ? OR email LIKE ? OR subject LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    if (status && ['NEW','CONTACTED','RESOLVED'].includes(status)) { filters.push('status=?'); args.push(status); }
    return json(res, 200, many(`SELECT id,name,email,phone,subject,message,status,created_at AS createdAt FROM enquiries ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT 300`, ...args));
  }
  const enquiryAdmin = path.match(/^\/api\/admin\/enquiries\/([0-9a-f-]+)$/i);
  if (method === 'PATCH' && enquiryAdmin) {
    const staff = requireRole(session, STAFF), status = enumValue(body.status, ['NEW','CONTACTED','RESOLVED'], 'Status');
    set('UPDATE enquiries SET status=?,updated_at=? WHERE id=?', status, nowIso(), enquiryAdmin[1]);
    audit(staff.id, `enquiry.${status.toLowerCase()}`, 'enquiry', enquiryAdmin[1]); return json(res, 200, { id: enquiryAdmin[1], status });
  }
  if (method === 'GET' && path === '/api/admin/audit') {
    requireRole(session, ADMIN);
    return json(res, 200, many(`SELECT l.id,l.actor_user_id AS actorId,u.email AS actorEmail,l.action,l.resource_type AS resourceType,l.resource_id AS resourceId,l.created_at AS createdAt
      FROM audit_logs l LEFT JOIN users u ON u.id=l.actor_user_id ORDER BY l.created_at DESC LIMIT 200`));
  }
  if (method === 'GET' && path === '/api/admin/staff') {
    requireRole(session, ['SUPER_ADMIN']);
    return json(res, 200, many("SELECT id,email,role,active,created_at AS createdAt FROM users WHERE role IN ('SUPER_ADMIN','ADMIN','RECEPTIONIST') ORDER BY role,email"));
  }
  if (method === 'POST' && path === '/api/admin/staff') {
    const admin = requireRole(session, ['SUPER_ADMIN']), userEmail = email(body.email), role = enumValue(body.role, ['ADMIN','RECEPTIONIST'], 'Role'), pass = password(body.password);
    if (one('SELECT id FROM users WHERE email=?', userEmail)) throw fail(409, 'EMAIL_IN_USE', 'An account with that email already exists.');
    const id = uuid(), stamp = nowIso();
    set('INSERT INTO users(id,email,password_hash,role,active,created_at,updated_at) VALUES (?,?,?,?,1,?,?)', id, userEmail, await hashPassword(pass), role, stamp, stamp);
    audit(admin.id, 'staff.created', 'staff', id); return json(res, 201, { id, email: userEmail, role });
  }
  const staffAdmin = path.match(/^\/api\/admin\/staff\/([0-9a-f-]+)$/i);
  if (method === 'PATCH' && staffAdmin) {
    const admin = requireRole(session, ['SUPER_ADMIN']), id = staffAdmin[1];
    if (id === admin.id) throw fail(409, 'SELF_DEACTIVATION', 'You cannot deactivate your own account.');
    const active = body.active;
    if (typeof active !== 'boolean') throw fail(400, 'VALIDATION_ERROR', 'Active must be true or false.');
    set("UPDATE users SET active=?,updated_at=? WHERE id=? AND role IN ('ADMIN','RECEPTIONIST')", active ? 1 : 0, nowIso(), id);
    if (!active) set('DELETE FROM sessions WHERE user_id=?', id);
    audit(admin.id, active ? 'staff.activated' : 'staff.deactivated', 'staff', id); return json(res, 200, { id, active });
  }

  const contentAdmin = path.match(/^\/api\/admin\/content\/(faq|testimonial|gallery)(?:\/([0-9a-f-]+))?$/i);
  if (contentAdmin && method === 'GET') {
    requireRole(session, STAFF); const [kind] = contentAdmin, { table } = contentTables[kind];
    return json(res, 200, many(`SELECT * FROM ${table} ORDER BY rowid DESC`));
  }
  if (contentAdmin && method === 'POST') {
    const admin = requireRole(session, ADMIN), [kind] = contentAdmin, { config, values } = contentRow(kind, body);
    const id = uuid(), columns = [...Object.keys(values), 'id', 'active'], vals = [...Object.values(values), id, 1];
    set(`INSERT INTO ${config.table}(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, ...vals);
    audit(admin.id, `content.${kind}.created`, kind, id); return json(res, 201, { id });
  }
  if (contentAdmin && method === 'PATCH') {
    const admin = requireRole(session, ADMIN), [, kind, id] = contentAdmin, { config, values } = contentRow(kind, body, id);
    if (body.active !== undefined) { if (typeof body.active !== 'boolean') throw fail(400, 'VALIDATION_ERROR', 'Active must be true or false.'); values.active = body.active ? 1 : 0; }
    if (!Object.keys(values).length) throw fail(400, 'VALIDATION_ERROR', 'There are no content changes to save.');
    set(`UPDATE ${config.table} SET ${Object.keys(values).map(key => `${key}=?`).join(',')} WHERE id=?`, ...Object.values(values), id);
    audit(admin.id, `content.${kind}.updated`, kind, id); return json(res, 200, { id, updated: true });
  }
  throw fail(404, 'NOT_FOUND', 'The requested API route was not found.');
}
