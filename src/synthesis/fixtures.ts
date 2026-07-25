import type { Customer, Job, Visit, RawCapture, CustomerContext } from '../db/index.js';

// Shared, in-memory test fixtures for the synthesis layer. Synthesis is pure over
// a CustomerContext, so tests build literal rows here — no DB required. Each
// builder takes a Partial override so individual tests can vary one field.

export const customer = (over: Partial<Customer> = {}): Customer => ({
  id: 'cust-1',
  tenant_id: 'tenant-1',
  name: 'Mrs. Lee',
  phone: '555-2200',
  email: null,
  address_line1: '14 Smith St',
  address_line2: null,
  city: 'Springfield',
  state: 'IL',
  postal_code: null,
  attributes: { gateCode: '1234', dog: true },
  source_capture_id: null,
  created_at: '2026-06-01T00:00:00.000Z',
  updated_at: '2026-06-01T00:00:00.000Z',
  ...over,
});

export const job = (over: Partial<Job> = {}): Job => ({
  id: 'job-1',
  tenant_id: 'tenant-1',
  customer_id: 'cust-1',
  title: 'AC repair',
  job_type: 'hvac',
  status: 'open',
  priority: 'routine',
  price_cents: null,
  duration_minutes: null,
  attributes: {},
  source_capture_id: null,
  created_at: '2026-06-02T00:00:00.000Z',
  updated_at: '2026-06-02T00:00:00.000Z',
  ...over,
});

export const visit = (over: Partial<Visit> = {}): Visit => ({
  id: 'visit-1',
  tenant_id: 'tenant-1',
  job_id: 'job-1',
  technician_name: 'Jane',
  scheduled_at: null,
  started_at: null,
  completed_at: null,
  labor_hours: 1.5,
  attributes: { workPerformed: 'inspected unit' },
  source_capture_id: 'cap-a',
  created_at: '2026-06-03T00:00:00.000Z',
  ...over,
});

export const capture = (over: Partial<RawCapture> = {}): RawCapture => ({
  id: 'cap-a',
  tenant_id: 'tenant-1',
  customer_id: null,
  job_id: null,
  visit_id: null,
  channel: 'technician_voice',
  raw_text: 'Capacitor failing, recommend full unit replacement soon.',
  blob_path: null,
  external_id: null,
  technician_ref: null,
  metadata: {},
  sensitivity: null,
  retracts_capture_id: null,
  captured_at: '2026-06-03T00:00:00.000Z',
  created_at: '2026-06-03T00:00:00.000Z',
  ...over,
});

// A realistic single-customer context: one open HVAC job, one visit linked to the
// "capacitor failing" voice note (cap-a). Used by the live briefing + Q&A tests.
export const sampleContext = (): CustomerContext => ({
  customer: customer(),
  jobs: [job()],
  recentVisits: [visit()],
  recentCaptures: [capture()],
});
