/**
 * Typed API client.
 *
 * A single fetch wrapper so the auth header, the clinician `patient_id` scoping
 * parameter, and error shaping are handled in exactly one place. Every backend
 * error carries a `detail` string; `ApiError` surfaces it so the UI can show what
 * actually went wrong instead of "something went wrong".
 */

/**
 * Where the API lives.
 *
 * In development the Vite dev server and Django run on different ports, so the
 * base is Django's. In a production build the SPA is served by Django itself
 * from the same origin, so the base is wherever the page was loaded from — that
 * way the deployed URL is never baked into the bundle and the same build works
 * on a preview instance, a custom domain, or localhost.
 *
 * `VITE_API_BASE` overrides both, for a deployment that hosts the frontend
 * separately from the API. An empty value counts as unset: `??` alone would
 * accept "" and every request would then be built from an invalid URL.
 */
const CONFIGURED_BASE = import.meta.env.VITE_API_BASE?.trim();
const BASE =
  CONFIGURED_BASE || (import.meta.env.DEV ? "http://127.0.0.1:8000" : window.location.origin);

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }

  get isAuth(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

let token: string | null = null;
/** Set when a clinician is acting on a specific patient's record. */
let actingPatientId: number | null = null;
const authFailureHandlers = new Set<() => void>();

export function setToken(next: string | null): void {
  token = next;
}

export function setActingPatient(id: number | null): void {
  actingPatientId = id;
}

export function getActingPatient(): number | null {
  return actingPatientId;
}

export function onAuthFailure(handler: () => void): () => void {
  authFailureHandlers.add(handler);
  return () => authFailureHandlers.delete(handler);
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
  /** Set false on endpoints that must never receive the patient_id scope. */
  scoped?: boolean;
  raw?: boolean;
  signal?: AbortSignal;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, query, scoped = true, raw = false, signal } = options;
  const url = new URL(BASE + path);

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== null && value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }
  }
  // Clinician acting on a patient: the backend requires patient_id and enforces
  // the assignment check itself. Patients never send it — the server ignores it
  // for them rather than trusting it.
  if (scoped && actingPatientId !== null && !url.searchParams.has("patient_id")) {
    url.searchParams.set("patient_id", String(actingPatientId));
  }

  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";

  const response = await fetch(url.toString(), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });

  if (response.status === 204) return undefined as T;

  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    let parsed: unknown;
    try {
      parsed = await response.json();
      const d = (parsed as { detail?: unknown }).detail;
      if (typeof d === "string") detail = d;
      else if (Array.isArray(d)) {
        // FastAPI validation errors.
        detail = d
          .map((e: { loc?: unknown[]; msg?: string }) => `${(e.loc ?? []).slice(1).join(".")}: ${e.msg}`)
          .join("; ");
      }
    } catch {
      /* non-JSON error body */
    }
    const error = new ApiError(response.status, detail, parsed);
    if (error.isAuth && response.status === 401) authFailureHandlers.forEach((h) => h());
    throw error;
  }

  if (raw) return (await response.text()) as T;
  return (await response.json()) as T;
}

/* ------------------------------------------------------------------------- */
/* File download                                                              */
/* ------------------------------------------------------------------------- */
/**
 * Fetch an authenticated endpoint and save the response as a file.
 *
 * A plain `<a href>` cannot do this: browser navigation carries no
 * `Authorization` header, so every export link was landing on a 401 and the
 * download silently produced nothing. The bytes have to be fetched with the
 * token attached and handed to the browser as a blob.
 *
 * The server's own `Content-Disposition` filename wins when present, so the
 * name stays correct (and MRN-stamped) without the client guessing it.
 */
export async function downloadFile(
  path: string,
  fallbackName: string,
  options: Omit<RequestOptions, "raw"> = {}
): Promise<string> {
  const { method = "GET", body, query, scoped = true, signal } = options;
  const url = new URL(BASE + path);

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== null && value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }
  }
  if (scoped && actingPatientId !== null && !url.searchParams.has("patient_id")) {
    url.searchParams.set("patient_id", String(actingPatientId));
  }

  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";

  const response = await fetch(url.toString(), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const parsed = await response.json();
      if (typeof (parsed as { detail?: unknown }).detail === "string") {
        detail = (parsed as { detail: string }).detail;
      }
    } catch {
      /* non-JSON error body */
    }
    const error = new ApiError(response.status, detail);
    if (error.isAuth && response.status === 401) authFailureHandlers.forEach((h) => h());
    throw error;
  }

  const filename = filenameFrom(response.headers.get("content-disposition")) ?? fallbackName;
  saveBlob(await response.blob(), filename);
  return filename;
}

