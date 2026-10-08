import { createHash, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const scrypt = promisify(scryptCb);
const databasePath = resolve(process.env.DATABASE_PATH || './data/smilecare.sqlite');
mkdirSync(dirname(databasePath), { recursive: true });
export const db = new DatabaseSync(databasePath);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');

export const schema = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('SUPER_ADMIN','ADMIN','RECEPTIONIST','DOCTOR','PATIENT')),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS patients (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '', date_of_birth TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS doctors (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL, qualification TEXT NOT NULL, specialization TEXT NOT NULL,
  experience_years INTEGER NOT NULL DEFAULT 0 CHECK(experience_years >= 0), bio TEXT NOT NULL DEFAULT '',
  photo_url TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
);
CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, description TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL CHECK(duration_minutes BETWEEN 10 AND 240),
  price_cents INTEGER, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS doctor_services (
  doctor_id TEXT NOT NULL REFERENCES doctors(user_id) ON DELETE CASCADE,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  PRIMARY KEY (doctor_id, service_id)
);
CREATE TABLE IF NOT EXISTS doctor_availability (
  id TEXT PRIMARY KEY, doctor_id TEXT NOT NULL REFERENCES doctors(user_id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK(weekday BETWEEN 0 AND 6), start_time TEXT NOT NULL, end_time TEXT NOT NULL,
  break_start TEXT, break_end TEXT, slot_minutes INTEGER NOT NULL DEFAULT 30 CHECK(slot_minutes BETWEEN 10 AND 240),
  UNIQUE(doctor_id, weekday)
);
CREATE TABLE IF NOT EXISTS doctor_unavailability (
  id TEXT PRIMARY KEY, doctor_id TEXT NOT NULL REFERENCES doctors(user_id) ON DELETE CASCADE,
  date TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', UNIQUE(doctor_id, date)
);
CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY, reference TEXT NOT NULL UNIQUE, patient_id TEXT NOT NULL REFERENCES patients(user_id),
  doctor_id TEXT NOT NULL REFERENCES doctors(user_id), service_id TEXT NOT NULL REFERENCES services(id),
  starts_at TEXT NOT NULL, ends_at TEXT NOT NULL,
  problem TEXT NOT NULL DEFAULT '', submission_key TEXT,
  status TEXT NOT NULL CHECK(status IN ('PENDING','CONFIRMED','RESCHEDULED','CANCELLED','COMPLETED','NO_SHOW')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK(ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS appointments_doctor_time ON appointments(doctor_id, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS appointments_patient_time ON appointments(patient_id, starts_at DESC);
CREATE INDEX IF NOT EXISTS appointments_status_time ON appointments(status, starts_at);
CREATE TABLE IF NOT EXISTS enquiries (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '', message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'NEW'
    CHECK(status IN ('NEW','CONTACTED','RESOLVED')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY, actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_logs_created ON audit_logs(created_at DESC);
CREATE TABLE IF NOT EXISTS domain_events (
  id TEXT PRIMARY KEY, event_type TEXT NOT NULL, resource_id TEXT NOT NULL,
  payload_json TEXT NOT NULL, created_at TEXT NOT NULL, published_at TEXT
);
CREATE INDEX IF NOT EXISTS domain_events_pending ON domain_events(published_at, created_at);
CREATE TABLE IF NOT EXISTS testimonials (
  id TEXT PRIMARY KEY, patient_name TEXT NOT NULL, rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
  review TEXT NOT NULL, category TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS gallery_items (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', image_url TEXT NOT NULL,
  alt_text TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS faqs (
  id TEXT PRIMARY KEY, question TEXT NOT NULL, answer TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
`;

export function nowIso() { return new Date().toISOString(); }
export function uuid() { return randomUUID(); }
export function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
export async function hashPassword(password) {
  const salt = cryptoRandom(16);
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${Buffer.from(derived).toString('hex')}`;
}
function cryptoRandom(size) {
  // Imported lazily to keep the public database helpers small.
  return randomBytes(size);
}
import { randomBytes } from 'node:crypto';
export async function verifyPassword(password, encoded) {
  const [algorithm, saltHex, hashHex] = String(encoded || '').split('$');
  if (algorithm !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = Buffer.from(await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function audit(actorId, action, type, resourceId) {
  db.prepare('INSERT INTO audit_logs(id,actor_user_id,action,resource_type,resource_id,created_at) VALUES (?,?,?,?,?,?)')
    .run(uuid(), actorId || null, action, type, String(resourceId), nowIso());
}
export function emitEvent(eventType, resourceId, payload = {}) {
  db.prepare('INSERT INTO domain_events(id,event_type,resource_id,payload_json,created_at) VALUES (?,?,?,?,?)')
    .run(uuid(), eventType, String(resourceId), JSON.stringify(payload), nowIso());
}

function insertService(name, slug, description, duration, priceCents = null) {
  const id = uuid();
  db.prepare('INSERT INTO services(id,name,slug,description,duration_minutes,price_cents,active,created_at) VALUES (?,?,?,?,?,?,1,?)')
    .run(id, name, slug, description, duration, priceCents, nowIso());
  return id;
}

export async function initializeDatabase() {
  db.exec(schema);
  // Keep existing local databases compatible with the appointment-submission safeguards.
  const appointmentColumns = new Set(db.prepare('PRAGMA table_info(appointments)').all().map(row => row.name));
  if (!appointmentColumns.has('problem')) db.exec("ALTER TABLE appointments ADD COLUMN problem TEXT NOT NULL DEFAULT ''");
  if (!appointmentColumns.has('submission_key')) db.exec('ALTER TABLE appointments ADD COLUMN submission_key TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS appointments_patient_submission_key ON appointments(patient_id, submission_key) WHERE submission_key IS NOT NULL');
  const production = process.env.NODE_ENV === 'production';
  const seedDemo = !production && process.env.SEED_DEMO_DATA !== 'false';
  const adminEmail = process.env.INITIAL_SUPER_ADMIN_EMAIL?.trim().toLowerCase();
  const adminPassword = process.env.INITIAL_SUPER_ADMIN_PASSWORD;
  if (!seedDemo && adminEmail && adminPassword && !db.prepare("SELECT 1 FROM users WHERE role='SUPER_ADMIN'").get()) {
    const userId = uuid();
    db.prepare('INSERT INTO users(id,email,password_hash,role,active,created_at,updated_at) VALUES (?,?,?,\'SUPER_ADMIN\',1,?,?)')
      .run(userId, adminEmail, await hashPassword(adminPassword), nowIso(), nowIso());
  }
  if (seedDemo && !db.prepare('SELECT 1 FROM users LIMIT 1').get()) await seedDemoDatabase();
  if (production && !db.prepare("SELECT 1 FROM users WHERE role='SUPER_ADMIN' AND active=1").get()) {
    throw new Error('Production startup requires INITIAL_SUPER_ADMIN_EMAIL and INITIAL_SUPER_ADMIN_PASSWORD on first run.');
  }
}

async function seedDemoDatabase() {
  const stamp = nowIso();
  const clinicServices = [
    insertService('Dental checkup', 'dental-checkup', 'A comprehensive oral health examination with a clear care plan.', 30, 80000),
    insertService('Teeth cleaning', 'teeth-cleaning', 'Professional cleaning to remove plaque and surface stains.', 45, 140000),
    insertService('Root canal treatment', 'root-canal', 'Care to treat infection and preserve a natural tooth.', 60, 650000),
    insertService('Dental implants', 'dental-implants', 'Personalized implant consultation and restorative care.', 60, 4500000),
    insertService('Teeth whitening', 'teeth-whitening', 'A professional consultation for brighter, healthy-looking teeth.', 45, 250000),
    insertService('Orthodontics', 'orthodontics', 'Assessment and planning for braces and aligner treatment.', 45, 180000),
    insertService('Pediatric dentistry', 'pediatric-dentistry', 'Gentle preventive and restorative dental care for children.', 30, 100000),
    insertService('Gum treatment', 'gum-treatment', 'Evaluation and treatment planning for gum health.', 45, 160000)
  ];
  const demoPassword = await hashPassword('SmileCareDemo!24');
  const createUser = (id, email, role) => db.prepare('INSERT INTO users(id,email,password_hash,role,active,created_at,updated_at) VALUES (?,?,?,?,1,?,?)')
    .run(id, email, demoPassword, role, stamp, stamp);
  const doctorRows = [
    ['Dr. Arjun Sen', 'BDS, MDS', 'Endodontics', 12, 'Focused on comfortable restorative care and preserving natural teeth.'],
    ['Dr. Ananya Roy', 'BDS, MDS', 'Orthodontics', 9, 'Helps children and adults build confident, healthy smiles.'],
    ['Dr. Rahul Das', 'BDS', 'General Dentistry', 7, 'Provides preventive care and family dentistry with a calm approach.']
  ];
  const doctors = [];
  for (let i = 0; i < doctorRows.length; i++) {
    const [name, qualification, specialization, years, bio] = doctorRows[i];
    const id = uuid(); doctors.push(id);
    createUser(id, `doctor${i + 1}@smilecare.demo`, 'DOCTOR');
    db.prepare('INSERT INTO doctors(user_id,full_name,qualification,specialization,experience_years,bio,active) VALUES (?,?,?,?,?,?,1)')
      .run(id, name, qualification, specialization, years, bio);
    for (let weekday = 1; weekday <= 6; weekday++) {
      db.prepare('INSERT INTO doctor_availability(id,doctor_id,weekday,start_time,end_time,break_start,break_end,slot_minutes) VALUES (?,?,?,?,?,?,?,?)')
        .run(uuid(), id, weekday, '09:00', '17:00', '13:00', '14:00', 30);
    }
    const assigned = i === 0 ? [0, 1, 2, 3, 4, 7] : i === 1 ? [0, 1, 4, 5, 6] : [0, 1, 2, 4, 6, 7];
    for (const index of assigned) db.prepare('INSERT INTO doctor_services(doctor_id,service_id) VALUES (?,?)').run(id, clinicServices[index]);
  }
  const staff = [
    ['admin@smilecare.demo', 'SUPER_ADMIN'], ['reception@smilecare.demo', 'RECEPTIONIST']
  ];
  for (const [email, role] of staff) createUser(uuid(), email, role);
  const patients = [
    ['Aditi Sharma', '9000000101'], ['Kabir Mehta', '9000000102'], ['Mira Das', '9000000103'], ['Dev Patel', '9000000104']
  ];
  const patientIds = [];
  for (let i = 0; i < patients.length; i++) {
    const [name, phone] = patients[i], id = uuid(); patientIds.push(id);
    createUser(id, `patient${i + 1}@smilecare.demo`, 'PATIENT');
    db.prepare('INSERT INTO patients(user_id,full_name,phone,created_at) VALUES (?,?,?,?)').run(id, name, phone, stamp);
  }
  db.prepare('INSERT INTO testimonials(id,patient_name,rating,review,category,active) VALUES (?,?,?,?,?,1)')
    .run(uuid(), 'A patient from our demo dataset', 5, 'The clinic team explained each step and made my visit feel calm and straightforward.', 'Dental checkup');
  db.prepare('INSERT INTO gallery_items(id,title,description,image_url,alt_text,active) VALUES (?,?,?,?,?,1)')
    .run(uuid(), 'Bright, welcoming reception', 'Demo image for the SmileCare clinic environment.', 'https://images.unsplash.com/photo-1629909613654-28e377c37b09?auto=format&fit=crop&w=1000&q=80', 'Bright, modern dental clinic reception');
  const questions = [
    ['How do I book an appointment?', 'Choose a service, a dentist and an available time. Your request is marked pending until the clinic confirms it.'],
    ['Can I request a different appointment time?', 'Yes. Open an upcoming appointment in your patient portal and request an available new time.'],
    ['What should I bring to my first visit?', 'Bring a photo ID and any relevant dental records or medication information you wish to share with the clinician.']
  ];
  questions.forEach(([q, a], i) => db.prepare('INSERT INTO faqs(id,question,answer,sort_order,active) VALUES (?,?,?,?,1)').run(uuid(), q, a, i));
  db.prepare('INSERT INTO enquiries(id,name,email,phone,subject,message,status,created_at,updated_at) VALUES (?,?,?,?,?,?,\'NEW\',?,?)')
    .run(uuid(), 'Sample enquiry', 'visitor@example.invalid', '9000000199', 'Opening hours', 'Could you share your weekend opening hours?', stamp, stamp);
  // A single upcoming appointment demonstrates the patient and staff views.
  const tomorrow = new Date(Date.now() + 86400000);
  while (tomorrow.getDay() === 0) tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(10, 0, 0, 0);
  const startsAt = tomorrow.toISOString(), endsAt = new Date(tomorrow.getTime() + 30 * 60000).toISOString();
  db.prepare('INSERT INTO appointments(id,reference,patient_id,doctor_id,service_id,starts_at,ends_at,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,\'CONFIRMED\',?,?)')
    .run(uuid(), 'SC-DEMO-001', patientIds[0], doctors[2], clinicServices[0], startsAt, endsAt, stamp, stamp);
}
