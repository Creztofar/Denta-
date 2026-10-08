import { fail } from './security.mjs';

export function string(value, field, { min = 1, max = 300, optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === '')) return '';
  if (typeof value !== 'string') throw fail(400, 'VALIDATION_ERROR', `${field} must be text.`);
  const normalized = value.trim().replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  if (normalized.length < min || normalized.length > max) throw fail(400, 'VALIDATION_ERROR', `${field} must be between ${min} and ${max} characters.`);
  return normalized;
}
export function email(value) {
  const normalized = string(value, 'Email', { max: 254 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw fail(400, 'VALIDATION_ERROR', 'Enter a valid email address.');
  return normalized;
}
export function phone(value, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || String(value).trim() === '')) return '';
  const raw = string(value, 'Phone number', { min: 7, max: 30 });
  const normalized = raw.replace(/[\s().-]/g, '');
  if (!/^\+?[1-9]\d{6,14}$/.test(normalized)) throw fail(400, 'VALIDATION_ERROR', 'Enter a valid phone number.');
  return normalized;
}
export function password(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 200) throw fail(400, 'VALIDATION_ERROR', 'Password must be 12–200 characters.');
  return value;
}
export function integer(value, field, { min = 0, max = 10000000 } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw fail(400, 'VALIDATION_ERROR', `${field} is invalid.`);
  return number;
}
export function date(value, field = 'Date') {
  const normalized = string(value, field, { max: 10 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized) || new Date(`${normalized}T00:00:00.000Z`).toISOString().slice(0, 10) !== normalized) {
    throw fail(400, 'VALIDATION_ERROR', `${field} must be a real date in YYYY-MM-DD format.`);
  }
  return normalized;
}
export function enumValue(value, allowed, field) {
  if (!allowed.includes(value)) throw fail(400, 'VALIDATION_ERROR', `${field} is not a supported value.`);
  return value;
}
export function time(value, field = 'Time') {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw fail(400, 'VALIDATION_ERROR', `${field} must use 24-hour HH:MM format.`);
  return value;
}