/** Pull the filename out of a Content-Disposition header, RFC 5987 form first. */
function filenameFrom(header: string | null): string | null {
  if (!header) return null;
  const encoded = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(header);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1].trim().replace(/^"|"$/g, ""));
    } catch {
      /* fall through to the plain form */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain ? plain[1].trim() : null;
}

/**
 * Hand a blob to the browser as a download.
 *
 * The anchor is attached to the document before clicking — a detached anchor is
 * ignored by Firefox — and the object URL is revoked on a later task rather than
 * immediately, because revoking synchronously after `click()` can cancel the
 * download in Chromium before it has read the blob.
 */
export function saveBlob(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  window.setTimeout(() => {
    anchor.remove();
    URL.revokeObjectURL(objectUrl);
  }, 2000);
}

/** `2026-07-31` — used to stamp export filenames. */
function today(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/* ------------------------------------------------------------------------- */
/* Types (mirroring the backend response shapes we depend on)                 */
/* ------------------------------------------------------------------------- */
export interface Session {
  access_token: string;
  token_type: string;
  role: "patient" | "clinician" | "admin";
  user_id: number;
  patient_id: number | null;
  full_name: string;
  locale: string;
  country?: string;
  state?: string;
  city?: string;
  community_id?: number | null;
}

export interface UserLocation {
  country: string;
  state: string;
  city: string;
}

export interface Community {
  id: number;
  name: string;
  country: string;
  state: string;
  city: string;
  created_at: string;
  member_count: number;
  online_count?: number;
}

export interface CommunityComment {
  id: number;
  post_id: number;
  parent_id: number | null;
  author_name: string;
  content: string;
  created_at: string;
  is_own_comment: boolean;
  replies: CommunityComment[];
}

export interface CommunityPost {
  id: number;
  community_id: number;
  author_name: string;
  content: string;
  created_at: string;
  updated_at: string;
  is_own_post: boolean;
  likes_count: number;
  is_liked_by_me: boolean;
  comments_count: number;
  comments: CommunityComment[];
}

export interface CommunityChatMessage {
  id: number;
  community_id: number;
  sender_name: string;
  content: string;
  created_at: string;
  is_own_message: boolean;
  read_by_count: number;
  read_by_members: string[];
  unread_members: string[];
}

export interface CommunityAnnouncement {
  id: number;
  title: string;
  content: string;
  created_at: string;
}

export interface CommunityResource {
  id: number;
  title: string;
  category: string;
  link: string | null;
}

export interface CommunityResponse {
  has_community: boolean;
  joined_community: boolean;
  community: Community | null;
  user_location: UserLocation;
  announcements: CommunityAnnouncement[];
  resources: CommunityResource[];
  posts: CommunityPost[];
  chat_messages: CommunityChatMessage[];
  online_count: number;
}

export interface PatientProfile {
  id: number;
  mrn: string;
  full_name: string | null;
  email: string | null;
  date_of_birth: string | null;
  age: number | null;
  sex: string | null;
  phone: string | null;
  onset_date: string | null;
  duration_months: number | null;
  tinnitus_character: string | null;
  laterality: string | null;
  pulsatile: boolean;
  somatic_modulation: boolean;
  hyperacusis: boolean;
  hearing_aid_use: boolean;
  noise_exposure_years: number | null;
  comorbidities: string[];
  medications: string[];
  etiology_notes: string | null;
  consent_research: boolean;
  clinician_id: number | null;
  clinician_name: string | null;
  /** True when this patient has a stored headphone calibration to reuse. */
  has_saved_calibration?: boolean;
  saved_device_profile?: Record<string, any>;
}

export interface Assessment {
  id: number;
  patient_id: number;
  created_at: string;
  completed_at: string | null;
  status: string;
  modules_done: string[];
  device_profile: Record<string, unknown>;
  audiogram: Record<string, Record<string, number>>;
  pta_left: number | null;
  pta_right: number | null;
  hf_pta_left: number | null;
  hf_pta_right: number | null;
  hearing_grade: string | null;
  audiometric_notch_hz: number | null;
  pitch_match_hz: number | null;
  pitch_match_ear: string | null;
  pitch_match_confidence: number | null;
  octave_confusion: boolean | null;
  loudness_match_db_sl: number | null;
  mml_db_sl: number | null;
  ri_depth_pct: number | null;
  ri_duration_s: number | null;
  ri_category: string | null;
  tinnitus_bandwidth: string | null;
  ldl_left: number | null;
  ldl_right: number | null;
  thi_score: number | null;
  thi_grade: string | null;
  thi_subscales: Record<string, unknown>;
  vas_loudness: number | null;
  vas_annoyance: number | null;
  vas_awareness: number | null;
  vas_sleep_interference: number | null;
  psqi_score: number | null;
  psqi_grade: string | null;
  pss10_score: number | null;
  pss10_grade: string | null;
  gad7_score: number | null;
  gad7_grade: string | null;
  phq2_score: number | null;
  /** Stepped-protocol short forms; long forms stay null unless escalated. */
  gad2_score: number | null;
  pss4_score: number | null;
  sleep_screen_score: number | null;
  escalated_instruments: string[];
  derived: Record<string, any>;
  icd11_codes: any[];
}

/**
 * The personalised reference tone and level, as the server derives it.
 *
 * Every field carries the basis it came from — `frequency_basis` and
 * `level_basis` say which of the patient's own measurements produced the number,
 * so the screen can show its working rather than presenting a value that
 * appeared from nowhere.
 */
export interface PersonalisedReferenceResponse {
  assessment_id: number;
  personalised: boolean;
  reference_tone_hz: number | null;
  reference_level_db_hl: number | null;
  frequency_basis: string;
  level_basis: string;
  hearing_threshold_db_hl: number | null;
  sensation_level_db: number | null;
  masking_at_reference_db: number | null;
  masking_nearest_hz: number | null;
  floored_to_audibility: boolean;
  capped_to_safe: boolean;
  safe: boolean | null;
  max_safe_db: number;
  inputs: {
    pitch_match_hz: number | null;
    loudness_match_db_hl: number | null;
    masking_tested_count: number;
    masking_minimum_db: number | null;
    masking_minimum_hz: number | null;
    hearing_profile: boolean;
  };
  masking: {
    curve: { hz: number; threshold_db: number | null; masked: boolean | null; tested: boolean }[];
    reference_level_db: number | null;
    reference_level_hz: number | null;
    selectivity: string;
    spread_db: number | null;
    interpretation: string;
    tested_count: number;
    unmaskable_count: number;
    maskable: boolean;
    safe: boolean | null;
    max_safe_db: number;
  };
}

export interface ShapDriver {
  key: string;
  label: string;
  group: string;
  value: number | null;
  display_value: string;
  measured: boolean;
  contribution: number;
  abs_contribution: number;
  direction: string;
  polarity: "adverse" | "protective";
  frequency_factor?: number;
}

export interface Explanation {
  baseline: number;
  prediction: number;
  drivers: ShapDriver[];
  group_contributions: { group: string; contribution: number; share_pct: number }[];
  method: string;
  local_accuracy_residual: number;
  baseline_hz?: number;
  units?: string;
}

export interface Analysis {
  scores: Record<string, any>;
  audiogram: Record<string, any>;
  derived: Record<string, any>;
  red_flags: {
    flags: {
      code: string;
      title: string;
      urgency: "routine" | "soon" | "urgent" | "emergency";
      action: string;
      evidence: string;
      pathway: string;
    }[];
    count: number;
    highest_urgency: string;
    requires_human_review: boolean;
    summary: string;
  };
  icd11: { code: string; title: string; verify: boolean; rationale: string; primary?: boolean }[];
  coding_disclaimer: string;
  prediction: {
    model_version: string;
    trained_at: string;
    outputs: Record<string, any>;
    intervals: Record<string, { low: number; high: number; level: string; method: string }>;
    explanations: Record<string, Explanation>;
    narratives: Record<string, string>;
    consistency_checks: { check: string; label: string; passed: boolean; detail: string }[];
    feature_vector: Record<string, number | null>;
    features_measured: number;
    features_total: number;
  } | null;
  prediction_error: string | null;
  therapy: {
    revision: number;
    strategy: string;
    daily_minutes_target: number;
    review_after_days: number;
    program: any[];
    rationale: string[];
    guardrails: Record<string, any>;
    spectrum: Record<string, any> | null;
    derived: Record<string, any>;
  } | null;
  summary: {
    headline: string;
    findings: string[];
    actions: string[];
    requires_human_review: boolean;
    highest_urgency: string;
    narratives: Record<string, string>;
    generated_at: string;
  };
  alerts_created?: { kind: string; title: string; severity: string }[];
}

export interface Prescription {
  id: number;
  patient_id: number;
  assessment_id: number | null;
  created_at: string;
  revision: number;
  active: boolean;
  generated_by: string;
  program: any[];
  daily_minutes_target: number;
  rationale: string[];
  guardrails: Record<string, any>;
  review_after_days: number;
}

/* ------------------------------- consultation ----------------------------- */
/**
 * Where an appointment sits relative to its join window, decided by the server.
 *
 *   upcoming → more than ten minutes away; the meeting link is not even sent
 *   imminent → inside the ten-minute window, link live, countdown running
 *   live     → in progress
 *   ended    → finished; the summary replaces the join button
 *   closed   → cancelled or missed
 */
export type ConsultationPhase = "upcoming" | "imminent" | "live" | "ended" | "closed";

export interface ConsultationAppointment {
  id: number;
  scheduled_for: string;
  ends_at: string;
  kind: string;
  modality: string;
  status: string;
  notes: string;
  clinician_name: string | null;
  clinician_specialization: string;
  duration_minutes: number;
  /** Empty until the join window opens — the server withholds it, not the UI. */
  meeting_link: string;
  has_meeting_link: boolean;
  phase: ConsultationPhase;
  /** Seconds until the start, negative once it has passed. Server clock. */
  starts_in_seconds: number;
  /**
   * Whether the join button should be live, decided by the server.
   *
   * Not derived on the client: two clocks disagreeing is how a patient ends up
   * looking at a disabled button during their own appointment.
   */
  can_join: boolean;
  join_opens_at: string | null;
  is_online: boolean;
}

export interface ClinicianSchedule {
  clinician_id: number;
  name: string;
  email: string;
  specialization: string;
  qualifications: string;
  years_experience: number | null;
  bio: string;
  accepting_patients: boolean;
  working_days: number[];
  working_days_label: string;
  working_hours: { start: string; end: string }[];
  slot_minutes: number;
  booking_horizon_days: number;
  works_today: boolean;
  slots_remaining_today: number;
  slots_today_total: number;
  has_default_meeting_link: boolean;
  default_meeting_link?: string;
}

/** A schedule plus the availability summary a patient compares doctors on. */
export interface DoctorCard extends ClinicianSchedule {
  next_available_date: string | null;
  next_available_weekday: string | null;
  next_slots: string[];
  open_slots_soon: number;
  patient_count: number;
}

export interface Slot {
  start: string;
  label: string;
  available: boolean;
  reason: string | null;
  minutes: number;
}

export interface SlotDay {
  date: string;
  weekday: string;
  working: boolean;
  slots: Slot[];
  open_count: number;
}

export interface ConsultationNote {
  id: number;
  created_at: string;
  body: string;
  clinician_name: string | null;
  ai_draft: boolean;
}

export interface Consultation {
  /** `assigned: false` means the scheduling fields are absent, not empty. */
  clinician: {
    id: number | null;
    name: string | null;
    email: string | null;
    assigned: boolean;
  } & Partial<ClinicianSchedule>;
  upcoming: ConsultationAppointment[];
  history: ConsultationAppointment[];
  notes: ConsultationNote[];
  recommendations: { urgency: string; title: string; detail: string }[];
  summary: {
    assessment_date: string | null;
    thi_score: number | null;
    thi_grade: string | null;
    hearing_grade: string | null;
    laterality: string | null;
    plan_active: boolean;
    plan_blocks: number;
    daily_minutes_target: number | null;
    review_after_days: number | null;
  };
  treatment_recommendations: string[];
  options: { kinds: string[]; modalities: string[] };
}

export interface ClinicianAppointment extends ConsultationAppointment {
  patient_id: number;
  patient_name: string;
  patient_mrn: string;
}

export interface ClinicianScheduleView {
  profile: ClinicianSchedule;
  today: { date: string; weekday: string; slots: Slot[] };
  upcoming_days: SlotDay[];
}

/** Thresholds for one ear plus the matched pitch — enough to build the cochlea. */
export interface EarModelInputs {
  ear: string;
  thresholds: Record<string, number>;
  pitch_match_hz: number | null;
  hearing_grade: string | null;
  assessment_id: number;
}

export interface CaseloadRow {
  patient_id: number;
  mrn: string;
  full_name: string;
  age: number | null;
  laterality: string | null;
  duration_months: number | null;
  last_assessment: string | null;
  thi_score: number | null;
  thi_grade: string | null;
  thi_change: number | null;
  tri_score: number | null;
  tri_band: string | null;
  worsening_risk: number | null;
  risk_band: string | null;
  adherence_pct: number | null;
  /**
   * Still returned by the caseload endpoint, no longer rendered.
   *
   * The diary was withdrawn from the app; these are frozen at whatever the last
   * entry produced, so showing them would present stale numbers as current. Kept
   * on the type because the response still carries them and silently dropping a
   * field from the contract is how a client starts lying about the API.
   */
  diary_days_14: number;
  diary_mean_14: number | null;
  diary_trend: number | null;
  open_alerts: number;
  highest_urgency: string;
  next_appointment: string | null;
  triage_score: number;
  triage_reasons: string[];
}

/* ------------------------------- rehabilitation --------------------------- */
export interface RehabActivity {
  key: string;
  category: string;
  slot: string;
  minutes: number;
  /** Why this activity is prescribed — a key, rendered from `rehab.reason.*`. */
  because: string | null;
  core: boolean;
}

export interface RehabWeek {
  week: number;
  sound_minutes: number;
  activities: string[];
  introduces: string | null;
  goals: { key: string; target: number }[];
}

export interface RehabProgress {
  started_on: string;
  week: number;
  week_of: number;
  week_start: string;
  week_end: string;
  day_of_programme: number;
  streak_days: number;
  active_days: number;
  week_active_days: number;
  week_completion_pct: number;
  overall_completion_pct: number;
  completed_today: string[];
  remaining_today: string[];
  next_milestone: { week: number; introduces: string | null } | null;
  programme_complete: boolean;
}

export interface RehabProgramme {
  severity: {
    band: string;
    thi_score: number | null;
    anxious: boolean;
    stressed: boolean;
    sleep_disrupted: boolean;
    low_mood: boolean;
    hyperacusis: boolean;
    hearing_grade: string | null;
  };
  activities: RehabActivity[];
  today: RehabActivity[];
  weeks: RehabWeek[];
  current_week: RehabWeek;
  progress: RehabProgress;
  has_assessment: boolean;
  has_prescription: boolean;
  programme_weeks: number;
}

/* --------------------------------- monitoring ----------------------------- */
export interface MonitoringMetric {
  direction: "lower_better" | "higher_better";
  daily: { date: string; value: number }[];
  weekly: { week: number; start: string; end: string; mean: number | null; n: number; confident: boolean }[];
  trend: {
    baseline: number | null;
    current: number | null;
    delta: number | null;
    direction: "improving" | "worsening" | "steady" | null;
    n: number;
  };
}

export interface Monitoring {
  started_on: string;
  today: string;
  programme_weeks: number;
  day_of_programme: number;
  metrics: Record<string, MonitoringMetric>;
  check_in: {
    streak_days: number;
    total_days: number;
    logged_today: boolean;
    dates: string[];
  };
  adherence: {
    active_days: number;
    elapsed_days: number;
    pct: number;
    session_days: number;
    activity_days: number;
    streak_days: number;
    dates: string[];
  };
  rehab: Partial<RehabProgress>;
  consultations: {
    id: number;
    scheduled_for: string;
    status: string;
    kind: string;
    clinician_name: string | null;
  }[];
  recovery_pct: number | null;
  /** Null until the patient chooses a clinician — see the endpoint's note. */
  shared_with: { clinician_id: number; clinician_name: string } | null;
  /** Present only on the clinician-facing variant. */
  patient?: { id: number; full_name: string; mrn: string };
}

export interface CheckInBody {
  tinnitus_loudness?: number | null;
  tinnitus_annoyance?: number | null;
  sleep_quality?: number | null;
  stress_level?: number | null;
  mood?: number | null;
  note?: string;
  on_date?: string;
}

export interface ChatReply {
  reply: string;
  intent: string;
  confidence: number;
  locale: string;
  engine: string;
  safety_flag: string | null;
  escalate: boolean;
  suggestions: { label: string; intent: string; action?: string }[];
  distortions: { key: string; name: string; correction: string }[];
  crisis_resources: { region: string; name: string; contact: string }[];
  note: string | null;
}

/* ------------------------------------------------------------------------- */
/* Endpoint surface                                                           */
/* ------------------------------------------------------------------------- */
export const api = {
  health: () => request<any>("/api/health", { scoped: false }),

  auth: {
    login: (email: string, password: string) =>
      request<Session>("/api/auth/login", { method: "POST", body: { email, password }, scoped: false }),
    register: (body: Record<string, unknown>) =>
      request<Session>("/api/auth/register", { method: "POST", body, scoped: false }),
    me: () => request<any>("/api/auth/me", { scoped: false }),
    /**
     * Persist the signed-in user's language preference.
     *
     * Unscoped on purpose: a clinician who is acting on a patient's record is
     * still setting *their own* interface language, and letting the acting
     * `patient_id` ride along on this call would be an invitation for the server
     * to one day interpret it as "set the patient's language".
     */
    setLocale: (locale: string) =>
      request<{ locale: string }>("/api/auth/locale", {
        method: "PATCH",
        body: { locale },
        scoped: false,
      }),
    demoAccounts: () =>
      request<{ accounts: { email: string; password: string; role: string; full_name: string; mrn: string | null }[]; seeded: boolean }>(
        "/api/auth/demo-accounts",
        { scoped: false }
      ),
  },

  patients: {
    me: () => request<PatientProfile>("/api/patients/me"),
    updateMe: (body: Record<string, unknown>) =>
      request<PatientProfile>("/api/patients/me", { method: "PATCH", body, scoped: false }),
    list: () => request<PatientProfile[]>("/api/patients", { scoped: false }),
    get: (id: number) => request<PatientProfile>(`/api/patients/${id}`, { scoped: false }),
    update: (id: number, body: Record<string, unknown>) =>
      request<PatientProfile>(`/api/patients/${id}`, { method: "PATCH", body, scoped: false }),
    earModel: () => request<{ layers: any[]; note: string }>("/api/patients/education/ear-model", { scoped: false }),
  },

  assessments: {
    instruments: () => request<any>("/api/assessments/instruments", { scoped: false }),
    create: () => request<Assessment>("/api/assessments", { method: "POST" }),
    list: () => request<Assessment[]>("/api/assessments"),
    latest: () => request<Assessment>("/api/assessments/latest"),
    get: (id: number) => request<Assessment>(`/api/assessments/${id}`),
    save: (id: number, body: Record<string, unknown>) =>
      request<Assessment>(`/api/assessments/${id}`, { method: "PATCH", body }),
    finalise: (id: number, body?: Record<string, unknown>) =>
      request<{ assessment: Assessment; analysis: Analysis }>(`/api/assessments/${id}/finalise`, {
        method: "POST",
        body: body ?? {},
      }),
    analysis: (id: number) =>
      request<{ assessment: Assessment; analysis: Analysis }>(`/api/assessments/${id}/analysis`),
    /**
     * The patient's personalised reference tone and level.
     *
     * Derived server-side from the pitch match, loudness match, masking profile
     * and audiogram already on the record — so it is asked for *after* those
     * modules are saved, and the patient is never asked to repeat one to produce
     * it. Read-only: like the reference level itself, the client may not submit
     * a value the server would then have to trust.
     */
    referenceLevel: (id: number) =>
      request<PersonalisedReferenceResponse>(`/api/assessments/${id}/reference-level`),
  },

  therapy: {
    catalogue: () => request<any>("/api/therapy/catalogue", { scoped: false }),
    current: () => request<Prescription>("/api/therapy/current"),
    history: () => request<Prescription[]>("/api/therapy/history"),
    generate: (assessmentId?: number) =>
      request<Prescription>("/api/therapy/generate", {
        method: "POST",
        query: assessmentId ? { assessment_id: assessmentId } : undefined,
      }),
    adapt: () => request<Prescription>("/api/therapy/adapt", { method: "POST" }),
    approve: (prescriptionId: number) =>
      request<Prescription>("/api/therapy/approve", { method: "POST", query: { prescription_id: prescriptionId } }),
    logSession: (body: Record<string, unknown>) =>
      request<any>("/api/therapy/sessions", { method: "POST", body }),
    sessions: (days = 90) => request<any[]>("/api/therapy/sessions", { query: { days } }),
    adherence: (days = 28) => request<any>("/api/therapy/adherence", { query: { days } }),
    spectrum: (query: Record<string, number | string | null | undefined>) =>
      request<any>("/api/therapy/spectrum", { query, scoped: false }),
  },

  /**
   * The patient's own view of their care team.
   *
   * Distinct from `clinician.appointments`, which is gated on the clinician role
   * and scoped to *their* whole caseload. These two endpoints read the same
   * models from opposite ends and neither widens the other's permissions.
   */
  consultation: {
    get: () => request<Consultation>("/api/consultation"),
    /** Every doctor a patient can choose between, with availability to compare. */
    doctors: () =>
      request<{ current_clinician_id: number | null; doctors: DoctorCard[] }>(
        "/api/consultation/doctors"
      ),
    /**
     * Slots for a chosen doctor. Omit `clinicianId` to use the patient's current
     * one; omit `date` for the whole horizon, so a calendar needs one call.
     */
    slots: (clinicianId?: number, date?: string) =>
      request<{ clinician: ClinicianSchedule | null; days: SlotDay[] }>("/api/consultation/slots", {
        query: { clinician_id: clinicianId ?? null, date: date ?? null },
      }),
    /**
     * Confirm a doctor as this patient's own, without booking a slot.
     *
     * Separate from `request` because choosing who looks after you and choosing
     * when to see them are two decisions — see the endpoint's own note.
     */
    selectClinician: (clinicianId: number) =>
      request<{ clinician: Consultation["clinician"] & { changed: boolean } }>(
        "/api/consultation/select-clinician",
        { method: "POST", body: { clinician_id: clinicianId } }
      ),
    request: (body: Record<string, unknown>) =>
      request<ConsultationAppointment>("/api/consultation/request", { method: "POST", body }),
    cancel: (appointmentId: number) =>
      request<ConsultationAppointment>(`/api/consultation/${appointmentId}/cancel`, { method: "POST" }),
  },

  /**
   * The structured rehabilitation programme built on top of the prescription.
   *
   * Distinct from `therapy`, which is the acoustic prescription and its player.
   * This is the schedule, the goals and the progress around it.
   */
  rehab: {
    programme: () => request<RehabProgramme>("/api/rehab/programme"),
    complete: (activityKey: string, minutes?: number) =>
      request<{ activity_key: string; on_date: string; minutes: number; created: boolean }>(
        "/api/rehab/activity",
        { method: "POST", body: { activity_key: activityKey, minutes } }
      ),
    undo: (activityKey: string) =>
      request<void>("/api/rehab/activity", {
        method: "DELETE",
        query: { activity_key: activityKey },
      }),
  },

  /**
   * Daily monitoring: the patient's own self-report, and the trends built from
   * it together with their rehabilitation activity.
   */
  monitoring: {
    get: () => request<Monitoring>("/api/monitoring"),
    checkIn: (body: CheckInBody) =>
      request<CheckInBody & { on_date: string; created: boolean }>("/api/monitoring/check-in", {
        method: "POST",
        body,
      }),
    clear: (onDate?: string) =>
      request<void>("/api/monitoring/check-in", {
        method: "DELETE",
        query: onDate ? { on_date: onDate } : undefined,
      }),
  },

  chat: {
    meta: () => request<any>("/api/chat/meta", { scoped: false }),
    send: (message: string, locale = "en") =>
      request<ChatReply>("/api/chat", { method: "POST", body: { message, locale } }),
    history: (limit = 60) => request<{ messages: any[] }>("/api/chat/history", { query: { limit } }),
    clear: () => request<void>("/api/chat/history", { method: "DELETE" }),
  },

  communities: {
    myCommunity: () => request<CommunityResponse>("/api/communities/my-community"),
    join: (join: boolean) =>
      request<CommunityResponse>("/api/communities/join", { method: "POST", body: { join } }),
    updateLocation: (location: { country: string; state: string; city: string }) =>
      request<CommunityResponse>("/api/communities/location", { method: "POST", body: location }),
    createPost: (content: string) =>
      request<CommunityPost>("/api/communities/posts", { method: "POST", body: { content } }),
    deletePost: (postId: number) =>
      request<{ detail: string }>(`/api/communities/posts/${postId}`, { method: "DELETE" }),
    likePost: (postId: number) =>
      request<{ likes_count: number; is_liked_by_me: boolean }>(`/api/communities/posts/${postId}/like`, {
        method: "POST",
      }),
    createComment: (postId: number, content: string, parentId?: number | null) =>
      request<CommunityComment>(`/api/communities/posts/${postId}/comments`, {
        method: "POST",
        body: { content, parent_id: parentId ?? null },
      }),
    deleteComment: (commentId: number) =>
      request<{ detail: string }>(`/api/communities/comments/${commentId}`, { method: "DELETE" }),
    getChat: () =>
      request<{ messages: CommunityChatMessage[]; online_count: number }>("/api/communities/chat"),
    sendChat: (content: string) =>
      request<CommunityChatMessage>("/api/communities/chat", { method: "POST", body: { content } }),
  },

  clinician: {
    caseload: () => request<CaseloadRow[]>("/api/clinician/caseload", { scoped: false }),
    /**
     * One assigned patient's monitoring data.
     *
     * Unscoped: the patient is named in the path, and the server checks the
     * caseload relationship. Riding on the acting-patient header instead would
     * make the authorisation depend on client state.
     */
    monitoring: (patientId: number) =>
      request<Monitoring>(`/api/clinician/patients/${patientId}/monitoring`, { scoped: false }),
    overview: (patientId: number) =>
      request<any>(`/api/clinician/patients/${patientId}/overview`, { scoped: false }),
    alerts: (unacknowledgedOnly = true) =>
      request<any[]>("/api/clinician/alerts", {
        query: { unacknowledged_only: unacknowledgedOnly },
        scoped: false,
      }),
    acknowledge: (alertId: number) =>
      request<any>(`/api/clinician/alerts/${alertId}/acknowledge`, { method: "POST", scoped: false }),
    appointments: (upcomingOnly = true) =>
      request<ClinicianAppointment[]>("/api/clinician/appointments", {
        query: { upcoming_only: upcomingOnly },
        scoped: false,
      }),
    createAppointment: (body: Record<string, unknown>) =>
      request<any>("/api/clinician/appointments", { method: "POST", body, scoped: false }),
    /** Set the meeting link, confirm a request, or amend the notes. */
    updateAppointment: (id: number, body: Record<string, unknown>) =>
      request<ClinicianAppointment>(`/api/clinician/appointments/${id}`, {
        method: "PATCH",
        body,
        scoped: false,
      }),
    schedule: () => request<ClinicianScheduleView>("/api/clinician/schedule", { scoped: false }),
    updateSchedule: (body: Record<string, unknown>) =>
      request<ClinicianScheduleView>("/api/clinician/schedule", { method: "PATCH", body, scoped: false }),
    createNote: (body: Record<string, unknown>) =>
      request<any>("/api/clinician/notes", { method: "POST", body, scoped: false }),
    cohort: () => request<any>("/api/clinician/cohort", { scoped: false }),
  },

  reports: {
    clinical: (assessmentId?: number) =>
      request<any>("/api/reports/clinical", { query: assessmentId ? { assessment_id: assessmentId } : undefined }),
    fhir: (assessmentId?: number) =>
      request<any>("/api/reports/fhir", { query: assessmentId ? { assessment_id: assessmentId } : undefined }),
    noteDraft: (assessmentId?: number) =>
      request<any>("/api/reports/note-draft", { query: assessmentId ? { assessment_id: assessmentId } : undefined }),
    /** Clinician-only de-identified cohort extract. */
    downloadResearchExtract: () =>
      downloadFile("/api/reports/research-extract.csv", `echosense-research-extract-${today()}.csv`, {
        scoped: false,
      }),
  },

  /**
   * `modelCard`, `status` and `retrain` were dropped with the Model card screen.
   * The endpoints remain on the API — held-out metrics and the simulated-cohort
   * disclosure are still published for anyone auditing the models, and pulling
   * a documented endpoint because one client stopped calling it is not the
   * frontend's decision to make.
   */
  ml: {
    predict: (assessmentId?: number) =>
      request<any>("/api/ml/predict", { query: assessmentId ? { assessment_id: assessmentId } : undefined }),
    whatIf: (overrides: Record<string, number>, assessmentId?: number) =>
      request<any>("/api/ml/what-if", {
        method: "POST",
        body: overrides,
        query: assessmentId ? { assessment_id: assessmentId } : undefined,
      }),
  },
};

export { BASE as API_BASE };
