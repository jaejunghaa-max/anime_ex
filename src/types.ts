// Environment bindings + typed D1 rows + the minimal slice of Discord's
// interaction payloads this bot touches. Raw fetch everywhere (spec §2.4) —
// no SDK types.

export interface Env {
  DB: D1Database;
  DISCORD_TOKEN: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_APP_ID: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REDIRECT_URI: string;
  TOKEN_ENC_KEY: string;
  MAX_PARTICIPANTS?: string;
  JOB_BATCH?: string;
  REMINDERS_PER_TICK?: string;
  SFW_ONLY?: string;
  /** Secret (`wrangler secret put`), not a var — see wrangler.toml. */
  MAL_CLIENT_ID?: string;
  /** Secret gating /diag/search; the route 404s when unset. */
  DIAG_KEY?: string;
}

export interface Cfg {
  maxParticipants: number;
  jobBatch: number;
  remindersPerTick: number;
  sfwOnly: boolean;
  /** Official MAL API v2 client id — primary search source when set. */
  malClientId: string | null;
}

export function cfgOf(env: Env): Cfg {
  const int = (v: string | undefined, d: number) => {
    const n = parseInt(v ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    maxParticipants: int(env.MAX_PARTICIPANTS, 100),
    jobBatch: int(env.JOB_BATCH, 5),
    remindersPerTick: int(env.REMINDERS_PER_TICK, 30),
    sfwOnly: (env.SFW_ONLY ?? 'true') !== 'false',
    malClientId: env.MAL_CLIENT_ID?.trim() || null,
  };
}

// ---------------------------------------------------------------- D1 rows

export interface GuildRow {
  guild_id: string;
  manager_channel_id: string | null;
  participant_channel_id: string | null;
  manager_msg_id: string | null;
  participant_msg_id: string | null;
  manager_role_id: string | null;
  google_refresh_token_enc: string | null;
  google_email: string | null;
  created_at: number;
}

export type EventState =
  | 'DRAFTING' | 'SIGNUP_OPEN' | 'MATCHING' | 'PREPARING' | 'RECOMMENDING'
  | 'LAUNCHING' | 'RUNNING' | 'CLOSING' | 'REVEALED';

export interface EventRow {
  event_id: number;
  guild_id: string;
  state: EventState;
  /** The Session — the event's name (column kept from the old "Topic"). */
  topic: string | null;
  /** Optional Theme — what the picks should aim for; shown to participants. */
  theme: string | null;
  tz: string | null;
  signup_deadline: number | null;
  auto_stop: number;
  signup_banner_flipped: number;
  /** v3.4: deadline for the recommendation phase (display + banner only). */
  reco_deadline: number | null;
  reco_banner_flipped: number;
  review_deadline: number | null;
  reminder_days: string;
  dm_mirror: number;
  /** v3: how many times each participant may "Sorry😞" a recommendation (0–9). */
  max_declines: number;
  /** The @everyone sign-up announcement, so Abort can clean it up. */
  announce_msg_id: string | null;
  /** JSON array of the reveal-gallery message ids, so Abort can remove them. */
  gallery_msg_ids: string;
  /** Manager-editable label/description of the built-in list-link item. */
  link_label: string | null;
  link_desc: string | null;
  sheet_id: string | null;
  sheet_gid: number | null;
  gallery_posted: number;
  validated_at: number | null;
  count_panel_at: number;
  panel_dirty: number;
  created_at: number;
  updated_at: number;
}

export interface FormItem {
  item_id: number;
  event_id: number;
  position: number;
  label: string;
  type: 'FIB' | 'MCQ';
  /** Optional helper text shown under the question in the sign-up modal. */
  description: string | null;
  options_json: string | null;
  visible_to_recommender: number;
}

/** DECLINED rows stay as history: the Santa sees what missed and can't
 *  re-pick it. Only PENDING/FINAL rows count against the giftee's maximum. */
export type RecoStatus = 'PENDING' | 'FINAL' | 'DECLINED';
/** APPROVED = the giftee said Thank you (reversible until Launch);
 *  FORCED = still pending at Launch, locked by the launch sweep. */
export type RecoFinalVia = 'APPROVED' | 'FORCED';

/**
 * One recommendation, addressed by (giftee signup, slot 1..max_recos). The
 * giftee accepts/declines each slot on its own; the Santa fills the lowest
 * empty slot each time they recommend.
 */
export interface RecoRow {
  reco_id: number;
  event_id: number;
  /** The GIFTEE's signup_id — whose slot this is. */
  signup_id: number;
  slot: number;
  mal_id: number | null;
  title: string | null;
  title_en: string | null;
  year: number | null;
  type: string | null;
  episodes: number | null;
  url: string | null;
  image: string | null;
  status: RecoStatus;
  final_via: RecoFinalVia | null;
  /** The giftee's /10 rating of this anime. */
  score: number | null;
  /** The pick card in the giftee's thread, so it can be updated/removed. */
  msg_id: string | null;
  // v6: every accepted anime gets its own review doc.
  doc_id: string | null;
  doc_url: string | null;
  perm_id: string | null;
  template_chars: number;
  doc_missing: number;
  doc_readonly: number;
  wrote: number;
  char_count: number;
  last_edited: number | null;
  synced_at: number | null;
  created_at: number;
  updated_at: number;
}

/**
 * Note: the DB still carries columns this type omits — events.max_recos and
 * loop_status, signups.reco_declined_json and the pre-v6 per-person doc block
 * (doc_id, doc_url, perm_id, doc_readonly, template_chars, last_edited).
 * Nothing reads or writes them since v6; they are dropped from the types so a
 * reader does not have to work out that they are inert, and left in the schema
 * because removing a column in SQLite means rebuilding the table.
 */
export interface SignupRow {
  signup_id: number;
  event_id: number;
  user_id: string;
  display_name: string;
  /** Discord handle, for the review-doc "given to Display(@username)" line. */
  username: string;
  /** v3 built-in form item: link to the participant's MAL/AniList list. */
  list_url: string;
  /** v6: how many anime this participant is willing to receive (1–3, a max). */
  max_recos: number;
  /** The consolidated status panel in their thread, edited in place. */
  mission_msg_id: string | null;
  answers_json: string;
  row_order: number | null;
  group_no: number;
  /** Sorry😞 budget spent, counted per person across all slots. */
  declines_used: number;
  reco_card_posted: number;
  thread_id: string | null;
  dm_channel_id: string | null;
  assignment_posted: number;
  reveal_posted: number;
  /** Per-participant rollups of their `recos` rows, kept as the panel and
   *  reminder cache (syncTick recomputes them). */
  synced_at: number | null;
  doc_missing: number;
  wrote: number;
  char_count: number;
  created_at: number;
  updated_at: number;
}

export type JobKind = 'prepare' | 'launch' | 'close' | 'sync' | 'finish';

export interface JobRow {
  id: number;
  event_id: number;
  kind: JobKind;
  payload_json: string;
  created_at: number;
  done_at: number | null;
  attempts: number;
  last_error: string | null;
  attempted_at: number | null;
}

/**
 * Wizard drafts, shared by the signup wizard (steps A_DONE/B_DONE — answers in
 * partial_answers_json, list link under the "link" key) and the RECOMMENDING
 * wizard (steps R_SEARCH/R_PICKED — keyword/candidates/chosen). The two never
 * overlap: they run in mutually exclusive event states.
 */
export interface DraftRow {
  event_id: number;
  user_id: string;
  step: 'A_DONE' | 'B_DONE' | 'R_SEARCH' | 'R_PICKED';
  keyword: string | null;
  partial_answers_json: string | null;
  candidates_json: string | null;
  chosen_json: string | null;
  expires_at: number;
}

export interface ReminderRow {
  id: number;
  event_id: number;
  user_id: string;
  kind: 'review' | 'manual';
  due_at: number;
  sent_at: number | null;
}

// ------------------------------------------------------- Discord payloads

export const IT = { PING: 1, COMMAND: 2, COMPONENT: 3, AUTOCOMPLETE: 4, MODAL: 5 } as const;

// Interaction callback types (§13.1)
export const RT = {
  PONG: 1,
  MESSAGE: 4,
  DEFER_MESSAGE: 5,
  DEFER_UPDATE: 6,
  UPDATE_MESSAGE: 7,
  MODAL: 9,
} as const;

export const EPHEMERAL = 64;

export interface DUser {
  id: string;
  username: string;
  global_name?: string | null;
}

export interface DMember {
  user: DUser;
  nick?: string | null;
  roles: string[];
  permissions: string;
}

export interface Interaction {
  id: string;
  application_id: string;
  type: number;
  token: string;
  guild_id?: string;
  channel_id?: string;
  member?: DMember;
  user?: DUser;
  message?: { id: string; flags?: number };
  data?: InteractionData;
}

export interface InteractionData {
  // command
  id?: string;
  name?: string;
  options?: Array<{ name: string; type: number; value?: unknown; options?: unknown[] }>;
  // component
  custom_id?: string;
  component_type?: number;
  values?: string[];
  // modal
  components?: ModalNode[];
}

// Modal submit tree: Labels (18) wrapping one component, or legacy Action
// Rows (1) wrapping several. Flattened by `modalFields`.
export interface ModalNode {
  type: number;
  component?: ModalLeaf;
  components?: ModalLeaf[];
}
export interface ModalLeaf {
  type: number;
  custom_id: string;
  value?: string;
  values?: string[];
}

export function modalFields(nodes: ModalNode[] | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of nodes ?? []) {
    const leaves = n.component ? [n.component] : (n.components ?? []);
    for (const leaf of leaves) {
      if (!leaf?.custom_id) continue;
      if (leaf.values) out.set(leaf.custom_id, leaf.values[0] ?? '');
      else out.set(leaf.custom_id, leaf.value ?? '');
    }
  }
  return out;
}
