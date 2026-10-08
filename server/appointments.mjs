import { db, nowIso, uuid } from './db.mjs';
import { fail } from './security.mjs';

export const ACTIVE_STATUSES = ['PENDING', 'CONFIRMED', 'RESCHEDULED'];
const transitions = {
  PENDING: ['CONFIRMED', 'CANCELLED', 'RESCHEDULED'],
  CONFIRMED: ['CANCELLED', 'RESCHEDULED', 'COMPLETED', 'NO_SHOW'],
  RESCHEDULED: ['CONFIRMED', 'CANCELLED', 'RESCHEDULED', 'COMPLETED', 'NO_SHOW'],
  CANCELLED: [], COMPLETED: [], NO_SHOW: []
};
export function assertTransition(current, next) {
  if (!transitions[current]?.includes(next)) throw fail(409, 'INVALID_STATUS_TRANSITION', `An appointment cannot move from ${current} to ${next}.`);
}
export function inTransaction(action) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function localDateTimeToIso(date, time, timeZone = process.env.CLINIC_TIMEZONE || 'Asia/Kolkata') {
  const [year, month, day] = date.split('-').map(Number), [hour, minute] = time.split(':').map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(target));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const localAsUtc = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute));
  return new Date(target - (localAsUtc - target)).toISOString();
}
export function clinicDate(value = new Date(), timeZone = process.env.CLINIC_TIMEZONE || 'Asia/Kolkata') {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(value).map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
export function clinicDayBounds(day) {
  const endDay = new Date(Date.parse(`${day}T00:00:00.000Z`) + 86400000).toISOString().slice(0, 10);
  return { start: localDateTimeToIso(day, '00:00'), end: localDateTimeToIso(endDay, '00:00') };
}
export function slotIsAvailable({ doctorId, serviceId, date, time, excludeAppointmentId = null }) {
  const today = clinicDate();
  const lastDate = new Date(Date.parse(`${today}T00:00:00.000Z`) + 90 * 86400000).toISOString().slice(0, 10);
  if (date < today || date > lastDate) return null;
  const service = db.prepare(`SELECT s.duration_minutes FROM services s JOIN doctor_services ds ON ds.service_id=s.id
    JOIN doctors d ON d.user_id=ds.doctor_id JOIN users u ON u.id=d.user_id
    WHERE s.id=? AND s.active=1 AND ds.doctor_id=? AND d.active=1 AND u.active=1`).get(serviceId, doctorId);
  const dayOfWeek = new Date(`${date}T12:00:00Z`).getUTCDay();
  const availability = db.prepare('SELECT * FROM doctor_availability WHERE doctor_id=? AND weekday=?').get(doctorId, dayOfWeek);
  if (!service || !availability) return null;
  if (db.prepare('SELECT 1 FROM doctor_unavailability WHERE doctor_id=? AND date=?').get(doctorId, date)) return null;
  const [hour, minute] = time.split(':').map(Number);
  const timeMinutes = hour * 60 + minute, startMinutes = Number(availability.start_time.slice(0, 2)) * 60 + Number(availability.start_time.slice(3));
  const endMinutes = Number(availability.end_time.slice(0, 2)) * 60 + Number(availability.end_time.slice(3));
  const slotStep = availability.slot_minutes;
  const duration = service.duration_minutes;
  if (timeMinutes < startMinutes || timeMinutes + duration > endMinutes || (timeMinutes - startMinutes) % slotStep !== 0) return null;
  if (availability.break_start && availability.break_end) {
    const breakStart = Number(availability.break_start.slice(0, 2)) * 60 + Number(availability.break_start.slice(3));
    const breakEnd = Number(availability.break_end.slice(0, 2)) * 60 + Number(availability.break_end.slice(3));
    if (timeMinutes < breakEnd && timeMinutes + duration > breakStart) return null;
  }
  const startsAt = localDateTimeToIso(date, time), endsAt = new Date(new Date(startsAt).getTime() + duration * 60000).toISOString();
  if (new Date(startsAt).getTime() <= Date.now()) return null;
  const conflict = db.prepare(`SELECT 1 FROM appointments WHERE doctor_id=? AND status IN ('PENDING','CONFIRMED','RESCHEDULED')
    AND starts_at < ? AND ends_at > ? AND (? IS NULL OR id<>?) LIMIT 1`)
    .get(doctorId, endsAt, startsAt, excludeAppointmentId, excludeAppointmentId);
  return conflict ? null : { startsAt, endsAt, durationMinutes: duration };
}
export function getAvailability(doctorId, serviceId, date) {
  const service = db.prepare(`SELECT s.duration_minutes FROM services s JOIN doctor_services ds ON ds.service_id=s.id
    JOIN doctors d ON d.user_id=ds.doctor_id JOIN users u ON u.id=d.user_id
    WHERE s.id=? AND s.active=1 AND ds.doctor_id=? AND d.active=1 AND u.active=1`).get(serviceId, doctorId);
  if (!service) return [];
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const availability = db.prepare('SELECT * FROM doctor_availability WHERE doctor_id=? AND weekday=?').get(doctorId, weekday);
  if (!availability || db.prepare('SELECT 1 FROM doctor_unavailability WHERE doctor_id=? AND date=?').get(doctorId, date)) return [];
  const start = Number(availability.start_time.slice(0, 2)) * 60 + Number(availability.start_time.slice(3));
  const end = Number(availability.end_time.slice(0, 2)) * 60 + Number(availability.end_time.slice(3));
  const breakStart = availability.break_start ? Number(availability.break_start.slice(0, 2)) * 60 + Number(availability.break_start.slice(3)) : -1;
  const breakEnd = availability.break_end ? Number(availability.break_end.slice(0, 2)) * 60 + Number(availability.break_end.slice(3)) : -1;
  const slots = [];
  for (let minute = start; minute + service.duration_minutes <= end; minute += availability.slot_minutes) {
    if (minute < breakEnd && minute + service.duration_minutes > breakStart) continue;
    const hhmm = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
    const slot = slotIsAvailable({ doctorId, serviceId, date, time: hhmm });
    if (slot) slots.push({ time: hhmm, startsAt: slot.startsAt, endsAt: slot.endsAt });
  }
  return slots;
}
function formatAppointmentDateTime(startsAt) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.CLINIC_TIMEZONE || 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(startsAt)).map(part => [part.type, part.value]));
  return { appointmentDate: `${parts.day}-${parts.month}-${parts.year}`, appointmentTime: `${parts.hour}:${parts.minute}` };
}

export function appointmentAutomationPayload(appointment) {
  const { appointmentDate, appointmentTime } = formatAppointmentDateTime(appointment.startsAt);
  return {
    patientName: appointment.patientName,
    phone: appointment.patientPhone || '',
    email: appointment.patientEmail,
    doctor: appointment.doctorName,
    service: appointment.serviceName,
    appointmentDate,
    appointmentTime,
    problem: appointment.problem || '',
    appointmentId: appointment.id,
    status: appointment.status,
    createdAt: appointment.createdAt
  };
}

export function createAppointment({ patientId, doctorId, serviceId, date, time, problem = '', submissionKey = null, actorId = patientId }) {
  return inTransaction(() => {
    if (!db.prepare('SELECT user_id FROM patients WHERE user_id=?').get(patientId)) throw fail(404, 'PATIENT_NOT_FOUND', 'Patient account was not found.');
    if (submissionKey) {
      const existing = db.prepare(appointmentSelect + ' WHERE a.patient_id=? AND a.submission_key=?').get(patientId, submissionKey);
      if (existing) return existing;
    }
    const slot = slotIsAvailable({ doctorId, serviceId, date, time });
    if (!slot) throw fail(409, 'SLOT_UNAVAILABLE', 'That time is no longer available. Choose another slot.');
    const id = uuid(), reference = `SC-${new Date().getUTCFullYear()}-${id.slice(0, 8).toUpperCase()}`, stamp = nowIso();
    db.prepare(`INSERT INTO appointments(id,reference,patient_id,doctor_id,service_id,starts_at,ends_at,problem,submission_key,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,'PENDING',?,?)`).run(id, reference, patientId, doctorId, serviceId, slot.startsAt, slot.endsAt, problem, submissionKey, stamp, stamp);
    db.prepare('INSERT INTO audit_logs(id,actor_user_id,action,resource_type,resource_id,created_at) VALUES (?,?,?,?,?,?)')
      .run(uuid(), actorId, 'appointment.created', 'appointment', id, stamp);
    const appointment = db.prepare(appointmentSelect + ' WHERE a.id=?').get(id);
    db.prepare('INSERT INTO domain_events(id,event_type,resource_id,payload_json,created_at) VALUES (?,?,?,?,?)')
      .run(uuid(), 'appointment.created', id, JSON.stringify(appointmentAutomationPayload(appointment)), stamp);
    return appointment;
  });
}
export const appointmentSelect = `SELECT a.id,a.reference,a.patient_id AS patientId,a.doctor_id AS doctorId,
  a.service_id AS serviceId,a.starts_at AS startsAt,a.ends_at AS endsAt,a.status,a.created_at AS createdAt,
  a.problem,p.full_name AS patientName,p.phone AS patientPhone,u.email AS patientEmail,d.full_name AS doctorName,d.specialization,
  s.name AS serviceName,s.duration_minutes AS durationMinutes
  FROM appointments a JOIN patients p ON p.user_id=a.patient_id JOIN users u ON u.id=a.patient_id
  JOIN doctors d ON d.user_id=a.doctor_id JOIN services s ON s.id=a.service_id`;
